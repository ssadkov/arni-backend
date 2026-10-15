// Real disposable PostgreSQL plus mocked AWS: no billed model invocations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
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
const { generateImage, IMAGE_PRICE_MICROS, IMAGE_MODEL } = require('../src/lib/imageGeneration.ts');
const { reserveBudget, settleBudget } = require('../src/lib/budget.ts');
let userId, passed = 0;
const check = async (name, run) => { await run(); console.log(`PASS ${name}`); passed++; };
async function main() {
	process.env.AWS_BEARER_TOKEN_BEDROCK = 'mock-only';
	process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES = 'mock-images-only';
	const user = await prisma.user.create({ data: { email: `media-${crypto.randomUUID()}@billing-test.invalid` } }); userId = user.id;
	await prisma.accountBudget.create({ data: { userId, balanceMicros: 2_000_000, validUntil: new Date(Date.now() + 86400_000), fiveHourLimitMicros: 2_000_000, weeklyLimitMicros: 2_000_000, fiveHourRequestLimit: 100, weeklyRequestLimit: 100 } });
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
		assert.ok(catalog.data.some(row => row.id === second)); assert.equal(catalog.data.find(row => row.id === model).arni_default, true);
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
	await check('remote, malformed, oversized, wrong-role screenshots rejected', async () => {
		for (const part of [{ type: 'image_url', image_url: { url: 'http://169.254.169.254/' } }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }]) {
			assert.throws(() => managedBody({ messages: [{ role: 'user', content: [part] }] }, true));
		}
		assert.throws(() => managedBody({ messages: [{ role: 'system', content: [imagePart] }] }, true));
		assert.throws(() => managedBody({ messages: [{ role: 'user', content: Array(21).fill(imagePart) }] }, true));
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
	process.env.ARNI_IMAGE_GENERATION_ENABLED = 'true';
	await check('concurrent image/replay uses one invocation and one charge, changed payload conflicts', async () => {
		const key = crypto.randomUUID(); const input = { prompt: 'A landing illustration' };
		const responses = await Promise.allSettled([generateImage(userId, key, input), generateImage(userId, key, input)]);
		const first = responses.find(response => response.status === 'fulfilled').value;
		const again = await generateImage(userId, key, input);
		assert.equal(first.id, again.id); assert.equal(invocations, 1);
		assert.equal(again.costMicros, IMAGE_PRICE_MICROS);
		await assert.rejects(generateImage(userId, key, { prompt: 'Another image' }), error => error.code === 'idempotency_conflict');
		const log = await prisma.usageLog.findUniqueOrThrow({ where: { requestId: first.id } });
		assert.deepEqual([log.model, log.operation, log.imageCount, log.unitPriceMicros, log.costMicros], [IMAGE_MODEL, 'image', 1, IMAGE_PRICE_MICROS, IMAGE_PRICE_MICROS]);
		const asset = await prisma.mediaGeneration.findUniqueOrThrow({ where: { id: first.id } }); assert.deepEqual(Buffer.from(asset.image), Buffer.from(png, 'base64'));
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
