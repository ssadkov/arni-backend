import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopCorsHeaders } from './desktopCors.ts';

test('only the Arni Code renderer origin gets CORS headers', () => {
	const request = (origin?: string) => ({ headers: new Headers(origin ? { origin } : {}) });
	assert.deepStrictEqual([
		desktopCorsHeaders(request('vscode-file://vscode-app'))['Access-Control-Allow-Origin'],
		desktopCorsHeaders(request('https://evil.example')),
		desktopCorsHeaders(request()),
	], ['vscode-file://vscode-app', {}, {}]);
});
