import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { webJson, webOptions } from '@/lib/webCors';
import { apiPublicOrigin, oauthCookie, pkceChallenge, randomToken } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export function GET(req: NextRequest) {
	const clientId = process.env.YANDEX_OAUTH_CLIENT_ID;
	if (!clientId || !process.env.YANDEX_OAUTH_CLIENT_SECRET) {
		return webJson(req, { error: { message: 'Вход через Яндекс ещё не настроен.' } }, 503);
	}
	const state = randomToken(24);
	const redirectUri = `${apiPublicOrigin(req)}/api/web/auth/yandex/callback`;
	const url = new URL('https://oauth.yandex.ru/authorize');
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('state', state);
	const response = new Response(null, { status: 302, headers: { Location: url.toString() } });
	response.headers.append('Set-Cookie', oauthCookie(state, 'yandex', req.nextUrl.protocol === 'https:'));
	return response;
}
