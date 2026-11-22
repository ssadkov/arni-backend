// Runs against an explicitly supplied disposable local PostgreSQL database only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
global.fetch = async () => Response.json({ data: require('./fixtures/router-models.cjs') });

const db = process.env.ARNI_TEST_DATABASE_URL;
if (!db || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/arni_budget_test(?:\?|$)/.test(db)) {
	throw new Error('Set ARNI_TEST_DATABASE_URL to a disposable localhost arni_budget_test database.');
}
process.env.PRISMA_DATABASE_URL = db;
process.env.DATABASE_URL = db;
process.env.ADMIN_USER = 'billing-test';
process.env.ADMIN_PASS = 'local-test-only';
process.env.JWT_SECRET = 'local-disposable-test-secret-with-at-least-32-characters';

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
	return resolveFilename.call(this, name.startsWith('@/') ? path.join(__dirname, '../src', name.slice(2)) : name, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => {
	module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	}).outputText, filename);
};

const prisma = require('../src/lib/prisma.ts').default;
const { reserveBudget, settleBudget, budgetSnapshot } = require('../src/lib/budget.ts');
const { UsageParser, costMicros, currentWindow, FIVE_HOURS_MS, MAX_CONCURRENT_RESERVATIONS } = require('../src/lib/budgetPolicy.ts');
const { usageStream } = require('../src/lib/usageStream.ts');
const { managedBody } = require('../src/lib/budgetPricing.ts');
const { POST: grant } = require('../src/app/api/admin/users/[id]/budget/route.ts');
const { POST: reconcile } = require('../src/app/api/admin/users/[id]/budget/reconcile/route.ts');
const { FREE_DAILY_STEP_LIMIT } = require('../src/lib/freeSteps.ts');
const { NextRequest } = require('next/server');
const { requireAdmin } = require('../src/lib/adminAuth.ts');
const { GET: getUsage } = require('../src/app/api/account/usage/route.ts');
const { encryptJWT } = require('../src/lib/jwt.ts');
const { randomUUID } = require('node:crypto');
const { billingRates } = require('../src/lib/billingCurrency.ts');
const { mock } = require('node:test');
const { PAID_DEEPSEEK_MODEL, TRIAL_PICKER_ID } = require('../src/lib/llm/trialModel.ts');
const { DEEPSEEK_BONUS_KIND: BONUS_KIND, deepSeekBonusReport } = require('../src/lib/deepSeekBonus.ts');
const { POST: grantBonus } = require('../src/app/api/admin/deepseek-bonus/grant/route.ts');
const { GET: getAccount } = require('../src/app/api/account/route.ts');
const { GET: getModels } = require('../src/app/api/models/route.ts');

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const defaults = { grantUsd: 20, fiveHourUsd: 2, weeklyUsd: 5, fiveHourRequests: 150, weeklyRequests: 1000, days: 30, enabled: true, note: 'Internal test' };
function grantRequest(userId, payload, authenticated = true) {
	return grant(new NextRequest(`http://localhost/api/admin/users/${userId}/budget`, { method: 'POST',
		headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Basic ${Buffer.from('billing-test:local-test-only').toString('base64')}` } : {}) },
		body: JSON.stringify(payload) }), { params: Promise.resolve({ id: userId }) });
}

async function main() {
	// Prisma loads the developer's .env, which holds a real Gemini key; tests must never reach Google.
	delete process.env.GEMINI_API_KEY;
	delete process.env.DEEPSEEK_BONUS_ENABLED;
	await prisma.billingMarkup.upsert({ where: { id: 'global' }, create: { id: 'global', percent: 0 }, update: { percent: 0 } });
	await check('additive migration preserves existing token balance', async () => {
		const fixture = await prisma.user.findUnique({ where: { id: 'migration-fixture' }, include: { budget: true } });
		assert.deepEqual({ tokens: fixture?.tokenBalance, budget: fixture?.budget }, { tokens: 12345, budget: null });
	});
	await prisma.user.deleteMany({ where: { email: { endsWith: '@billing-test.invalid' } } });
	const user = await prisma.user.create({ data: { email: 'employee@billing-test.invalid' } });
	const userId = user.id;
	await check('unauthenticated grant denied, missing admin configuration fails closed', async () => {
		assert.equal((await grantRequest(userId, defaults, false)).status, 401);
		assert.equal((await grantRequest(userId, null)).status, 400);
		const password = process.env.ADMIN_PASS;
		delete process.env.ADMIN_PASS;
		assert.equal(requireAdmin(new NextRequest('http://localhost/admin')).status, 401);
		process.env.ADMIN_PASS = password;
		assert.equal(requireAdmin(new NextRequest('http://localhost/api/admin/users', { method: 'POST', headers: {
			Authorization: `Basic ${Buffer.from('billing-test:local-test-only').toString('base64')}`, Origin: 'https://unrelated.invalid',
		} })).status, 403);
	});
	await check('concurrent duplicate grant credits $20 once; changed payload conflicts', async () => {
		const payload = { ...defaults, key: crypto.randomUUID() };
		const responses = await Promise.all([grantRequest(userId, payload), grantRequest(userId, payload)]);
		assert.deepEqual(responses.map(response => response.status), [200, 200]);
		assert.equal((await prisma.accountBudget.findUniqueOrThrow({ where: { userId } })).balanceMicros, 20_000_000);
		assert.equal((await grantRequest(userId, { ...payload, weeklyUsd: 10 })).status, 409);
	});
	await check('concurrent requests are capped per user and cannot overspend one balance', async () => {
		const results = await Promise.allSettled(Array.from({ length: MAX_CONCURRENT_RESERVATIONS + 1 }, () => reserveBudget(userId, 'test-model', 'bedrock', 500000, 3, 15)));
		const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value);
		assert.deepEqual({ fulfilled: fulfilled.length, rejected: results.filter(result => result.status === 'rejected').map(result => result.reason.code) },
			{ fulfilled: MAX_CONCURRENT_RESERVATIONS, rejected: ['request_in_progress'] });
		const [reservation, ...extra] = fulfilled;
		// Refunding the extra steps leaves the same ledger state the later checks expect.
		for (const row of extra) { await settleBudget(row.id, null, true); }
		await Promise.all([settleBudget(reservation.id, { prompt_tokens: 1000, completion_tokens: 100 }), settleBudget(reservation.id, { prompt_tokens: 1000, completion_tokens: 100 })]);
		const budget = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		assert.deepEqual({ balance: budget.balanceMicros, used: budget.fiveHourUsedMicros, requests: budget.fiveHourRequests, logs: await prisma.usageLog.count({ where: { userId } }) },
			{ balance: 19_995_500, used: 4500, requests: 1, logs: 1 });
	});
	await check('OpenRouter uses reported monetary cost instead of token sum', async () => {
		const row = await reserveBudget(userId, 'paid/model', 'openrouter', 10000, 3, 15);
		await settleBudget(row.id, { prompt_tokens: 1000, completion_tokens: 100, cost: 0.002 });
		assert.equal((await prisma.budgetReservation.findUniqueOrThrow({ where: { id: row.id } })).costMicros, 2000);
	});
	await check('cache tariffs are snapshotted, settled once and retained across model switches', async () => {
		const row = await reserveBudget(userId, 'claude', 'bedrock', 100000, 3, 15,
			{ chatId: 'restored-chat', cacheReadPerMillion: 0.3, cacheWritePerMillion: 3.75 });
		const usage = { prompt_tokens: 10000, completion_tokens: 100,
			prompt_tokens_details: { cached_tokens: 8000, cache_creation_input_tokens: 1000 }, cost: 99 };
		await Promise.all([settleBudget(row.id, usage), settleBudget(row.id, usage)]);
		const next = await reserveBudget(userId, 'qwen', 'bedrock', 10000, 0.5, 1.2, { chatId: 'restored-chat', client: 'arni' });
		await settleBudget(next.id, { prompt_tokens: 1000, completion_tokens: 100 });
		const logs = await prisma.usageLog.findMany({ where: { userId, chatId: 'restored-chat' }, orderBy: { createdAt: 'asc' } });
		assert.deepEqual(logs.map(log => [log.model, log.costMicros, log.cacheReadTokens, log.cacheWriteTokens, log.client]),
			[['claude', 10650, 8000, 1000, null], ['qwen', 620, 0, 0, 'arni']]);
	});
	await check('missing usage: Bedrock chat refunds money but counts the request; OpenRouter and images keep the reserve', async () => {
		const before = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		const interrupted = await reserveBudget(userId, 'test', 'bedrock', 10500, 3, 15, { requestId: crypto.randomUUID(), markupPercent: 5 });
		await settleBudget(interrupted.id, null);
		await settleBudget(interrupted.id, null);
		const router = await reserveBudget(userId, 'paid/model', 'openrouter', 10000, 3, 15);
		await settleBudget(router.id, null);
		const picture = await reserveBudget(userId, 'picture', 'bedrock', 700, 0, 0, { operation: 'image', unitPriceMicros: 700 });
		await settleBudget(picture.id, null);
		const rejected = await reserveBudget(userId, 'test', 'bedrock', 10000, 3, 15);
		await settleBudget(rejected.id, null, true);
		const after = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		const row = id => prisma.budgetReservation.findUniqueOrThrow({ where: { id } });
		const log = await prisma.usageLog.findUniqueOrThrow({ where: { requestId: interrupted.requestId } });
		assert.deepEqual({
			delta: before.balanceMicros - after.balanceMicros,
			windows: [after.fiveHourUsedMicros - before.fiveHourUsedMicros, after.weeklyUsedMicros - before.weeklyUsedMicros],
			steps: after.fiveHourRequests - before.fiveHourRequests,
			statuses: [(await row(interrupted.id)).status, (await row(router.id)).status, (await row(picture.id)).status],
			log: [log.costMicros, log.providerCostMicros, log.accounting, log.costBasis],
		}, {
			delta: 10700, windows: [10700, 10700], steps: 3, statuses: ['refunded', 'estimated', 'estimated'],
			log: [0, null, 'refunded', 'interrupted'],
		});
	});
	await check('5-hour, weekly, request and balance caps block before upstream', async () => {
		const before = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		await prisma.accountBudget.update({ where: { userId }, data: { fiveHourLimitMicros: before.fiveHourUsedMicros } });
		await assert.rejects(reserveBudget(userId, 'test', 'bedrock', 1, 3, 15), error => error.code === 'five_hour_limit');
		await prisma.accountBudget.update({ where: { userId }, data: { fiveHourLimitMicros: 2000000, weeklyLimitMicros: before.weeklyUsedMicros } });
		await assert.rejects(reserveBudget(userId, 'test', 'bedrock', 1, 3, 15), error => error.code === 'weekly_limit');
		await prisma.accountBudget.update({ where: { userId }, data: { weeklyLimitMicros: 5000000, fiveHourRequestLimit: before.fiveHourRequests } });
		await assert.rejects(reserveBudget(userId, 'test:free', 'openrouter', 0, 0, 0), error => error.code === 'five_hour_limit');
		await prisma.accountBudget.update({ where: { userId }, data: { fiveHourRequestLimit: 150, balanceMicros: 0 } });
		await assert.rejects(reserveBudget(userId, 'test', 'bedrock', 1, 3, 15), error => error.code === 'insufficient_budget');
		await prisma.accountBudget.update({ where: { userId }, data: { balanceMicros: before.balanceMicros } });
	});
	await check('windows restart on first request after expiry, independently', async () => {
		await prisma.accountBudget.update({ where: { userId }, data: { fiveHourStartedAt: new Date(Date.now() - FIVE_HOURS_MS - 1000), fiveHourRequests: 150, fiveHourUsedMicros: 2000000 } });
		const before = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		const row = await reserveBudget(userId, 'test:free', 'openrouter', 0, 0, 0);
		await settleBudget(row.id, { prompt_tokens: 50, completion_tokens: 20 });
		const after = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		assert.deepEqual({ fiveSteps: after.fiveHourRequests, weeklySteps: after.weeklyRequests, balance: after.balanceMicros }, { fiveSteps: 1, weeklySteps: before.weeklyRequests + 1, balance: before.balanceMicros });
		const now = new Date();
		assert.equal(currentWindow({ startedAt: new Date(now.getTime() - FIVE_HOURS_MS), usedMicros: 1, requests: 1 }, FIVE_HOURS_MS, now).startedAt, null);
	});
	await check('disabled, expired, and banned managed accounts are denied', async () => {
		await prisma.accountBudget.update({ where: { userId }, data: { enabled: false } });
		await assert.rejects(reserveBudget(userId, 'test:free', 'openrouter', 0, 0, 0), error => error.code === 'access_expired');
		await prisma.accountBudget.update({ where: { userId }, data: { enabled: true, validUntil: new Date(0) } });
		await assert.rejects(reserveBudget(userId, 'test:free', 'openrouter', 0, 0, 0), error => error.code === 'access_expired');
		await prisma.accountBudget.update({ where: { userId }, data: { validUntil: new Date(Date.now() + 86400000) } });
		await prisma.user.update({ where: { id: userId }, data: { isBanned: true } });
		await assert.rejects(reserveBudget(userId, 'test:free', 'openrouter', 0, 0, 0), error => error.code === 'account_blocked');
		await prisma.user.update({ where: { id: userId }, data: { isBanned: false } });
	});
	await check('split UTF-8/SSE events and zero-token usage parse correctly', async () => {
		const parser = new UsageParser();
		const bytes = new TextEncoder().encode('data: {"text":"Привет"}\r\n\r\ndata: {"usage":{"prompt_tokens":0,"completion_tokens":0,"cost":0}}\n\ndata: [DONE]\n\n');
		for (const byte of bytes) { parser.push(Uint8Array.of(byte)); }
		parser.push(new Uint8Array(), true);
		assert.deepEqual(parser.usage, { prompt_tokens: 0, completion_tokens: 0, cost: 0 });
		assert.equal(costMicros(1, 0, 0.1, 0), 1);
	});
	await check('client cancellation still drains usage and settles exactly once', async () => {
		let send;
		let settled = [];
		const input = new ReadableStream({ start(controller) { send = controller; } });
		const monitored = usageStream(input, async usage => { settled.push(usage); });
		await monitored.stream.cancel();
		send.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\n'));
		send.close();
		await monitored.completed;
		assert.deepEqual(settled, [{ prompt_tokens: 20, completion_tokens: 10, cost: undefined }]);
	});
	await check('stream holds a split terminal marker until chat cost is recorded', async () => {
		const encoder = new TextEncoder();
		const input = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":20,"completion_tokens":10}}\n\ndata: [DO'));
				controller.enqueue(encoder.encode('NE]\n\n'));
				controller.close();
			},
		});
		let release;
		const pending = new Promise(resolve => { release = resolve; });
		const settlements = [];
		const monitored = usageStream(input, async usage => { settlements.push(usage); await pending; });
		const reader = monitored.stream.getReader();
		await reader.read();
		let terminalReceived = false;
		const terminal = reader.read().then(result => { terminalReceived = true; return result; });
		try {
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(terminalReceived, false);
			assert.deepEqual(settlements, [{ prompt_tokens: 20, completion_tokens: 10, cost: undefined }]);
		} finally { release(); }
		assert.equal(new TextDecoder().decode((await terminal).value), 'NE]\n\n');
		await monitored.completed;
		assert.equal(settlements.length, 1);
	});
	await check('extra billable request options stripped and multimodal requests rejected', async () => {
		const body = managedBody({ model: 'test', messages: [{ role: 'user', content: 'hello', cache_control: {} }], max_tokens: 50000, n: 100, plugins: [{}], provider: {} });
		assert.deepEqual({ max: body.max_tokens, n: body.n, plugins: body.plugins, cache: body.messages[0].cache_control }, { max: 4096, n: undefined, plugins: undefined, cache: undefined });
		assert.equal(managedBody({ model: 'vendor/model:free', messages: [{ role: 'user', content: 'hello' }], max_tokens: 50000 }).max_tokens, 16000);
		assert.equal(managedBody({ model: 'vendor/model:free', messages: [{ role: 'user', content: 'hello' }] }).max_tokens, 16000);
		assert.equal(managedBody({ model: 'global.anthropic.claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }], max_tokens: 50000 }).max_tokens, 16000);
		assert.throws(() => managedBody({ messages: [{ content: [{ type: 'image_url' }] }] }));
	});
	await check('balance ledger reconciles to current balance; snapshot excludes expired windows', async () => {
		const entries = await prisma.budgetEntry.aggregate({ where: { userId }, _sum: { amountMicros: true } });
		const budget = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		assert.equal(entries._sum.amountMicros, budget.balanceMicros);
		assert.equal(budgetSnapshot({ ...budget, fiveHourStartedAt: new Date(0) }).fiveHour.requests, 0);
	});
	await check('chat route reserves and settles Bedrock, split SSE, free steps, and upstream errors', async () => {
		let calls = 0;
		let mode = 'json';
		const originalLoad = Module._load;
		Module._load = function (name, parent, ...rest) {
			if (name === '@/lib/jwt') { return { decryptJWT: async () => ({ userId }) }; }
			if (name === 'next/server') { return { ...originalLoad.call(this, name, parent, ...rest), after: () => {} }; }
			if (name === '@/lib/openRouterStatus') { return { routeFreeModel: async model => ({ model }), rememberUnavailable: () => {}, rememberRejected: () => {}, isModelAccessDenied: () => false }; }
			if (name === '@/lib/llm/bedrock' || name === '@/lib/llm/openrouter') {
				const complete = async () => {
					calls++;
					if (mode === 'error') { return new Response('Upstream refused', { status: 400 }); }
					if (mode === 'uncertain') { return new Response('Upstream timeout', { status: 503 }); }
					if (mode === 'broken' || mode === 'truncated') {
						let sent = false;
						return new Response(new ReadableStream({ pull(controller) {
							if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"part"}}]}\n\n')); }
							else if (mode === 'broken') { controller.error(new Error('reset')); }
							else { controller.close(); }
						} }));
					}
					if (mode === 'stream') {
						const bytes = new TextEncoder().encode('data: {"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\ndata: [DONE]\n\n');
						return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) { controller.enqueue(Uint8Array.of(byte)); } controller.close(); } }));
					}
					return Response.json({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
				};
				return { completeWithBedrock: complete, completeWithOpenRouter: complete };
			}
			return originalLoad.call(this, name, parent, ...rest);
		};
		let chat;
		try { chat = require('../src/app/api/chat/completions/route.ts').POST; }
		finally { Module._load = originalLoad; }
		await prisma.bedrockModel.upsert({ where: { id: 'test-bedrock' }, update: {}, create: { id: 'test-bedrock', name: 'Test', inputPerMillion: 3, outputPerMillion: 15, enabled: true } });
		await prisma.user.update({ where: { id: userId }, data: { llmProvider: 'BEDROCK', bedrockModelId: 'test-bedrock' } });
		const request = (stream, model = 'test-bedrock') => new NextRequest('http://localhost/api/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], stream, max_tokens: 10 }) });
		const before = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		assert.equal((await chat(request(false))).status, 200);
		mode = 'stream';
		const streamed = await chat(request(true));
		await streamed.text();
		assert.equal(streamed.status, 200);
		const after = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		assert.equal(before.balanceMicros - after.balanceMicros, 900);
		mode = 'error';
		assert.equal((await chat(request(false))).status, 400);
		assert.equal((await prisma.accountBudget.findUniqueOrThrow({ where: { userId } })).balanceMicros, after.balanceMicros);
		const balance = async () => (await prisma.accountBudget.findUniqueOrThrow({ where: { userId } })).balanceMicros;
		const settled = async () => {
			for (let i = 0; i < 50 && await prisma.budgetReservation.count({ where: { userId, status: 'pending', model: 'test-bedrock' } }); i++) {
				await new Promise(resolve => setTimeout(resolve, 20));
			}
		};
		for (mode of ['broken', 'truncated']) {
			const start = await balance();
			await (await chat(request(true))).text().catch(() => undefined);
			await settled();
			assert.equal(await balance(), start, `${mode} Bedrock stream costs the user nothing`);
		}
		mode = 'stream';
		const beforeCancel = await balance();
		await (await chat(request(true))).body.cancel();
		await settled();
		assert.equal(beforeCancel - await balance(), 450, 'cancelling on the client is not a way to a free answer');
		mode = 'uncertain';
		const beforeFailure = await balance();
		assert.equal((await chat(request(false))).status, 503);
		assert.equal(await balance(), beforeFailure, 'a Bedrock 5xx costs the user nothing');
		await prisma.user.update({ where: { id: userId }, data: { llmProvider: 'OPENROUTER' } });
		mode = 'json';
		assert.equal((await chat(request(false, 'test:free'))).status, 200);
		await prisma.accountBudget.update({ where: { userId }, data: { enabled: false } });
		assert.equal((await chat(request(false, 'test:free'))).status, 200, 'Free route survives disabled paid access');
		const priorCalls = calls;
		assert.equal((await chat(request(false))).status, 403);
		assert.equal(calls, priorCalls);
	});
	await check('stale Bedrock reservations close with a refund; fresh ones cannot be closed', async () => {
		await prisma.accountBudget.update({ where: { userId }, data: { enabled: true } });
		const row = await reserveBudget(userId, 'test', 'bedrock', 10000, 3, 15);
		const request = () => new NextRequest('http://localhost/api/admin/reconcile', { method: 'POST', headers: {
			Authorization: `Basic ${Buffer.from('billing-test:local-test-only').toString('base64')}`, 'Content-Type': 'application/json',
		}, body: JSON.stringify({ reservationId: row.id }) });
		assert.equal((await reconcile(request(), { params: Promise.resolve({ id: userId }) })).status, 409);
		await prisma.budgetReservation.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - 601000) } });
		assert.equal((await reconcile(request(), { params: Promise.resolve({ id: userId }) })).status, 200);
		assert.equal((await reconcile(request(), { params: Promise.resolve({ id: userId }) })).status, 200);
		assert.equal(await prisma.budgetEntry.count({ where: { key: `reconcile:${row.id}` } }), 1);
		const closed = await prisma.budgetReservation.findUniqueOrThrow({ where: { id: row.id } });
		assert.deepEqual([closed.status, closed.costMicros], ['refunded', 0]);
	});
	await check('existing FREE account keeps daily quota, zero balance access, streaming usage and rejected-step refund', async () => {
		// Remove only this disposable account's test budget to exercise the existing-user path.
		await prisma.accountBudget.delete({ where: { userId } });
		await prisma.user.update({ where: { id: userId }, data: { plan: 'FREE', tokenBalance: 0, llmProvider: 'OPENROUTER', freeStepsToday: 0, freeStepsDay: null, freeStepsTotal: 0 } });
		let mode = 'json';
		let calls = 0;
		const originalLoad = Module._load;
		const file = require.resolve('../src/app/api/chat/completions/route.ts');
		delete require.cache[file];
		Module._load = function (name, parent, ...rest) {
			if (name === '@/lib/jwt') { return { decryptJWT: async () => ({ userId }) }; }
			if (name === 'next/server') { return { ...originalLoad.call(this, name, parent, ...rest), after: () => {} }; }
			if (name === '@/lib/openRouterStatus') { return { routeFreeModel: async model => ({ model }), rememberUnavailable: () => {}, rememberRejected: () => {}, isModelAccessDenied: () => false }; }
			if (name === '@/lib/llm/openrouter') { return { completeWithOpenRouter: async () => {
				calls++;
				if (mode === 'error') { return new Response('refused', { status: 429 }); }
				if (mode === 'stream') { return new Response('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n'); }
				return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 2 } });
			} }; }
			return originalLoad.call(this, name, parent, ...rest);
		};
		let chat;
		try { chat = require(file).POST; } finally { Module._load = originalLoad; }
		const request = stream => new NextRequest('http://localhost/api/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test:free', messages: [{ role: 'user', content: 'hello' }], stream }) });
		assert.equal((await chat(request(false))).status, 200);
		mode = 'stream';
		const response = await chat(request(true));
		assert.equal(response.headers.get('X-Free-Steps-Remaining'), String(FREE_DAILY_STEP_LIMIT - 2));
		await response.text();
		mode = 'error';
		assert.equal((await chat(request(false))).status, 429);
		const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
		assert.deepEqual({ tokens: user.tokenBalance, daily: user.freeStepsToday, total: user.freeStepsTotal, budgets: await prisma.accountBudget.count({ where: { userId } }) }, { tokens: 0, daily: 2, total: 2, budgets: 0 });
		await prisma.user.update({ where: { id: userId }, data: { freeStepsToday: FREE_DAILY_STEP_LIMIT } });
		const before = calls;
		assert.equal((await chat(request(false))).status, 429);
		assert.equal(calls, before);
	});
	await check('display rates account for foreign currency nominal and use USD when the feed is unavailable', async () => {
		const originalFetch = global.fetch;
		const originalRub = process.env.ARNI_USD_TO_RUB;
		const originalKzt = process.env.ARNI_USD_TO_KZT;
		delete process.env.ARNI_USD_TO_RUB;
		delete process.env.ARNI_USD_TO_KZT;
		try {
			const urls = [];
			const beforeMoscowMidnight = new Date('2026-11-03T20:59:59Z');
			const atMoscowMidnight = new Date('2026-11-03T21:00:00Z');
			global.fetch = async url => {
				urls.push(url);
				return new Response('<ValCurs><Valute ID="a"><CharCode>USD</CharCode><Nominal>1</Nominal><Value>80,0000</Value></Valute>'
					+ '<Valute ID="b"><CharCode>KZT</CharCode><Nominal>100</Nominal><Value>16,0000</Value></Valute></ValCurs>');
			};
			assert.deepEqual(await billingRates(beforeMoscowMidnight), { USD: 1, RUB: 80, KZT: 500 });
			process.env.ARNI_USD_TO_RUB = '90';
			assert.deepEqual(await billingRates(atMoscowMidnight), { USD: 1, RUB: 90, KZT: 500 });
			assert.deepEqual(urls, [
				'https://www.cbr.ru/scripts/XML_daily.asp?date_req=03/11/2026',
				'https://www.cbr.ru/scripts/XML_daily.asp?date_req=04/11/2026',
			]);
			global.fetch = async () => { throw new Error('offline'); };
			assert.deepEqual(await billingRates(), { USD: 1, RUB: 90, KZT: null });
		} finally {
			global.fetch = originalFetch;
			if (originalRub === undefined) { delete process.env.ARNI_USD_TO_RUB; } else { process.env.ARNI_USD_TO_RUB = originalRub; }
			if (originalKzt === undefined) { delete process.env.ARNI_USD_TO_KZT; } else { process.env.ARNI_USD_TO_KZT = originalKzt; }
		}
	});
	await check('RUB grants use the quoted rate and replay without double credit', async () => {
		const rubUser = await prisma.user.create({ data: { email: 'rub-grant@billing-test.invalid' } });
		process.env.ARNI_USD_TO_RUB = '100';
		process.env.ARNI_USD_TO_KZT = '500';
		const { grantUsd, fiveHourUsd, weeklyUsd, ...settings } = defaults;
		const payload = { ...settings, key: randomUUID(), rubRate: 100, rubKopecks: [99_900, 20_000, 50_000] };
		assert.equal((await grantRequest(rubUser.id, payload)).status, 200);
		process.env.ARNI_USD_TO_RUB = '110';
		assert.equal((await grantRequest(rubUser.id, payload)).status, 200);
		assert.equal((await grantRequest(rubUser.id, { ...payload, key: randomUUID() })).status, 409);
		const budget = await prisma.accountBudget.findUniqueOrThrow({ where: { userId: rubUser.id } });
		assert.equal(budget.balanceMicros, 9_990_000);
	});
	await check('chat totals distinguish zero-cost usage from missing data and filter by owner', async () => {
		const first = await prisma.user.create({ data: { email: 'first-chat@billing-test.invalid' } });
		const second = await prisma.user.create({ data: { email: 'second-chat@billing-test.invalid' } });
		const row = { chatId: 'chat-123', promptTokens: 10, completionTokens: 20, operation: 'chat' };
		await prisma.usageLog.createMany({ data: [
			{ ...row, userId: first.id, model: 'test:free', costMicros: 0 },
			{ ...row, userId: second.id, model: 'test:paid', costMicros: 42_000 },
			{ ...row, userId: second.id, model: 'test:paid', chatId: 'unknown-cost' },
		] });
		async function summary(userId, chatId) {
			const token = await encryptJWT({ userId });
			const response = await getUsage(new NextRequest('http://localhost/api/account/usage?summary=1&chatId=' + chatId,
				{ headers: { Authorization: 'Bearer ' + token } }));
			assert.equal(response.status, 200);
			return response.json();
		}
		assert.deepEqual(await Promise.all([summary(first.id, row.chatId), summary(second.id, row.chatId), summary(second.id, 'unknown-cost')]), [
			{ totalMicros: 0, requestCount: 1, pricedRequests: 1 },
			{ totalMicros: 42_000, requestCount: 1, pricedRequests: 1 },
			{ totalMicros: null, requestCount: 1, pricedRequests: 0 },
		]);
	});
	await check('payment notice credits once, removes expiry, and refunds the same dollars', async () => {
		process.env.BILLING_CHECKOUT_PRODUCT_TOPUP = '9001';
		process.env.ARNI_USD_TO_RUB = '100';
		const payer = await prisma.user.create({ data: { email: `payer-${randomUUID()}@billing-test.invalid` } });
		const { handlePaymentNotice } = require('../src/lib/billingPayment.ts');
		const notice = { idAccount: `acct-${payer.id}`, idLogicliftUser: payer.id, idRate: '9001', accountStatus: '5', accountSum: '100.00', currency: 'RUB' };
		assert.equal((await handlePaymentNotice(notice, 100)).created, true);
		assert.equal((await handlePaymentNotice(notice, 100)).created, false);
		const budget = await prisma.accountBudget.findUniqueOrThrow({ where: { userId: payer.id } });
		assert.equal(budget.balanceMicros, 1_000_000);
		assert.ok(budget.validUntil.getUTCFullYear() >= 2099);
		await handlePaymentNotice({ ...notice, accountStatus: '6' }, 100);
		assert.equal((await prisma.accountBudget.findUniqueOrThrow({ where: { userId: payer.id } })).balanceMicros, 0);
		await handlePaymentNotice({ ...notice, accountStatus: '6' }, 100);
		assert.equal((await prisma.accountBudget.findUniqueOrThrow({ where: { userId: payer.id } })).balanceMicros, 0);
	});
	await check('frozen markup doubles the provider cost and leaves the provider amount beside it', async () => {
		const marked = await prisma.user.create({ data: { email: `markup-${randomUUID()}@billing-test.invalid` } });
		await prisma.accountBudget.create({ data: { userId: marked.id, balanceMicros: 100_000, validUntil: new Date(Date.now() + 86400000) } });
		const row = await reserveBudget(marked.id, 'marked', 'openrouter', 20_000, 3, 15, { markupPercent: 100 });
		await settleBudget(row.id, { prompt_tokens: 1, completion_tokens: 1, cost: 0.01 });
		const settled = await prisma.budgetReservation.findUniqueOrThrow({ where: { id: row.id } });
		assert.equal(settled.providerCostMicros, 10_000);
		assert.equal(settled.costMicros, 20_000);
		const log = await prisma.usageLog.findFirstOrThrow({ where: { userId: marked.id, model: 'marked' } });
		assert.equal(log.providerCostMicros, 10_000);
		assert.equal(log.costMicros, 20_000);
	});
	await check('bonus grants are idempotent and only active paid users qualify for the batch', async () => {
		const now = Date.now();
		process.env.DEEPSEEK_BONUS_ENABLED = 'true';
		process.env.DEEPSEEK_BONUS_EXPIRES_AT = new Date(now + 86400_000).toISOString();
		const make = (name, budget, isBanned = false) => prisma.user.create({ data: {
			email: `bonus-${name}@billing-test.invalid`, isBanned,
			...(budget ? { budget: { create: { balanceMicros: 20_000_000, validUntil: new Date(now + 86_400_000), ...budget } } } : {}),
		} });
		const [active, paused, expired, banned, free] = await Promise.all([
			make('active', {}), make('paused', { enabled: false }), make('expired', { validUntil: new Date(now - 1000) }),
			make('banned', {}, true), make('free', null),
		]);
		const adminAuth = `Basic ${Buffer.from('billing-test:local-test-only').toString('base64')}`;
		const request = (dryRun, authorization = adminAuth) => grantBonus(new NextRequest('http://localhost/api/admin/deepseek-bonus/grant', {
			method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun }),
		}));
		assert.equal((await request(true, 'Invalid')).status, 401);
		const preview = await (await request(true)).json();
		assert.ok(preview.userIds.includes(active.id));
		for (const account of [paused, expired, banned, free]) { assert.ok(!preview.userIds.includes(account.id)); }
		assert.equal(await prisma.budgetWallet.count(), 0);
		assert.equal((await (await request(false)).json()).created, preview.count);
		const replay = await (await request(false)).json();
		assert.deepEqual(replay, { created: 0, skipped: preview.count, unavailable: 0, failed: 0 });
		assert.equal((await (await request(true)).json()).count, 0);
		assert.equal(await prisma.budgetEntry.count({ where: { userId: active.id, key: `wallet:${BONUS_KIND}:${active.id}` } }), 1);
		const bonusRequest = (route) => encryptJWT({ userId: active.id }).then(token => route(
			new NextRequest('http://localhost/api/test', { headers: { Authorization: `Bearer ${token}` } }),
		));
		const account = (await (await bonusRequest(getAccount)).json()).user;
		assert.equal(account.budget.bonus.balanceMicros, 15_000_000);
		assert.equal(account.budget.bonus.weekly.limitMicros, 10_000_000);
		const catalog = (await (await bonusRequest(getModels)).json()).data;
		const deepseek = catalog.find(row => row.id === PAID_DEEPSEEK_MODEL);
		assert.equal(deepseek.arni_bonus.balanceMicros, 15_000_000);
		assert.match(deepseek.name, /бонус \$15\.00/);
		delete process.env.DEEPSEEK_BONUS_ENABLED;
		assert.equal((await (await bonusRequest(getAccount)).json()).user.budget.bonus, null);
	});

	await check('positive manual and ruble top-ups each grant the promo once', async () => {
		process.env.DEEPSEEK_BONUS_ENABLED = 'true';
		const user = await prisma.user.create({ data: { email: 'bonus-manual@billing-test.invalid' } });
		assert.equal((await grantRequest(user.id, { ...defaults, grantUsd: 0, key: randomUUID() })).status, 200);
		const count = (id) => prisma.budgetWallet.count({ where: { userId: id, kind: BONUS_KIND } });
		assert.equal(await count(user.id), 0);
		for (const key of [randomUUID(), randomUUID()]) {
			assert.equal((await grantRequest(user.id, { ...defaults, grantUsd: 1, key })).status, 200);
		}
		assert.equal(await count(user.id), 1);
		const payer = await prisma.user.create({ data: { email: 'bonus-payment@billing-test.invalid' } });
		const { handlePaymentNotice } = require('../src/lib/billingPayment.ts');
		const notice = { idAccount: `bonus-acct-${payer.id}`, idLogicliftUser: payer.id, idRate: '9001', accountStatus: '5', accountSum: '100.00', currency: 'RUB' };
		await handlePaymentNotice(notice, 100);
		await handlePaymentNotice(notice, 100);
		assert.equal(await count(payer.id), 1);
		assert.equal((await prisma.accountBudget.findUniqueOrThrow({ where: { userId: payer.id } })).balanceMicros, 1_000_000);
	});

	await check('bonus splits only DeepSeek charges and protects the main balance, including after disabling', async () => {
		const { id } = await prisma.user.findUniqueOrThrow({ where: { email: 'bonus-active@billing-test.invalid' } });
		const where = { userId_kind: { userId: id, kind: BONUS_KIND } };
		const wallet = () => prisma.budgetWallet.findUniqueOrThrow({ where });
		const budget = () => prisma.accountBudget.findUniqueOrThrow({ where: { userId: id } });
		const reserve = (amount, requestId) => reserveBudget(id, PAID_DEEPSEEK_MODEL, 'openrouter', amount, 0.1, 0.6, { markupPercent: 5, requestId });
		const usage = (cost) => ({ prompt_tokens: 10, completion_tokens: 2, cost });
		const other = await reserveBudget(id, 'claude', 'bedrock', 100_000, 3, 15);
		assert.equal(other.walletMicros, 0);
		await settleBudget(other.id, null, true);
		const splitRequest = randomUUID();
		const split = await reserve(6_000_000, splitRequest);
		assert.equal(split.walletMicros, 5_000_000);
		assert.equal((await budget()).fiveHourUsedMicros, 1_000_000);
		assert.equal((await budget()).fiveHourRequests, 1);
		assert.equal(await prisma.budgetEntry.count({ where: { key: { startsWith: `reserve:${split.id}` } } }), 2);
		await settleBudget(split.id, usage(4));
		assert.equal((await wallet()).balanceMicros, 10_800_000);
		assert.equal((await budget()).balanceMicros, 20_000_000);
		assert.deepEqual(await prisma.usageLog.findUniqueOrThrow({ where: { requestId: splitRequest },
			select: { walletMicros: true, costMicros: true, providerCostMicros: true } }),
			{ walletMicros: 4_200_000, costMicros: 4_200_000, providerCostMicros: 4_000_000 });
		assert.equal((await deepSeekBonusReport()).spentMicros, 4_200_000);
		await prisma.accountBudget.update({ where: { userId: id }, data: { validUntil: new Date(Date.now() - 1000) } });
		await assert.rejects(reserve(1_000_000), error => error.code === 'access_expired');
		const only = await reserve(600_000);
		delete process.env.DEEPSEEK_BONUS_ENABLED;
		await settleBudget(only.id, usage(1));
		assert.equal((await budget()).balanceMicros, 20_000_000);
		assert.equal((await wallet()).balanceMicros, 10_200_000);
		assert.equal((await prisma.budgetReservation.findUniqueOrThrow({ where: { id: only.id } })).costMicros, 600_000);
		await assert.rejects(reserve(100_000), error => error.code === 'access_expired');
		process.env.DEEPSEEK_BONUS_ENABLED = 'true';
		const disputed = await reserve(100_000);
		await prisma.budgetWallet.update({ where, data: { expiresAt: new Date(Date.now() - 1000) } });
		await settleBudget(disputed.id, null, true);
		assert.equal((await wallet()).balanceMicros, 10_100_000);
		assert.equal((await budget()).balanceMicros, 20_000_000);
		delete process.env.DEEPSEEK_BONUS_ENABLED;
	});

	await check('late wallet refunds respect window boundaries and concurrent reserves respect limits', async () => {
		const { id } = await prisma.user.findUniqueOrThrow({ where: { email: 'bonus-manual@billing-test.invalid' } });
		const where = { userId_kind: { userId: id, kind: BONUS_KIND } };
		const wallet = () => prisma.budgetWallet.findUniqueOrThrow({ where });
		const reserve = amount => reserveBudget(id, PAID_DEEPSEEK_MODEL, 'openrouter', amount, 0.1, 0.6);
		const now = Date.now();
		process.env.DEEPSEEK_BONUS_ENABLED = 'true';
		mock.timers.enable({ apis: ['Date'], now });
		try {
			await prisma.budgetWallet.update({ where, data: { fiveHourStartedAt: new Date(now - FIVE_HOURS_MS + 1000) } });
			const old = await reserve(500_000);
			mock.timers.setTime(now + 2000);
			const current = await reserve(700_000);
			delete process.env.DEEPSEEK_BONUS_ENABLED;
			await settleBudget(old.id, null, true);
			assert.equal((await wallet()).fiveHourUsedMicros, 700_000);
			assert.equal((await wallet()).weeklyUsedMicros, 700_000);
			assert.equal((await wallet()).balanceMicros, 14_300_000);
			await settleBudget(current.id, null, true);
			assert.equal((await wallet()).balanceMicros, 15_000_000);
			process.env.DEEPSEEK_BONUS_ENABLED = 'true';
			const results = await Promise.allSettled([reserve(4_500_000), reserve(4_500_000)]);
			const accepted = results.filter(result => result.status === 'fulfilled');
			assert.equal(accepted.length, 1);
			assert.equal((await wallet()).fiveHourUsedMicros, 4_500_000);
			assert.equal((await wallet()).balanceMicros, 10_500_000);
			await prisma.accountBudget.update({ where: { userId: id }, data: { fiveHourRequestLimit: 1 } });
			await assert.rejects(reserve(100_000), error => error.code === 'five_hour_limit');
			await settleBudget(accepted[0].value.id, null, true);
		} finally {
			mock.timers.reset();
			delete process.env.DEEPSEEK_BONUS_ENABLED;
		}
	});

	await check('DeepSeek records interruption diagnostics and settles paid and trial streams with the correct key', async () => {
		const { id } = await prisma.user.findUniqueOrThrow({ where: { email: 'bonus-payment@billing-test.invalid' } });
		const trialUser = await prisma.user.create({ data: { email: 'trial-stream@billing-test.invalid' } });
		process.env.OPENROUTER_PAID_API_KEY = 'mock-paid-key';
		process.env.OPENROUTER_TRIAL_API_KEY = 'mock-trial-key';
		process.env.DEEPSEEK_TRIAL_EMAILS = trialUser.email;
		await prisma.billingMarkup.update({ where: { id: 'global' }, data: { percent: 5 } });
		const originalLoad = Module._load;
		const originalFetch = global.fetch;
		const originalError = console.error;
		const originalWarn = console.warn;
		const tasks = [];
		const errors = [];
		const warnings = [];
		const lookups = [];
		let mode = 'paid';
		const file = require.resolve('../src/app/api/chat/completions/route.ts');
		delete require.cache[file];
		Module._load = function (name, parent, ...rest) {
			if (name === 'next/server') { return { ...originalLoad.call(this, name, parent, ...rest), after: task => tasks.push(task) }; }
			if (name === '@/lib/llm/openrouter') {
				return { completeWithOpenRouter: async (body, key) => {
					assert.equal(key, mode === 'trial' ? 'mock-trial-key' : 'mock-paid-key');
					if (mode !== 'trial') { assert.deepEqual(body.provider.max_price, { prompt: 0.1, completion: 0.6, request: 0 }); }
					const upstream = {
						id: mode === 'missing-id' ? undefined : `gen-${mode}`,
						provider: 'stream-host',
						choices: mode === 'normal' ? [{ finish_reason: 'length' }] : mode === 'paid' ? [{ finish_reason: 'error' }] : [],
						error: mode === 'paid' ? { code: 502, message: 'provider disconnected' } : undefined,
						usage: mode === 'normal' ? { prompt_tokens: 100, completion_tokens: 6, cost: 0.002 } : undefined,
					};
					let sent = false;
					return new Response(new ReadableStream({
						pull(controller) {
							if (sent) {
								if (mode === 'paid') { controller.error(new Error('interrupted')); }
								else { controller.close(); }
								return;
							}
							sent = true;
							controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(upstream)}\n\n${mode === 'normal' ? 'data: [DONE]\n\n' : ''}`));
						},
					}));
				} };
			}
			return originalLoad.call(this, name, parent, ...rest);
		};
		let chat;
		try { chat = require(file).POST; } finally { Module._load = originalLoad; }
		global.fetch = async (url, init) => {
			const target = new URL(String(url));
			if (target.origin !== 'https://openrouter.ai' || target.pathname !== '/api/v1/generation') { return originalFetch(url, init); }
			const generation = target.searchParams.get('id');
			lookups.push([generation, init.headers.Authorization]);
			if (generation === 'gen-lookup-failed') { return new Response(null, { status: 401 }); }
			return Response.json({ data: { total_cost: 0.002, native_tokens_prompt: 100, native_tokens_completion: 6, native_tokens_cached: 50, provider_name: 'mock' } });
		};
		console.error = (message, ...rest) => message === 'OpenRouter stream interrupted' ? errors.push(JSON.parse(rest[0])) : originalError(message, ...rest);
		console.warn = (message, ...rest) => message === 'OpenRouter output limit reached' ? warnings.push(JSON.parse(rest[0])) : originalWarn(message, ...rest);
		const send = async (name, userId = id, model = PAID_DEEPSEEK_MODEL) => {
			mode = name;
			const token = await encryptJWT({ userId });
			const response = await chat(new NextRequest('http://localhost/api/chat/completions', {
				method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Arni-Chat-Id': name },
				body: JSON.stringify({ model, messages: [{ role: 'user', content: 'do-not-log-this-message' }], stream: true }),
			}));
			assert.equal(response.status, 200);
			if (name === 'paid') { await assert.rejects(response.text()); }
			else { await response.text(); }
		};
		const flush = () => Promise.all(tasks.splice(0).map(task => task()));
		const usageRow = (chatId, userId = id) => prisma.usageLog.findFirstOrThrow({ where: { userId, chatId } });
		try {
			await send('paid');
			assert.equal(lookups.length, 0);
			assert.equal((await prisma.budgetReservation.findFirstOrThrow({ where: { userId: id } })).status, 'pending');
			await flush();
			const log = await usageRow('paid');
			assert.deepEqual([log.costMicros, log.providerCostMicros, log.accounting, log.costBasis, log.cacheReadTokens, log.walletMicros],
				[2100, 2000, 'reported', 'provider_lookup', 50, 0]);
			assert.deepEqual([log.generationId, log.region, log.finishReason, log.streamError],
				['gen-paid', 'mock', 'error', '502: provider disconnected']);
			assert.deepEqual(errors[0], { requestId: log.requestId, model: PAID_DEEPSEEK_MODEL, host: 'stream-host',
				generationId: 'gen-paid', finishReason: 'error', streamError: '502: provider disconnected' });
			for (const fallback of ['missing-id', 'lookup-failed']) {
				await send(fallback);
				await flush();
				const estimate = await usageRow(fallback);
				const reservation = await prisma.budgetReservation.findUniqueOrThrow({ where: { requestId: estimate.requestId } });
				assert.deepEqual([estimate.accounting, estimate.costBasis, estimate.costMicros, estimate.streamError, estimate.region],
					['estimated', 'reservation', reservation.reservedMicros, 'missing_done', 'stream-host']);
			}
			await send('normal');
			await flush();
			const normal = await usageRow('normal');
			assert.deepEqual([normal.costMicros, normal.costBasis, normal.finishReason, normal.streamError], [2100, 'provider', 'length', null]);
			assert.equal(warnings.length, 1);
			assert.equal(warnings[0].requestId, normal.requestId);
			await send('trial', trialUser.id, TRIAL_PICKER_ID);
			await flush();
			const trial = await usageRow('trial', trialUser.id);
			assert.deepEqual([trial.costMicros, trial.accounting, trial.costBasis, trial.region, trial.streamError],
				[2000, 'reported', 'provider_lookup', 'mock', 'missing_done']);
			assert.equal(await prisma.budgetReservation.count({ where: { userId: trialUser.id } }), 0);
			assert.deepEqual(lookups, [['gen-paid', 'Bearer mock-paid-key'], ['gen-lookup-failed', 'Bearer mock-paid-key'], ['gen-trial', 'Bearer mock-trial-key']]);
			assert.equal(errors.length, 4);
			assert.doesNotMatch(JSON.stringify(errors), /do-not-log-this-message/);
		} finally {
			global.fetch = originalFetch;
			console.error = originalError;
			console.warn = originalWarn;
			delete process.env.OPENROUTER_PAID_API_KEY;
			delete process.env.OPENROUTER_TRIAL_API_KEY;
			delete process.env.DEEPSEEK_TRIAL_EMAILS;
		}
	});
	console.log(`${passed} billing checks passed on disposable PostgreSQL.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
