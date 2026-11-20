import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAdmin } from '@/lib/adminAuth';
import { MARKUP_PROVIDERS } from '@/lib/billingMarkup';

export const dynamic = 'force-dynamic';

/** null clears an override. undefined means the value is not a valid percent. */
function readPercent(value: unknown): number | null | undefined {
	if (value === null || value === '') { return null; }
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000) { return value; }
	return undefined;
}

export async function POST(req: NextRequest) {
	const denied = requireAdmin(req);
	if (denied) { return denied; }
	let body: { global?: unknown; providers?: Record<string, unknown>; model?: { id?: unknown; percent?: unknown } | null };
	try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный запрос.' }, { status: 400 }); }
	const global = readPercent(body.global);
	if (global === undefined || global === null) {
		return NextResponse.json({ error: 'Общая наценка — целое число от 0 до 1000.' }, { status: 400 });
	}
	const providers = body.providers && typeof body.providers === 'object' ? body.providers : {};
	for (const provider of MARKUP_PROVIDERS) {
		if (!Object.prototype.hasOwnProperty.call(providers, provider)) { continue; }
		if (readPercent(providers[provider]) === undefined) {
			return NextResponse.json({ error: 'Наценка провайдера — целое число от 0 до 1000 или пусто.' }, { status: 400 });
		}
	}
	const modelId = typeof body.model?.id === 'string' ? body.model.id.trim() : '';
	const modelPercent = body.model ? readPercent(body.model.percent) : null;
	if (modelId && !/^[a-zA-Z0-9._:/-]{1,200}$/.test(modelId)) {
		return NextResponse.json({ error: 'Некорректный id модели.' }, { status: 400 });
	}
	if (modelId && modelPercent === undefined) {
		return NextResponse.json({ error: 'Наценка модели — целое число от 0 до 1000 или пусто для сброса.' }, { status: 400 });
	}
	try {
		await prisma.billingMarkup.upsert({ where: { id: 'global' }, create: { id: 'global', percent: global }, update: { percent: global } });
		for (const provider of MARKUP_PROVIDERS) {
			if (!Object.prototype.hasOwnProperty.call(providers, provider)) { continue; }
			const value = readPercent(providers[provider]);
			if (value === null) { await prisma.billingMarkup.deleteMany({ where: { id: `provider:${provider}` } }); }
			else if (value !== undefined) { await prisma.billingMarkup.upsert({ where: { id: `provider:${provider}` }, create: { id: `provider:${provider}`, percent: value }, update: { percent: value } }); }
		}
		if (modelId && modelPercent === null) { await prisma.billingMarkup.deleteMany({ where: { id: `model:${modelId}` } }); }
		if (modelId && modelPercent !== null && modelPercent !== undefined) {
			await prisma.billingMarkup.upsert({ where: { id: `model:${modelId}` }, create: { id: `model:${modelId}`, percent: modelPercent }, update: { percent: modelPercent } });
		}
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: 'Наценка не сохранена. Сначала примените SQL биллинга.' }, { status: 503 });
	}
}
