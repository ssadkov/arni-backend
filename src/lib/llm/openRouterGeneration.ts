import { openRouterGenerationId, validUsage, withHost, type ReportedUsage } from '../budgetPolicy';

export async function lookupOpenRouterGeneration(id: string, apiKey: string): Promise<ReportedUsage | null> {
	if (!openRouterGenerationId(id)) { return null; }
	const url = new URL('https://openrouter.ai/api/v1/generation');
	url.searchParams.set('id', id);
	for (const delay of [2_000, 5_000, 10_000]) {
		await new Promise(resolve => setTimeout(resolve, delay));
		try {
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${apiKey}` },
				cache: 'no-store',
				signal: AbortSignal.timeout(3_000),
			});
			if (!response.ok) {
				if (response.status === 404 || response.status === 429 || response.status >= 500) { continue; }
				return null;
			}
			const { data } = await response.json();
			if (typeof data?.total_cost !== 'number' || !Number.isFinite(data.total_cost) || data.total_cost < 0) { continue; }
			const usage = validUsage({
				prompt_tokens: data.native_tokens_prompt ?? data.tokens_prompt,
				completion_tokens: data.native_tokens_completion ?? data.tokens_completion,
				prompt_tokens_details: { cached_tokens: data.native_tokens_cached ?? 0 },
				cost: data.total_cost,
			});
			return withHost(usage ?? { prompt_tokens: 0, completion_tokens: 0, cost: data.total_cost }, data.provider_name);
		} catch {
			// Metadata may not be available immediately after OpenRouter closes the stream.
		}
	}
	return null;
}
