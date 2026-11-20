import prisma from '@/lib/prisma';
import MarkupForm from './MarkupForm';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
	let rows: { id: string; percent: number }[] = [];
	let dbError = false;
	try {
		rows = await prisma.billingMarkup.findMany({ orderBy: { id: 'asc' }, select: { id: true, percent: true } });
	} catch {
		dbError = true;
	}
	return (
		<div className="space-y-6">
			<h2 className="text-2xl font-bold text-gray-800">Настройки системы</h2>
			{dbError && <div className="bg-red-50 border-l-4 border-red-500 p-4 text-red-700">Таблица наценки ещё не создана. Примените SQL биллинга.</div>}
			<div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
				<h3 className="text-lg font-medium text-gray-900">Наценка</h3>
				<div className="mt-4">{dbError ? null : <MarkupForm rows={rows} />}</div>
			</div>
			<div className="bg-blue-50 border-l-4 border-blue-400 p-4 text-sm text-blue-700">
				Секрет уведомления об оплате, id товара и адрес страницы оплаты задаются переменными окружения: BILLING_WEBHOOK_SECRET, BILLING_CHECKOUT_PRODUCT_TOPUP, BILLING_CHECKOUT_BASE_URL, BILLING_CHECKOUT_EMAIL_SECRET.
			</div>
		</div>
	);
}
