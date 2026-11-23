import type { AccountBudget, Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { costMicros, usageCostMicros, currentWindow, staleReservationCutoff, FIVE_HOURS_MS, WEEK_MS, MAX_CONCURRENT_RESERVATIONS, type ReportedUsage } from './budgetPolicy';
import { applyMarkup } from './billingMarkup';

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
		enabled: budget.enabled, limitsEnabled: budget.limitsEnabled !== false, currency: 'USD', balanceMicros: budget.balanceMicros,
		validUntil: budget.validUntil.toISOString(), expired: now >= budget.validUntil,
		fiveHour: window(FIVE_HOURS_MS, budget.fiveHourStartedAt, budget.fiveHourUsedMicros, budget.fiveHourRequests, budget.fiveHourLimitMicros, budget.fiveHourRequestLimit),
		weekly: window(WEEK_MS, budget.weeklyStartedAt, budget.weeklyUsedMicros, budget.weeklyRequests, budget.weeklyLimitMicros, budget.weeklyRequestLimit),
	};
}

async function lockBudget(tx: Prisma.TransactionClient, userId: string) {
	await tx.$queryRaw`SELECT "userId" FROM "AccountBudget" WHERE "userId" = ${userId} FOR UPDATE`;
	return tx.accountBudget.findUniqueOrThrow({ where: { userId } });
}

async function lockWallet(tx: Prisma.TransactionClient, id: string) {
	await tx.$queryRaw`SELECT "id" FROM "BudgetWallet" WHERE "id" = ${id} FOR UPDATE`;
	return tx.budgetWallet.findUniqueOrThrow({ where: { id } });
}

export type UsageMetadata = { requestId?: string; requestedModel?: string; operation?: 'chat' | 'image'; region?: string; unitPriceMicros?: number; imageCount?: number;
	chatId?: string; cacheReadPerMillion?: number; cacheWritePerMillion?: number; client?: string; markupPercent?: number };
export async function reserveBudget(userId: string, model: string, source: string, reservedMicros: number, inputPerMillion: number, outputPerMillion: number, metadata: UsageMetadata = {}, walletId?: string) {
	if (!Number.isSafeInteger(reservedMicros) || reservedMicros < 0 || reservedMicros > 1_000_000_000
		|| ![inputPerMillion, outputPerMillion].every(value => Number.isFinite(value) && value >= 0)) {
		throw new BudgetError('pricing_unavailable', 'Некорректный резерв API.', 503);
	}
	// A function killed mid-stream never settles its reservation; without this the user is locked out of paid models.
	const stale = await prisma.budgetReservation.findMany({ where: { userId, status: 'pending', createdAt: { lt: staleReservationCutoff(new Date()) } }, select: { id: true } });
	for (const { id } of stale) {
		console.warn(`Settling stale budget reservation ${id}`);
		await settleBudget(id, null);
	}
	return prisma.$transaction(async tx => {
		const [user] = await tx.$queryRaw<Array<{ isBanned: boolean }>>`SELECT "isBanned" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
		if (!user || user.isBanned) { throw new BudgetError('account_blocked', 'Аккаунт заблокирован.', 403); }
		if (await tx.budgetReservation.count({ where: { userId, status: 'pending' } }) >= MAX_CONCURRENT_RESERVATIONS) {
			throw new BudgetError('request_in_progress', 'Уже выполняется несколько запросов. Дождитесь завершения одного из них.');
		}
		const data = { userId, model, source, reservedMicros, inputPerMillion, outputPerMillion, ...metadata };
		if (walletId) {
			const wallet = await lockWallet(tx, walletId);
			if (wallet.userId !== userId || wallet.model !== model || source !== 'openrouter' || metadata.operation === 'image') {
				throw new BudgetError('bonus_unavailable', 'Бонус недоступен для этой модели.', 403);
			}
			if (new Date() >= wallet.expiresAt) {
				throw new BudgetError('bonus_expired', 'Срок действия бонуса DeepSeek истёк.', 403);
			}
			if (wallet.balanceMicros <= 0 || wallet.balanceMicros < reservedMicros) {
				throw new BudgetError('insufficient_bonus', 'Бонуса DeepSeek недостаточно для этого запроса.', 402);
			}
			const reservation = await tx.budgetReservation.create({ data: { ...data, walletId } });
			await tx.budgetWallet.update({ where: { id: walletId }, data: { balanceMicros: { decrement: reservedMicros } } });
			await tx.budgetEntry.create({ data: { userId, walletId, key: `reserve:${reservation.id}`, kind: 'reserve', amountMicros: -reservedMicros, note: model } });
			return reservation;
		}
		const budget = await lockBudget(tx, userId);
		const now = new Date();
		if (!budget.enabled || now >= budget.validUntil) {
			throw new BudgetError('access_expired', 'Срок доступа истёк. Пополните баланс в аккаунте.', 403);
		}
		const snapshot = budgetSnapshot(budget, now);
		if (budget.limitsEnabled !== false) {
			for (const [name, window] of [['five_hour_limit', snapshot.fiveHour], ['weekly_limit', snapshot.weekly]] as const) {
				if (window.requests >= window.requestLimit || window.usedMicros + reservedMicros > window.limitMicros) {
					throw new BudgetError(name, `Недостаточно лимита ${name === 'five_hour_limit' ? 'на 5 часов' : 'на неделю'} для этого запроса. Уменьшите контекст или дождитесь сброса.`, 429, window.resetsAt || undefined);
				}
			}
		}
		if (budget.balanceMicros < reservedMicros) {
			throw new BudgetError('insufficient_budget', 'Недостаточно баланса для этого запроса. Пополните его в аккаунте.', 403);
		}
		const fiveHourStartedAt = snapshot.fiveHour.startedAt || now;
		const weeklyStartedAt = snapshot.weekly.startedAt || now;
		const reservation = await tx.budgetReservation.create({ data: { ...data, fiveHourStartedAt, weeklyStartedAt } });
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

/**
 * Missing usage is charged at `promptEstimateMicros` (provider cost before markup) when the caller has one,
 * otherwise at the reservation; only confirmed upstream rejection is refunded.
 */
export async function settleBudget(id: string, usage: ReportedUsage | null, rejected = false, servedModel?: string, promptEstimateMicros?: number) {
	return prisma.$transaction(async tx => {
		const initial = await tx.budgetReservation.findUniqueOrThrow({ where: { id } });
		const wallet = initial.walletId ? await lockWallet(tx, initial.walletId) : null;
		const budget = wallet ? null : await lockBudget(tx, initial.userId);
		const reservation = await tx.budgetReservation.findUniqueOrThrow({ where: { id } });
		if (reservation.status !== 'pending') { return; }
		// Free-model fallback preserves the zero tariff while recording the model that served it.
		const billedModel = reservation.source === 'openrouter' && reservation.model.endsWith(':free') && servedModel?.endsWith(':free')
			? servedModel : reservation.model;
		const percent = reservation.markupPercent || 0;
		// An answer that ended without usage is charged for its prompt, never above the reservation.
		const estimate = !usage && !rejected && reservation.operation !== 'image' && promptEstimateMicros !== undefined
			? Math.min(promptEstimateMicros, percent <= 0 ? reservation.reservedMicros : Math.floor(reservation.reservedMicros * 100 / (100 + percent))) : undefined;
		const catalog = usage ? usageCostMicros(usage, reservation.inputPerMillion, reservation.outputPerMillion,
			reservation.cacheReadPerMillion ?? reservation.inputPerMillion, reservation.cacheWritePerMillion ?? reservation.inputPerMillion) : null;
		// Provider cost stays unmarked. The reserve already includes the markup frozen on this row.
		const providerActual = rejected ? 0
			: reservation.operation === 'image' ? (reservation.unitPriceMicros ?? reservation.reservedMicros)
			: usage?.cost !== undefined && reservation.source === 'openrouter' ? costMicros(1, 0, usage.cost * 1_000_000, 0)
			: catalog ?? estimate ?? (percent <= 0 ? reservation.reservedMicros : Math.round(reservation.reservedMicros * 100 / (100 + percent)));
		const actual = !rejected && reservation.operation !== 'image' && !usage && estimate === undefined ? reservation.reservedMicros
			: estimate !== undefined ? Math.min(reservation.reservedMicros, applyMarkup(estimate, percent)) : applyMarkup(providerActual, percent);
		// Keep the wallet debit within the approved reservation even if upstream overbills.
		const charged = wallet ? Math.min(reservation.reservedMicros, actual) : actual;
		const refund = reservation.reservedMicros - charged;
		const status = rejected ? 'refunded' : usage && (reservation.source !== 'openrouter' || usage.cost !== undefined) ? 'reported' : 'estimated';
		const cacheUsage = { cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens || 0,
			cacheWriteTokens: usage?.prompt_tokens_details?.cache_creation_input_tokens || 0 };
		await tx.budgetReservation.update({ where: { id }, data: { model: billedModel, status, costMicros: charged, providerCostMicros: providerActual, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, ...cacheUsage } });
		if (wallet && refund > 0) {
			// A late refund reconciles the ledger but cannot be spent after expiresAt.
			await tx.budgetWallet.update({ where: { id: wallet.id }, data: { balanceMicros: { increment: refund } } });
		}
		if (budget) {
			await tx.accountBudget.update({ where: { userId: budget.userId }, data: {
				balanceMicros: { increment: refund },
				...(reservation.fiveHourStartedAt && budget.fiveHourStartedAt?.getTime() === reservation.fiveHourStartedAt.getTime() ? {
					fiveHourUsedMicros: { decrement: refund }, ...(rejected ? { fiveHourRequests: { decrement: 1 } } : {}),
				} : {}),
				...(reservation.weeklyStartedAt && budget.weeklyStartedAt?.getTime() === reservation.weeklyStartedAt.getTime() ? {
					weeklyUsedMicros: { decrement: refund }, ...(rejected ? { weeklyRequests: { decrement: 1 } } : {}),
				} : {}),
			} });
		}
		if (refund !== 0) {
			await tx.budgetEntry.create({ data: { userId: reservation.userId, walletId: reservation.walletId, key: `settle:${id}`, kind: refund > 0 ? 'refund' : 'adjustment', amountMicros: refund, note: `${status}: ${reservation.model}` } });
		}
		if (!rejected) {
			await tx.usageLog.create({ data: { userId: reservation.userId, model: billedModel, source: reservation.source, client: reservation.client,
				promptTokens: usage?.prompt_tokens || 0, completionTokens: usage?.completion_tokens || 0, costMicros: charged, providerCostMicros: providerActual, markupPercent: percent, accounting: status,
				costBasis: !usage ? estimate !== undefined ? 'prompt_estimate' : 'reservation' : reservation.source === 'openrouter' && usage.cost !== undefined ? 'provider' : 'catalog',
				requestId: reservation.requestId, requestedModel: reservation.requestedModel, operation: reservation.operation, region: reservation.region,
				inputPerMillion: reservation.inputPerMillion, outputPerMillion: reservation.outputPerMillion,
				...cacheUsage, cacheReadPerMillion: reservation.cacheReadPerMillion, cacheWritePerMillion: reservation.cacheWritePerMillion, chatId: reservation.chatId,
				unitPriceMicros: reservation.unitPriceMicros, imageCount: reservation.imageCount } });
		}
	});
}
