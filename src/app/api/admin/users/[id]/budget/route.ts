import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import prisma from '@/lib/prisma';
import { budgetSnapshot } from '@/lib/budget';
import { createHash } from 'node:crypto';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
	const denied = requireAdmin(req);
	if (denied) { return denied; }
	const { id } = await context.params;
	let body;
	try { body = await req.json(); } catch { return NextResponse.json({ error: 'Некорректный запрос.' }, { status: 400 }); }
	if (!body || typeof body !== 'object' || Array.isArray(body)) { return NextResponse.json({ error: 'Некорректный запрос.' }, { status: 400 }); }
	const { key, grantUsd, fiveHourUsd, weeklyUsd, fiveHourRequests, weeklyRequests, days, enabled, note } = body;
	if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(key)
		|| ![grantUsd, fiveHourUsd, weeklyUsd].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000)
		|| ![fiveHourRequests, weeklyRequests].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 100000)
		|| !Number.isSafeInteger(days) || days < 1 || days > 365 || typeof enabled !== 'boolean'
		|| typeof note !== 'string' || !note.trim() || note.length > 300) {
		return NextResponse.json({ error: 'Проверьте сумму, лимиты, срок и основание начисления.' }, { status: 400 });
	}
	try {
		const payloadHash = createHash('sha256').update(JSON.stringify({ id, grantUsd, fiveHourUsd, weeklyUsd, fiveHourRequests, weeklyRequests, days, enabled, note: note.trim() })).digest('hex');
		const result = await prisma.$transaction(async tx => {
			// Locks both initial creation and subsequent grants. No user plan change is needed.
			const users = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${id} FOR UPDATE`;
			if (!users.length) { return null; }
			const entryKey = `grant:${key}`;
			const existing = await tx.budgetEntry.findUnique({ where: { key: entryKey } });
			if (existing) {
				if (existing.userId !== id || existing.payloadHash !== payloadHash) {
					throw new Error('idempotency_conflict');
				}
				return tx.accountBudget.findUniqueOrThrow({ where: { userId: id } });
			}
			const config = { enabled, fiveHourLimitMicros: Math.round(fiveHourUsd * 1_000_000), weeklyLimitMicros: Math.round(weeklyUsd * 1_000_000),
				fiveHourRequestLimit: fiveHourRequests, weeklyRequestLimit: weeklyRequests };
			const validUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
			const previous = await tx.accountBudget.findUnique({ where: { userId: id } });
			if ((previous?.balanceMicros || 0) + Math.round(grantUsd * 1_000_000) > 1_000_000_000) { throw new Error('balance_limit'); }
			const budget = await tx.accountBudget.upsert({ where: { userId: id },
				create: { userId: id, ...config, validUntil, balanceMicros: Math.round(grantUsd * 1_000_000) },
				update: { ...config, ...(grantUsd > 0 ? { validUntil } : {}), balanceMicros: { increment: Math.round(grantUsd * 1_000_000) } },
			});
			await tx.budgetEntry.create({ data: { userId: id, key: entryKey, amountMicros: Math.round(grantUsd * 1_000_000), kind: 'grant', note: note.trim(), payloadHash } });
			return budget;
		});
		if (!result) { return NextResponse.json({ error: 'Пользователь не найден.' }, { status: 404 }); }
		return NextResponse.json({ budget: budgetSnapshot(result) });
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error && error.message === 'idempotency_conflict' ? 'Ключ начисления уже использован для другой операции.' : 'Начисление не выполнено. Повторите с тем же ключом.' }, { status: 409 });
	}
}
