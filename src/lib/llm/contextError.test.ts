import assert from 'node:assert/strict';
import test from 'node:test';
import { isContextError } from './contextError.ts';

test('only explicit provider context overflows are treated as context errors', () => {
	const cases: Array<[number, string]> = [
		[400, JSON.stringify({ error: { code: 'bedrock_error', message: 'Input is too long for requested model.' } })],
		[400, JSON.stringify({ error: { code: 'context_length_exceeded', message: 'x' } })],
		[400, JSON.stringify({ error: 'This model\'s maximum context length is 131072 tokens. However, you requested 140000 tokens' })],
		[400, JSON.stringify({ error: { code: 'bedrock_error', message: 'Malformed input request: tool name is invalid' } })],
		[429, JSON.stringify({ error: { message: 'Input is too long for requested model.' } })],
		[400, 'not json'],
	];
	assert.deepStrictEqual(cases.map(([status, text]) => isContextError(status, text)), [true, true, true, false, false, false]);
});
