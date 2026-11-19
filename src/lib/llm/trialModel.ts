import type { RouterModel } from './openRouterCatalog';

/**
 * Paid DeepSeek through OpenRouter, offered as a test to named accounts only (DEEPSEEK_TRIAL_EMAILS).
 * The picker id ends with `:free` so the client lists it with no client change, like the Gemini picker.
 * Arni pays for it: it runs on its own OpenRouter key (OPENROUTER_TRIAL_API_KEY) so the key's spend limit
 * caps the whole test, and each account is capped per UTC day (DEEPSEEK_TRIAL_DAILY_USD).
 */
export const TRIAL_PICKER_ID = 'arni-trial/deepseek-v4.1-flash-1017:free';
export const TRIAL_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
/**
 * DeepSeek thinks by default, and reasoning counts toward the output limit. With the free models' 16K a long
 * answer plus reasoning ran out before the tool call. 64K costs at most ~$0.03 per step at Wafer's $0.50/1M.
 */
export const TRIAL_MAX_OUTPUT_TOKENS = 64_000;

export function isTrialPick(id: unknown): boolean {
	return id === TRIAL_PICKER_ID;
}

function emails(): string[] {
	return (process.env.DEEPSEEK_TRIAL_EMAILS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
}

export function trialAllowed(email: string): boolean {
	return Boolean(process.env.OPENROUTER_TRIAL_API_KEY) && emails().includes(email.toLowerCase());
}

function positive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Per-account spend per UTC day, in USD micro-units. Default $2. */
export function trialDailyLimitMicros(): number {
	return Math.round(positive(process.env.DEEPSEEK_TRIAL_DAILY_USD, 2) * 1_000_000);
}

/**
 * OpenRouter provider routing: Wafer first, other hosts only below the price ceiling (USD per million tokens).
 * Wafer was $0.036 / $0.50 on 2026-11-19; the default ceiling also admits Particle ($0.06 / $0.50).
 */
export function trialProvider() {
	const order = (process.env.DEEPSEEK_TRIAL_PROVIDERS || 'wafer').split(',').map(item => item.trim()).filter(Boolean);
	return {
		order,
		allow_fallbacks: true,
		require_parameters: true,
		max_price: {
			prompt: positive(process.env.DEEPSEEK_TRIAL_MAX_PROMPT_USD, 0.1),
			completion: positive(process.env.DEEPSEEK_TRIAL_MAX_COMPLETION_USD, 0.6),
		},
	};
}

/** Start of the current UTC day. */
export function trialDayStart(now = new Date()): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Picker row in the shape of the OpenRouter catalog; prices are OpenRouter's, shown to the tester. */
export function trialCatalogRow(router: readonly RouterModel[], maxCompletionTokens: number) {
	const model = router.find(row => row.id === TRIAL_MODEL);
	if (!model) { return null; }
	return {
		...model,
		id: TRIAL_PICKER_ID,
		name: `${model.name} (тест)`,
		top_provider: { ...model.top_provider, max_completion_tokens: Math.min(model.top_provider?.max_completion_tokens || maxCompletionTokens, maxCompletionTokens) },
		arni_provider: 'openrouter', arni_free: false, arni_default: false, arni_traffic: 'unknown', arni_recommended: false,
	};
}

/**
 * DeepSeek for paying accounts (those with an AccountBudget): the real OpenRouter id, billed from the account's
 * budget at OpenRouter's reported cost. Same routing and output limit as the test. Runs on OPENROUTER_PAID_API_KEY
 * when set (its own spend limit), otherwise on the main key.
 */
export const PAID_DEEPSEEK_MODEL = TRIAL_MODEL;

/** Both DeepSeek ids reason before acting and get the long output limit whatever the client asks. */
export function isDeepSeekPick(id: unknown): boolean {
	return id === TRIAL_PICKER_ID || id === PAID_DEEPSEEK_MODEL;
}

export function paidDeepSeekKey(): string | undefined {
	return process.env.OPENROUTER_PAID_API_KEY || process.env.OPENROUTER_API_KEY || undefined;
}

/** Picker row for paying accounts, under the real id; prices are OpenRouter's model-level ones. */
export function paidDeepSeekRow(router: readonly RouterModel[], maxCompletionTokens: number) {
	const row = trialCatalogRow(router, maxCompletionTokens);
	if (!row) { return null; }
	const model = router.find(item => item.id === PAID_DEEPSEEK_MODEL)!;
	return { ...row, id: PAID_DEEPSEEK_MODEL, name: model.name, arni_recommended: true };
}
