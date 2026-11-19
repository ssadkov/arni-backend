import assert from 'node:assert/strict';
import test from 'node:test';
import { pruneScreenshots, PRUNED_SCREENSHOT_TEXT } from './screenshotHistory.ts';

const image = (id: string, bytes = 30) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${id.padEnd(Math.ceil(bytes * 4 / 3), 'A')}` } });
const shape = (messages: Array<{ role: string; content: unknown }>) => messages.map(message => Array.isArray(message.content)
	? message.content.map((part: { type: string; text?: string; image_url?: { url: string } }) => part.type === 'image_url' ? part.image_url!.url.slice(22, 24) : part.text === PRUNED_SCREENSHOT_TEXT ? 'pruned' : part.text)
	: message.content);

test('Old screenshots become a note; the newest ones are kept in place', () => {
	const messages = [
		{ role: 'user', content: 'Сделай змейку' },
		{ role: 'tool', content: [image('s1'), { type: 'text', text: 'shot 1' }] },
		{ role: 'tool', content: [image('s2')] },
		{ role: 'tool', content: [image('s3'), image('s4')] },
		{ role: 'assistant', content: 'ok' },
	];
	assert.deepEqual(shape(pruneScreenshots(messages, 3)), [
		'Сделай змейку', ['pruned', 'shot 1'], ['s2'], ['s3', 's4'], 'ok',
	]);
	assert.deepEqual(shape(messages)[1], ['s1', 'shot 1'], 'input is not mutated');
});

test('The byte budget prunes before the count does', () => {
	const messages = [{ role: 'tool', content: [image('a1', 600)] }, { role: 'tool', content: [image('b2', 600)] }];
	assert.deepEqual(shape(pruneScreenshots(messages, 6, 1000)), [['pruned'], ['b2']]);
	assert.deepEqual(shape(pruneScreenshots([{ role: 'user', content: 'text only' }])), ['text only']);
});
