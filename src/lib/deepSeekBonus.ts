import type { BudgetWallet } from '@prisma/client';
import prisma from '@/lib/prisma';
import { PAID_DEEPSEEK_MODEL } from '@/lib/llm/trialModel';

const CAMPAIGN = 'deepseek_bonus_2026';
export type DeepSeekFunding = 'bonus' | 'account';
export const DEEPSEEK_BONUS_MICROS = 15_000_000;
export const DEEPSEEK_BONUS_EXPIRES_AT = new Date('2026-12-14T19:00:00Z');

function walletKey(userId: string) {
	return { userId_campaign: { userId, campaign: CAMPAIGN } };
}

export function deepSeekBonus(userId: string) {
	return prisma.budgetWallet.findUnique({ where: walletKey(userId) });
}

export function bonusSnapshot(wallet: BudgetWallet, now = new Date()) {
	const expired = now >= wallet.expiresAt;
	return {
		modelId: wallet.model,
		balanceMicros: expired ? 0 : wallet.balanceMicros,
		grantedMicros: wallet.grantedMicros,
		expiresAt: wallet.expiresAt.toISOString(),
		expired,
	};
}

export async function grantDeepSeekBonus(userId: string) {
	return prisma.$transaction(async tx => {
		const [user] = await tx.$queryRaw<Array<{ isBanned: boolean }>>`SELECT "isBanned" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
		if (!user || user.isBanned) { return { status: 'unavailable' as const }; }
		const existing = await tx.budgetWallet.findUnique({ where: walletKey(userId) });
		if (existing) { return { status: 'ok' as const, wallet: existing }; }
		if (new Date() >= DEEPSEEK_BONUS_EXPIRES_AT) { return { status: 'expired' as const }; }
		const wallet = await tx.budgetWallet.create({ data: {
			userId, campaign: CAMPAIGN, model: PAID_DEEPSEEK_MODEL,
			grantedMicros: DEEPSEEK_BONUS_MICROS, balanceMicros: DEEPSEEK_BONUS_MICROS, expiresAt: DEEPSEEK_BONUS_EXPIRES_AT,
		} });
		await tx.budgetEntry.create({ data: {
			userId, walletId: wallet.id, key: `wallet:${CAMPAIGN}:${userId}`,
			amountMicros: DEEPSEEK_BONUS_MICROS, kind: 'grant', note: 'DeepSeek V4.1 Flash',
		} });
		return { status: 'ok' as const, wallet };
	});
}
