import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';
import { storeImage } from '@/lib/webTurn';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function POST(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const body = await req.json().catch(() => null) as { dataUrl?: string } | null;
		if (!body?.dataUrl) {
			throw new BudgetError('invalid_image', 'Прикрепите PNG или JPEG.', 400);
		}
		return webJson(req, await storeImage(user.id, body.dataUrl), 201);
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: { message: known ? error.message : 'Не удалось загрузить картинку.' } }, known ? error.status : 500);
	}
}
