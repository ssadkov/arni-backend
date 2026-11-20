import type { AccountBudget, BudgetWallet, Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { costMicros, usageCostMicros, currentWindow, staleReservationCutoff, FIVE_HOURS_MS, WEEK_MS, MAX_CONCURRENT_RESERVATIONS, type ReportedUsage } from './budgetPolicy';
import { applyMarkup } from './billingMarkup';
import { bonusSnapshot, bonusWindows, deepSeekBonusEnabled, DEEPSEEK_BONUS_KIND, DEEPSEEK_BONUS_LEDGER } from './deepSeekBonus';
import { PAID_DEEPSEEK_MODEL } from './llm/trialModel';

export class BudgetError extends Error {
	constructor(public readonly code: string, message: string, public readonly status = 429, public readonly resetsAt?: string) {
		super(message);
	}
}

export function budgetSnapshot(budget: AccountBudget, now = new Date(), wallet: BudgetWallet | null = null) {
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
		bonus: wallet ? bonusSnapshot(wallet, now) : null,
	};
}

async function lockWallet(tx: Prisma.TransactionClient, id: string) {
	await tx.$queryRaw`SELECT "id" FROM "BudgetWallet" WHERE "id" = ${id} FOR UPDATE`;
	return tx.budgetWallet.findUniqueOrThrow({ where: { id } });
}

async function lockBudget(tx: Prisma.TransactionClient, userId: string) {
	await tx.$queryRaw`SELECT "userId" FROM "AccountBudget" WHERE "userId" = ${userId} FOR UPDATE`;
	return tx.accountBudget.findUniqueOrThrow({ where: { userId } });
}

export type UsageMetadata = { requestId?: string; requestedModel?: string; operation?: 'chat' | 'image'; region?: string; unitPriceMicros?: number; imageCount?: number;
	chatId?: string; cacheReadPerMillion?: number; cacheWritePerMillion?: number; client?: string; markupPercent?: number };
export async function reserveBudget(userId: string, model: string, source: string, reservedMicros: number, inputPerMillion: number, outputPerMillion: number, metadata: UsageMetadata = {}) {
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
		const budget = await lockBudget(tx, userId);
		const now = new Date();
		const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
		if (user.isBanned) { throw new BudgetError('account_blocked', 'Аккаунт заблокирован.', 403); }
		if (!budget.enabled) {
			throw new BudgetError('access_expired', 'Срок доступа истёк. Пополните баланс в аккаунте.', 403);
		}
		const walletCandidate = deepSeekBonusEnabled() && source === 'openrouter' && model === PAID_DEEPSEEK_MODEL && metadata.operation !== 'image'
			? await tx.budgetWallet.findUnique({ where: { userId_kind: { userId, kind: DEEPSEEK_BONUS_KIND } }, select: { id: true } })
			: null;
		const wallet = walletCandidate ? await lockWallet(tx, walletCandidate.id) : null;
		const windows = wallet && now < wallet.expiresAt && wallet.models.includes(model) ? bonusWindows(wallet, now) : null;
		const walletMicros = wallet && windows
			? Math.min(reservedMicros, wallet.balanceMicros, windows.fiveHour.remainingMicros, windows.weekly.remainingMicros) : 0;
		const fromBalance = reservedMicros - walletMicros;
		const usesBalance = fromBalance > 0 || walletMicros === 0;
		if (usesBalance && now >= budget.validUntil) {
			throw new BudgetError('access_expired', 'Срок доступа истёк. Пополните баланс в аккаунте.', 403);
		}
		if (await tx.budgetReservation.count({ where: { userId, status: 'pending' } }) >= MAX_CONCURRENT_RESERVATIONS) {
			throw new BudgetError('request_in_progress', 'Уже выполняется несколько запросов. Дождитесь завершения одного из них.');
		}
		const snapshot = budgetSnapshot(budget, now);
		if (budget.limitsEnabled !== false) {
			for (const [name, window] of [['five_hour_limit', snapshot.fiveHour], ['weekly_limit', snapshot.weekly]] as const) {
				if (window.requests >= window.requestLimit || (usesBalance && window.usedMicros + fromBalance > window.limitMicros)) {
					throw new BudgetError(name, `Недостаточно лимита ${name === 'five_hour_limit' ? 'на 5 часов' : 'на неделю'} для этого запроса. Уменьшите контекст или дождитесь сброса.`, 429, window.resetsAt || undefined);
				}
			}
		}
		if (usesBalance && budget.balanceMicros < fromBalance) {
			throw new BudgetError('insufficient_budget', 'Недостаточно баланса для этого запроса. Пополните его в аккаунте.', 403);
		}
		const fiveHourStartedAt = snapshot.fiveHour.startedAt || now;
		const weeklyStartedAt = snapshot.weekly.startedAt || now;
		const reservation = await tx.budgetReservation.create({ data: {
			userId, model, source, reservedMicros, inputPerMillion, outputPerMillion, fiveHourStartedAt, weeklyStartedAt, ...metadata,
			...(walletMicros > 0 && wallet && windows ? {
				walletId: wallet.id, walletMicros, walletFiveHourStartedAt: windows.fiveHour.startedAt || now, walletWeeklyStartedAt: windows.weekly.startedAt || now,
			} : {}),
		} });
		await tx.accountBudget.update({ where: { userId }, data: {
			balanceMicros: { decrement: fromBalance }, fiveHourStartedAt, weeklyStartedAt,
			fiveHourUsedMicros: snapshot.fiveHour.usedMicros + fromBalance,
			weeklyUsedMicros: snapshot.weekly.usedMicros + fromBalance,
			fiveHourRequests: snapshot.fiveHour.requests + 1, weeklyRequests: snapshot.weekly.requests + 1,
		} });
		if (usesBalance) {
			await tx.budgetEntry.create({ data: { userId, key: `reserve:${reservation.id}`, kind: 'reserve', amountMicros: -fromBalance, note: model } });
		}
		if (walletMicros > 0 && wallet && windows) {
			await tx.budgetWallet.update({ where: { id: wallet.id }, data: {
				balanceMicros: { decrement: walletMicros },
				fiveHourStartedAt: reservation.walletFiveHourStartedAt,
				weeklyStartedAt: reservation.walletWeeklyStartedAt,
				fiveHourUsedMicros: windows.fiveHour.usedMicros + walletMicros,
				weeklyUsedMicros: windows.weekly.usedMicros + walletMicros,
			} });
			await tx.budgetEntry.create({ data: { userId, key: `reserve:${reservation.id}:wallet`, kind: 'reserve',
				amountMicros: -walletMicros, note: `${DEEPSEEK_BONUS_LEDGER}: ${model}` } });
		}
		return reservation;
	});
}

/** Missing usage stays charged at the reservation; only confirmed upstream rejection is refunded. */
export async function settleBudget(id: string, usage: ReportedUsage | null, rejected = false, servedModel?: string, providerLookup = false) {
	return prisma.$transaction(async tx => {
		const initial = await tx.budgetReservation.findUniqueOrThrow({ where: { id } });
		const budget = await lockBudget(tx, initial.userId);
		const reservation = await tx.budgetReservation.findUniqueOrThrow({ where: { id } });
		if (reservation.status !== 'pending') { return; }
		// The feature flag only gates new reserves, so disabling it cannot strand funds.
		const wallet = reservation.walletId ? await lockWallet(tx, reservation.walletId) : null;
		// Free-model fallback preserves the zero tariff while recording the model that served it.
		const billedModel = reservation.source === 'openrouter' && reservation.model.endsWith(':free') && servedModel?.endsWith(':free')
			? servedModel : reservation.model;
		const percent = reservation.markupPercent || 0;
		const catalog = usage ? usageCostMicros(usage, reservation.inputPerMillion, reservation.outputPerMillion,
			reservation.cacheReadPerMillion ?? reservation.inputPerMillion, reservation.cacheWritePerMillion ?? reservation.inputPerMillion) : null;
		// Provider cost stays unmarked. The reserve already includes the markup frozen on this row.
		const providerActual = rejected ? 0
			: reservation.operation === 'image' ? (reservation.unitPriceMicros ?? reservation.reservedMicros)
			: usage?.cost !== undefined && reservation.source === 'openrouter' ? costMicros(1, 0, usage.cost * 1_000_000, 0)
			: catalog ?? (percent <= 0 ? reservation.reservedMicros : Math.round(reservation.reservedMicros * 100 / (100 + percent)));
		const actual = !rejected && reservation.operation !== 'image' && !usage ? reservation.reservedMicros : applyMarkup(providerActual, percent);
		const walletActual = Math.min(actual, reservation.walletMicros);
		const balanceReserved = reservation.reservedMicros - reservation.walletMicros;
		// A bonus-only request never authorized a debit from the main balance.
		const balanceActual = wallet && balanceReserved === 0 ? 0 : actual - walletActual;
		const charged = walletActual + balanceActual;
		const refund = balanceReserved - balanceActual;
		const walletRefund = reservation.walletMicros - walletActual;
		const status = rejected ? 'refunded' : usage && (reservation.source !== 'openrouter' || usage.cost !== undefined) ? 'reported' : 'estimated';
		const cacheUsage = { cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens || 0,
			cacheWriteTokens: usage?.prompt_tokens_details?.cache_creation_input_tokens || 0 };
		await tx.budgetReservation.update({ where: { id }, data: { model: billedModel, status, costMicros: charged, providerCostMicros: providerActual, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, ...cacheUsage } });
		if (wallet && walletRefund > 0 && new Date() < wallet.expiresAt) {
			await tx.budgetWallet.update({ where: { id: wallet.id }, data: {
				balanceMicros: { increment: walletRefund },
				...(wallet.fiveHourStartedAt?.getTime() === reservation.walletFiveHourStartedAt?.getTime() ? { fiveHourUsedMicros: { decrement: walletRefund } } : {}),
				...(wallet.weeklyStartedAt?.getTime() === reservation.walletWeeklyStartedAt?.getTime() ? { weeklyUsedMicros: { decrement: walletRefund } } : {}),
			} });
			await tx.budgetEntry.create({ data: { userId: budget.userId, key: `settle:${id}:wallet`, kind: 'refund',
				amountMicros: walletRefund, note: `${DEEPSEEK_BONUS_LEDGER}: ${status}: ${reservation.model}` } });
		}
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
			await tx.usageLog.create({ data: { userId: budget.userId, model: billedModel, source: reservation.source, client: reservation.client,
				promptTokens: usage?.prompt_tokens || 0, completionTokens: usage?.completion_tokens || 0, costMicros: charged, providerCostMicros: providerActual,
				markupPercent: percent, walletMicros: walletActual, accounting: status,
				costBasis: providerLookup ? 'provider_lookup' : !usage ? 'reservation' : reservation.source === 'openrouter' && usage.cost !== undefined ? 'provider' : 'catalog',
				requestId: reservation.requestId, requestedModel: reservation.requestedModel, operation: reservation.operation, region: usage?.host ?? reservation.region,
				inputPerMillion: reservation.inputPerMillion, outputPerMillion: reservation.outputPerMillion,
				...cacheUsage, cacheReadPerMillion: reservation.cacheReadPerMillion, cacheWritePerMillion: reservation.cacheWritePerMillion, chatId: reservation.chatId,
				unitPriceMicros: reservation.unitPriceMicros, imageCount: reservation.imageCount } });
		}
	});
}
