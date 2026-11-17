/**
 * Free-tier Google AI Studio (Gemini) as a reserve for OpenRouter's shared daily :free pool.
 * It is never offered in the picker: the route calls it only after OpenRouter refused a free model.
 * Limits are per Google project and per model (docs/llm-providers.md), so models are tried in order.
 * Free-tier prompts may be used by Google for training.
 */

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const DEFAULT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
/** Marks history that Gemini did not produce; documented way to skip signature validation. */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';
const ALLOWED_FIELDS = ['messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'response_format'] as const;

type ChatBody = Record<string, unknown> & { messages?: unknown };

export function geminiModels(): string[] {
	if (!process.env.GEMINI_API_KEY) { return []; }
	const configured = (process.env.GEMINI_FREE_MODELS || '').split(',').map(id => id.trim()).filter(id => /^[a-z0-9.-]{3,60}$/.test(id));
	return configured.length ? configured : DEFAULT_MODELS;
}

/** OpenAI-shaped body limited to fields Google accepts; assistant tool calls get a signature placeholder. */
export function geminiBody(body: ChatBody, model: string): Record<string, unknown> {
	const out: Record<string, unknown> = { model };
	for (const field of ALLOWED_FIELDS) {
		if (body[field] !== undefined) { out[field] = body[field]; }
	}
	if (Array.isArray(out.messages)) {
		out.messages = out.messages.map((message: Record<string, unknown>) => {
			if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) { return message; }
			return {
				...message,
				tool_calls: message.tool_calls.map((call: Record<string, unknown>) => call.extra_content ? call
					: { ...call, extra_content: { google: { thought_signature: SKIP_SIGNATURE } } }),
			};
		});
	}
	return out;
}

/**
 * Google streams each tool call whole but without the `index` OpenAI clients use to assemble them.
 * Adds a running index to every `data:` event; other lines and `[DONE]` pass through untouched.
 */
export function withToolCallIndexes(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let next = 0;
	const fix = (event: string) => {
		if (!event.startsWith('data: ') || event === 'data: [DONE]') { return event; }
		try {
			const json = JSON.parse(event.slice(6));
			let changed = false;
			for (const choice of json.choices || []) {
				for (const call of choice.delta?.tool_calls || []) {
					if (call.index === undefined) { call.index = next++; changed = true; }
				}
			}
			return changed ? `data: ${JSON.stringify(json)}` : event;
		} catch {
			return event;
		}
	};
	return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			buffer += decoder.decode(chunk, { stream: true });
			const events = buffer.split('\n\n');
			buffer = events.pop() ?? '';
			for (const event of events) { controller.enqueue(encoder.encode(`${fix(event)}\n\n`)); }
		},
		flush(controller) {
			buffer += decoder.decode();
			if (buffer) { controller.enqueue(encoder.encode(fix(buffer))); }
		},
	}));
}

/** First Gemini model that accepts the request, or null so the caller keeps the OpenRouter error. */
export async function completeWithGemini(body: ChatBody): Promise<{ response: Response; model: string } | null> {
	const key = process.env.GEMINI_API_KEY;
	for (const model of geminiModels()) {
		let response: Response;
		try {
			response = await fetch(GEMINI_ENDPOINT, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
				body: JSON.stringify(geminiBody(body, model)),
				signal: AbortSignal.timeout(120_000),
			});
		} catch {
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			continue;
		}
		const headers = new Headers(response.headers);
		headers.set('X-Llm-Provider', 'gemini');
		headers.set('X-Llm-Model', model);
		const stream = body.stream && response.body ? withToolCallIndexes(response.body) : response.body;
		return { response: new Response(stream, { status: response.status, headers }), model };
	}
	return null;
}
