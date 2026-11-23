/** Bytes held back while waiting for the first answer event; past this the stream is passed on as is. */
const MAX_HELD_BYTES = 1_000_000;

/**
 * True for an SSE `data:` payload the client acts on: answer text, a tool call, a finish reason,
 * an error, or `[DONE]`. Role-only chunks, empty deltas, reasoning, and keep-alive comments are not.
 */
function answers(data: string): boolean {
	if (data === '[DONE]') { return true; }
	try {
		const event = JSON.parse(data);
		const choice = event?.choices?.[0];
		return Boolean(event?.error || choice?.finish_reason || choice?.delta?.content || choice?.delta?.tool_calls?.length);
	} catch { return false; }
}

/** Replays the held chunks, then passes the rest of upstream through. */
function replay(held: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array> | null): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) { for (const chunk of held) { controller.enqueue(chunk); } if (!reader) { controller.close(); } },
		async pull(controller) {
			if (!reader) { return; }
			const { value, done } = await reader.read();
			if (done) { controller.close(); } else { controller.enqueue(value); }
		},
		cancel(reason) { return reader?.cancel(reason); },
	});
}

/**
 * Holds an upstream SSE response until its first answer event. A stream that ends before one,
 * with nothing the client could use, is requested once more; it reached nobody, so the repeat is invisible.
 * When the repeat fails too, the first (empty) stream is returned as it was.
 */
export async function retryEmptyStream(response: Response, retry: () => Promise<Response>): Promise<{ response: Response; retried: boolean }> {
	if (!response.body) { return { response, retried: false }; }
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const held: Uint8Array[] = [];
	let heldBytes = 0;
	let pending = '';
	const passOn = (body: ReadableStream<Uint8Array>) => new Response(body, { status: response.status, headers: response.headers });
	while (true) {
		const { value, done } = await reader.read();
		if (done) { break; }
		held.push(value);
		heldBytes += value.byteLength;
		pending += decoder.decode(value, { stream: true });
		const lines = pending.split('\n');
		pending = lines.pop() || '';
		if (heldBytes > MAX_HELD_BYTES || lines.some(line => line.startsWith('data:') && answers(line.slice(5).trim()))) {
			return { response: passOn(replay(held, reader)), retried: false };
		}
	}
	if (pending.startsWith('data:') && answers(pending.slice(5).trim())) {
		return { response: passOn(replay(held, null)), retried: false };
	}
	const repeated = await retry();
	if (repeated.ok && repeated.body) { return { response: repeated, retried: true }; }
	await repeated.body?.cancel();
	return { response: passOn(replay(held, null)), retried: true };
}
