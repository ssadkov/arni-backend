// Real disposable PostgreSQL plus mocked AWS: no billed model invocations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
let routerCalls = 0, routerBody, routerMode = 'success', geminiMode = 'ok';
const geminiCalls = [];
global.fetch = async (url, options) => {
	if (String(url).includes('generativelanguage.googleapis.com')) {
		const sent = JSON.parse(options.body); geminiCalls.push(sent);
		if (geminiMode === 'down') { return new Response('unavailable', { status: 503 }); }
		if (geminiMode === 'first-limited' && sent.model === 'gemini-3.5-flash-lite') { return new Response('quota', { status: 429 }); }
		return Response.json({ choices: [{ message: { role: 'assistant', content: 'from gemini' } }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
	}
	if (String(url).includes('/chat/completions')) {
		routerCalls++; routerBody = JSON.parse(options.body);
		if (routerMode === 'daily-cap' && routerBody.model.endsWith(':free')) { return Response.json({ error: { message: 'Rate limit exceeded: free-models-per-day-high-balance. ', code: 429 } }, { status: 429 }); }
		if (routerMode === 'limited' && routerBody.model === 'test/vision:free') { return Response.json({ error: 'shared pool busy' }, { status: 429 }); }
		return Response.json({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, cost: routerBody.model.endsWith(':free') ? 0 : 0.00005 } });
	}
	if (String(url).endsWith('/endpoints')) { return Response.json({ data: { endpoints: [{ provider_name: 'Test', status: 0, uptime_last_30m: 100 }] } }); }
	return Response.json({ data: require('./fixtures/router-models.cjs') });
};
const db = process.env.ARNI_TEST_DATABASE_URL;
if (!db || !/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/arni_budget_test(?:\?|$)/.test(db)) { throw new Error('Disposable localhost database required'); }
process.env.PRISMA_DATABASE_URL = db;
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(__dirname, '../src', name.slice(2)) : name, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const prisma = require('../src/lib/prisma.ts').default;
const runtime = require('@aws-sdk/client-bedrock-runtime');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACLSURBVHhe7dAxAQAgEIDAD2slY34G3akAwy2MzLn7zIbBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYfCkwUrO2iye6AAAAAElFTkSuQmCC';
const imagePart = { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } };
let invocations = 0, countCalls = 0, mode = 'success', captured;
runtime.BedrockRuntimeClient.prototype.send = async function (command) {
	captured = command.input;
	if (command instanceof runtime.ConverseCommand) { return { output: { message: { role: 'assistant', content: [{ text: 'Selected model response' }] } }, usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end_turn' }; }
	if (command instanceof runtime.CountTokensCommand) { countCalls++; if (mode === 'count-failed') { throw new Error('Unsupported'); } return { inputTokens: 2000 }; }
	invocations++;
	if (mode === 'rejected') { throw Object.assign(new Error('Denied'), { $metadata: { httpStatusCode: 403 } }); }
	if (mode === 'timeout') { throw new Error('Unknown outcome'); }
	if (mode === 'filtered') { return { body: Buffer.from(JSON.stringify({ images: [], finish_reasons: ['CONTENT_FILTERED'] })) }; }
	return { body: Buffer.from(JSON.stringify({ images: [png], seeds: [42], finish_reasons: [null] })) };
};
const { managedBody, budgetPrice } = require('../src/lib/budgetPricing.ts');
const { toConverse } = require('../src/lib/llm/bedrock.ts');
const { generateImage, IMAGE_PRICE_MICROS, IMAGE_MODEL, imageCatalogPublic } = require('../src/lib/imageGeneration.ts');
const { IMAGE_MODELS } = require('../src/lib/imageModels.ts');
const { fitImagePng } = require('../src/lib/imagePng.ts');
const { reserveBudget, settleBudget } = require('../src/lib/budget.ts');
const TEXT_IMAGE_MODEL = IMAGE_MODELS.find(row => row.purpose === 'text').id;
const TEXT_IMAGE_PRICE = IMAGE_MODELS.find(row => row.purpose === 'text').costMicros;
let userId, passed = 0;
const check = async (name, run) => { await run(); console.log(`PASS ${name}`); passed++; };
async function main() {
	// Prisma loads the developer's .env, which holds a real Gemini key; only the new check enables a mock one.
	delete process.env.GEMINI_API_KEY;
	process.env.OPENROUTER_API_KEY = 'mock-only';
	process.env.AWS_BEARER_TOKEN_BEDROCK = 'mock-only';
	process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES = 'mock-images-only';
	const user = await prisma.user.create({ data: { email: `media-${crypto.randomUUID()}@billing-test.invalid` } }); userId = user.id;
	await prisma.accountBudget.create({ data: { userId, balanceMicros: 2_000_000, validUntil: new Date(Date.now() + 86400_000), fiveHourLimitMicros: 2_000_000, weeklyLimitMicros: 2_000_000, fiveHourRequestLimit: 100, weeklyRequestLimit: 100 } });
	await prisma.billingMarkup.upsert({ where: { id: 'global' }, create: { id: 'global', percent: 0 }, update: { percent: 0 } });
	const model = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
	await prisma.bedrockModel.upsert({ where: { id: model }, update: { inputPerMillion: 3, outputPerMillion: 15 }, create: { id: model, name: 'Screenshot test', inputPerMillion: 3, outputPerMillion: 15, enabled: true } });
	await check('managed catalog offers allowed models and selected model is invoked and billed; denied model is blocked', async () => {
		const second = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
		await prisma.bedrockModel.upsert({ where: { id: second }, update: { enabled: false, inputPerMillion: 1, outputPerMillion: 5 }, create: { id: second, name: 'Second model', enabled: false, inputPerMillion: 1, outputPerMillion: 5 } });
		await prisma.user.update({ where: { id: userId }, data: { llmProvider: 'BEDROCK', bedrockModelId: model } });
		await prisma.userModelAccess.create({ data: { userId, modelId: second, enabled: true } });
		const { NextRequest } = require('next/server');
		const jwt = await require('../src/lib/jwt.ts').encryptJWT({ userId });
		const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
		const list = await require('../src/app/api/models/route.ts').GET(new NextRequest('http://localhost/api/models', { headers }));
		const catalog = await list.json(); assert.equal(catalog.arni_managed, true);
		assert.ok(catalog.data.some(row => row.id === second)); assert.equal(catalog.data.find(row => row.id === model).arni_default, false, 'a paid model is never the default (6ee6f06)');
		const post = require('../src/app/api/chat/completions/route.ts').POST;
		const request = selected => new NextRequest('http://localhost/api/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: selected, messages: [{ role: 'user', content: 'Test selection' }], max_tokens: 50 }) });
		const result = await post(request(second)); assert.equal(result.status, 200); await result.json();
		assert.equal(captured.modelId, second);
		const log = await prisma.usageLog.findFirstOrThrow({ where: { userId, model: second } }); assert.equal(log.requestedModel, second); assert.equal(log.inputPerMillion, 1); assert.equal(log.costMicros, 35);
		const usageEndpoint = require('../src/app/api/account/usage/route.ts').GET;
		const usageResponse = await usageEndpoint(new NextRequest('http://localhost/api/account/usage', { headers }));
		const ledger = await usageResponse.json();
		assert.deepEqual([usageResponse.status, ledger.totalMicros, ledger.requestCount, ledger.requests[0].model], [200, 35, 1, second]);
		assert.equal((await usageEndpoint(new NextRequest('http://localhost/api/account/usage'))).status, 401);
		const isolated = await usageEndpoint(new NextRequest('http://localhost/api/account/usage?chatId=another-users-chat', { headers }));
		assert.equal((await isolated.json()).requestCount, 0);
		await prisma.userModelAccess.update({ where: { userId_modelId: { userId, modelId: second } }, data: { enabled: false } });
		assert.equal((await post(request(second))).status, 403);
		assert.equal((await post(request('us.unknown-model'))).status, 403);
	});
	await check('screenshots survive managed sanitization and Converse user/tool conversion', async () => {
		const body = managedBody({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Match this landing' }, imagePart] }, { role: 'assistant', content: null, tool_calls: [{ id: 'shot', function: { name: 'screenshot', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'shot', content: [imagePart] }], max_tokens: 100 }, true);
		const converted = toConverse(body);
		assert.deepEqual(Buffer.from(converted.messages[0].content[1].image.source.bytes), Buffer.from(png, 'base64'));
		assert.equal(converted.messages[2].content[0].toolResult.content[0].image.format, 'png');
		const price = await budgetPrice(body, 'bedrock', model);
		assert.equal(price.reservedMicros, 9000); assert.equal(countCalls, 1);
		assert.equal(captured.modelId, model.replace('us.', ''));
		mode = 'count-failed'; await assert.rejects(budgetPrice(body, 'bedrock', model), error => error.code === 'vision_count_unavailable'); mode = 'success';
	});
	await check('one account selects free vision and paid models without provider changes; expired budget cannot block free', async () => {
		const { NextRequest } = require('next/server');
		const jwt = await require('../src/lib/jwt.ts').encryptJWT({ userId });
		const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
		const list = await require('../src/app/api/models/route.ts').GET(new NextRequest('http://localhost/api/models', { headers }));
		const models = (await list.json()).data;
		assert.ok(models.some(row => row.id === model));
		assert.ok(models.find(row => row.id === 'test/vision:free').architecture.input_modalities.includes('image'));
		const post = require('../src/app/api/chat/completions/route.ts').POST;
		const request = selected => new NextRequest('http://localhost/api/chat/completions', { method: 'POST', headers: { ...headers, 'X-Arni-Chat-Id': 'mixed-test' }, body: JSON.stringify({ model: selected, messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect frame' }, imagePart] }], max_tokens: 50 }) });
		await prisma.accountBudget.update({ where: { userId }, data: { enabled: false, balanceMicros: 0, validUntil: new Date(0) } });
		const free = await post(request('test/vision:free')); assert.equal(free.status, 200); await free.json();
		assert.deepEqual(routerBody.provider.max_price, { prompt: 0, completion: 0, request: 0 });
		assert.equal(routerBody.messages[0].content[1].image_url.url, imagePart.image_url.url);
		const log = await prisma.usageLog.findFirstOrThrow({ where: { userId, chatId: 'mixed-test' } });
		assert.deepEqual([log.model, log.imageCount, log.costMicros, log.accounting], ['test/vision:free', 1, 0, 'reported']);
		assert.equal((await prisma.accountBudget.findUniqueOrThrow({ where: { userId } })).balanceMicros, 0);
		assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).llmProvider, 'BEDROCK');
		const before = routerCalls;
		assert.equal((await post(request('test/text:free'))).status, 400);
		assert.equal((await post(request('fake/vision:free'))).status, 400);
		assert.equal((await post(request('test/paid'))).status, 403);
		assert.equal(routerCalls, before);
		await prisma.accountBudget.update({ where: { userId }, data: { enabled: true, balanceMicros: 2_000_000, validUntil: new Date(Date.now() + 86400_000) } });
		const paid = await post(request('test/paid')); assert.equal(paid.status, 403); assert.equal((await paid.json()).error.code, 'paid_openrouter_disabled'); assert.equal(routerCalls, before, 'paid OpenRouter never reaches OpenRouter');
		assert.equal((await prisma.accountBudget.findUniqueOrThrow({ where: { userId } })).balanceMicros, 2_000_000);
		routerMode = 'limited';
		const beforeSteps = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).freeStepsTotal;
		const fallback = await post(request('test/vision:free')); assert.equal(fallback.status, 200); await fallback.json();
		assert.equal(routerBody.model, 'test:free');
		assert.equal(routerBody.messages[0].content[1].image_url.url, imagePart.image_url.url);
		assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).freeStepsTotal, beforeSteps + 1);
		assert.equal((await prisma.accountBudget.findUniqueOrThrow({ where: { userId } })).balanceMicros, 2_000_000);
		routerMode = 'success';
		const publicList = await require('../src/app/api/models/route.ts').GET(new NextRequest('http://localhost/api/models'));
		assert.ok((await publicList.json()).data.every(row => row.id.endsWith(':free')));
	});
	await check('invalid screenshots are rejected and long histories keep only recent screenshots', async () => {
		for (const part of [{ type: 'image_url', image_url: { url: 'http://169.254.169.254/' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }]) {
			assert.throws(() => managedBody({ messages: [{ role: 'user', content: [part] }] }, true));
		}
		assert.throws(() => managedBody({ messages: [{ role: 'system', content: [imagePart] }] }, true));
		const { KEPT_SCREENSHOTS } = require('../src/lib/llm/screenshotHistory.ts');
		const longHistory = managedBody({ messages: [{ role: 'user', content: Array(21).fill(imagePart) }] }, true);
		assert.equal(longHistory.messages[0].content.filter(part => part.type === 'image_url').length, KEPT_SCREENSHOTS);
		assert.throws(() => managedBody({ messages: [{ role: 'user', content: [imagePart] }] }));
		const large = Buffer.from(png, 'base64'); large.writeUInt32BE(9000, 16);
		assert.throws(() => managedBody({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${large.toString('base64')}` } }] }] }, true));
	});
	await check('rate snapshot and requested/served model persist after catalog changes', async () => {
		const id = crypto.randomUUID(); const reservation = await reserveBudget(userId, model, 'bedrock', 10000, 3, 15, { requestId: id, requestedModel: 'picker-label', imageCount: 1, region: 'us-east-1' });
		await prisma.bedrockModel.update({ where: { id: model }, data: { inputPerMillion: 99, outputPerMillion: 99 } });
		await settleBudget(reservation.id, { prompt_tokens: 1000, completion_tokens: 100 });
		const log = await prisma.usageLog.findUniqueOrThrow({ where: { requestId: id } });
		assert.deepEqual([log.costMicros, log.inputPerMillion, log.outputPerMillion, log.requestedModel, log.model, log.imageCount], [4500, 3, 15, 'picker-label', model, 1]);
	});
	await check('disabled feature never invokes AWS or reserves money', async () => {
		delete process.env.ARNI_IMAGE_GENERATION_ENABLED;
		await assert.rejects(generateImage(userId, crypto.randomUUID(), { prompt: 'A landing illustration' }), error => error.code === 'image_generation_disabled');
		assert.equal(invocations, 0);
	});
	await check('free fallback records the served model while preserving the requested one', async () => {
		const id = crypto.randomUUID();
		const reservation = await reserveBudget(userId, 'first:free', 'openrouter', 0, 0, 0, { requestId: id, requestedModel: 'first:free' });
		await settleBudget(reservation.id, { prompt_tokens: 10, completion_tokens: 5 }, false, 'healthy:free');
		const log = await prisma.usageLog.findUniqueOrThrow({ where: { requestId: id } });
		assert.deepEqual([log.model, log.requestedModel, log.costMicros], ['healthy:free', 'first:free', 0]);
	});
	await check('Gemini is the free reserve when OpenRouter refuses :free; paid money and other routes are untouched', async () => {
		const { NextRequest } = require('next/server');
		const jwt = await require('../src/lib/jwt.ts').encryptJWT({ userId });
		const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
		const post = require('../src/app/api/chat/completions/route.ts').POST;
		const request = (selected, extra = {}) => new NextRequest('http://localhost/api/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: selected, messages: [{ role: 'user', content: 'Reserve test' }], max_tokens: 50, provider: { max_price: 0 }, reasoning: { enabled: false }, ...extra }) });
		const snapshot = async () => ({ steps: (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).freeStepsTotal, balance: (await prisma.accountBudget.findUniqueOrThrow({ where: { userId } })).balanceMicros });
		process.env.GEMINI_API_KEY = 'mock-only';
		routerMode = 'daily-cap'; geminiMode = 'ok';

		// Account-wide daily cap: no pointless hop to another :free model, Gemini answers.
		let before = await snapshot(); const calls = routerCalls; geminiCalls.length = 0;
		let result = await post(request('test/text:free'));
		assert.equal(result.status, 200);
		assert.equal((await result.json()).choices[0].message.content, 'from gemini');
		assert.deepEqual([result.headers.get('X-Arni-Served-Model'), Boolean(result.headers.get('X-Arni-Routed-From')), routerCalls - calls, geminiCalls.length], ['gemini-3.5-flash-lite', true, 1, 1]);
		assert.deepEqual(Object.keys(geminiCalls[0]).sort(), ['max_tokens', 'messages', 'model', 'stream', 'stream_options']);
		let after = await snapshot();
		assert.deepEqual([after.steps - before.steps, after.balance - before.balance], [1, 0]);
		const log = await prisma.usageLog.findFirstOrThrow({ where: { userId, model: 'gemini-3.5-flash-lite' }, orderBy: { createdAt: 'desc' } });
		assert.deepEqual([log.source, log.costMicros, log.accounting, log.requestedModel, log.promptTokens], ['gemini', 0, 'reported', 'test/text:free', 50]);
		const attempts = await prisma.modelRequest.findMany({ where: { userId, requestedModel: 'test/text:free', source: 'openrouter', statusCode: 429 } });
		assert.ok(attempts.length >= 1, 'the refused OpenRouter attempt is still recorded');

		// First Gemini model out of quota: the second one answers.
		geminiMode = 'first-limited'; geminiCalls.length = 0;
		result = await post(request('test/vision:free'));
		assert.equal(result.status, 200); await result.json();
		assert.deepEqual([result.headers.get('X-Arni-Served-Model'), geminiCalls.map(row => row.model)], ['gemini-3.1-flash-lite', ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']]);

		// Gemini down too: the user gets OpenRouter's original refusal and the free step is returned.
		geminiMode = 'down'; before = await snapshot();
		result = await post(request('test:free'));
		assert.equal(result.status, 429);
		assert.match(await result.text(), /free-models-per-day/);
		after = await snapshot();
		assert.deepEqual([after.steps - before.steps, after.balance - before.balance], [0, 0]);

		// No key: behaviour is exactly the old one and Google is never called.
		delete process.env.GEMINI_API_KEY; geminiMode = 'ok'; geminiCalls.length = 0;
		result = await post(request('test/text:free'));
		assert.deepEqual([result.status, geminiCalls.length], [429, 0]);

		// Paid models never fall back to Gemini.
		process.env.GEMINI_API_KEY = 'mock-only'; geminiCalls.length = 0;
		assert.equal((await post(request('test/paid'))).status, 403);
		assert.equal(geminiCalls.length, 0);
		delete process.env.GEMINI_API_KEY; routerMode = 'success';
	});
	await check('Gemini picker models are listed and callable only for named accounts, and never rerouted', async () => {
		const { NextRequest } = require('next/server');
		const email = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).email;
		const jwt = await require('../src/lib/jwt.ts').encryptJWT({ userId });
		const headers = { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' };
		const catalog = async () => (await (await require('../src/app/api/models/route.ts').GET(new NextRequest('http://localhost/api/models', { headers }))).json()).data;
		const post = require('../src/app/api/chat/completions/route.ts').POST;
		const request = selected => new NextRequest('http://localhost/api/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: selected, messages: [{ role: 'user', content: 'Picker test' }], max_tokens: 50 }) });
		const snapshot = async () => ({ steps: (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).freeStepsTotal, balance: (await prisma.accountBudget.findUniqueOrThrow({ where: { userId } })).balanceMicros });
		const first = 'gemini/gemini-3.5-flash-lite:free'; const second = 'gemini/gemini-3.1-flash-lite:free';
		routerMode = 'success'; geminiMode = 'ok'; geminiCalls.length = 0;

		// Not named: invisible and uncallable, even with a key configured.
		process.env.GEMINI_API_KEY = 'mock-only'; process.env.GEMINI_PICKER_EMAILS = 'someone-else@example.com';
		assert.ok(!(await catalog()).some(row => row.id.startsWith('gemini/')));
		assert.equal((await post(request(first))).status, 400);
		assert.equal(geminiCalls.length, 0);

		// Named (case-insensitive): both models are listed like free models, never as the default.
		process.env.GEMINI_PICKER_EMAILS = ` ${email.toUpperCase()} , other@example.com`;
		const listed = (await catalog()).filter(row => row.id.startsWith('gemini/'));
		assert.deepEqual(listed.map(row => [row.id, row.arni_free, row.arni_default, row.pricing.prompt]), [[first, true, false, '0'], [second, true, false, '0']]);
		let before = await snapshot(); const calls = routerCalls;
		let result = await post(request(second));
		assert.equal(result.status, 200); assert.equal((await result.json()).choices[0].message.content, 'from gemini');
		assert.deepEqual([geminiCalls.map(row => row.model), routerCalls - calls], [['gemini-3.1-flash-lite'], 0]);
		let after = await snapshot();
		assert.deepEqual([after.steps - before.steps, after.balance - before.balance], [1, 0]);
		const log = await prisma.usageLog.findFirstOrThrow({ where: { userId, requestedModel: second }, orderBy: { createdAt: 'desc' } });
		assert.deepEqual([log.source, log.model, log.costMicros], ['gemini', 'gemini-3.1-flash-lite', 0]);

		// The picked model is the only one tried; its failure is reported, not rerouted to OpenRouter or the other Gemini.
		geminiMode = 'first-limited'; geminiCalls.length = 0; before = await snapshot();
		result = await post(request(first));
		assert.equal(result.status, 503); assert.equal((await result.json()).error.code, 'gemini_unavailable');
		assert.deepEqual([geminiCalls.map(row => row.model), routerCalls - calls], [['gemini-3.5-flash-lite'], 0]);
		after = await snapshot();
		assert.deepEqual([after.steps - before.steps, after.balance - before.balance], [0, 0]);

		// A key-less deployment hides them again.
		delete process.env.GEMINI_API_KEY; geminiCalls.length = 0;
		assert.ok(!(await catalog()).some(row => row.id.startsWith('gemini/')));
		assert.equal((await post(request(first))).status, 400);
		delete process.env.GEMINI_PICKER_EMAILS; geminiMode = 'ok';
	});
	process.env.ARNI_IMAGE_GENERATION_ENABLED = 'true';
	await check('image catalog lists simple and text models with default Core price', async () => {
		const catalog = imageCatalogPublic();
		assert.equal(catalog.default_model, IMAGE_MODEL);
		assert.equal(catalog.model, IMAGE_MODEL);
		assert.equal(catalog.costMicros, IMAGE_PRICE_MICROS);
		assert.deepEqual(catalog.models.map(row => row.id), IMAGE_MODELS.map(row => row.id));
		assert.equal(catalog.models.find(row => row.purpose === 'text').costMicros, TEXT_IMAGE_PRICE);
		assert.equal(catalog.models[0].modelName, 'Stable Image Core');
		assert.equal(catalog.models[1].modelName, 'Stable Diffusion 3.5 Large');
		await assert.rejects(generateImage(userId, crypto.randomUUID().replace(/-/g, '').slice(0, 32), { prompt: 'рыжий кот на диване' }), error => error.code === 'image_prompt_language');
		assert.equal(invocations, 0);
		process.env.JWT_SECRET = 'disposable-media-test-only';
		const jwt = await require('../src/lib/jwt.ts').encryptJWT({ userId });
		const { NextRequest } = require('next/server');
		const headers = { Authorization: `Bearer ${jwt}` };
		const mediaGet = require('../src/app/api/images/generations/route.ts').GET;
		const media = await (await mediaGet(new NextRequest('http://localhost/api/images/generations', { headers }))).json();
		assert.equal(media.enabled, true);
		assert.equal(media.models.length, 2);
		const webGet = require('../src/app/api/web/images/config/route.ts').GET;
		const web = await (await webGet(new NextRequest('http://localhost/api/web/images/config', { headers }))).json();
		assert.equal(web.default_model, IMAGE_MODEL);
		assert.equal(web.models[1].id, TEXT_IMAGE_MODEL);
	});
	await check('concurrent image/replay uses one invocation and one charge, changed payload conflicts', async () => {
		const key = crypto.randomUUID(); const input = { prompt: 'A landing illustration' };
		const before = invocations;
		const responses = await Promise.allSettled([generateImage(userId, key, input), generateImage(userId, key, input)]);
		const first = responses.find(response => response.status === 'fulfilled').value;
		const again = await generateImage(userId, key, input);
		assert.equal(first.id, again.id); assert.equal(invocations, before + 1);
		assert.equal(again.costMicros, IMAGE_PRICE_MICROS);
		await assert.rejects(generateImage(userId, key, { prompt: 'Another image' }), error => error.code === 'idempotency_conflict');
		await assert.rejects(generateImage(userId, key, { prompt: input.prompt, model: TEXT_IMAGE_MODEL }), error => error.code === 'idempotency_conflict');
		const log = await prisma.usageLog.findUniqueOrThrow({ where: { requestId: first.id } });
		assert.deepEqual([log.model, log.operation, log.imageCount, log.unitPriceMicros, log.costMicros], [IMAGE_MODEL, 'image', 1, IMAGE_PRICE_MICROS, IMAGE_PRICE_MICROS]);
		const asset = await prisma.mediaGeneration.findUniqueOrThrow({ where: { id: first.id } }); assert.deepEqual(Buffer.from(asset.image), Buffer.from(png, 'base64'));
	});
	await check('text image model bills 0.08 to its chat and sends mode text-to-image', async () => {
		const before = invocations;
		const created = await generateImage(userId, crypto.randomUUID().replace(/-/g, '').slice(0, 32), {
			prompt: 'Logo with readable Arni Code text',
			model: TEXT_IMAGE_MODEL,
			aspect_ratio: '1:1',
		}, 'desktop-chat-1');
		assert.equal(created.model, TEXT_IMAGE_MODEL);
		assert.equal(created.costMicros, TEXT_IMAGE_PRICE);
		assert.equal(invocations, before + 1);
		assert.equal(captured.modelId, TEXT_IMAGE_MODEL);
		const body = JSON.parse(Buffer.from(captured.body).toString());
		assert.equal(body.mode, 'text-to-image');
		const log = await prisma.usageLog.findUniqueOrThrow({ where: { requestId: created.id } });
		assert.deepEqual([log.model, log.unitPriceMicros, log.costMicros, log.chatId], [TEXT_IMAGE_MODEL, TEXT_IMAGE_PRICE, TEXT_IMAGE_PRICE, 'desktop-chat-1']);
	});
	await check('oversized PNG is compressed under the product byte limit', async () => {
		const sharp = require('sharp');
		const { randomFillSync } = require('node:crypto');
		const width = 2200; const height = 2200;
		const raw = Buffer.alloc(width * height * 3);
		randomFillSync(raw);
		const big = await sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
		assert.ok(big.length > 3_000_000);
		const fitted = await fitImagePng(big);
		assert.ok(fitted.length <= 3_000_000);
		assert.ok(fitted.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
	});
	await check('confirmed 403 refunded; timeout/filter stays conservative and is never reinvoked by replay', async () => {
		for (const state of ['rejected', 'timeout', 'filtered']) {
			mode = state; const key = crypto.randomUUID(); const before = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
			await assert.rejects(generateImage(userId, key, { prompt: state })); const calls = invocations;
			await assert.rejects(generateImage(userId, key, { prompt: state })); assert.equal(invocations, calls);
			const after = await prisma.accountBudget.findUniqueOrThrow({ where: { userId } });
			assert.equal(before.balanceMicros - after.balanceMicros, state === 'rejected' ? 0 : IMAGE_PRICE_MICROS);
		}
		mode = 'success';
	});
	await check('image API enforces owner auth; CSV export requires admin and retains rates', async () => {
		process.env.JWT_SECRET = 'disposable-media-test-only';
		const jwt = await require('../src/lib/jwt.ts').encryptJWT({ userId });
		const assetGet = require('../src/app/api/images/[id]/route.ts').GET;
		const { NextRequest } = require('next/server');
		const row = await prisma.mediaGeneration.findFirstOrThrow({ where: { userId, status: 'succeeded' } });
		const request = auth => new NextRequest('http://localhost/api/images/test', { headers: auth ? { Authorization: `Bearer ${jwt}` } : {} });
		assert.equal((await assetGet(request(false), { params: Promise.resolve({ id: row.id }) })).status, 401);
		assert.equal((await assetGet(request(true), { params: Promise.resolve({ id: row.id }) })).status, 200);
		const other = await prisma.user.create({ data: { email: `other-${crypto.randomUUID()}@billing-test.invalid` } });
		const privateRow = await prisma.mediaGeneration.create({ data: { userId: other.id, model: IMAGE_MODEL, region: 'us-west-2', requestKey: crypto.randomUUID(), payloadHash: 'test', status: 'succeeded', image: Buffer.from(png, 'base64') } });
		assert.equal((await assetGet(request(true), { params: Promise.resolve({ id: privateRow.id }) })).status, 404);
		const csv = require('../src/app/api/admin/usage/export/route.ts').GET;
		process.env.ADMIN_PASS = 'local-test-only'; process.env.ADMIN_USER = 'billing-test';
		assert.equal((await csv(new NextRequest('http://localhost/api/admin/usage/export'))).status, 401);
		const exported = await csv(new NextRequest('http://localhost/api/admin/usage/export', { headers: { Authorization: `Basic ${Buffer.from('billing-test:local-test-only').toString('base64')}` } }));
		assert.equal(exported.status, 200); const text = await exported.text(); assert.match(text, /unitPriceMicros/); assert.match(text, /"40000"/);
		await prisma.user.delete({ where: { id: other.id } });
	});
	console.log(`${passed} media checks passed on disposable PostgreSQL.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (userId) { await prisma.user.delete({ where: { id: userId } }); } await prisma.$disconnect(); });
