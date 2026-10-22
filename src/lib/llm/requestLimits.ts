import { BudgetError } from '../budget';
import { MAX_CHAT_BYTES, conservativeInputTokenBound } from './vision';

export type RequestLimits = { contextWindow: number; maxOutputTokens: number };

/** Payload sizes and a billing reserve are not a model tokenizer. Never reject
 * an uncounted prompt by comparing UTF-8 bytes to a token context window. */
export function requestLimits(
	body: { messages: Array<Record<string, unknown>>; tools?: unknown; max_tokens?: number },
	limits: RequestLimits,
	exactInputTokens?: number,
) {
	if (![limits.contextWindow, limits.maxOutputTokens].every(value => Number.isSafeInteger(value) && value > 0)) {
		throw new BudgetError('context_unavailable', 'Не удалось проверить лимиты выбранной модели. Обновите каталог моделей.', 503);
	}
	const messageBytes = Buffer.byteLength(JSON.stringify(body.messages), 'utf8');
	const toolBytes = Buffer.byteLength(JSON.stringify(body.tools ?? []), 'utf8');
	const requestBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
	if (requestBytes > MAX_CHAT_BYTES) {
		throw new BudgetError('request_too_large', 'Размер запроса превышает 3,8 МБ. Уменьшите вложения или объём передаваемых файлов.', 413);
	}
	const maxOutputTokens = Math.min(body.max_tokens ?? limits.maxOutputTokens, limits.maxOutputTokens, limits.contextWindow - 1);
	if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
		throw new BudgetError('invalid_output_limit', 'Некорректный лимит ответа.', 400);
	}
	if (exactInputTokens !== undefined && (!Number.isSafeInteger(exactInputTokens) || exactInputTokens < 0)) {
		throw new BudgetError('token_count_unavailable', 'Не удалось проверить число токенов запроса.', 503);
	}
	if (exactInputTokens !== undefined && exactInputTokens + maxOutputTokens > limits.contextWindow) {
		throw new BudgetError('context_too_large', 'Запрос вместе с резервом для ответа превышает контекст выбранной модели. Сожмите историю или уменьшите вложения. При ошибке в новом чате уменьшите набор инструментов и инструкций.', 400);
	}
	const inputReservationTokens = exactInputTokens ?? Math.min(conservativeInputTokenBound(body.messages, body.tools), limits.contextWindow);
	return {
		requestBytes, messageBytes, toolBytes, contextWindow: limits.contextWindow,
		maxOutputTokens, exactInputTokens: exactInputTokens ?? null,
		// Without the model's tokenizer/API the provider validates the actual context.
		contextValidation: exactInputTokens === undefined ? 'provider' as const : 'counted' as const,
		inputReservationTokens,
	};
}
