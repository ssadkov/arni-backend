export type WebSearchHit = { title: string; url: string; snippet: string };

const TAG = /<[^>]+>/g;

function textOf(value: string) {
	return value.replace(TAG, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/** Pull the first documents out of a Yandex Search API XML payload. */
export function parseYandexSearchXml(xml: string, limit = 5): WebSearchHit[] {
	const hits: WebSearchHit[] = [];
	const docs = xml.match(/<doc\b[^>]*>[\s\S]*?<\/doc>/g) ?? [];
	for (const doc of docs) {
		if (hits.length >= limit) {
			break;
		}
		const url = textOf(doc.match(/<url>([\s\S]*?)<\/url>/)?.[1] ?? '');
		const title = textOf(doc.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
		const snippet = textOf(doc.match(/<passage>([\s\S]*?)<\/passage>/)?.[1] ?? '').slice(0, 240);
		if (!url.startsWith('https://') && !url.startsWith('http://')) {
			continue;
		}
		hits.push({ title: title || url, url, snippet });
	}
	return hits;
}

export function searchConfigured() {
	return Boolean(process.env.YANDEX_SEARCH_API_KEY && process.env.YANDEX_SEARCH_FOLDER_ID);
}

/** Server-side web search. Returns no hits when the provider is not configured. */
export async function searchWeb(query: string): Promise<WebSearchHit[]> {
	const key = process.env.YANDEX_SEARCH_API_KEY;
	const folderId = process.env.YANDEX_SEARCH_FOLDER_ID;
	const trimmed = query.trim().slice(0, 300);
	if (!key || !folderId || !trimmed) {
		return [];
	}
	const response = await fetch('https://searchapi.api.cloud.yandex.net/v2/web/search', {
		method: 'POST',
		headers: { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			query: { searchType: 'SEARCH_TYPE_RU', queryText: trimmed, familyMode: 'FAMILY_MODE_MODERATE' },
			folderId,
			groupSpec: { groupMode: 'GROUP_MODE_FLAT', groupsOnPage: 5, docsInGroup: 1 },
			maxPassages: 1,
			responseFormat: 'FORMAT_XML',
		}),
		signal: AbortSignal.timeout(12_000),
	});
	if (!response.ok) {
		return [];
	}
	const payload = await response.json() as { rawData?: string; xml?: string };
	const xml = payload.rawData ? Buffer.from(payload.rawData, 'base64').toString('utf8') : payload.xml || '';
	return parseYandexSearchXml(xml);
}
