import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { handlePaymentNotice, PaymentNoticeError, type PaymentNoticeInput } from '@/lib/billingPayment';

export const dynamic = 'force-dynamic';

function secretMatches(header: string, secret: string): boolean {
	const left = Buffer.from(header);
	const right = Buffer.from(secret);
	return left.length === right.length && timingSafeEqual(left, right);
}

function clientIp(req: NextRequest): string {
	const forwarded = req.headers.get('x-forwarded-for');
	if (forwarded) {
		const first = forwarded.split(',')[0]?.trim();
		if (first) { return first; }
	}
	return '';
}

function failure(status: number, code: string, message: string) {
	return NextResponse.json({ statusCode: status, code, message, details: [] }, { status });
}

export async function POST(req: NextRequest) {
	const secret = process.env.BILLING_WEBHOOK_SECRET?.trim() || '';
	if (!secret) { return failure(503, 'BILLING_WEBHOOK_NOT_CONFIGURED', 'BILLING_WEBHOOK_SECRET не задан'); }
	const header = req.headers.get('x-billing-webhook-secret') || '';
	if (!secretMatches(header, secret)) { return failure(401, 'BILLING_WEBHOOK_UNAUTHORIZED', 'Неверный секрет webhook'); }
	const allowlist = (process.env.BILLING_WEBHOOK_IP_ALLOWLIST || '').split(',').map(ip => ip.trim()).filter(Boolean);
	if (allowlist.length && !allowlist.includes(clientIp(req))) {
		return failure(401, 'BILLING_WEBHOOK_IP_DENIED', 'IP не в allowlist');
	}
	let body: PaymentNoticeInput;
	try { body = await req.json(); }
	catch { return failure(400, 'VALIDATION_ERROR', 'Некорректный JSON'); }
	if (!body || typeof body !== 'object') { return failure(400, 'VALIDATION_ERROR', 'Некорректный JSON'); }
	try {
		const result = await handlePaymentNotice({
			...body,
			idAccount: String(body.idAccount ?? ''),
			idLogicliftUser: String(body.idLogicliftUser ?? ''),
			idRate: String(body.idRate ?? ''),
			accountStatus: String(body.accountStatus ?? ''),
		});
		return NextResponse.json(result);
	} catch (error) {
		if (error instanceof PaymentNoticeError) { return failure(error.status, error.code, error.message); }
		console.error('Payment notice failed:', error instanceof Error ? error.name : 'unknown');
		return failure(500, 'PAYMENT_NOTICE_FAILED', 'Уведомление не проведено');
	}
}
