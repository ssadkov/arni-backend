// Live Bedrock probe: does each picker model accept its managed output limit and stream one long tool call?
// Billed. Uses the local AWS profile (AWS_PROFILE, default arni-bedrock-audit), not the production token.
// Run: node scripts/probe-output-limits.cjs [model ...]
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

process.env.AWS_PROFILE ??= 'arni-bedrock-audit';
const { BedrockRuntimeClient, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
const { toConverse } = require('../src/lib/llm/bedrock.ts');
const { modelCapabilities, managedOutputLimit } = require('../src/lib/llm/modelCapabilities.ts');
const prices = require('../data/bedrock-models.json');

const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : [
	'global.anthropic.claude-sonnet-4-6',
	'global.anthropic.claude-haiku-4-5-20251001-v1:0',
	'zai.glm-5',
	'minimax.minimax-m2.5',
	'qwen.qwen3-next-80b-a3b',
	'deepseek.v3.2',
	'moonshotai.kimi-k2.5',
];

const body = limit => ({
	model: 'probe',
	max_tokens: limit,
	stream: true,
	messages: [
		{ role: 'system', content: 'You are a coding agent. Write files only through the create_file tool, the whole file in one call.' },
		{ role: 'user', content: 'Create build_deck.py: a python-pptx script for a 12-slide pitch deck with a playful design. '
			+ 'Every slide gets its own function with full layout code, shapes, colours and real example text; no placeholders, no "...". '
			+ 'Aim for about 1000 lines. Call create_file once with the complete file and do not write anything else.' },
	],
	tools: [{ type: 'function', function: { name: 'create_file', description: 'Create a file with the given content.',
		parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }],
});

function price(model) {
	const row = (Array.isArray(prices) ? prices : prices.models || Object.values(prices)).find(entry => (entry.id || entry.modelId) === model);
	return row ? { input: row.inputPerMillion, output: row.outputPerMillion } : null;
}

function validJson(text) {
	try { return typeof JSON.parse(text).content === 'string'; } catch { return false; }
}

async function probe(model) {
	const limit = Number(process.env.PROBE_LIMIT) || managedOutputLimit(model);
	const { system, messages, toolConfig } = toConverse(body(limit), model);
	const region = modelCapabilities(model).region || 'us-east-1';
	const client = new BedrockRuntimeClient({ region });
	const started = Date.now();
	let stopReason = null; let usage = {}; let toolInput = ''; let textChars = 0;
	try {
		const response = await client.send(new ConverseStreamCommand({ modelId: model, system, messages, toolConfig, inferenceConfig: { maxTokens: limit } }));
		for await (const event of response.stream) {
			const delta = event.contentBlockDelta?.delta;
			if (delta?.toolUse) { toolInput += delta.toolUse.input || ''; }
			if (delta?.text) { textChars += delta.text.length; }
			if (event.messageStop) { stopReason = event.messageStop.stopReason; }
			if (event.metadata?.usage) { usage = event.metadata.usage; }
		}
	} catch (error) {
		return { model, limit, error: `${error.name}: ${error.message}`.slice(0, 200) };
	}
	const rate = price(model);
	const cost = rate ? (usage.inputTokens * rate.input + usage.outputTokens * rate.output) / 1e6 : null;
	return { model, limit, stopReason, outputTokens: usage.outputTokens, beyondOldCap: usage.outputTokens > 4096,
		toolChars: toolInput.length, toolJson: toolInput ? validJson(toolInput) : null, textChars, seconds: Math.round((Date.now() - started) / 1000), cost: cost == null ? null : Number(cost.toFixed(4)) };
}

(async () => {
	let total = 0;
	for (const model of MODELS) {
		const result = await probe(model);
		total += result.cost || 0;
		console.log(JSON.stringify(result));
	}
	console.log(`total ≈ $${total.toFixed(3)}`);
})();
