import { routerCacheMode } from './openRouterCatalog';

/** Rolling text-prefix marker. Unsupported models receive no cache controls. */
export function cachedRouterBody(body: any) {
	if (routerCacheMode(body.model) !== 'explicit' || body.messages?.length < 2) { return body; }
	const index = body.messages.findLastIndex((message: any, i: number) => i < body.messages.length - 1 && message.role !== 'tool'
		&& (typeof message.content === 'string' && message.content.trim() || Array.isArray(message.content) && message.content.some((part: any) => part.type === 'text' && part.text?.trim())));
	if (index < 0) { return body; }
	if (Buffer.byteLength(JSON.stringify(body.messages.slice(0, index + 1))) < 16_384) { return body; }
	const messages = body.messages.map((message: any, i: number) => {
		if (i !== index || message.role === 'tool') { return message; }
		const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
		if (!Array.isArray(content)) { return message; }
		const lastText = content.findLastIndex(part => part.type === 'text' && part.text?.trim());
		return { ...message, content: content.map((part, j) => j === lastText ? { ...part, cache_control: { type: 'ephemeral' } } : part) };
	});
	return { ...body, messages };
}

export async function completeWithOpenRouter(body: unknown): Promise<Response> {
	const openRouterApiKey = process.env.OPENROUTER_API_KEY;
	if (!openRouterApiKey) {
		return Response.json({ error: 'OpenRouter API Key not configured' }, { status: 500 });
	}

	const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${openRouterApiKey}`,
			'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'https://arni-code.com',
			'X-Title': 'Arni Code IDE',
		},
        body: JSON.stringify(cachedRouterBody(body)),
	});

	const headers = new Headers(response.headers);
	headers.set('X-Llm-Provider', 'openrouter');
	const model = typeof body === 'object' && body && 'model' in body && typeof body.model === 'string' ? body.model : '';
	if (model) {
		headers.set('X-Llm-Model', model);
	}
	return new Response(response.body, { status: response.status, headers });
}
