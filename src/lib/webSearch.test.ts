import assert from 'node:assert/strict';
import test from 'node:test';
import { parseYandexSearchXml, searchConfigured, searchWeb } from './webSearch.ts';

test('parseYandexSearchXml keeps http documents and strips highlight tags', () => {
	const xml = `<doc><url>https://example.com/a</url><title>Hello <hlword>world</hlword></title><passages><passage>One &amp; two</passage></passages></doc><doc><url>javascript:alert(1)</url><title>bad</title></doc>`;
	assert.deepEqual(parseYandexSearchXml(xml), [{ title: 'Hello world', url: 'https://example.com/a', snippet: 'One & two' }]);
});

test('selects Exa Lite explicitly and preserves the existing Yandex configuration', async t => {
	const keys = ['WEB_SEARCH_PROVIDER', 'EXA_API_KEY', 'YANDEX_SEARCH_API_KEY', 'YANDEX_SEARCH_FOLDER_ID'];
	const original = keys.map(key => [key, process.env[key]] as const);
	t.after(() => {
		for (const [key, value] of original) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});
	process.env.EXA_API_KEY = 'test-exa';
	process.env.YANDEX_SEARCH_API_KEY = 'test-yandex';
	process.env.YANDEX_SEARCH_FOLDER_ID = 'test-folder';

	const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
		if (url === 'https://api.exa.ai/search') {
			assert.equal(new Headers(init.headers).get('x-api-key'), 'test-exa');
			assert.deepEqual(JSON.parse(String(init.body)), {
				query: 'Новости', type: 'lite', numResults: 5, contents: { highlights: true },
			});
			return Response.json({ results: [
				{ url: 'https://example.com/exa', title: 'Новости', highlights: [' ', 'Текст источника'] },
				{ url: 'javascript:alert(1)', title: 'Invalid link' },
			] });
		}
		assert.equal(url, 'https://searchapi.api.cloud.yandex.net/v2/web/search');
		assert.equal(new Headers(init.headers).get('Authorization'), 'Api-Key test-yandex');
		const xml = '<doc><url>https://example.com/yandex</url><title>Новости</title><passage>Выдача Яндекса</passage></doc>';
		return Response.json({ rawData: Buffer.from(xml).toString('base64') });
	});

	process.env.WEB_SEARCH_PROVIDER = 'exa';
	assert.equal(searchConfigured(), true);
	assert.deepEqual(await searchWeb(' Новости '), [{ title: 'Новости', url: 'https://example.com/exa', snippet: 'Текст источника' }]);

	delete process.env.EXA_API_KEY;
	assert.equal(searchConfigured(), false);
	assert.deepEqual(await searchWeb('Новости'), []);
	assert.equal(fetchMock.mock.callCount(), 1);

	delete process.env.WEB_SEARCH_PROVIDER;
	assert.equal(searchConfigured(), true);
	assert.deepEqual(await searchWeb('Новости'), [{ title: 'Новости', url: 'https://example.com/yandex', snippet: 'Выдача Яндекса' }]);

	process.env.WEB_SEARCH_PROVIDER = 'off';
	assert.equal(searchConfigured(), false);
	assert.deepEqual(await searchWeb('Новости'), []);
	assert.equal(fetchMock.mock.callCount(), 2);
});
