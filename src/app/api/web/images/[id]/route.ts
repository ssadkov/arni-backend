import { NextRequest, NextResponse } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { webCorsHeaders, webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';
import { readOwnedImage } from '@/lib/webTurn';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	try {
		const { user } = await webUser(req);
		const { id } = await context.params;
		const image = await readOwnedImage(user.id, id);
		return new NextResponse(new Uint8Array(image.bytes), {
			headers: {
				...webCorsHeaders(req),
				'Content-Type': image.mediaType,
				'Cache-Control': 'private, no-store',
				'X-Content-Type-Options': 'nosniff',
			},
		});
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: { message: known ? error.message : 'Картинка не найдена.' } }, known ? error.status : 500);
	}
}
