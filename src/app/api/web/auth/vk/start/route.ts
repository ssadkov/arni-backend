import { NextRequest } from 'next/server';
import { webJson, webOptions } from '@/lib/webCors';
import { apiPublicOrigin, oauthCookie, pkceChallenge, randomToken } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export function GET(req: NextRequest) {
	const clientId = process.env.VK_CLIENT_ID?.trim() || '54785916';
	const state = randomToken(24);
	const verifier = randomToken(32);
	const redirectUri = `${apiPublicOrigin(req)}/api/web/auth/vk/callback`;
	const url = new URL('https://id.vk.ru/authorize');
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', pkceChallenge(verifier));
	url.searchParams.set('code_challenge_method', 'S256');
	url.searchParams.set('scope', 'email');
	const response = new Response(null, { status: 302, headers: { Location: url.toString() } });
	response.headers.append('Set-Cookie', oauthCookie(state, verifier, req.nextUrl.protocol === 'https:'));
	return response;
}
