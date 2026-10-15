// Regression checks for Bedrock message conversion. AWS is mocked; no billed calls.
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

const runtime = require('@aws-sdk/client-bedrock-runtime');
const { toConverse, completeWithBedrock } = require('../src/lib/llm/bedrock.ts');
const model = 'us.anthropic.claude-sonnet-4-6';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNGkAAAAASUVORK5CYII=';
const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } };
const call = { id: 'save-script', function: { name: 'create', arguments: '{"path":"chroma_key.py"}' } };
const history = [
	{ role: 'system', content: '\n\t ' },
	{ role: 'user', content: 'Create a video script.' },
	{ role: 'assistant', content: ' \n', tool_calls: [call] },
	{ role: 'tool', tool_call_id: call.id, content: [{ type: 'text', text: '' }, { type: 'text', text: '\n\t' }] },
	{ role: 'assistant', content: '' },
	{ role: 'user', content: 'Continue with the preview.' },
];

function assertValidText(input) {
	for (const block of input.system ?? []) { assert.ok(block.text.trim(), 'system text must not be blank'); }
	for (const message of input.messages) {
		assert.ok(message.content.length, 'message content must not be empty');
		for (const block of message.content) {
			if ('text' in block) { assert.ok(block.text.trim(), 'message text must not be blank'); }
			if (block.toolResult) {
				assert.ok(block.toolResult.content.length, 'tool result must not be empty');
				for (const result of block.toolResult.content) {
					if ('text' in result) { assert.ok(result.text.trim(), 'tool result text must not be blank'); }
				}
			}
		}
	}
}

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
async function main() {
	await check('agent history retains tool pairing and skips whitespace-only assistant/system blocks', () => {
		const converted = toConverse({ messages: history });
		assertValidText(converted);
		assert.deepEqual(converted.system, []);
		assert.deepEqual(converted.messages.map(message => message.role), ['user', 'assistant', 'user']);
		assert.deepEqual(converted.messages[1].content, [{ toolUse: { toolUseId: call.id, name: 'create', input: { path: 'chroma_key.py' } } }]);
		assert.equal(converted.messages[2].content[0].toolResult.toolUseId, call.id);
		assert.deepEqual(converted.messages[2].content[1], { text: 'Continue with the preview.' });
	});
	await check('mixed text and image blocks omit blank/service parts without losing image bytes or text formatting', () => {
		const converted = toConverse({ messages: [{ role: 'user', content: [
			{ type: 'text', text: ' \n' }, { type: 'file_edit', diff: { added: 223 } }, image, { type: 'text', text: '  Inspect this frame.\n' },
		] }] });
		assertValidText(converted);
		assert.equal(converted.messages[0].content.length, 2);
		assert.deepEqual(Buffer.from(converted.messages[0].content[0].image.source.bytes), Buffer.from(png, 'base64'));
		assert.deepEqual(converted.messages[0].content[1], { text: '  Inspect this frame.\n' });
	});
	await check('image-only tool output remains image-only and null/empty tool outputs remain paired', () => {
		for (const content of [null, '', ' \n\t', [], [image, { type: 'text', text: ' ' }]]) {
			const converted = toConverse({ messages: [{ role: 'user', content: 'Inspect video.' }, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content }] });
			assertValidText(converted);
			const result = converted.messages[2].content[0].toolResult;
			assert.equal(result.toolUseId, call.id);
			if (Array.isArray(content) && content.length) {
				assert.equal(result.content.length, 1);
				assert.equal(result.content[0].image.format, 'png');
			}
		}
	});
	await check('assistant-first continuation has valid user text; entirely blank histories fail locally', () => {
		const converted = toConverse({ messages: [{ role: 'assistant', content: 'Script saved.' }] });
		assertValidText(converted);
		assert.equal(converted.messages[0].role, 'user');
		for (const messages of [[], [{ role: 'user', content: null }], [{ role: 'system', content: ' ' }, { role: 'assistant', content: '\n' }, { role: 'user', content: [] }]]) {
			assert.throws(() => toConverse({ messages }), error => error.code === 'invalid_messages' && error.status === 400);
		}
	});

	const savedSend = runtime.BedrockRuntimeClient.prototype.send;
	const savedToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
	let sent = 0;
	process.env.AWS_BEARER_TOKEN_BEDROCK = 'mock-only';
	runtime.BedrockRuntimeClient.prototype.send = async command => {
		sent++;
		assertValidText(command.input);
		if (command instanceof runtime.ConverseStreamCommand) {
			return { stream: (async function* () {
				yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Preview ready.' } } };
				yield { messageStop: { stopReason: 'end_turn' } };
				yield { metadata: { usage: { inputTokens: 30, outputTokens: 4 } } };
			})() };
		}
		return { output: { message: { role: 'assistant', content: [{ text: 'Preview ready.' }] } }, usage: { inputTokens: 30, outputTokens: 4 }, stopReason: 'end_turn' };
	};
	try {
		await check('streaming and non-streaming requests send valid normalized history; empty input never invokes AWS', async () => {
			for (const stream of [false, true]) {
				const response = await completeWithBedrock({ messages: history, stream, max_tokens: 32 }, model);
				assert.equal(response.status, 200);
				assert.match(await response.text(), /Preview ready\./);
			}
			const before = sent;
			const response = await completeWithBedrock({ messages: [{ role: 'user', content: '\n ' }] }, model);
			assert.equal(response.status, 400);
			assert.equal((await response.json()).error.code, 'invalid_messages');
			assert.equal(sent, before);
		});
		await check('Bedrock validation errors retain HTTP 400 and are not retried inside the backend', async () => {
			runtime.BedrockRuntimeClient.prototype.send = async () => { sent++; throw Object.assign(new Error('Invalid request'), { $metadata: { httpStatusCode: 400 } }); };
			const before = sent;
			const response = await completeWithBedrock({ messages: [{ role: 'user', content: 'Test.' }] }, model);
			assert.equal(response.status, 400);
			assert.equal(sent - before, 1);
		});
	} finally {
		runtime.BedrockRuntimeClient.prototype.send = savedSend;
		if (savedToken === undefined) { delete process.env.AWS_BEARER_TOKEN_BEDROCK; } else { process.env.AWS_BEARER_TOKEN_BEDROCK = savedToken; }
	}
	console.log(`${passed} Bedrock regression checks passed; no billed AWS calls.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
