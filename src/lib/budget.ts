import type { AccountBudget, Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { costMicros, currentWindow, FIVE_HOURS_MS, WEEK_MS, type ReportedUsage } from './budgetPolicy';

export class BudgetError extends Error {
	constructor(public readonly code: string, message: string, public readonly status = 429, public readonly resetsAt?: string) {
		super(message);
	}
}

export function budgetSnapshot(budget: AccountBudget, now = new Date()) {
	const window = (duration: number, startedAt: Date | null, usedMicros: number, requests: number, limitMicros: number, requestLimit: number) => {
		const current = currentWindow({ startedAt, usedMicros, requests }, duration, now);
		return { ...current, limitMicros, requestLimit, remainingMicros: Math.max(0, limitMicros - current.usedMicros),
			resetsAt: current.startedAt ? new Date(current.startedAt.getTime() + duration).toISOString() : null };
	};
	return {
		enabled: budget.enabled, currency: 'USD', balanceMicros: budget.balanceMicros,
		validUntil: budget.validUntil.toISOString(), expired: now >= budget.validUntil,
		fiveHour: window(FIVE_HOURS_MS, budget.fiveHourStartedAt, budget.fiveHourUsedMicros, budget.fiveHourRequests, budget.fiveHourLimitMicros, budget.fiveHourRequestLimit),
		weekly: window(WEEK_MS, budget.weeklyStartedAt, budget.weeklyUsedMicros, budget.weeklyRequests, budget.weeklyLimitMicros, budget.weeklyRequestLimit),
	};
}

async function lockBudget(tx: Prisma.TransactionClient, userId: string) {
	await tx.$queryRaw`SELECT "userId" FROM "AccountBudget" WHERE "userId" = ${userId} FOR UPDATE`;
	return tx.accountBudget.findUniqueOrThrow({ where: { userId } });
}

export async function reserveBudget(userId: string, model: string, source: string, reservedMicros: number, inputPerMillion: number, outputPerMillion: number) {
	if (!Number.isSafeInteger(reservedMicros) || reservedMicros < 0 || reservedMicros > 1_000_000_000
		|| ![inputPerMillion, outputPerMillion].every(value => Number.isFinite(value) && value >= 0)) {
		throw new BudgetError('pricing_unavailable', 'Некорректный резерв API.', 503);
	}
	return prisma.$transaction(async tx => {
		const budget = await lockBudget(tx, userId);
		const now = new Date();
		const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
		if (user.isBanned) { throw new BudgetError('account_blocked', 'Аккаунт заблокирован.', 403); }
		if (!budget.enabled || now >= budget.validUntil) {
			throw new BudgetError('access_expired', 'Выданный доступ приостановлен или истёк. Обратитесь к администратору.', 403);
		}
		if (await tx.budgetReservation.findFirst({ where: { userId, status: 'pending' } })) {
			throw new BudgetError('request_in_progress', 'Предыдущий запрос ещё выполняется. Дождитесь его завершения.');
		}
		const snapshot = budgetSnapshot(budget, now);
		for (const [name, window] of [['five_hour_limit', snapshot.fiveHour], ['weekly_limit', snapshot.weekly]] as const) {
			if (window.requests >= window.requestLimit || window.usedMicros + reservedMicros > window.limitMicros) {
				throw new BudgetError(name, `Недостаточно лимита ${name === 'five_hour_limit' ? 'на 5 часов' : 'на неделю'} для этого запроса. Уменьшите контекст или дождитесь сброса.`, 429, window.resetsAt || undefined);
			}
		}
		if (budget.balanceMicros < reservedMicros) {
			throw new BudgetError('insufficient_budget', 'Недостаточно выданного бюджета API для этого запроса. Обратитесь к администратору.', 403);
		}
		const fiveHourStartedAt = snapshot.fiveHour.startedAt || now;
		const weeklyStartedAt = snapshot.weekly.startedAt || now;
		const reservation = await tx.budgetReservation.create({ data: { userId, model, source, reservedMicros, inputPerMillion, outputPerMillion, fiveHourStartedAt, weeklyStartedAt } });
		await tx.accountBudget.update({ where: { userId }, data: {
			balanceMicros: { decrement: reservedMicros }, fiveHourStartedAt, weeklyStartedAt,
			fiveHourUsedMicros: snapshot.fiveHour.usedMicros + reservedMicros,
			weeklyUsedMicros: snapshot.weekly.usedMicros + reservedMicros,
			fiveHourRequests: snapshot.fiveHour.requests + 1, weeklyRequests: snapshot.weekly.requests + 1,
		} });
		await tx.budgetEntry.create({ data: { userId, key: `reserve:${reservation.id}`, kind: 'reserve', amountMicros: -reservedMicros, note: model } });
		return reservation;
	});
}

/** Missing usage stays charged at the reservation; only confirmed upstream rejection is refunded. */
export async function settleBudget(id: string, usage: ReportedUsage | null, rejected = false) {
	return prisma.$transaction(async tx => {
		const initial = await tx.budgetReservation.findUniqueOrThrow({ where: { id } });
		const budget = await lockBudget(tx, initial.userId);
		const reservation = await tx.budgetReservation.findUniqueOrThrow({ where: { id } });
		if (reservation.status !== 'pending') { return; }
		const calculated = usage ? costMicros(usage.prompt_tokens, usage.completion_tokens, reservation.inputPerMillion, reservation.outputPerMillion) : reservation.reservedMicros;
		// OpenRouter reports actual USD cost; Bedrock uses the snapshotted catalog rates.
		const actual = rejected ? 0 : usage?.cost !== undefined && reservation.source === 'openrouter'
			? costMicros(1, 0, usage.cost * 1_000_000, 0) : calculated;
		const refund = reservation.reservedMicros - actual;
		const status = rejected ? 'refunded' : usage ? 'reported' : 'estimated';
		await tx.budgetReservation.update({ where: { id }, data: { status, costMicros: actual, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens } });
		await tx.accountBudget.update({ where: { userId: budget.userId }, data: {
			balanceMicros: { increment: refund },
			...(budget.fiveHourStartedAt?.getTime() === reservation.fiveHourStartedAt.getTime() ? {
				fiveHourUsedMicros: { decrement: refund }, ...(rejected ? { fiveHourRequests: { decrement: 1 } } : {}),
			} : {}),
			...(budget.weeklyStartedAt?.getTime() === reservation.weeklyStartedAt.getTime() ? {
				weeklyUsedMicros: { decrement: refund }, ...(rejected ? { weeklyRequests: { decrement: 1 } } : {}),
			} : {}),
		} });
		if (refund !== 0) {
			await tx.budgetEntry.create({ data: { userId: budget.userId, key: `settle:${id}`, kind: refund > 0 ? 'refund' : 'adjustment', amountMicros: refund, note: `${status}: ${reservation.model}` } });
		}
		if (!rejected) {
			await tx.usageLog.create({ data: { userId: budget.userId, model: reservation.model, source: reservation.source,
				promptTokens: usage?.prompt_tokens || 0, completionTokens: usage?.completion_tokens || 0, costMicros: actual, accounting: status } });
		}
	});
}
