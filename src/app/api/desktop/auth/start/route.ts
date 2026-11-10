import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { clientKeyHash, startDesktopAuth } from '@/lib/desktopAuth';
import { webJson, webOptions } from '@/lib/webCors';
import { webAppOrigin } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

function fail(error: unknown) {
	if (error instanceof BudgetError) {
		return { status: error.status, body: { error: { code: error.code, message: error.message } } };
	}
	return { status: 500, body: { error: { code: 'internal_error', message: 'Не удалось начать вход.' } } };
}

export async function POST(req: NextRequest) {
	const raw = await req.text();
	if (raw.trim()) {
		try {
			const body = JSON.parse(raw) as Record<string, unknown>;
			if (body && typeof body === 'object' && ('redirect_uri' in body || 'verification_uri' in body || 'device_code' in body)) {
				return webJson(req, { error: { code: 'invalid_request', message: 'Этот вход не принимает адрес перенаправления.' } }, 400);
			}
		} catch {
			return webJson(req, { error: { code: 'invalid_request', message: 'Некорректный JSON.' } }, 400);
		}
	}
	try {
		const started = await startDesktopAuth(webAppOrigin(), clientKeyHash(req.headers.get('x-forwarded-for'), req.headers.get('x-real-ip')));
		return webJson(req, started);
	} catch (error) {
		const response = fail(error);
		return webJson(req, response.body, response.status);
	}
}
