import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBraveWebSearch, parseYandexSearchXml, searchConfigured, searchExaWeb, searchWeb } from './webSearch.ts';

test('parseYandexSearchXml keeps http documents and strips highlight tags', () => {
	const xml = `<doc><url>https://example.com/a</url><title>Hello <hlword>world</hlword></title><passages><passage>One &amp; two</passage></passages></doc><doc><url>javascript:alert(1)</url><title>bad</title></doc>`;
	assert.deepEqual(parseYandexSearchXml(xml), [{ title: 'Hello world', url: 'https://example.com/a', snippet: 'One & two' }]);
});

test('parseBraveWebSearch keeps http documents and drops other urls', () => {
	assert.deepEqual(parseBraveWebSearch({
		web: { results: [
			{ title: 'Docs', url: 'https://example.com/docs', description: 'Reference' },
			{ title: 'Script', url: 'javascript:alert(1)', description: 'nope' },
		] },
	}), [{ title: 'Docs', url: 'https://example.com/docs', snippet: 'Reference' }]);
});

test('selects Exa Lite explicitly and preserves the existing Yandex configuration', async t => {
	const keys = ['WEB_SEARCH_PROVIDER', 'EXA_API_KEY', 'BRAVE_SEARCH_API_KEY', 'YANDEX_SEARCH_API_KEY', 'YANDEX_SEARCH_FOLDER_ID'];
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
	process.env.BRAVE_SEARCH_API_KEY = 'test-brave';
	process.env.YANDEX_SEARCH_API_KEY = 'test-yandex';
	process.env.YANDEX_SEARCH_FOLDER_ID = 'test-folder';

	const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
		const target = String(url);
		if (target === 'https://api.exa.ai/search') {
			assert.equal(new Headers(init.headers).get('x-api-key'), 'test-exa');
			assert.deepEqual(JSON.parse(String(init.body)), {
				query: 'Новости', type: 'lite', numResults: 5, contents: { highlights: true },
			});
			return Response.json({ results: [
				{ url: 'https://example.com/exa', title: 'Новости', highlights: [' ', 'Текст источника'] },
				{ url: 'javascript:alert(1)', title: 'Invalid link' },
			] });
		}
		if (target.startsWith('https://api.search.brave.com/res/v1/web/search')) {
			assert.equal(new Headers(init.headers).get('X-Subscription-Token'), 'test-brave');
			assert.equal(new URL(target).searchParams.get('q'), 'Новости');
			return Response.json({ web: { results: [{ title: 'Brave', url: 'https://example.com/brave', description: 'Сниппет' }] } });
		}
		assert.equal(target, 'https://searchapi.api.cloud.yandex.net/v2/web/search');
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

	process.env.WEB_SEARCH_PROVIDER = 'brave';
	assert.equal(searchConfigured(), true);
	assert.deepEqual(await searchWeb('Новости'), [{ title: 'Brave', url: 'https://example.com/brave', snippet: 'Сниппет' }]);

	delete process.env.WEB_SEARCH_PROVIDER;
	assert.equal(searchConfigured(), true);
	assert.deepEqual(await searchWeb('Новости'), [{ title: 'Новости', url: 'https://example.com/yandex', snippet: 'Выдача Яндекса' }]);

	process.env.WEB_SEARCH_PROVIDER = 'off';
	assert.equal(searchConfigured(), false);
	assert.deepEqual(await searchWeb('Новости'), []);
	assert.equal(fetchMock.mock.callCount(), 3);
});

test('agent search uses Exa even when the web-chat provider is Yandex', async t => {
	const keys = ['WEB_SEARCH_PROVIDER', 'EXA_API_KEY'] as const;
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
	delete process.env.WEB_SEARCH_PROVIDER;
	process.env.EXA_API_KEY = 'agent-exa';
	t.mock.method(globalThis, 'fetch', async (url: string | URL, init: RequestInit) => {
		assert.equal(String(url), 'https://api.exa.ai/search');
		assert.equal(new Headers(init.headers).get('x-api-key'), 'agent-exa');
		return Response.json({ results: [{ url: 'https://example.com/agent', title: 'Agent', highlights: ['From Exa'] }] });
	});
	assert.deepEqual(await searchExaWeb('query'), [{ title: 'Agent', url: 'https://example.com/agent', snippet: 'From Exa' }]);
	delete process.env.EXA_API_KEY;
	assert.equal(await searchExaWeb('query'), undefined);
});
