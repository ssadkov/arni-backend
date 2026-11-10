/**
 * The short model list the editor picker shows. The full catalogs stay available to
 * `/chat/completions`; this only decides what `/api/models` offers.
 */

/** Upper bound per category (free / paid) in the picker. */
export const PICKER_LIMIT_PER_CATEGORY = 7;

/** When fewer curated free models are live, other free models fill the list up to this count. */
const MIN_FREE_MODELS = 3;

/**
 * Free OpenRouter models, best first. Verified with Arni tool calls: Nemotron Ultra and
 * North Mini as agent defaults, Nemotron 3.5 Super VL with a real screenshot (2026-10-16),
 * Gemma 4 on file and document tasks (2026-11-10).
 */
export const PICKER_FREE_MODELS: readonly string[] = [
	'nvidia/nemotron-3-ultra-550b-a55b:free',
	'cohere/north-mini-code:free',
	'nvidia/nemotron-3.5-super-vl:free',
	'google/gemma-4-31b-it:free',
	'google/gemma-4-26b-a4b-it:free',
];

/**
 * Paid Bedrock models, best first, by foundation model id (without `us.`/`global.`).
 * Ranked by the 2026-11-09 ffmpeg agent benchmark; Kimi K2.5 is the cheap vision option.
 */
export const PICKER_BEDROCK_MODELS: readonly string[] = [
	'anthropic.claude-sonnet-4-6',
	'anthropic.claude-haiku-4-5-20251001-v1:0',
	'zai.glm-5',
	'minimax.minimax-m2.5',
	'qwen.qwen3-next-80b-a3b',
	'deepseek.v3.2',
	'moonshotai.kimi-k2.5',
];

/** Strips the cross-region inference profile prefix: `global.anthropic.x` → `anthropic.x`. */
function foundationModelId(id: string): string {
	return id.replace(/^(?:us|eu|apac|global)\./, '');
}

/** Whether the picker should lead with this model: it is on one of the curated lists. */
export function isRecommendedModel(id: string): boolean {
	return PICKER_FREE_MODELS.includes(id) || PICKER_BEDROCK_MODELS.includes(foundationModelId(id));
}

/** Curated free models in their order, topped up from the rest when too few are live. */
export function pickFreeModels<T extends { id: string }>(freeModels: readonly T[]): T[] {
	const curated = PICKER_FREE_MODELS.map(id => freeModels.find(model => model.id === id)).filter((model): model is T => !!model);
	const fill = freeModels.filter(model => !curated.includes(model)).slice(0, Math.max(0, MIN_FREE_MODELS - curated.length));
	return [...curated, ...fill].slice(0, PICKER_LIMIT_PER_CATEGORY);
}

/**
 * Curated Bedrock models among those the account may use, one profile per foundation
 * model (the selected one, else `global.`), plus the selected model if it is not curated.
 */
export function pickBedrockModels<T extends { id: string }>(allowed: readonly T[], selectedId: string | null | undefined): T[] {
	const picked: T[] = [];
	for (const base of PICKER_BEDROCK_MODELS) {
		const variants = allowed.filter(model => foundationModelId(model.id) === base);
		const chosen = variants.find(model => model.id === selectedId) ?? variants.find(model => model.id.startsWith('global.')) ?? variants[0];
		if (chosen) {
			picked.push(chosen);
		}
	}
	const result = picked.slice(0, PICKER_LIMIT_PER_CATEGORY);
	const selected = allowed.find(model => model.id === selectedId);
	if (selected && !result.includes(selected)) {
		result.push(selected);
	}
	return result;
}
