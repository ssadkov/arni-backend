export type WebSearchHit = { title: string; url: string; snippet: string };

type WebSearch = (query: string) => Promise<WebSearchHit[]>;

const RESULT_LIMIT = 5;
const SNIPPET_LIMIT = 240;
const TAG = /<[^>]+>/g;

function textOf(value: string) {
	return value.replace(TAG, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/** Pull the first documents out of a Yandex Search API XML payload. */
export function parseYandexSearchXml(xml: string, limit = RESULT_LIMIT): WebSearchHit[] {
	const hits: WebSearchHit[] = [];
	const docs = xml.match(/<doc\b[^>]*>[\s\S]*?<\/doc>/g) ?? [];
	for (const doc of docs) {
		if (hits.length >= limit) {
			break;
		}
		const url = textOf(doc.match(/<url>([\s\S]*?)<\/url>/)?.[1] ?? '');
		const title = textOf(doc.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
		const snippet = textOf(doc.match(/<passage>([\s\S]*?)<\/passage>/)?.[1] ?? '').slice(0, SNIPPET_LIMIT);
		if (!url.startsWith('https://') && !url.startsWith('http://')) {
			continue;
		}
		hits.push({ title: title || url, url, snippet });
	}
	return hits;
}

async function searchYandex(query: string, key: string, folderId: string): Promise<WebSearchHit[]> {
	const response = await fetch('https://searchapi.api.cloud.yandex.net/v2/web/search', {
		method: 'POST',
		headers: { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query: { searchType: 'SEARCH_TYPE_RU', queryText: query, familyMode: 'FAMILY_MODE_MODERATE' },
			folderId,
			groupSpec: { groupMode: 'GROUP_MODE_FLAT', groupsOnPage: RESULT_LIMIT, docsInGroup: 1 },
			maxPassages: 1,
			responseFormat: 'FORMAT_XML',
		}),
		redirect: 'error',
		signal: AbortSignal.timeout(12_000),
	});
	if (!response.ok) {
		return [];
	}
	const payload = await response.json() as { rawData?: string; xml?: string };
	const xml = payload.rawData ? Buffer.from(payload.rawData, 'base64').toString('utf8') : payload.xml || '';
	return parseYandexSearchXml(xml);
}

async function searchExa(query: string, key: string): Promise<WebSearchHit[]> {
	const response = await fetch('https://api.exa.ai/search', {
		method: 'POST',
		headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query,
			type: 'lite',
			numResults: RESULT_LIMIT,
			contents: { highlights: true },
		}),
		redirect: 'error',
		signal: AbortSignal.timeout(12_000),
	});
	if (!response.ok) {
		console.warn('Exa web search failed', response.status);
		return [];
	}
	const payload = await response.json() as {
		results?: Array<{ url?: string; title?: string; highlights?: string[] } | null>;
	} | null;
	if (!Array.isArray(payload?.results)) {
		return [];
	}
	const hits: WebSearchHit[] = [];
	for (const result of payload.results.slice(0, RESULT_LIMIT)) {
		const url = typeof result?.url === 'string' ? result.url.trim() : '';
		if (!/^https?:\/\//i.test(url)) {
			continue;
		}
		const title = typeof result?.title === 'string' ? result.title.trim().slice(0, SNIPPET_LIMIT) : '';
		const highlight = Array.isArray(result?.highlights)
			? result.highlights.find(value => typeof value === 'string' && value.trim())
			: undefined;
		hits.push({ title: title || url, url, snippet: highlight?.trim().slice(0, SNIPPET_LIMIT) ?? '' });
	}
	return hits;
}

function configuredSearch(): WebSearch | undefined {
	switch (process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase() || 'yandex') {
		case 'exa': {
			const key = process.env.EXA_API_KEY?.trim();
			return key ? query => searchExa(query, key) : undefined;
		}
		case 'yandex': {
			const key = process.env.YANDEX_SEARCH_API_KEY?.trim();
			const folderId = process.env.YANDEX_SEARCH_FOLDER_ID?.trim();
			return key && folderId ? query => searchYandex(query, key, folderId) : undefined;
		}
		default:
			return undefined;
	}
}

export function searchConfigured() {
	return Boolean(configuredSearch());
}

export async function searchWeb(query: string): Promise<WebSearchHit[]> {
	const search = configuredSearch();
	const trimmed = query.trim().slice(0, 300);
	if (!search || !trimmed) {
		return [];
	}
	try {
		return await search(trimmed);
	} catch (error) {
		console.warn('Web search request failed', error instanceof Error ? error.name : 'unknown');
		return [];
	}
}
