import { NextRequest } from 'next/server';
import { apiPublicOrigin, GOOGLE_VERIFIER_PREFIX, issueLoginCode, readOauthCookie, redirectToApp, sessionFromProviderToken } from '@/lib/webSession';

export async function GET(req: NextRequest) {
	const secure = req.nextUrl.protocol === 'https:';
	const url = req.nextUrl;
	const cookie = readOauthCookie(req);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const deviceId = url.searchParams.get('device_id') || '';
	if (!cookie || !code || !state || cookie.state !== state || cookie.verifier === 'yandex' || cookie.verifier.startsWith(GOOGLE_VERIFIER_PREFIX)) {
		return redirectToApp('/?error=oauth', secure);
	}
	try {
		const redirectUri = `${apiPublicOrigin(req)}/api/web/auth/vk/callback`;
		const tokenResponse = await fetch('https://id.vk.ru/oauth2/auth', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				code_verifier: cookie.verifier,
				client_id: process.env.VK_CLIENT_ID?.trim() || '54785916',
				device_id: deviceId,
				redirect_uri: redirectUri,
				state,
			}),
		});
		const tokenBody = await tokenResponse.json().catch(() => null) as { access_token?: string } | null;
		if (!tokenResponse.ok || !tokenBody?.access_token) {
			return redirectToApp('/?error=oauth', secure);
		}
		const userId = await sessionFromProviderToken('vk', tokenBody.access_token);
		const loginCode = await issueLoginCode(userId);
		return redirectToApp(`/?code=${loginCode}`, secure);
	} catch {
		return redirectToApp('/?error=oauth', secure);
	}
}
