import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMarkup, percentFromTable } from './billingMarkup.ts';

test('default markup doubles a paid model and skips free models', () => {
	const table = new Map<string, number>();
	assert.equal(percentFromTable(table, { source: 'bedrock', model: 'claude' }), 100);
	assert.equal(percentFromTable(table, { source: 'openrouter', model: 'qwen:free' }), 0);
	assert.equal(applyMarkup(40_000, 100), 80_000);
	assert.equal(applyMarkup(40_000, 0), 40_000);
});

test('model markup wins over provider and global', () => {
	const table = new Map<string, number>([
		['global', 100],
		['provider:bedrock', 50],
		['provider:image', 25],
		['model:claude', 10],
	]);
	assert.equal(percentFromTable(table, { source: 'bedrock', model: 'claude' }), 10);
	assert.equal(percentFromTable(table, { source: 'bedrock', model: 'other' }), 50);
	assert.equal(percentFromTable(table, { source: 'bedrock', model: 'stability.core', operation: 'image' }), 25);
	assert.equal(percentFromTable(table, { source: 'openrouter', model: 'paid' }), 100);
});
