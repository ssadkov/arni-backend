import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { POST as exchangeIdentity } from '@/app/api/auth/exchange/route';
import { BudgetError } from '@/lib/budget';
import { decryptJWT } from '@/lib/jwt';
import prisma from '@/lib/prisma';

const COOKIE = 'arni_web_oauth';
const CODE_TTL_MS = 2 * 60 * 1000;

/** Marks the PKCE verifier as Google's so other providers' callbacks reject it. */
export const GOOGLE_VERIFIER_PREFIX = 'google.';

export function apiPublicOrigin(req: NextRequest) {
	const configured = process.env.API_PUBLIC_ORIGIN?.replace(/\/$/, '');
	if (configured) {
		return configured;
	}
	const host = req.headers.get('host') || '';
	if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
		return `http://${host}`;
	}
	return 'https://api.arnion.ru';
}

export function webAppOrigin() {
	return (process.env.WEB_APP_ORIGIN || 'https://chat.arnion.kz').split(',')[0].trim().replace(/\/$/, '');
}

export async function webUser(req: NextRequest) {
	const header = req.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) {
		throw new BudgetError('unauthorized', 'Войдите в аккаунт.', 401);
	}
	const token = header.slice('Bearer '.length);
	let userId: string;
	try {
		userId = (await decryptJWT(token)).userId;
	} catch {
		throw new BudgetError('unauthorized', 'Войдите в аккаунт повторно.', 401);
	}
	const user = await prisma.user.findUnique({ where: { id: userId } });
	if (!user || user.isBanned) {
		throw new BudgetError('account_blocked', 'Аккаунт недоступен.', 403);
	}
	return { user, token };
}

export function oauthCookie(state: string, verifier: string, secure: boolean) {
	const value = Buffer.from(JSON.stringify({ state, verifier })).toString('base64url');
	const parts = [`${COOKIE}=${value}`, 'HttpOnly', 'Path=/', 'Max-Age=600', 'SameSite=Lax'];
	if (secure) {
		parts.push('Secure');
	}
	return parts.join('; ');
}

export function readOauthCookie(req: NextRequest): { state: string; verifier: string } | null {
	const raw = req.cookies.get(COOKIE)?.value;
	if (!raw) {
		return null;
	}
	try {
		const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { state?: string; verifier?: string };
		if (!parsed.state || !parsed.verifier) {
			return null;
		}
		return { state: parsed.state, verifier: parsed.verifier };
	} catch {
		return null;
	}
}

export function clearOauthCookie(secure: boolean) {
	return `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function pkceChallenge(verifier: string) {
	return createHash('sha256').update(verifier).digest('base64url');
}

export function randomToken(bytes = 32) {
	return randomBytes(bytes).toString('base64url');
}

export async function issueLoginCode(userId: string) {
	await prisma.webLoginCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
	const row = await prisma.webLoginCode.create({
		data: { userId, expiresAt: new Date(Date.now() + CODE_TTL_MS) },
	});
	return row.id;
}

export async function consumeLoginCode(code: string) {
	if (!/^[0-9a-f-]{36}$/i.test(code)) {
		return null;
	}
	const row = await prisma.webLoginCode.findUnique({ where: { id: code } });
	if (!row) {
		return null;
	}
	await prisma.webLoginCode.delete({ where: { id: code } });
	if (row.expiresAt.getTime() < Date.now()) {
		return null;
	}
	const user = await prisma.user.findUnique({ where: { id: row.userId } });
	if (!user || user.isBanned) {
		return null;
	}
	return user;
}

/** Exchange a provider access token through the existing Yandex/VK/Google account path. */
export async function sessionFromProviderToken(provider: 'yandex' | 'vk' | 'google', token: string) {
	const response = await exchangeIdentity(new NextRequest('https://arni.internal/api/auth/exchange', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ provider, token }),
	}));
	const body = await response.json().catch(() => null) as { token?: string; error?: string } | null;
	if (!response.ok || !body?.token) {
		throw new BudgetError('oauth_failed', body?.error || 'Не удалось войти.', response.status === 401 ? 401 : 400);
	}
	const payload = await decryptJWT(body.token);
	return String(payload.userId);
}

export function redirectToApp(path: string, secure: boolean) {
	const response = NextResponse.redirect(`${webAppOrigin()}${path}`);
	response.headers.set('Set-Cookie', clearOauthCookie(secure));
	return response;
}

