/** Bedrock model cards, verified 2026-10-15. Keep native and application limits explicit. */
export type ModelCapabilities = {
	contextWindow: number;
	maxOutputTokens: number;
	vision: boolean;
	region?: string;
	cache?: { minimumTokens: number; readMultiplier: number; writeMultiplier: number };
};

const qwen: Record<string, ModelCapabilities> = {
	'qwen.qwen3-coder-next': { contextWindow: 262144, maxOutputTokens: 16384, vision: false, region: 'us-east-1' },
	'qwen.qwen3-next-80b-a3b': { contextWindow: 262144, maxOutputTokens: 8192, vision: false, region: 'us-east-1' },
	'qwen.qwen3-32b-v1:0': { contextWindow: 32768, maxOutputTokens: 8192, vision: false, region: 'us-east-1' },
	'qwen.qwen3-vl-235b-a22b': { contextWindow: 262144, maxOutputTokens: 8192, vision: true, region: 'us-east-1' },
	'qwen.qwen3-coder-30b-a3b-v1:0': { contextWindow: 262144, maxOutputTokens: 16384, vision: false, region: 'us-east-1' },
	'qwen.qwen3-coder-480b-a35b-v1:0': { contextWindow: 131072, maxOutputTokens: 16384, vision: false, region: 'us-west-2' },
	'qwen.qwen3-235b-a22b-2507-v1:0': { contextWindow: 262144, maxOutputTokens: 8192, vision: false, region: 'us-west-2' },
};

export const QWEN3_MODEL_IDS = Object.keys(qwen);
export const MANAGED_MAX_OUTPUT_TOKENS = 4096;

export function modelCapabilities(model: string): ModelCapabilities {
	if (qwen[model]) { return qwen[model]; }
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

/** Mirrors the response cap enforced by managedBody, rather than advertising unusable output. */
export function managedModelMetadata(model: string) {
	const capability = modelCapabilities(model);
	return {
		context_length: capability.contextWindow,
		arni_native_max_output_tokens: capability.maxOutputTokens,
		top_provider: { context_length: capability.contextWindow,
			max_completion_tokens: Math.min(capability.maxOutputTokens, MANAGED_MAX_OUTPUT_TOKENS) },
		architecture: { input_modalities: capability.vision ? ['text', 'image'] : ['text'] },
	};
}
