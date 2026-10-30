import { BudgetError } from '../budget';

export type RouterModel = {
	id: string; name: string; context_length?: number;
	architecture?: { input_modalities?: string[] };
	supported_parameters?: string[];
	top_provider?: { context_length?: number; max_completion_tokens?: number };
	pricing?: { prompt?: string; completion?: string; request?: string; image?: string; input_cache_read?: string; input_cache_write?: string;
		overrides?: Array<{ prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string }> };
};

let cached: { until: number; models: RouterModel[] } | undefined;

/** Public metadata only; credentials and user grants are never cached here. */
/** Listed by OpenRouter, but refused for this app: 502 "only available on agentic harnesses" (2026-10-30). */
const UNUSABLE_MODELS = new Set(['thinkingmachines/inkling:free']);

export async function routerCatalog(): Promise<RouterModel[]> {
	if (cached && cached.until > Date.now()) { return cached.models; }
	const response = await fetch('https://openrouter.ai/api/v1/models?supported_parameters=tools', { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
	if (!response.ok) { throw new BudgetError('catalog_unavailable', 'Каталог моделей временно недоступен. Повторите запрос.', 503); }
	const data = await response.json();
	if (!Array.isArray(data.data)) { throw new BudgetError('catalog_unavailable', 'Некорректный каталог моделей.', 503); }
	const models: RouterModel[] = data.data.filter((row: RouterModel) => typeof row.id === 'string' && row.supported_parameters?.includes('tools') && !UNUSABLE_MODELS.has(row.id));
	cached = { until: Date.now() + 60_000, models };
	return models;
}

export function zeroPrice(model: RouterModel): boolean {
	return model.id.endsWith(':free') && model.pricing?.prompt != null && model.pricing.completion != null
		&& [model.pricing.prompt, model.pricing.completion, model.pricing.request ?? '0', model.pricing.image ?? '0'].every(price => Number(price) === 0);
}

export async function routerModel(id: string, images = false): Promise<RouterModel> {
	const model = (await routerCatalog()).find(row => row.id === id);
	if (!model || id.endsWith(':free') && !zeroPrice(model)) { throw new BudgetError('model_unavailable', 'Модель отсутствует в текущем каталоге. Обновите список моделей.', 400); }
	if (images && !model.architecture?.input_modalities?.includes('image')) { throw new BudgetError('vision_unavailable', 'Выбранная модель не поддерживает изображения. Выберите vision-модель.', 400); }
	return model;
}

/** Cache controls are provider-specific; never send them to unverified Qwen snapshots. */
export function routerCacheMode(id: string): 'explicit' | 'automatic' | undefined {
	if (id.endsWith(':free')) { return undefined; }
	if (['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4.6', 'anthropic/claude-opus-4.5', 'anthropic/claude-opus-4.6',
		'deepseek/deepseek-v3.2', 'qwen/qwen3-max', 'qwen/qwen-plus', 'qwen/qwen3.6-plus', 'qwen/qwen3-coder-plus', 'qwen/qwen3-coder-flash'].includes(id)) { return 'explicit'; }
	if (/^openai\/(?:gpt-(?:4o|4\.1|[56])|o[134](?:-|$))/.test(id)
		|| ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash', 'google/gemini-2.5-pro'].includes(id)) { return 'automatic'; }
	return undefined;
}
