import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';
import { removeChatImageBackground } from '@/lib/webTurn';

export const maxDuration = 300;

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

/** Removes the background of a picture uploaded through POST /api/web/images. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	try {
		const { user } = await webUser(req);
		const { id } = await context.params;
		const body = await req.json().catch(() => null) as { imageId?: unknown } | null;
		if (typeof body?.imageId !== 'string' || !body.imageId) {
			throw new BudgetError('invalid_image', 'Сначала прикрепите картинку.', 400);
		}
		return webJson(req, await removeChatImageBackground(user.id, id, body.imageId), 201);
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Не удалось убрать фон.' } }, known ? error.status : 500);
	}
}
