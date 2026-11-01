import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYandexSearchXml } from './webSearch.ts';

test('parseYandexSearchXml keeps http documents and strips highlight tags', () => {
	const xml = `<doc><url>https://example.com/a</url><title>Hello <hlword>world</hlword></title><passages><passage>One &amp; two</passage></passages></doc><doc><url>javascript:alert(1)</url><title>bad</title></doc>`;
	assert.deepEqual(parseYandexSearchXml(xml), [{ title: 'Hello world', url: 'https://example.com/a', snippet: 'One & two' }]);
});
