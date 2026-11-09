// Regression checks for web search completion. No database or billed model calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
	return resolve.call(this, name.startsWith('@/') ? path.join(__dirname, '../src', name.slice(2)) : name, parent, ...rest);
};
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, filename);

const model = 'us.anthropic.claude-sonnet-4-6';
const calls = [];
const searches = [];
const saved = [];
let configured = true;
let responses = [];
const hit = { title: 'Example author', url: 'https://example.com/author', snippet: 'Source facts with exact identifier 12345.' };
const streamText = 'data: {"choices":[{"delta":{"content":"Author from the search results."}}]}\n\ndata: [DONE]\n\n';
const mocks = {
	'@/lib/prisma': { __esModule: true, default: {
		webMemory: { findUnique: async () => null },
		webMessage: {
			findMany: async () => [{ id: 'user-message', role: 'user', text: 'Find authors about coding.', images: [] }],
			create: async ({ data }) => { saved.push(data); },
		},
		webChat: { update: async () => ({}) },
	} },
	'@/lib/imageGeneration': {},
	'@/lib/budget': { BudgetError: class BudgetError extends Error {} },
	'@/lib/webSearch': {
		searchConfigured: () => configured,
		searchWeb: async query => { searches.push(query); return [hit]; },
	},
	'@/app/api/chat/completions/route': { POST: async req => {
		const body = await req.json();
		calls.push(body);
		if (!body.stream) {
			assert.ok(responses.length, 'unexpected extra tool request');
			return Response.json(responses.shift());
		}
		const { toConverse } = require('../src/lib/llm/bedrock.ts');
		const converted = toConverse(body, model);
		assert.equal(converted.toolConfig, undefined);
		assert.ok(converted.messages.every(message => message.content.every(block => !block.toolUse && !block.toolResult)),
			'Bedrock final answer without toolConfig must contain no protocol tool blocks');
		return new Response(streamText, { headers: { 'Content-Type': 'text/event-stream' } });
	} },
};
const load = Module._load;
Module._load = function (name, parent, ...rest) {
	return Object.hasOwn(mocks, name) ? mocks[name] : load.call(this, name, parent, ...rest);
};
const { runTurn, textFromSse } = require('../src/lib/webTurn.ts');

function searchResponse(ids) {
	return { choices: [{ message: { role: 'assistant', content: '', tool_calls: ids.map(id => ({
		id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: `author ${id}` }) },
	})) } }] };
}
function reset() { calls.length = 0; searches.length = 0; saved.length = 0; configured = true; responses = []; }
let passed = 0;
async function check(name, run) { reset(); await run(); passed++; console.log(`PASS ${name}`); }

async function main() {
	for (const batches of [[['one', 'two']], [['one'], ['two']]]) {
		await check(`two searches produce a Bedrock-compatible final answer (${batches.length} batches)`, async () => {
			responses = batches.map(searchResponse);
			const result = await runTurn('mock-token', 'user', 'chat', model);
			assert.equal(await new Response(result.stream).text(), streamText);
			assert.deepEqual(searches, ['author one', 'author two']);
			assert.deepEqual(result.sources, [hit, hit]);
			const final = calls.at(-1);
			assert.equal(calls.length, batches.length + 1);
			assert.equal(final.tools, undefined);
			assert.ok(final.messages.every(message => message.role !== 'tool' && !message.tool_calls));
			assert.equal(final.messages.filter(message => message.content.includes(hit.snippet)).length, 2,
				'both search results must reach the final model request');
			assert.ok(final.messages.some(message => message.content.includes('author one')));
		});
	}
	await check('an answer before the search cap is saved with its sources', async () => {
		responses = [searchResponse(['one']), { choices: [{ message: { content: 'An answer with sources.' } }] }];
		const result = await runTurn('mock-token', 'user', 'chat', model);
		assert.equal(result.text, 'An answer with sources.');
		assert.equal(calls.length, 2);
		assert.equal(saved[0].text, result.text);
		assert.deepEqual(saved[0].sources, [hit]);
	});
	await check('disabled search streams ordinary conversation without adding tool context', async () => {
		configured = false;
		const result = await runTurn('mock-token', 'user', 'chat', model);
		assert.equal(await new Response(result.stream).text(), streamText);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'Find authors about coding.' }]);
		assert.deepEqual(result.sources, []);
	});
	await check('the final answer can be extracted from real SSE packets', () => {
		assert.equal(textFromSse(streamText), 'Author from the search results.');
	});
	console.log(`${passed} web turn regression checks passed; no billed calls.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
