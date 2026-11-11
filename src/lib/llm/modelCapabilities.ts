/** Bedrock model cards, verified 2026-10-15. Keep native and application limits explicit. */
export type ModelCapabilities = {
	contextWindow: number;
	maxOutputTokens: number;
	vision: boolean;
	region?: string;
	/**
	 * `textOnly`: Bedrock rejects a cachePoint in a message with toolUse or toolResult, so only the
	 * system prompt and text-only user messages can be checkpointed, not the rolling tool history.
	 */
	cache?: { minimumTokens: number; readMultiplier: number; writeMultiplier: number; textOnly?: true };
	/**
	 * False when Bedrock rejects image blocks inside a toolResult ("doesn't support the image field
	 * for user messages") but accepts the same image as a sibling block of that user message.
	 */
	toolResultImages?: false;
};

const qwen: Record<string, ModelCapabilities> = {
	'qwen.qwen3-coder-next': { contextWindow: 262144, maxOutputTokens: 16384, vision: false, region: 'us-east-1' },
	// Bedrock accepted 16000 and finished a 13.7K-token tool call (probe 2026-11-11).
	'qwen.qwen3-next-80b-a3b': { contextWindow: 262144, maxOutputTokens: 16000, vision: false, region: 'us-east-1' },
	'qwen.qwen3-32b-v1:0': { contextWindow: 32768, maxOutputTokens: 8192, vision: false, region: 'us-east-1' },
	'qwen.qwen3-vl-235b-a22b': { contextWindow: 262144, maxOutputTokens: 8192, vision: true, region: 'us-east-1', toolResultImages: false },
	'qwen.qwen3-coder-30b-a3b-v1:0': { contextWindow: 262144, maxOutputTokens: 16384, vision: false, region: 'us-east-1' },
	'qwen.qwen3-coder-480b-a35b-v1:0': { contextWindow: 131072, maxOutputTokens: 16384, vision: false, region: 'us-west-2' },
	'qwen.qwen3-235b-a22b-2507-v1:0': { contextWindow: 262144, maxOutputTokens: 8192, vision: false, region: 'us-west-2' },
};

/**
 * Added 2026-10-29 after a live Converse tool-call and exact-copy check. Context is a conservative
 * lower bound, not the vendor maximum; AWS lists no cache tariff for these models.
 */
const openWeight: Record<string, ModelCapabilities> = {
	'deepseek.v3.2': { contextWindow: 131072, maxOutputTokens: 8192, vision: false, region: 'us-east-1' },
	'minimax.minimax-m2.5': { contextWindow: 131072, maxOutputTokens: 8192, vision: false, region: 'us-east-1' },
	// Reads a contract page exactly from a screenshot (verified 2026-10-30), but only outside toolResult.
	// Bedrock accepted 16000 (probe 2026-11-11); at the limit it reports tool_use with cut JSON, see finishReason.
	'moonshotai.kimi-k2.5': { contextWindow: 131072, maxOutputTokens: 16000, vision: true, region: 'us-east-1', toolResultImages: false },
	// Streamed a tool call over 65K input tokens and passed the ffmpeg agent benchmark 2/3 with a frame check (2026-11-09).
	// Bedrock accepted 16000 (probe 2026-11-11); same cut-JSON tool_use at the limit as Kimi.
	'zai.glm-5': { contextWindow: 131072, maxOutputTokens: 16000, vision: false, region: 'us-east-1' },
};

export const QWEN3_MODEL_IDS = Object.keys(qwen);
export const OPEN_WEIGHT_MODEL_IDS = Object.keys(openWeight);
/** Fallback answer cap for a paid model without a verified card. */
export const MANAGED_MAX_OUTPUT_TOKENS = 4096;
export const FREE_MAX_OUTPUT_TOKENS = 16000;
/** Highest answer cap the Bedrock route sends; it bounds the per-step budget reservation. */
export const BEDROCK_MAX_OUTPUT_TOKENS = 16000;

export function modelCapabilities(model: string): ModelCapabilities {
	if (qwen[model]) { return qwen[model]; }
	if (openWeight[model]) { return openWeight[model]; }
	// AWS tariff: cache read is 25% of input, cache write is free. Premier is end of life and stays out.
	const nova = /amazon\.nova-(micro|lite|pro|2-lite)-/.exec(model)?.[1];
	if (nova) {
		return { contextWindow: nova === 'micro' ? 128000 : 300000, maxOutputTokens: MANAGED_MAX_OUTPUT_TOKENS, vision: nova !== 'micro',
			cache: { minimumTokens: 1000, readMultiplier: 0.25, writeMultiplier: 0, textOnly: true } };
	}
	if (/anthropic\.claude-sonnet-4-6/.test(model)) {
		return { contextWindow: 1_000_000, maxOutputTokens: 64000, vision: true,
			cache: { minimumTokens: 2048, readMultiplier: 0.1, writeMultiplier: 1.25 } };
	}
	if (/anthropic\.claude-(?:sonnet|haiku)-4-5/.test(model)) {
		return { contextWindow: 200000, maxOutputTokens: 64000, vision: true,
			cache: { minimumTokens: model.includes('haiku') ? 4096 : 1024, readMultiplier: 0.1, writeMultiplier: 1.25 } };
	}
	return { contextWindow: 32768, maxOutputTokens: MANAGED_MAX_OUTPUT_TOKENS,
		vision: /anthropic\.claude-(?:3|sonnet-4|opus-4|haiku-4)/i.test(model) };
}

/**
 * Answer cap for a paid model: its native limit, bounded by the Bedrock route. A whole file
 * written in one tool call needs well over 4096 tokens; a cut tool call is dropped by the client.
 */
export function managedOutputLimit(model: string): number {
	return Math.min(modelCapabilities(model).maxOutputTokens, BEDROCK_MAX_OUTPUT_TOKENS);
}

/** Mirrors the response cap enforced by managedBody, rather than advertising unusable output. */
export function managedModelMetadata(model: string) {
	const capability = modelCapabilities(model);
	return {
		arni_cache: capability.cache ? 'explicit' : undefined,
		context_length: capability.contextWindow,
		arni_native_max_output_tokens: capability.maxOutputTokens,
		top_provider: { context_length: capability.contextWindow,
			max_completion_tokens: managedOutputLimit(model) },
		architecture: { input_modalities: capability.vision ? ['text', 'image'] : ['text'] },
	};
}
