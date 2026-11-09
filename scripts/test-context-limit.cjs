// Context-size pre-check for paid OpenRouter models. No database or network: the catalog is stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(name, parent, ...rest) { return resolve.call(this, name.startsWith('@/') ? path.join(__dirname, '../src', name.slice(2)) : name, parent, ...rest); };
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);

const catalog = [
	// Shape of a 200K-context paid model as OpenRouter lists it (the 2026-11-09 failure was Claude Haiku via OpenRouter).
	{ id: 'test/paid-200k', name: 'paid 200k', supported_parameters: ['tools'], context_length: 200000,
		top_provider: { context_length: 200000, max_completion_tokens: 64000 },
		pricing: { prompt: '0.000001', completion: '0.000005', request: '0' } },
	{ id: 'test/paid-no-context', name: 'paid without context', supported_parameters: ['tools'],
		pricing: { prompt: '0.000001', completion: '0.000005', request: '0' } },
];
global.fetch = async () => ({ ok: true, json: async () => ({ data: catalog }) });

const { budgetPrice, contextByteLimit, routerContextWindow } = require('../src/lib/budgetPricing.ts');

/** An agent request: Russian system prompt plus tool schemas, about `bytes` UTF-8 bytes in total. */
function agentBody(model, bytes) {
	const tools = Array.from({ length: 40 }, (_, i) => ({ type: 'function', function: { name: `tool_${i}`, description: 'Описание инструмента. '.repeat(40), parameters: { type: 'object', properties: {} } } }));
	const toolBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
	const system = 'Ты — Арни. '.repeat(Math.max(0, Math.ceil((bytes - toolBytes) / Buffer.byteLength('Ты — Арни. ', 'utf8'))));
	return { model, messages: [{ role: 'system', content: system }, { role: 'user', content: 'собери корзину во ВкусВилле' }], tools, max_tokens: 4096 };
}

async function outcome(model, bytes) {
	try {
		const price = await budgetPrice(agentBody(model, bytes), 'openrouter', model);
		return `reserved ${price.reservedMicros}`;
	} catch (error) {
		return error.code || error.message;
	}
}

(async () => {
	assert.deepEqual({
		window: routerContextWindow(catalog[0]),
		missing: routerContextWindow(catalog[1]),
		limit200k: contextByteLimit(200000),
		floor: contextByteLimit(32768),
	}, { window: 200000, missing: undefined, limit200k: 800000, floor: 200000 });

	assert.deepEqual({
		// A new chat with a large tool set used to fail here with context_too_large.
		newChat250k: await outcome('test/paid-200k', 250_000),
		history700k: await outcome('test/paid-200k', 700_000),
		tooLarge: await outcome('test/paid-200k', 900_000),
		// Without a published context the old 200 000-byte floor still applies.
		noContext250k: await outcome('test/paid-no-context', 250_000),
	}, {
		// Input reservation is capped at the 200K window: 200000 * $1/M + 4096 * $5/M = 220480 micros.
		newChat250k: 'reserved 220480',
		history700k: 'reserved 220480',
		tooLarge: 'context_too_large',
		noContext250k: 'context_too_large',
	});
	console.log('PASS paid OpenRouter context limit uses the published window, caps the reservation and keeps the floor');
})().catch(error => { console.error(error); process.exit(1); });
