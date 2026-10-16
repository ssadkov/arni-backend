// Copyright (c) Microsoft Corporation. Licensed under the MIT License.
import catalog from '@/lib/skills/library.json';

const headers = {
	'Content-Type': 'application/json; charset=utf-8',
	'Cache-Control': 'public, max-age=60, s-maxage=60',
	'Access-Control-Allow-Origin': '*',
	ETag: '"' + catalog.revision + '"',
};

/** Public, generic profession pack only. No account data, credentials or uploaded files. */
export async function GET(request: Request) {
	if (request.headers.get('if-none-match') === headers.ETag) {
		return new Response(null, { status: 304, headers });
	}
	return Response.json(catalog, { headers });
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
}
