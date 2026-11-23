const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name, parent, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(__dirname, '../src', name.slice(2)) : name, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
const { cachedRouterBody } = require('../src/lib/llm/openrouter.ts');
const { routerCacheMode, zeroPrice } = require('../src/lib/llm/openRouterCatalog.ts');
const { validUsage } = require('../src/lib/budgetPolicy.ts');
const { chooseRoutedModel } = require('../src/lib/openRouterStatus.ts');
const { retryEmptyStream } = require('../src/lib/llm/emptyStreamRetry.ts');
const original = { model: 'qwen/qwen3-coder-flash', messages: [{ role: 'system', content: 'stable '.repeat(5000) }, { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] }, { role: 'tool', tool_call_id: 'a', content: 'done' }] };
const cached = cachedRouterBody(original);
assert.equal(cached.messages[0].content[0].cache_control.type, 'ephemeral');
assert.equal(original.messages[0].content, 'stable '.repeat(5000));
assert.deepEqual(cached.messages.slice(1), original.messages.slice(1));
assert.equal(cachedRouterBody({ ...original, model: 'qwen/qwen3-vl-235b-a22b-instruct' }).messages, original.messages);
assert.equal(routerCacheMode('qwen/qwen3.5-flash-02-23'), undefined);
assert.equal(routerCacheMode('google/gemini-2.5-flash-lite'), 'automatic');
assert.equal(routerCacheMode('anthropic/claude-3-haiku'), undefined);
assert.equal(routerCacheMode('anthropic/claude-haiku-4.5'), 'explicit');
assert.equal(validUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 } }).prompt_tokens_details.cache_creation_input_tokens, 30);
assert.equal(zeroPrice({ id: 'fake/model:free', pricing: { prompt: '1', completion: '0' } }), false);
const routed = chooseRoutedModel('broken/vision:free', new Map([['broken/vision:free', 'red'], ['text:free', 'green'], ['vision:free', 'green']]), ['vision:free']);
assert.equal(routed.model, 'vision:free');
assert.equal(chooseRoutedModel('broken/vision:free', new Map([['broken/vision:free', 'red'], ['vision:free', 'unknown']]), ['vision:free']).model, 'vision:free');
console.log('PASS explicit cache markers, provider-specific capability, cache usage normalization, zero-price validation and vision-safe fallback');

(async () => {
	const { freeRequestBody } = require('../src/lib/llm/openRouterCatalog.ts');
	const catalog = [
		{ id: 'loops/model:free', supported_parameters: ['tools', 'reasoning'], reasoning: { mandatory: false } },
		{ id: 'always/thinks:free', supported_parameters: ['tools', 'reasoning'], reasoning: { mandatory: true } },
		{ id: 'plain/model:free', supported_parameters: ['tools'] },
	];
	global.fetch = async () => ({ ok: true, json: async () => ({ data: catalog }) });
	const body = { model: 'loops/model:free', messages: [] };
	assert.deepEqual((await freeRequestBody(body)).reasoning, { enabled: false });
	assert.equal(body.reasoning, undefined, 'the request object is not mutated');
	assert.equal('reasoning' in await freeRequestBody({ model: 'always/thinks:free', reasoning: { enabled: false } }), false);
	assert.equal('reasoning' in await freeRequestBody({ model: 'plain/model:free' }), false);
	const paid = { model: 'vendor/paid', reasoning: { effort: 'high' } };
	assert.equal(await freeRequestBody(paid), paid);
	console.log('PASS free models run without reasoning unless it is mandatory');

	const sse = (...events) => new Response(new ReadableStream({ start(controller) {
		for (const event of events) { controller.enqueue(new TextEncoder().encode(event)); }
		controller.close();
	} }), { status: 200 });
	const keepAlive = ': OPENROUTER PROCESSING\n\n';
	const role = 'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n';
	const answer = 'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
	let calls = 0;
	const again = async () => { calls++; return sse(role, answer); };
	const results = [];
	for (const first of [sse(keepAlive, role), sse(keepAlive, role, 'data: {"choices":[{"delta":{"reasoning":"hm"}}]}\n\n'), sse(role, answer), sse('data: {"choices":[{"delta":{"content":"H'), sse('data: {"choices":[{"delta":{"content":"Hi"}}]}')]) {
		const held = await retryEmptyStream(first, again);
		results.push([held.retried, await held.response.text()]);
	}
	assert.deepEqual({ calls, results }, { calls: 3, results: [
		[true, role + answer],
		[true, role + answer],
		[false, role + answer],
		[true, role + answer],
		[false, 'data: {"choices":[{"delta":{"content":"Hi"}}]}'],
	] });
	const failed = await retryEmptyStream(sse(keepAlive), async () => new Response('busy', { status: 503 }));
	assert.deepEqual([failed.retried, await failed.response.text()], [true, keepAlive]);
	console.log('PASS a stream that ends before its first answer event is requested once more');
})().catch(error => { console.error(error); process.exit(1); });
