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
	const validators = request.headers.get('if-none-match')?.split(',').map(value => value.trim().replace(/^W\//, '')) ?? [];
	if (validators.includes('*') || validators.includes(headers.ETag)) {
		return new Response(null, { status: 304, headers });
	}
	return Response.json(catalog, { headers });
}

export async function OPTIONS() {
	return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'If-None-Match' } });
}
