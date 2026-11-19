import assert from 'node:assert/strict';
import test from 'node:test';
import { requestClient } from './requestClient.ts';

test('requestClient keeps the three known apps and rejects everything else', () => {
	assert.equal(requestClient('web'), 'web');
	assert.equal(requestClient(' Arni '), 'arni');
	assert.equal(requestClient('ARNI-CODE'), 'arni-code');
	assert.equal(requestClient(null), 'unknown');
	assert.equal(requestClient(''), 'unknown');
	assert.equal(requestClient('arni-lite'), 'unknown');
	assert.equal(requestClient('web\narni'), 'unknown');
});
