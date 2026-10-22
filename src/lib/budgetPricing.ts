import prisma from '@/lib/prisma';
import { BudgetError } from './budget';
import { costMicros } from './budgetPolicy';
import { screenshotCount, supportsScreenshots } from './llm/vision';
import { MANAGED_MAX_OUTPUT_TOKENS, modelCapabilities } from './llm/modelCapabilities';
import { countBedrockInput } from './llm/bedrock';
import { routerModel, routerCacheMode } from './llm/openRouterCatalog';
import { requestLimits } from './llm/requestLimits';

export type BudgetBody = {
	model: string; messages: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>>;
	stream?: boolean; max_tokens?: number; max_completion_tokens?: number;
	temperature?: number; tool_choice?: unknown; stream_options?: { include_usage: boolean };
	provider?: { max_price: { prompt: number; completion: number; request: number }; require_parameters: boolean };
};

/** Allow embedded screenshots for Bedrock; strip unsupported billable request options. */
export function managedBody(body: BudgetBody, allowImages = false): BudgetBody {
	const textContent = (content: unknown) => content == null || typeof content === 'string' || (Array.isArray(content)
		&& content.every(part => part && typeof part === 'object' && (part.type === 'text' && typeof part.text === 'string' || allowImages && part.type === 'image_url')));
	if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 2000
		|| body.messages.some(message => !message || !textContent(message.content))
		|| (body.tools && (!Array.isArray(body.tools) || body.tools.some(tool => tool.type !== 'function')))) {
		throw new BudgetError('unsupported_request', allowImages
			? 'Поддерживаются текст, PNG/JPEG и инструменты агента. Другие форматы и платные серверные инструменты недоступны.'
			: 'Для этого провайдера поддерживаются текст и инструменты агента. Для скриншотов выберите Claude через Bedrock.', 400);
	}
	const requested = body.max_completion_tokens ?? body.max_tokens ?? MANAGED_MAX_OUTPUT_TOKENS;
	if (allowImages) { screenshotCount(body.messages); }
	if (!Number.isFinite(requested) || requested < 1) { throw new BudgetError('invalid_output_limit', 'Некорректный лимит ответа.', 400); }
	const messages = body.messages.map(message => ({ role: message.role, content: Array.isArray(message.content) ? message.content.map(part => part.type === 'image_url' ? { type: 'image_url', image_url: { url: part.image_url.url } } : { type: 'text', text: part.text }) : message.content,
		tool_call_id: message.tool_call_id, tool_calls: message.tool_calls }));
	const tools = body.tools?.map(tool => ({ type: 'function', function: tool.function }));
	return { model: body.model, messages, tools, stream: body.stream === true,
		max_tokens: Math.min(Math.floor(requested), MANAGED_MAX_OUTPUT_TOKENS), temperature: body.temperature,
		tool_choice: body.tool_choice, stream_options: { include_usage: true } };
}

export async function budgetPrice(body: BudgetBody, source: string, model: string) {
	let input = 0;
	let output = 0;
	let routerWriteRate = 0;
	let routerReadRate: number | undefined;
	let limits = modelCapabilities(model);
	if (source === 'bedrock') {
		const row = await prisma.bedrockModel.findUnique({ where: { id: model } });
		if (row?.inputPerMillion == null || row.outputPerMillion == null) {
			throw new BudgetError('pricing_unavailable', 'Для модели не задана цена API. Администратору нужно обновить каталог Bedrock.', 503);
		}
		input = row.inputPerMillion;
		output = row.outputPerMillion;
	} else if (source === 'openrouter') {
		const metadata = await routerModel(model);
		const contexts = [metadata.context_length, metadata.top_provider?.context_length].filter(value => value != null);
		if (!contexts.length || contexts.some(value => !Number.isSafeInteger(value) || Number(value) < 2)) {
			throw new BudgetError('context_unavailable', 'Для модели не получен размер контекста. Обновите каталог моделей.', 503);
		}
		limits = { ...limits, contextWindow: Math.min(...contexts.map(Number)), maxOutputTokens: metadata.top_provider?.max_completion_tokens ?? MANAGED_MAX_OUTPUT_TOKENS };
		const price = metadata.pricing;
		if (!price || price.prompt == null || price.completion == null || Number(price.request || 0) !== 0) {
			throw new BudgetError('pricing_unavailable', 'Модель не имеет поддерживаемого тарифа за токены.', 503);
		}
		// Reserve the highest published tier and image-token rate. The provider's
		// reported USD cost remains authoritative when settling the reservation.
		input = Math.max(Number(price.prompt), Number(price.image || 0), ...(price.overrides || []).map(tier => Number(tier.prompt || price.prompt))) * 1_000_000;
		output = Math.max(Number(price.completion), ...(price.overrides || []).map(tier => Number(tier.completion || price.completion))) * 1_000_000;
		routerWriteRate = Math.max(Number(price.input_cache_write || 0), ...(price.overrides || []).map(tier => Number(tier.input_cache_write || 0))) * 1_000_000;
		if (price.input_cache_read != null) { routerReadRate = Math.max(Number(price.input_cache_read), ...(price.overrides || []).map(tier => Number(tier.input_cache_read || price.input_cache_read))) * 1_000_000; }
		body.provider = { max_price: { prompt: input, completion: output, request: 0 }, require_parameters: true };
	} else { throw new BudgetError('invalid_provider', 'Неизвестный провайдер модели.', 400); }
	if (![input, output].every(value => Number.isFinite(value) && value >= 0)) {
		throw new BudgetError('pricing_unavailable', 'Некорректная цена API в каталоге.', 503);
	}
	const images = screenshotCount(body.messages);
	if (images) {
		if (source === 'bedrock' && !supportsScreenshots(model)) { throw new BudgetError('vision_unavailable', 'Выберите модель с поддержкой изображений.', 400); }
		if (source === 'openrouter') { await routerModel(model, true); }
	}
	const exactInputTokens = source === 'bedrock' && images && model.includes('anthropic.') ? await countBedrockInput(body, model) : undefined;
	const preflight = requestLimits(body, limits, exactInputTokens);
	body.max_tokens = preflight.maxOutputTokens;
	const cache = source === 'bedrock' ? modelCapabilities(model).cache
		: routerCacheMode(model) === 'explicit' ? { readMultiplier: 0.1, writeMultiplier: 1.25 } : undefined;
	const cacheReadPerMillion = routerReadRate ?? input * (cache?.readMultiplier ?? 1);
	const cacheWritePerMillion = Math.max(routerWriteRate, input * (cache?.writeMultiplier ?? 1));
	return { input, output, cacheReadPerMillion, cacheWritePerMillion, preflight,
		reservedMicros: costMicros(preflight.inputReservationTokens, preflight.maxOutputTokens, Math.max(input, cacheWritePerMillion, routerWriteRate), output) };
}
