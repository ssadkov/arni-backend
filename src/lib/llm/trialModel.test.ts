import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepSeekPick, isTrialPick, PAID_DEEPSEEK_MODEL, paidDeepSeekKey, paidDeepSeekRow, TRIAL_MAX_OUTPUT_TOKENS, TRIAL_MODEL, TRIAL_PICKER_ID, trialAllowed, trialCatalogRow, trialDailyLimitMicros, trialDayStart, trialProvider } from './trialModel.ts';

const KEYS = ['OPENROUTER_TRIAL_API_KEY', 'DEEPSEEK_TRIAL_EMAILS', 'DEEPSEEK_TRIAL_DAILY_USD', 'DEEPSEEK_TRIAL_PROVIDERS', 'DEEPSEEK_TRIAL_MAX_PROMPT_USD', 'DEEPSEEK_TRIAL_MAX_COMPLETION_USD'];

function withEnv(values: Record<string, string>, run: () => void) {
	const saved = KEYS.map(key => [key, process.env[key]] as const);
	for (const key of KEYS) { delete process.env[key]; }
	Object.assign(process.env, values);
	try { run(); }
	finally {
		for (const [key, value] of saved) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } }
	}
}

test('DeepSeek test is offered only to named accounts and only with its own key', () => {
	withEnv({ DEEPSEEK_TRIAL_EMAILS: ' A@Example.com , b@example.com ' }, () => {
		assert.equal(trialAllowed('a@example.com'), false);
	});
	withEnv({ DEEPSEEK_TRIAL_EMAILS: ' A@Example.com , b@example.com ', OPENROUTER_TRIAL_API_KEY: 'k' }, () => {
		assert.deepEqual(['a@example.com', 'B@EXAMPLE.COM', 'c@example.com'].map(trialAllowed), [true, true, false]);
	});
	assert.deepEqual([TRIAL_PICKER_ID, TRIAL_MODEL, 'gemini/x:free'].map(isTrialPick), [true, false, false]);
});

test('DeepSeek test defaults: $2 a day, Wafer first, price ceiling', () => {
	withEnv({}, () => {
		assert.deepEqual({ limit: trialDailyLimitMicros(), provider: trialProvider() }, {
			limit: 2_000_000,
			provider: { order: ['wafer'], allow_fallbacks: true, require_parameters: true, max_price: { prompt: 0.1, completion: 0.6 } },
		});
	});
	withEnv({ DEEPSEEK_TRIAL_DAILY_USD: '0.5', DEEPSEEK_TRIAL_PROVIDERS: 'wafer, particle', DEEPSEEK_TRIAL_MAX_PROMPT_USD: 'bad' }, () => {
		assert.deepEqual({ limit: trialDailyLimitMicros(), order: trialProvider().order, prompt: trialProvider().max_price.prompt }, { limit: 500_000, order: ['wafer', 'particle'], prompt: 0.1 });
	});
	assert.equal(trialDayStart(new Date('2026-11-19T23:59:00+05:00')).toISOString(), '2026-11-19T00:00:00.000Z');
});

test('DeepSeek picker row keeps OpenRouter metadata under the test id', () => {
	const row = trialCatalogRow([{ id: TRIAL_MODEL, name: 'DeepSeek: V4.1 Flash', context_length: 1_048_576, top_provider: { max_completion_tokens: 65_536 } }], 32_000);
	assert.deepEqual(row && { id: row.id, name: row.name, max: row.top_provider.max_completion_tokens, free: row.arni_free, context: row.context_length },
		{ id: TRIAL_PICKER_ID, name: 'DeepSeek: V4.1 Flash (тест)', max: 32_000, free: false, context: 1_048_576 });
	assert.equal(trialCatalogRow([], 32_000), null);
});

test('Paying accounts get DeepSeek under its real id, on the paid key when one is set', () => {
	const router = [{ id: TRIAL_MODEL, name: 'DeepSeek: V4.1 Flash', top_provider: { max_completion_tokens: 943_718 } }];
	const row = paidDeepSeekRow(router, TRIAL_MAX_OUTPUT_TOKENS);
	assert.deepEqual(row && { id: row.id, name: row.name, max: row.top_provider.max_completion_tokens, recommended: row.arni_recommended },
		{ id: PAID_DEEPSEEK_MODEL, name: 'DeepSeek: V4.1 Flash', max: 64_000, recommended: true });
	assert.deepEqual([TRIAL_PICKER_ID, PAID_DEEPSEEK_MODEL, 'deepseek/deepseek-v4-pro'].map(isDeepSeekPick), [true, true, false]);
	const saved = [process.env.OPENROUTER_PAID_API_KEY, process.env.OPENROUTER_API_KEY];
	try {
		process.env.OPENROUTER_API_KEY = 'main';
		delete process.env.OPENROUTER_PAID_API_KEY;
		const fallback = paidDeepSeekKey();
		process.env.OPENROUTER_PAID_API_KEY = 'paid';
		assert.deepEqual([fallback, paidDeepSeekKey()], ['main', 'paid']);
	} finally {
		if (saved[0] === undefined) { delete process.env.OPENROUTER_PAID_API_KEY; } else { process.env.OPENROUTER_PAID_API_KEY = saved[0]; }
		if (saved[1] === undefined) { delete process.env.OPENROUTER_API_KEY; } else { process.env.OPENROUTER_API_KEY = saved[1]; }
	}
});
