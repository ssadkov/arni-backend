import { NextRequest } from 'next/server';
import { apiPublicOrigin, clearOauthCookie, issueLoginCode, readOauthCookie, redirectToApp, sessionFromProviderToken } from '@/lib/webSession';

export async function GET(req: NextRequest) {
	const secure = req.nextUrl.protocol === 'https:';
	const url = req.nextUrl;
	const cookie = readOauthCookie(req);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	if (!cookie || !code || !state || cookie.state !== state || cookie.verifier !== 'yandex') {
		return redirectToApp('/?error=oauth', secure);
	}
	try {
		const redirectUri = `${apiPublicOrigin(req)}/api/web/auth/yandex/callback`;
		const tokenResponse = await fetch('https://oauth.yandex.ru/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				client_id: process.env.YANDEX_OAUTH_CLIENT_ID || '',
				client_secret: process.env.YANDEX_OAUTH_CLIENT_SECRET || '',
				redirect_uri: redirectUri,
			}),
		});
		const tokenBody = await tokenResponse.json().catch(() => null) as { access_token?: string } | null;
		if (!tokenResponse.ok || !tokenBody?.access_token) {
			return redirectToApp('/?error=oauth', secure);
		}
		const userId = await sessionFromProviderToken('yandex', tokenBody.access_token);
		const loginCode = await issueLoginCode(userId);
		return redirectToApp(`/?code=${loginCode}`, secure);
	} catch {
		const response = redirectToApp('/?error=oauth', secure);
		response.headers.set('Set-Cookie', clearOauthCookie(secure));
		return response;
	}
}
