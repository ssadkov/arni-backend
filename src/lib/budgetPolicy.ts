export const USD_MICROS = 1_000_000;
export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
	prompt_tokens_details?: { cached_tokens: number; cache_creation_input_tokens: number } };

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
	const write = details?.cache_creation_input_tokens ?? 0;
	if (![read, write].every(count => Number.isSafeInteger(count) && Number(count) >= 0) || Number(read) + Number(write) > Number(prompt)) { return null; }
	return { prompt_tokens: Number(prompt), completion_tokens: Number(completion), cost,
		...(details ? { prompt_tokens_details: { cached_tokens: Number(read), cache_creation_input_tokens: Number(write) } } : {}) };
}

/** Incremental UTF-8/SSE parser: network chunks need not end on event boundaries. */
export class UsageParser {
	private readonly decoder = new TextDecoder();
	private pending = '';
	usage: ReportedUsage | null = null;

	push(chunk: Uint8Array, final = false): void {
		this.pending += this.decoder.decode(chunk, { stream: !final });
		const lines = this.pending.split('\n');
		this.pending = final ? '' : lines.pop() || '';
		for (const line of lines) {
			if (!line.startsWith('data:')) { continue; }
			try {
				const data = JSON.parse(line.slice(5).trim());
				const usage = validUsage(data.usage);
				if (usage) { this.usage = usage; }
			} catch { /* Comments, [DONE], or non-JSON events. */ }
		}
		// Refuse unbounded/malformed events instead of accumulating an entire response.
		if (this.pending.length > 1_000_000) { throw new Error('SSE event too large'); }
	}
}
