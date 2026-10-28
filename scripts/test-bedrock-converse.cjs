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
const { toConverse, completeWithBedrock, cacheConversePrefix, bedrockUsage } = require('../src/lib/llm/bedrock.ts');
const { modelCapabilities, managedModelMetadata, QWEN3_MODEL_IDS, OPEN_WEIGHT_MODEL_IDS } = require('../src/lib/llm/modelCapabilities.ts');
const { supportsScreenshots, conservativeInputTokenBound } = require('../src/lib/llm/vision.ts');
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
	let pending = new Set();
	for (const block of input.system ?? []) { assert.ok(block.text.trim(), 'system text must not be blank'); }
	for (const message of input.messages) {
		assert.ok(message.content.length, 'message content must not be empty');
		for (const block of message.content) {
			if (block.toolUse) { pending.add(block.toolUse.toolUseId); }
			if ('text' in block) { assert.ok(block.text.trim(), 'message text must not be blank'); }
			if (block.toolResult) {
				assert.equal(message.role, 'user');
				assert.ok(pending.delete(block.toolResult.toolUseId), 'tool result must match an immediately preceding tool call');
				assert.ok(block.toolResult.content.length, 'tool result must not be empty');
				for (const result of block.toolResult.content) {
					if ('text' in result) { assert.ok(result.text.trim(), 'tool result text must not be blank'); }
				}
			}
		}
		if (message.role === 'user') { assert.equal(pending.size, 0, 'every tool call needs a result before continuing'); }
	}
	assert.equal(pending.size, 0, 'history cannot end with unresolved tool calls');
}

let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
async function main() {
 await check('Mac update feed refuses unsigned, mismatched, old and prerelease artifacts', () => {
  const {macUpdate}=require('../src/lib/macUpdates.ts');
  const release={draft:false,prerelease:false,published_at:'2026-10-15T12:00:00Z',body:'Release description',assets:[{name:'ArniCode-darwin-arm64.zip',browser_download_url:'https://github.com/ssadkov/arni-code/releases/download/v1.0.1/ArniCode-darwin-arm64.zip',digest:'sha256:'+'a'.repeat(64),size:12345}]};
  const manifest={version:'1.0.1',commit:'a'.repeat(40),assetName:'ArniCode-darwin-arm64.zip',sha256:'a'.repeat(64),signed:true,notarized:true};
  const update=macUpdate(release,manifest,'arm64','b'.repeat(40),'1.0.0');
  assert.equal(update.productVersion,'1.0.1');
  assert.equal(update.notes,manifest.commit,'Electron releaseNotes must preserve the pending commit');
  assert.equal(update.releaseNotes,release.body);
  assert.equal(update.sha256,manifest.sha256);
  assert.equal(update.size,12345);
  assert.equal(macUpdate(release,manifest,'arm64',manifest.commit,'1.0.0').url,update.url,'Manual download requests use the pending commit with the old running version');
  assert.equal(macUpdate(release,manifest,'arm64',manifest.commit,'1.0.1'),null,'The installed version must not download itself');
  for (const [r,m,arch,current] of [[release,{...manifest,signed:false},'arm64','1.0.0'],[{...release,prerelease:true},manifest,'arm64','1.0.0'],[release,{...manifest,sha256:'b'.repeat(64)},'arm64','1.0.0'],[release,manifest,'x64','1.0.0'],[release,manifest,'arm64','1.0.1'],[release,manifest,'arm64','1.0.2']]) assert.equal(macUpdate(r,m,arch,'b'.repeat(40),current),null);
 });
 await check('cache usage preserves full input count, discounted reads and write premium', () => {
  const usage=bedrockUsage(model,{inputTokens:1000,outputTokens:100,cacheReadInputTokens:8000,cacheWriteInputTokens:1000},{inputPerMillion:3,outputPerMillion:15});
  assert.deepEqual(usage,{prompt_tokens:10000,completion_tokens:100,total_tokens:10100,prompt_tokens_details:{cached_tokens:8000,cache_creation_input_tokens:1000},cost:0.01065});
 });
 await check('rolling cache checkpoints preserve tool pairs without mutating requests or touching Qwen', () => {
  const messages=toConverse({messages:[{role:'user',content:'Reference '.repeat(2500)},{role:'assistant',tool_calls:[call]},{role:'tool',tool_call_id:call.id,content:'saved'}]}).messages;
  const before=JSON.stringify(messages); const cached=cacheConversePrefix(model,messages);
  assert.equal(cached[1].content.at(-1).cachePoint.type,'default');
  assertValidText({messages:cached}); assert.equal(JSON.stringify(messages),before);
  assert.equal(cacheConversePrefix('qwen.qwen3-coder-next',messages),messages);
 });
	await check('model metadata carries real context, response reserve, vision and regional Qwen routing', () => {
		assert.equal(QWEN3_MODEL_IDS.length, 7);
		assert.equal(managedModelMetadata(model).context_length, 1_000_000);
		assert.equal(managedModelMetadata(model).top_provider.max_completion_tokens, 4096);
		assert.equal(modelCapabilities('us.anthropic.claude-haiku-4-5-20251001-v1:0').contextWindow, 200000);
		assert.equal(modelCapabilities('qwen.qwen3-32b-v1:0').contextWindow, 32768);
		assert.equal(modelCapabilities('qwen.qwen3-coder-480b-a35b-v1:0').region, 'us-west-2');
		const longHistory = [{ role: 'user', content: [{ text: 'Reference '.repeat(5000) }] }, { role: 'assistant', content: [{ text: 'ok' }] }];
		for (const id of [...QWEN3_MODEL_IDS, ...OPEN_WEIGHT_MODEL_IDS]) {
			assert.equal(supportsScreenshots(id), id === 'qwen.qwen3-vl-235b-a22b');
			assert.ok(managedModelMetadata(id).top_provider.max_completion_tokens < modelCapabilities(id).contextWindow);
			assert.equal(cacheConversePrefix(id, longHistory), longHistory, 'AWS lists no cache tariff for open-weight models');
		}
	});
	await check('Qwen screenshot reservation counts image dimensions without charging base64 as text', () => {
		const body = [{ role: 'user', content: [image] }];
		const bound = conservativeInputTokenBound(body, []);
		assert.ok(Number.isSafeInteger(bound) && bound > 2000 && bound < 3000);
		assert.equal(body[0].content[0], image);
	});
	await check('interrupted parallel calls and summary histories receive explicit missing-result errors', () => {
		for (const tail of [[], [{ role: 'user', content: 'Summarize the work.' }], [{ role: 'tool', tool_call_id: 'next', content: 'File saved.' }]]) {
			const converted = toConverse({ messages: [{ role: 'user', content: 'Prepare a preview.' }, { role: 'assistant', tool_calls: [call, { ...call, id: 'next' }] }, ...tail] });
			assertValidText(converted);
			const results = converted.messages[2].content.filter(block => block.toolResult).map(block => block.toolResult);
			assert.equal(results.length, 2);
			assert.equal(results.find(result => result.toolUseId === call.id).status, 'error');
			if (tail[0]?.role === 'tool') { assert.deepEqual(results.find(result => result.toolUseId === 'next').content, [{ text: 'File saved.' }]); }
		}
	});
	await check('orphan and duplicate results retain text/images as ordinary historical context', () => {
		const converted = toConverse({ messages: [{ role: 'tool', tool_call_id: 'old', content: ['Previous output.', image] }, { role: 'assistant', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'First result.' }, { role: 'tool', tool_call_id: call.id, content: 'Duplicate result.' }] });
		assertValidText(converted);
		assert.ok(converted.messages[0].content.some(block => block.image));
		assert.ok(converted.messages[0].content.some(block => block.text === 'Previous output.'));
		assert.ok(converted.messages[2].content.some(block => block.text === 'Duplicate result.'));
	});
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
