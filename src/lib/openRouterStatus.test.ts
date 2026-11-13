import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseRoutedModel, isModelAccessDenied, isRejected, rememberRejected } from './openRouterStatus.ts';

test('a harness-only refusal counts as access denied, moderation does not', () => {
	// 2026-11-13: inkling-2-small:free answered 403 to every request routed to it.
	const harness = '{"error":{"message":"thinkingmachines/inkling-2-small:free is only available on agentic harnesses.","code":403}}';
	assert.deepEqual(
		[isModelAccessDenied(403, harness), isModelAccessDenied(403, '{"error":{"message":"Input was flagged by moderation"}}'), isModelAccessDenied(429, harness)],
		[true, false, false],
	);
});

test('a refused model stays out of routing for six hours', () => {
	const start = 1_000_000;
	rememberRejected('refused:free', start);
	assert.deepEqual(
		[isRejected('refused:free', start + 5 * 60 * 60 * 1000), isRejected('refused:free', start + 6 * 60 * 60 * 1000), isRejected('other:free', start)],
		[true, false, false],
	);
});

test('routing skips a red refused model and takes the next healthy one', () => {
	const lights = new Map([['busy:free', 'red'], ['refused:free', 'red'], ['ok:free', 'green']] as const);
	assert.deepEqual(chooseRoutedModel('busy:free', lights, ['refused:free', 'ok:free']), { model: 'ok:free', routedFrom: 'busy:free' });
});
