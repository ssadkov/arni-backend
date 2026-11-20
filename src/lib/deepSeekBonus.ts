import type { BudgetWallet, Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { currentWindow, FIVE_HOURS_MS, USD_MICROS, WEEK_MS } from './budgetPolicy';
import { PAID_DEEPSEEK_MODEL } from './llm/trialModel';

export const DEEPSEEK_BONUS_KIND = 'deepseek_bonus_2026_12';
export const DEEPSEEK_BONUS_LEDGER = `wallet:${DEEPSEEK_BONUS_KIND}`;

export function deepSeekBonusEnabled() {
	return process.env.DEEPSEEK_BONUS_ENABLED === 'true';
}

function usdMicros(raw: string | undefined, fallback: number) {
	const micros = Math.round(Number(raw ?? fallback) * USD_MICROS);
	return Number.isSafeInteger(micros) && micros > 0 && micros <= 1_000_000_000 ? micros : null;
}

export function deepSeekBonusConfig() {
	if (!deepSeekBonusEnabled()) { return null; }
	const expiresAt = new Date(process.env.DEEPSEEK_BONUS_EXPIRES_AT ?? '2026-12-14T18:59:59Z');
	const grantedMicros = usdMicros(process.env.DEEPSEEK_BONUS_USD, 15);
	const fiveHourLimitMicros = usdMicros(process.env.DEEPSEEK_BONUS_FIVE_HOUR_USD, 5);
	const weeklyLimitMicros = usdMicros(process.env.DEEPSEEK_BONUS_WEEKLY_USD, 10);
	if (!Number.isFinite(expiresAt.getTime()) || grantedMicros === null || fiveHourLimitMicros === null || weeklyLimitMicros === null) {
		console.error('Invalid DeepSeek bonus configuration');
		return null;
	}
	return { grantedMicros, fiveHourLimitMicros, weeklyLimitMicros, expiresAt };
}

export function readDeepSeekBonus(userId: string) {
	return deepSeekBonusEnabled()
		? prisma.budgetWallet.findUnique({ where: { userId_kind: { userId, kind: DEEPSEEK_BONUS_KIND } } })
		: null;
}

export function bonusWindows(wallet: BudgetWallet, now: Date) {
	const window = (startedAt: Date | null, usedMicros: number, limitMicros: number, duration: number) => {
		const current = currentWindow({ startedAt, usedMicros, requests: 0 }, duration, now);
		return {
			startedAt: current.startedAt,
			usedMicros: current.usedMicros,
			limitMicros,
			remainingMicros: Math.max(0, limitMicros - current.usedMicros),
			resetsAt: current.startedAt ? new Date(current.startedAt.getTime() + duration).toISOString() : null,
		};
	};
	return {
		fiveHour: window(wallet.fiveHourStartedAt, wallet.fiveHourUsedMicros, wallet.fiveHourLimitMicros, FIVE_HOURS_MS),
		weekly: window(wallet.weeklyStartedAt, wallet.weeklyUsedMicros, wallet.weeklyLimitMicros, WEEK_MS),
	};
}

export function bonusSnapshot(wallet: BudgetWallet, now = new Date()) {
	return {
		kind: wallet.kind, models: wallet.models, grantedMicros: wallet.grantedMicros,
		balanceMicros: wallet.balanceMicros, expiresAt: wallet.expiresAt.toISOString(),
		expired: now >= wallet.expiresAt, ...bonusWindows(wallet, now),
	};
}

/** Call while the account budget is locked, including after creating or updating a top-up. */
export async function grantDeepSeekBonus(tx: Prisma.TransactionClient, userId: string, now = new Date()) {
	const config = deepSeekBonusConfig();
	if (!config || now >= config.expiresAt) { return 'unavailable'; }
	const existing = await tx.budgetWallet.findUnique({
		where: { userId_kind: { userId, kind: DEEPSEEK_BONUS_KIND } }, select: { id: true },
	});
	if (existing) { return 'already'; }
	await tx.budgetWallet.create({ data: {
		...config, userId, kind: DEEPSEEK_BONUS_KIND, models: [PAID_DEEPSEEK_MODEL], balanceMicros: config.grantedMicros,
	} });
	await tx.budgetEntry.create({ data: {
		userId, key: `${DEEPSEEK_BONUS_LEDGER}:${userId}`, note: 'Бонус DeepSeek',
		kind: 'grant', amountMicros: config.grantedMicros,
	} });
	return 'created';
}

export async function deepSeekBonusReport() {
	if (!deepSeekBonusEnabled()) { return null; }
	const [wallets, remaining, [spend]] = await Promise.all([
		prisma.budgetWallet.aggregate({
			where: { kind: DEEPSEEK_BONUS_KIND }, _sum: { grantedMicros: true }, _count: true,
		}),
		prisma.budgetWallet.aggregate({
			where: { kind: DEEPSEEK_BONUS_KIND, expiresAt: { gt: new Date() } }, _sum: { balanceMicros: true },
		}),
		prisma.$queryRaw<Array<{ spentMicros: number; spendingAccounts: number; providerMicros: number }>>`
			SELECT COALESCE(SUM(l."walletMicros"), 0)::float8 AS "spentMicros",
				COUNT(DISTINCT l."userId")::int AS "spendingAccounts",
				COALESCE(SUM(ROUND(l."providerCostMicros"::numeric * l."walletMicros" / NULLIF(l."costMicros", 0))), 0)::float8 AS "providerMicros"
			FROM "UsageLog" l
			JOIN "BudgetReservation" r ON r."requestId" = l."requestId"
			JOIN "BudgetWallet" w ON w."id" = r."walletId"
			WHERE w."kind" = ${DEEPSEEK_BONUS_KIND} AND l."walletMicros" > 0`,
	]);
	return { grantedMicros: wallets._sum.grantedMicros ?? 0, remainingMicros: remaining._sum.balanceMicros ?? 0,
		accounts: wallets._count, ...spend };
}
