import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultFreeModelId } from './modelPicker.ts';

test('a new chat starts on the first free model that is not red, never on a paid one', () => {
	assert.deepEqual(
		[
			defaultFreeModelId([{ id: 'a:free', light: 'red' }, { id: 'b:free', light: 'green' }, { id: 'c:free' }]),
			defaultFreeModelId([{ id: 'a:free', light: 'red' }, { id: 'b:free', light: 'red' }]),
			defaultFreeModelId([]),
		],
		['b:free', 'a:free', undefined],
	);
});
