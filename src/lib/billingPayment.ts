import type { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { billingRates } from '@/lib/billingCurrency';

/** Paid balance does not expire. Admin grants still use their own term until the first payment. */
export const PAID_UNTIL = new Date('2099-01-01T00:00:00.000Z');
const BALANCE_CAP_MICROS = 1_000_000_000;

export class PaymentNoticeError extends Error {
	constructor(public readonly status: number, public readonly code: string, message: string) {
		super(message);
	}
}

export type PaymentGoods = { name?: string; id?: string };
export type PaymentNoticeInput = {
	idAccount: string;
	accountNumber?: string | null;
	idLogicliftUser: string;
	idRate: string;
	accountStatus: string;
	accountSum: number | string;
	currency?: string | null;
	paymentSystem?: string | null;
	provider?: string | null;
	email?: string | null;
	goods?: PaymentGoods[] | null;
	dateOfOrder?: string | null;
	dateOfPayment?: string | null;
	eventAt?: string | null;
	testMode?: boolean | string | number | null;
};

const STATUS_BY_ID: Record<string, string> = {
	'1': 'PENDING', '2': 'CANCELED', '3': 'PENDING', '4': 'FAILED', '5': 'PAID', '6': 'REFUNDED',
};
const STATUS_BY_LABEL: Record<string, string> = {
	'создан': 'PENDING', 'отказ': 'CANCELED', 'в обработке': 'PENDING', 'ошибка': 'FAILED',
	'оплачен': 'PAID', 'возврат товара': 'REFUNDED', 'возврат': 'REFUNDED',
};

export function mapAccountStatus(raw: string | number): string {
	const value = String(raw ?? '').trim();
	if (!value) { return 'UNKNOWN'; }
	return STATUS_BY_ID[value] || STATUS_BY_LABEL[value.toLowerCase()] || 'UNKNOWN';
}

export function parseAmount(value: number | string): number {
	const amount = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
	if (!Number.isFinite(amount) || amount < 0) { throw new PaymentNoticeError(400, 'VALIDATION_ERROR', 'accountSum некорректен'); }
	return Math.round(amount * 100) / 100;
}

export function parseTestMode(value: boolean | string | number | null | undefined): boolean {
	if (typeof value === 'boolean') { return value; }
	if (typeof value === 'number') { return value !== 0; }
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
	}
	return false;
}

export function rublesToMicros(rubles: number, rubPerUsd: number | null): number {
	if (rubPerUsd == null || !Number.isFinite(rubPerUsd) || rubPerUsd <= 0) { throw new PaymentNoticeError(503, 'RATE_UNAVAILABLE', 'Курс рубля недоступен'); }
	return Math.round(rubles / rubPerUsd * 1_000_000);
}

function optionalText(value: unknown): string | null {
	if (value === undefined || value === null) { return null; }
	const text = String(value).trim();
	return text || null;
}

function parseDate(value: string | null | undefined): Date | null {
	if (!value) { return null; }
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith('0000-00-00')) { return null; }
	const date = new Date(trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T'));
	return Number.isNaN(date.getTime()) ? null : date;
}

function productIds(input: PaymentNoticeInput): string[] {
	const ids = [input.idRate];
	if (Array.isArray(input.goods)) {
		for (const item of input.goods) {
			if (item?.id !== undefined && item.id !== null) { ids.push(String(item.id)); }
		}
	}
	return ids.map(id => id.trim()).filter(Boolean);
}

export function checkoutProductId(): string {
	return process.env.BILLING_CHECKOUT_PRODUCT_TOPUP?.trim() || '';
}

export function checkoutConfigured(): boolean {
	const base = process.env.BILLING_CHECKOUT_BASE_URL?.trim() || '';
	return base.startsWith('https://') && Boolean(checkoutProductId()) && Boolean(process.env.BILLING_CHECKOUT_EMAIL_SECRET?.trim());
}

export async function handlePaymentNotice(input: PaymentNoticeInput, rubPerUsd?: number | null) {
	const idAccount = input.idAccount.trim();
	const userId = input.idLogicliftUser.trim();
	const accountStatus = input.accountStatus.trim();
	if (!idAccount || !userId || !input.idRate.trim() || !accountStatus) {
		throw new PaymentNoticeError(400, 'VALIDATION_ERROR', 'Нужны idAccount, idLogicliftUser, idRate и accountStatus');
	}
	const currency = (input.currency?.trim() || 'RUB').toUpperCase();
	if (currency !== 'RUB') { throw new PaymentNoticeError(400, 'VALIDATION_ERROR', 'Ожидается сумма в RUB'); }
	const product = checkoutProductId();
	if (!product) { throw new PaymentNoticeError(503, 'BILLING_PRODUCT_NOT_CONFIGURED', 'BILLING_CHECKOUT_PRODUCT_TOPUP не задан'); }
	if (!productIds(input).includes(product)) {
		throw new PaymentNoticeError(400, 'UNKNOWN_RATE', `Товар idRate=${input.idRate} не является пополнением Arni`);
	}
	const amount = parseAmount(input.accountSum);
	const amountKopecks = Math.round(amount * 100);
	const status = mapAccountStatus(accountStatus);
	const testMode = parseTestMode(input.testMode);
	const rate = rubPerUsd === undefined ? (await billingRates()).RUB : rubPerUsd;
	const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
	if (!user) { throw new PaymentNoticeError(404, 'USER_NOT_FOUND', `Пользователь ${userId} не найден`); }

	return prisma.$transaction(async tx => {
		await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
		const existing = await tx.paymentNotice.findUnique({ where: { idAccount } });
		const data = {
			userId, accountNumber: optionalText(input.accountNumber), idRate: input.idRate.trim(), accountStatus, status,
			amountKopecks, currency, paymentSystem: optionalText(input.paymentSystem), provider: optionalText(input.provider),
			email: optionalText(input.email),
			goods: Array.isArray(input.goods) ? input.goods as Prisma.InputJsonValue : undefined,
			dateOfOrder: parseDate(input.dateOfOrder), dateOfPayment: parseDate(input.dateOfPayment),
			eventAt: parseDate(input.eventAt) ?? new Date(), testMode,
		};
		if (!existing) {
			const creditedMicros = !testMode && status === 'PAID' ? rublesToMicros(amount, rate) : 0;
			if (creditedMicros > BALANCE_CAP_MICROS) { throw new PaymentNoticeError(409, 'BALANCE_LIMIT', 'Сумма пополнения больше допустимого остатка'); }
			await tx.paymentNotice.create({ data: { idAccount, ...data, rubPerUsd: creditedMicros ? rate : null, creditedMicros } });
			if (creditedMicros) { await credit(tx, userId, idAccount, creditedMicros, amountKopecks, rate); }
			return { ok: true as const, paymentId: idAccount, status: creditedMicros ? 'PAID' : status, created: true };
		}
		if (existing.userId !== userId) { throw new PaymentNoticeError(409, 'ACCOUNT_CONFLICT', 'Счёт уже привязан к другому пользователю'); }
		let nextStatus = status;
		let creditedMicros = existing.creditedMicros;
		if (!testMode && !existing.testMode && status === 'PAID' && existing.creditedMicros === 0 && existing.status !== 'REFUNDED') {
			creditedMicros = rublesToMicros(amount, rate);
			await credit(tx, userId, idAccount, creditedMicros, amountKopecks, rate);
			nextStatus = 'PAID';
		} else if (!testMode && !existing.testMode && status === 'REFUNDED' && existing.status === 'PAID' && existing.creditedMicros > 0) {
			await refund(tx, userId, idAccount, existing.creditedMicros);
			nextStatus = 'REFUNDED';
		} else {
			nextStatus = existing.status === 'PAID' || existing.status === 'REFUNDED' ? existing.status : status;
		}
		await tx.paymentNotice.update({ where: { idAccount }, data: { ...data, status: nextStatus, creditedMicros, rubPerUsd: existing.rubPerUsd } });
		return { ok: true as const, paymentId: idAccount, status: nextStatus, created: false };
	});
}

async function credit(tx: Prisma.TransactionClient, userId: string, idAccount: string, micros: number, rubKopecks: number, rate: number | null) {
	if (rate == null) { throw new PaymentNoticeError(503, 'RATE_UNAVAILABLE', 'Курс рубля недоступен'); }
	const previous = await tx.accountBudget.findUnique({ where: { userId } });
	if ((previous?.balanceMicros || 0) + micros > BALANCE_CAP_MICROS) {
		throw new PaymentNoticeError(409, 'BALANCE_LIMIT', 'Сумма пополнения больше допустимого остатка');
	}
	await tx.accountBudget.upsert({
		where: { userId },
		create: { userId, enabled: true, balanceMicros: micros, validUntil: PAID_UNTIL },
		update: { enabled: true, validUntil: PAID_UNTIL, balanceMicros: { increment: micros } },
	});
	await tx.budgetEntry.create({ data: {
		userId, key: `payment:${idAccount}`, kind: 'payment', amountMicros: micros, rubKopecks, rubPerUsd: rate, externalId: idAccount,
		note: `Оплата ${(rubKopecks / 100).toFixed(2)} RUB · счёт ${idAccount}`,
	} });
}

async function refund(tx: Prisma.TransactionClient, userId: string, idAccount: string, micros: number) {
	await tx.accountBudget.update({ where: { userId }, data: { balanceMicros: { decrement: micros } } });
	await tx.budgetEntry.create({ data: {
		userId, key: `payment-refund:${idAccount}`, kind: 'payment_refund', amountMicros: -micros, externalId: idAccount,
		note: `Возврат счёта ${idAccount}`,
	} });
}
