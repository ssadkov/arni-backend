import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { approveDesktopAuth } from '@/lib/desktopAuth';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function POST(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const body = await req.json().catch(() => null) as { request_id?: string; user_code?: string } | null;
		const result = await approveDesktopAuth(body?.request_id || '', body?.user_code || '', user.id);
		return webJson(req, result);
	} catch (error) {
		if (error instanceof BudgetError) {
			return webJson(req, { error: { code: error.code, message: error.message } }, error.status);
		}
		return webJson(req, { error: { code: 'internal_error', message: 'Не удалось подтвердить вход.' } }, 500);
	}
}
