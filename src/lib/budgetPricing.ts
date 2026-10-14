import prisma from '@/lib/prisma';
import { BudgetError } from './budget';
import { costMicros } from './budgetPolicy';
import { screenshotCount, supportsScreenshots } from './llm/vision';
import { countBedrockInput } from './llm/bedrock';

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
	const requested = body.max_completion_tokens ?? body.max_tokens ?? 4096;
	if (allowImages) { screenshotCount(body.messages); }
	if (!Number.isFinite(requested) || requested < 1) { throw new BudgetError('invalid_output_limit', 'Некорректный лимит ответа.', 400); }
	const messages = body.messages.map(message => ({ role: message.role, content: Array.isArray(message.content) ? message.content.map(part => part.type === 'image_url' ? { type: 'image_url', image_url: { url: part.image_url.url } } : { type: 'text', text: part.text }) : message.content,
		tool_call_id: message.tool_call_id, tool_calls: message.tool_calls }));
	const tools = body.tools?.map(tool => ({ type: 'function', function: tool.function }));
	return { model: body.model, messages, tools, stream: body.stream === true,
		max_tokens: Math.min(Math.floor(requested), 4096), temperature: body.temperature,
		tool_choice: body.tool_choice, stream_options: { include_usage: true } };
}

export async function budgetPrice(body: BudgetBody, source: string, model: string) {
	let input = 0;
	let output = 0;
	if (source === 'bedrock') {
		const row = await prisma.bedrockModel.findUnique({ where: { id: model } });
		if (row?.inputPerMillion == null || row.outputPerMillion == null) {
			throw new BudgetError('pricing_unavailable', 'Для модели не задана цена API. Администратору нужно обновить каталог Bedrock.', 503);
		}
		input = row.inputPerMillion;
		output = row.outputPerMillion;
	} else if (!model.endsWith(':free')) {
		const response = await fetch('https://openrouter.ai/api/v1/models', { cache: 'no-store' });
		if (!response.ok) { throw new BudgetError('pricing_unavailable', 'Каталог цен API временно недоступен.', 503); }
		const catalog = await response.json() as { data: Array<{ id: string; pricing?: { prompt?: string; completion?: string; request?: string } }> };
		const price = catalog.data?.find(row => row.id === model)?.pricing;
		if (!price || price.prompt == null || price.completion == null || Number(price.request || 0) !== 0) {
			throw new BudgetError('pricing_unavailable', 'Модель не имеет поддерживаемого тарифа за токены.', 503);
		}
		input = Number(price.prompt) * 1_000_000;
		output = Number(price.completion) * 1_000_000;
		body.provider = { max_price: { prompt: input, completion: output, request: 0 }, require_parameters: true };
	}
	if (![input, output].every(value => Number.isFinite(value) && value >= 0)) {
		throw new BudgetError('pricing_unavailable', 'Некорректная цена API в каталоге.', 503);
	}
	// One token per UTF-8 byte plus protocol overhead: deliberately conservative reservation.
	const images = screenshotCount(body.messages);
	if (images && (source !== 'bedrock' || !supportsScreenshots(model))) { throw new BudgetError('vision_unavailable', 'Для скриншотов выберите Claude через Bedrock.', 400); }
	const promptUpperBound = images ? await countBedrockInput(body, model)
		: Buffer.byteLength(JSON.stringify({ messages: body.messages, tools: body.tools }), 'utf8') + 1024 + body.messages.length * 32;
	if (promptUpperBound > 200_000) { throw new BudgetError('context_too_large', 'Уменьшите контекст: внутренний тест ограничивает размер запроса.', 400); }
	return { input, output, reservedMicros: costMicros(promptUpperBound, body.max_tokens || 4096, input, output) };
}
