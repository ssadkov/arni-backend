import { NextRequest } from 'next/server';
import { BudgetError } from '@/lib/budget';
import { checkoutProductId } from '@/lib/billingPayment';
import { encryptCheckoutEmail } from '@/lib/checkoutEmail';
import { webJson, webOptions } from '@/lib/webCors';
import { webUser } from '@/lib/webSession';

export const dynamic = 'force-dynamic';

export function OPTIONS(req: NextRequest) {
	return webOptions(req);
}

export async function GET(req: NextRequest) {
	try {
		const { user } = await webUser(req);
		const base = process.env.BILLING_CHECKOUT_BASE_URL?.trim() || '';
		const product = checkoutProductId();
		const emailSecret = process.env.BILLING_CHECKOUT_EMAIL_SECRET?.trim() || '';
		if (!base.startsWith('https://') || !product || !emailSecret) {
			throw new BudgetError('checkout_not_configured', 'Оплата ещё не настроена.', 503);
		}
		if (!user.email?.trim()) { throw new BudgetError('email_required', 'У аккаунта нет почты для оплаты.', 400); }
		const separator = base.includes('?') ? '&' : '?';
		const url = `${base}${separator}id=${encodeURIComponent(product)}` +
			`&ieu=${encodeURIComponent(user.id)}&em=${encodeURIComponent(encryptCheckoutEmail(user.email, emailSecret))}`;
		return webJson(req, { url });
	} catch (error) {
		const known = error instanceof BudgetError;
		return webJson(req, { error: known ? error.message : 'Не удалось открыть оплату.' }, known ? error.status : 500);
	}
}
