import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/adminAuth';
import { deepSeekBonusConfig, DEEPSEEK_BONUS_KIND, grantDeepSeekBonus } from '@/lib/deepSeekBonus';
import prisma from '@/lib/prisma';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
	const denied = requireAdmin(req);
	if (denied) { return denied; }
	const body = await req.json().catch(() => null);
	if (typeof body?.dryRun !== 'boolean' || (body.userId !== undefined && (typeof body.userId !== 'string' || !body.userId))) {
		return NextResponse.json({ error: 'Некорректный запрос.' }, { status: 400 });
	}
	const now = new Date();
	const config = deepSeekBonusConfig();
	if (!config || now >= config.expiresAt) {
		return NextResponse.json({ error: 'Акция выключена или завершилась.' }, { status: 409 });
	}
	const eligible = await prisma.accountBudget.findMany({
		where: {
			...(body.userId ? { userId: body.userId } : {}),
			enabled: true, validUntil: { gt: now }, user: { isBanned: false },
			...(body.dryRun ? { wallets: { none: { kind: DEEPSEEK_BONUS_KIND } } } : {}),
		},
		select: { userId: true },
		orderBy: { userId: 'asc' },
	});
	if (body.dryRun) {
		return NextResponse.json({ count: eligible.length, userIds: eligible.map(row => row.userId) });
	}
	let created = 0;
	let skipped = 0;
	let unavailable = 0;
	let failed = 0;
	for (const { userId } of eligible) {
		try {
			const status = await prisma.$transaction(async tx => {
				const [user] = await tx.$queryRaw<Array<{ isBanned: boolean }>>`SELECT "isBanned" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
				if (!user || user.isBanned) { return 'unavailable'; }
				const [budget] = await tx.$queryRaw<Array<{ enabled: boolean; validUntil: Date }>>`SELECT "enabled", "validUntil"
					FROM "AccountBudget" WHERE "userId" = ${userId} FOR UPDATE`;
				const current = new Date();
				if (!budget?.enabled || current >= budget.validUntil) { return 'unavailable'; }
				return grantDeepSeekBonus(tx, userId, current);
			});
			if (status === 'created') { created++; }
			else if (status === 'already') { skipped++; }
			else { unavailable++; }
		} catch (error) {
			console.error('DeepSeek bonus grant failed', error instanceof Error ? error.name : 'unknown');
			failed++;
		}
	}
	return NextResponse.json({ created, skipped, unavailable, failed });
}
