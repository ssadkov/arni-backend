// Offline regression: no provider requests, credentials or database required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
	return resolve.call(this, name.startsWith('@/') ? path.join(__dirname, '../src', name.slice(2)) : name, parent, ...rest);
};
const load = Module._load;
Module._load = function (name, parent, ...rest) {
	if (name === '@/lib/prisma') { return { default: { bedrockModel: { findUnique: async () => ({ inputPerMillion: 0.5, outputPerMillion: 1.2 }) } }, __esModule: true }; }
	return load.call(this, name, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);
const { requestLimits } = require('../src/lib/llm/requestLimits.ts');
const { isContextError } = require('../src/lib/llm/contextError.ts');
const { budgetPrice, managedBody } = require('../src/lib/budgetPricing.ts');
const { usageCostMicros } = require('../src/lib/budgetPolicy.ts');
const { paidModelEnabled, requirePaidModelEnabled } = require('../src/lib/llm/paidModelRollout.ts');
const model = 'qwen.qwen3-coder-next';
const limits = { contextWindow: 262144, maxOutputTokens: 16384 };
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`PASS ${name}`); }

async function main() {
	await check('large UTF-8 history is not mistaken for an exact token count', () => {
		const body = { messages: [{ role: 'system', content: 'Инструкции '.repeat(24000) }, { role: 'user', content: 'Разбери проект' }], max_tokens: 4096 };
		const result = requestLimits(body, limits);
		assert.ok(result.messageBytes > 200000);
		assert.equal(result.contextValidation, 'provider');
		assert.equal(result.exactInputTokens, null);
		assert.equal(result.inputReservationTokens, limits.contextWindow);
	});
	await check('exact count includes the requested answer reserve and boundary', () => {
		const body = { messages: [{ role: 'user', content: 'hello' }], max_tokens: 4096 };
		assert.equal(requestLimits(body, limits, 262144 - 4096).contextValidation, 'counted');
		assert.throws(() => requestLimits(body, limits, 262144 - 4095), error => error.code === 'context_too_large');
		assert.throws(() => requestLimits(body, limits, -1), error => error.code === 'token_count_unavailable');
	});
	await check('schemas and tool call arguments are measured; diagnostics contain no text', () => {
		const secret = 'PRIVATE-FIXTURE-CONTENT';
		const body = { messages: [{ role: 'assistant', tool_calls: [{ id: 'a', function: { arguments: secret } }] }],
			tools: [{ type: 'function', function: { name: 'read_file', description: secret, parameters: { type: 'object' } } }] };
		const result = requestLimits(body, limits);
		assert.equal(result.toolBytes, Buffer.byteLength(JSON.stringify(body.tools)));
		assert.ok(result.requestBytes > result.messageBytes);
		assert.ok(!JSON.stringify(result).includes(secret));
	});
	await check('HTTP size limit remains separate and rejects huge requests', () => {
		assert.throws(() => requestLimits({ messages: [{ content: 'x'.repeat(3800000) }] }, limits), error => error.code === 'request_too_large' && error.status === 413);
	});
	await check('output is clamped to native cap, invalid metadata fails closed', () => {
		assert.equal(requestLimits({ messages: [], max_tokens: 20000 }, limits).maxOutputTokens, 16384);
		assert.throws(() => requestLimits({ messages: [] }, { ...limits, contextWindow: NaN }), error => error.code === 'context_unavailable');
	});
	await check('Qwen reservation has no imaginary cache discount and real usage settles separately', async () => {
		const body = managedBody({ model, messages: [{ role: 'user', content: 'x'.repeat(300000) }] });
		const price = await budgetPrice(body, 'bedrock', model);
		assert.equal(price.preflight.contextWindow, 262144);
		assert.equal(price.preflight.contextValidation, 'provider');
		assert.equal(price.cacheReadPerMillion, 0.5);
		assert.equal(price.cacheWritePerMillion, 0.5);
		assert.equal(price.reservedMicros, Math.ceil(262144 * 0.5 + body.max_tokens * 1.2));
		assert.equal(usageCostMicros({ prompt_tokens: 100000, completion_tokens: 5000 }, 0.5, 1.2), 56000);
	});
	await check('OpenRouter context and output come from current catalog, not 32K fallback', async () => {
		global.fetch = async () => Response.json({ data: [
			{ id: 'test/glm', context_length: 200000, top_provider: { context_length: 128000, max_completion_tokens: 2048 }, supported_parameters: ['tools'], pricing: { prompt: '0.00000015', completion: '0.0000005' } },
			{ id: 'test/unknown', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
		] });
		const body = managedBody({ model: 'test/glm', messages: [{ role: 'user', content: 'x'.repeat(240000) }] });
		const price = await budgetPrice(body, 'openrouter', body.model);
		assert.equal(price.preflight.contextWindow, 128000);
		assert.equal(body.max_tokens, 2048);
		await assert.rejects(budgetPrice({ ...body, model: 'test/unknown' }, 'openrouter', 'test/unknown'), error => error.code === 'context_unavailable');
	});
	await check('only provider context failures become a nonretryable context error', () => {
		assert.equal(isContextError(400, JSON.stringify({ error: { code: 'context_length_exceeded' } })), true);
		assert.equal(isContextError(400, JSON.stringify({ error: { message: 'Input is too long for requested model' } })), true);
		assert.equal(isContextError(400, JSON.stringify({ error: { code: 400, message: 'This model\'s maximum context length is 32768 tokens. However, you requested 40000 tokens.' } })), true);
		assert.equal(isContextError(400, JSON.stringify({ error: { message: 'text content blocks must contain non-whitespace text' } })), false);
		assert.equal(isContextError(504, JSON.stringify({ error: { message: 'context too long' } })), false);
	});
	await check('rollout permits one exact paid ID, preserves verified free models, fails closed on malformed configuration', () => {
		const saved = process.env.ARNI_PAID_MODEL_ALLOWLIST;
		try {
			process.env.ARNI_PAID_MODEL_ALLOWLIST = JSON.stringify([model]);
			assert.equal(paidModelEnabled(model), true);
			assert.equal(paidModelEnabled('qwen/qwen3-coder-next'), false);
			assert.throws(() => requirePaidModelEnabled('openrouter/paid'), error => error.code === 'model_not_released' && error.status === 403);
			assert.equal(paidModelEnabled('test/model:free', true), true);
			process.env.ARNI_PAID_MODEL_ALLOWLIST = '[]';
			assert.equal(paidModelEnabled(model), false);
			for (const value of ['["*"]', '{}', 'typo']) {
				process.env.ARNI_PAID_MODEL_ALLOWLIST = value;
				assert.throws(() => paidModelEnabled(model), error => error.code === 'model_rollout_unavailable');
			}
		} finally { if (saved === undefined) { delete process.env.ARNI_PAID_MODEL_ALLOWLIST; } else { process.env.ARNI_PAID_MODEL_ALLOWLIST = saved; } }
	});
	console.log(`${passed} request limit checks passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
