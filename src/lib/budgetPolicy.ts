export const USD_MICROS = 1_000_000;
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Longest route maxDuration (chat and image generation) that holds a budget reservation open. */
export const MAX_REQUEST_DURATION_MS = 300 * 1000;
/** A reservation older than this was abandoned by a killed function and must not block the user. */
export const STALE_RESERVATION_MS = 2 * MAX_REQUEST_DURATION_MS;

/**
 * Paid requests one user may have in flight. One agent turn legitimately overlaps requests:
 * a subagent, chat title generation, a second open chat. Each reservation is already
 * deducted from the balance under a row lock, so this bounds bursts, not overspending.
 */
export const MAX_CONCURRENT_RESERVATIONS = 3;

/** Pending reservations created before the returned moment are stale. */
export function staleReservationCutoff(now: Date): Date {
	return new Date(now.getTime() - STALE_RESERVATION_MS);
}

export type BudgetWindow = { usedMicros: number; requests: number; startedAt: Date | null };

export function currentWindow(window: BudgetWindow, duration: number, now: Date): BudgetWindow {
	return !window.startedAt || now.getTime() >= window.startedAt.getTime() + duration
		? { usedMicros: 0, requests: 0, startedAt: null }
		: window;
}

export function costMicros(prompt: number, completion: number, inputPerMillion: number, outputPerMillion: number): number {
	const cost = Math.ceil(prompt * inputPerMillion + completion * outputPerMillion);
	if (!Number.isSafeInteger(cost) || cost < 0 || cost > 2_000_000_000) {
		throw new Error('Invalid usage cost');
	}
	return cost;
}

export type ReportedUsage = { prompt_tokens: number; completion_tokens: number; cost?: number;
	prompt_tokens_details?: { cached_tokens: number; cache_creation_input_tokens: number };
	/** OpenRouter's serving host (`provider` next to `usage`), e.g. "Wafer". */
	host?: string };

/** Attaches OpenRouter's serving host to the usage it was reported with. */
export function withHost(usage: ReportedUsage | null, provider: unknown): ReportedUsage | null {
	const host = metadataText(provider, 60);
	return usage && host ? { ...usage, host } : usage;
}

/** Prompt tokens include all three input buckets; cached tokens must not be billed twice. */
export function usageCostMicros(usage: ReportedUsage, input: number, output: number, cacheRead = input, cacheWrite = input): number {
	const read = usage.prompt_tokens_details?.cached_tokens || 0;
	const write = usage.prompt_tokens_details?.cache_creation_input_tokens || 0;
	return costMicros(1, 0, (usage.prompt_tokens - read - write) * input + usage.completion_tokens * output + read * cacheRead + write * cacheWrite, 0);
}

export function validUsage(value: unknown): ReportedUsage | null {
	if (!value || typeof value !== 'object' || !('prompt_tokens' in value) || !('completion_tokens' in value)) {
		return null;
	}
	const { prompt_tokens: prompt, completion_tokens: completion } = value;
	if (!Number.isSafeInteger(prompt) || !Number.isSafeInteger(completion) || Number(prompt) < 0 || Number(completion) < 0) {
		return null;
	}
	const cost = 'cost' in value && typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0
		? value.cost : undefined;
	const details = 'prompt_tokens_details' in value ? value.prompt_tokens_details as Record<string, unknown> | null : null;
	const read = details?.cached_tokens ?? 0;
	const write = details?.cache_creation_input_tokens ?? details?.cache_write_tokens ?? 0;
	if (![read, write].every(count => Number.isSafeInteger(count) && Number(count) >= 0) || Number(read) + Number(write) > Number(prompt)) { return null; }
	return { prompt_tokens: Number(prompt), completion_tokens: Number(completion), cost,
		...(details ? { prompt_tokens_details: { cached_tokens: Number(read), cache_creation_input_tokens: Number(write) } } : {}) };
}

export type OpenRouterResponseMetadata = {
	generationId?: string;
	host?: string;
	finishReason?: string;
	streamError?: string;
};

export type StreamMetadata = OpenRouterResponseMetadata & { completed: boolean };

function metadataText(value: unknown, limit: number) {
	if (typeof value !== 'string') { return undefined; }
	return value.replaceAll('\0', '').trim().split(/\s+/).join(' ').slice(0, limit) || undefined;
}

function fields(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function openRouterResponseMetadata(payload: unknown): OpenRouterResponseMetadata {
	const data = fields(payload);
	const choice = fields(Array.isArray(data.choices) ? data.choices[0] : undefined);
	const finishReason = metadataText(choice.finish_reason, 60);
	const upstreamError = data.error ?? choice.error;
	const error = fields(upstreamError);
	const code = metadataText(typeof error.code === 'number' ? String(error.code) : error.code, 60);
	const message = metadataText(error.message, 300);
	const streamError = upstreamError != null
		? ([code, message].filter(Boolean).join(': ').slice(0, 300) || 'upstream_error')
		: finishReason === 'error' ? 'finish_reason_error' : undefined;
	return { generationId: openRouterGenerationId(data.id), host: metadataText(data.provider, 60), finishReason, streamError };
}

/** Incremental UTF-8/SSE parser: network chunks need not end on event boundaries. */
export class UsageParser {
	private readonly decoder = new TextDecoder();
	private pending = '';
	private seen: OpenRouterResponseMetadata = {};
	usage: ReportedUsage | null = null;
	done = false;

	streamMetadata(transportFailed = false): StreamMetadata {
		return {
			...this.seen,
			completed: this.done,
			streamError: this.seen.streamError ?? (transportFailed ? 'transport_error' : this.done ? undefined : 'missing_done'),
		};
	}

	push(chunk: Uint8Array, final = false): void {
		this.pending += this.decoder.decode(chunk, { stream: !final });
		const lines = this.pending.split('\n');
		this.pending = final ? '' : lines.pop() || '';
		for (const line of lines) {
			if (!line.startsWith('data:')) { continue; }
			const dataText = line.slice(5).trim();
			if (dataText === '[DONE]') { this.done = true; break; }
			try {
				const data = fields(JSON.parse(dataText));
				const metadata = openRouterResponseMetadata(data);
				this.seen.generationId ??= metadata.generationId;
				this.seen.host = metadata.host ?? this.seen.host;
				this.seen.finishReason = metadata.finishReason ?? this.seen.finishReason;
				this.seen.streamError = metadata.streamError === 'finish_reason_error'
					? this.seen.streamError ?? metadata.streamError : metadata.streamError ?? this.seen.streamError;
				const usage = withHost(validUsage(data.usage), this.seen.host);
				if (usage) { this.usage = usage; }
			} catch { /* Non-JSON events. */ }
		}
		// Refuse unbounded/malformed events instead of accumulating an entire response.
		if (this.pending.length > 1_000_000) { throw new Error('SSE event too large'); }
	}
}

export function openRouterGenerationId(value: unknown) {
	return typeof value === 'string' && /^gen-[a-zA-Z0-9_-]{1,190}$/.test(value) ? value : undefined;
}
