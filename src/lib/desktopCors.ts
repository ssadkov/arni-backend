import type { NextRequest } from 'next/server';

/**
 * Origin of the Arni Code renderer (Electron `vscode-file` scheme). The Agents
 * window exchanges the signed-in Yandex, VK or Google session for an Arni JWT
 * with `fetch`, so the exchange needs CORS for this origin. Only Electron apps
 * load pages from this scheme; no cookies are involved.
 */
export const DESKTOP_RENDERER_ORIGIN = 'vscode-file://vscode-app';

export function desktopCorsHeaders(req: Pick<NextRequest, 'headers'>): Record<string, string> {
	if (req.headers.get('origin') !== DESKTOP_RENDERER_ORIGIN) {
		return {};
	}
	return {
		'Access-Control-Allow-Origin': DESKTOP_RENDERER_ORIGIN,
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
		Vary: 'Origin',
	};
}
