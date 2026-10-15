// Runs against an explicitly supplied disposable local PostgreSQL database only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const db = process.env.ARNI_TEST_DATABASE_URL;
if (!db || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/arni_budget_test(?:\?|$)/.test(db)) {
	throw new Error('Set ARNI_TEST_DATABASE_URL to a disposable localhost arni_budget_test database.');
}
process.env.PRISMA_DATABASE_URL = db;
process.env.DATABASE_URL = db;
process.env.ADMIN_USER = 'billing-test';
process.env.ADMIN_PASS = 'local-test-only';

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
const { UsageParser, costMicros, currentWindow, FIVE_HOURS_MS } = require('../src/lib/budgetPolicy.ts');
const { usageStream } = require('../src/lib/usageStream.ts');
const { managedBody } = require('../src/lib/budgetPricing.ts');
const { POST: grant } = require('../src/app/api/admin/users/[id]/budget/route.ts');
const { POST: reconcile } = require('../src/app/api/admin/users/[id]/budget/reconcile/route.ts');
const { NextRequest } = require('next/server');
const { requireAdmin } = require('../src/lib/adminAuth.ts');

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const defaults = { grantUsd: 20, fiveHourUsd: 2, weeklyUsd: 5, fiveHourRequests: 150, weeklyRequests: 1000, days: 30, enabled: true, note: 'Internal test' };
function grantRequest(userId, payload, authenticated = true) {
	return grant(new NextRequest(`http://localhost/api/admin/users/${userId}/budget`, { method: 'POST',
		headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Basic ${Buffer.from('billing-test:local-test-only').toString('base64')}` } : {}) },
		body: JSON.stringify(payload) }), { params: Promise.resolve({ id: userId }) });
}

async function main() {
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
	await check('concurrent requests cannot overspend one balance', async () => {
		const results = await Promise.allSettled([reserveBudget(userId, 'test-model', 'bedrock', 500000, 3, 15), reserveBudget(userId, 'test-model', 'bedrock', 500000, 3, 15)]);
		assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
		assert.equal(results.find(result => result.status === 'rejected').reason.code, 'request_in_progress');
		const reservation = results.find(result => result.status === 'fulfilled').value;
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
	await check('missing usage keeps estimated reservation; rejected request refunds budget and step', async () => {
		const before = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		const estimate = await reserveBudget(userId, 'test', 'bedrock', 10000, 3, 15);
		await settleBudget(estimate.id, null);
		const rejected = await reserveBudget(userId, 'test', 'bedrock', 10000, 3, 15);
		await settleBudget(rejected.id, null, true);
		const after = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
		assert.deepEqual({ delta: before.balanceMicros - after.balanceMicros, steps: after.fiveHourRequests - before.fiveHourRequests,
			status: (await prisma.budgetReservation.findUniqueOrThrow({ where: { id: estimate.id } })).status }, { delta: 10000, steps: 1, status: 'estimated' });
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
	await check('extra billable request options stripped and multimodal requests rejected', async () => {
		const body = managedBody({ model: 'test', messages: [{ role: 'user', content: 'hello', cache_control: {} }], max_tokens: 50000, n: 100, plugins: [{}], provider: {} });
		assert.deepEqual({ max: body.max_tokens, n: body.n, plugins: body.plugins, cache: body.messages[0].cache_control }, { max: 4096, n: undefined, plugins: undefined, cache: undefined });
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
			if (name === '@/lib/openRouterStatus') { return { routeFreeModel: async model => ({ model }), rememberUnavailable: () => {} }; }
			if (name === '@/lib/llm/bedrock' || name === '@/lib/llm/openrouter') {
				const complete = async () => {
					calls++;
					if (mode === 'error') { return new Response('Upstream refused', { status: 400 }); }
					if (mode === 'uncertain') { return new Response('Upstream timeout', { status: 503 }); }
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
		const request = stream => new NextRequest('http://localhost/api/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'test:free', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], stream, max_tokens: 10 }) });
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
		mode = 'uncertain';
		assert.equal((await chat(request(false))).status, 503);
		const uncertain = await prisma.budgetReservation.findFirstOrThrow({ where: { userId, status: 'estimated', model: 'test-bedrock' } });
		assert.equal(uncertain.costMicros, uncertain.reservedMicros);
		await prisma.user.update({ where: { id: userId }, data: { llmProvider: 'OPENROUTER' } });
		mode = 'json';
		assert.equal((await chat(request(false))).status, 200);
		await prisma.accountBudget.update({ where: { userId }, data: { enabled: false } });
		const priorCalls = calls;
		assert.equal((await chat(request(false))).status, 403);
		assert.equal(calls, priorCalls);
	});
	await check('stale pending reservations can be closed conservatively; fresh ones cannot', async () => {
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
		assert.equal((await prisma.budgetReservation.findUniqueOrThrow({ where: { id: row.id } })).costMicros, 10000);
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
			if (name === '@/lib/openRouterStatus') { return { routeFreeModel: async model => ({ model }), rememberUnavailable: () => {} }; }
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
		assert.equal(response.headers.get('X-Free-Steps-Remaining'), '148');
		await response.text();
		mode = 'error';
		assert.equal((await chat(request(false))).status, 429);
		const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
		assert.deepEqual({ tokens: user.tokenBalance, daily: user.freeStepsToday, total: user.freeStepsTotal, budgets: await prisma.accountBudget.count({ where: { userId } }) }, { tokens: 0, daily: 2, total: 2, budgets: 0 });
		await prisma.user.update({ where: { id: userId }, data: { freeStepsToday: 150 } });
		const before = calls;
		assert.equal((await chat(request(false))).status, 429);
		assert.equal(calls, before);
	});
	console.log(`${passed} billing checks passed on disposable PostgreSQL.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
