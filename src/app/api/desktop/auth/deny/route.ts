import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { denyDesktopAuth } from '@/lib/desktopAuth';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function POST(req: NextRequest) {
	try {
		await webUser(req);
		const body = await req.json().catch(() => null) as { request_id?: string } | null;
		const result = await denyDesktopAuth(body?.request_id || '');
		return webJson(req, result);
	} catch (error) {
		if (error instanceof BudgetError) {
			return webJson(req, { error: { code: error.code, message: error.message } }, error.status);
		}
		return webJson(req, { error: { code: 'internal_error', message: 'Не удалось отклонить вход.' } }, 500);
	}
}
