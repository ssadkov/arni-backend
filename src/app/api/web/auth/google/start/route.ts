import { NextRequest } from 'next/server';
import { webJson, webOptions } from '@/lib/webCors';
import { apiPublicOrigin, GOOGLE_VERIFIER_PREFIX, oauthCookie, pkceChallenge, randomToken } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export function GET(req: NextRequest) {
	const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
	if (!clientId || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
		return webJson(req, { error: { message: 'Вход через Google ещё не настроен.' } }, 503);
	}
	const state = randomToken(24);
	const verifier = `${GOOGLE_VERIFIER_PREFIX}${randomToken(32)}`;
	const redirectUri = `${apiPublicOrigin(req)}/api/web/auth/google/callback`;
	const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('scope', 'openid email profile');
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', pkceChallenge(verifier));
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('prompt', 'select_account');
	const response = new Response(null, { status: 302, headers: { Location: url.toString() } });
	response.headers.append('Set-Cookie', oauthCookie(state, verifier, req.nextUrl.protocol === 'https:'));
	return response;
}
