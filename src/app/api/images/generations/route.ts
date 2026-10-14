import { NextRequest, NextResponse } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { generateImage, IMAGE_MODEL, IMAGE_PRICE_MICROS, IMAGE_RATIOS } from '@/lib/imageGeneration';
import { mediaUser } from '@/lib/mediaAuth';
import prisma from '@/lib/prisma';

export const maxDuration = 300;
export async function GET(req: NextRequest) {
	try {
		const user = await mediaUser(req);
		const budget = await prisma.accountBudget.findUnique({ where: { userId: user.id } });
		return NextResponse.json({ enabled: process.env.ARNI_IMAGE_GENERATION_ENABLED === 'true' && !!process.env.AWS_BEARER_TOKEN_BEDROCK_IMAGES && !!budget?.enabled && budget.validUntil > new Date(), model: IMAGE_MODEL, costMicros: IMAGE_PRICE_MICROS, aspect_ratios: IMAGE_RATIOS }, { headers: { 'Cache-Control': 'private, no-store' } });
	} catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
	try {
		const user = await mediaUser(req);
		const raw = await req.text();
		if (Buffer.byteLength(raw) > 50_000) { throw new BudgetError('request_too_large', 'Описание слишком длинное.', 413); }
		let body;
		try { body = JSON.parse(raw); } catch { throw new BudgetError('invalid_json', 'Некорректный JSON.', 400); }
		return NextResponse.json(await generateImage(user.id, req.headers.get('idempotency-key') || '', body), { headers: { 'Cache-Control': 'private, no-store' } });
	} catch (error) { return failure(error); }
}
function failure(error: unknown) {
	const known = error instanceof BudgetError;
	return NextResponse.json({ error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Не удалось выполнить запрос.' } }, { status: known ? error.status : 500 });
}
