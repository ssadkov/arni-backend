import assert from 'node:assert/strict';
import test from 'node:test';
import { completeWithGemini, geminiBody, geminiModels, withToolCallIndexes } from './gemini.ts';

async function read(stream: ReadableStream<Uint8Array>) {
	return new Response(stream).text();
}

test('Gemini body keeps only supported fields and marks foreign tool calls', () => {
	const body = geminiBody({
		model: 'google/gemma-4-31b-it:free', provider: { max_price: 0 }, reasoning: { enabled: false }, plugins: [{}], stream: true,
		messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }, { id: 'b', extra_content: { google: { thought_signature: 'real' } } }] }],
	}, 'gemini-3.5-flash-lite');
	assert.deepStrictEqual(body, {
		model: 'gemini-3.5-flash-lite', stream: true,
		messages: [{ role: 'assistant', content: null, tool_calls: [
			{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } } },
			{ id: 'b', extra_content: { google: { thought_signature: 'real' } } },
		] }],
	});
});

test('streamed tool calls get running indexes and other events pass through', async () => {
	const event = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
	const input = event({ choices: [{ delta: { content: 'hi' } }] })
		+ event({ choices: [{ delta: { tool_calls: [{ id: '1', function: { name: 'a' } }, { id: '2', function: { name: 'b' } }] } }] })
		+ event({ choices: [{ delta: { tool_calls: [{ id: '3', index: 7 }] } }] }) + event('[DONE]');
	// Split mid-event to prove buffering across network packets.
	const cut = 40;
	const source = new ReadableStream<Uint8Array>({ start(controller) {
		const bytes = new TextEncoder().encode(input);
		controller.enqueue(bytes.slice(0, cut)); controller.enqueue(bytes.slice(cut)); controller.close();
	} });
	const output = (await read(withToolCallIndexes(source))).split('\n\n').filter(Boolean).map(line => line.startsWith('data: [DONE]') ? line : JSON.parse(line.slice(6)));
	assert.deepStrictEqual(output, [
		{ choices: [{ delta: { content: 'hi' } }] },
		{ choices: [{ delta: { tool_calls: [{ id: '1', function: { name: 'a' }, index: 0 }, { id: '2', function: { name: 'b' }, index: 1 }] } }] },
		{ choices: [{ delta: { tool_calls: [{ id: '3', index: 7 }] } }] },
		'data: [DONE]',
	]);
});

test('Gemini is skipped without a key and falls through refused models', async () => {
	const realFetch = globalThis.fetch;
	const savedKey = process.env.GEMINI_API_KEY;
	const savedModels = process.env.GEMINI_FREE_MODELS;
	try {
		delete process.env.GEMINI_API_KEY;
		assert.deepStrictEqual(geminiModels(), []);
		assert.equal(await completeWithGemini({ messages: [] }), null);

		process.env.GEMINI_API_KEY = 'test-key';
		process.env.GEMINI_FREE_MODELS = 'gemini-a, gemini-b, bad model!';
		assert.deepStrictEqual(geminiModels(), ['gemini-a', 'gemini-b']);
		const tried: string[] = [];
		globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
			const model = JSON.parse(String(init.body)).model as string;
			tried.push(model);
			return model === 'gemini-a' ? new Response('quota', { status: 429 }) : Response.json({ choices: [] });
		}) as typeof fetch;
		const result = await completeWithGemini({ messages: [] });
		assert.deepStrictEqual({ tried, model: result?.model, provider: result?.response.headers.get('X-Llm-Provider'), served: result?.response.headers.get('X-Llm-Model') },
			{ tried: ['gemini-a', 'gemini-b'], model: 'gemini-b', provider: 'gemini', served: 'gemini-b' });

		globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
		assert.equal(await completeWithGemini({ messages: [] }), null);
	} finally {
		globalThis.fetch = realFetch;
		if (savedKey === undefined) { delete process.env.GEMINI_API_KEY; } else { process.env.GEMINI_API_KEY = savedKey; }
		if (savedModels === undefined) { delete process.env.GEMINI_FREE_MODELS; } else { process.env.GEMINI_FREE_MODELS = savedModels; }
	}
});
