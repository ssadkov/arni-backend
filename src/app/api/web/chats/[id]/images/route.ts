import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { IMAGE_RATIOS } from '@/lib/imageGeneration';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';
import { generateChatImage } from '@/lib/webTurn';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	try {
		const { user } = await webUser(req);
		const { id } = await context.params;
		const body = await req.json().catch(() => null) as { prompt?: string; aspect_ratio?: string } | null;
		const ratio = body?.aspect_ratio && IMAGE_RATIOS.includes(body.aspect_ratio) ? body.aspect_ratio : '1:1';
		const created = await generateChatImage(user.id, id, body?.prompt || '', ratio);
		return webJson(req, created, 201);
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Не удалось создать картинку.' } }, known ? error.status : 500);
	}
}
