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
		body: JSON.stringify(body),
	});

	const headers = new Headers(response.headers);
	headers.set('X-Llm-Provider', 'openrouter');
	const model = typeof body === 'object' && body && 'model' in body && typeof body.model === 'string' ? body.model : '';
	if (model) {
		headers.set('X-Llm-Model', model);
	}
	return new Response(response.body, { status: response.status, headers });
}
