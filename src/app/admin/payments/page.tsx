import prisma from '@/lib/prisma';
import { formatBillingRub, billingRates } from '@/lib/billingCurrency';

export const dynamic = 'force-dynamic';

const LABELS: Record<string, string> = {
	PENDING: 'В обработке', CANCELED: 'Отказ', FAILED: 'Ошибка', PAID: 'Оплачен', REFUNDED: 'Возврат', UNKNOWN: 'Неизвестный',
};

export default async function PaymentsPage() {
	let dbError = false;
	let notices: Awaited<ReturnType<typeof prisma.paymentNotice.findMany>> = [];
	try {
		notices = await prisma.paymentNotice.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
	} catch {
		dbError = true;
	}
	const [users, rates] = await Promise.all([
		notices.length ? prisma.user.findMany({ where: { id: { in: notices.map(row => row.userId) } }, select: { id: true, email: true } }) : [],
		billingRates(),
	]);
	const email = new Map(users.map(user => [user.id, user.email]));
	return (
		<div className="space-y-6">
			<h2 className="text-2xl font-bold text-gray-800">Платежи</h2>
			{dbError && <div className="bg-red-50 border-l-4 border-red-500 p-4 text-red-700">Таблица платежей ещё не создана. Примените SQL биллинга.</div>}
			<div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
				<table className="min-w-full text-sm">
					<thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
						<tr>{['Счёт', 'Пользователь', 'Статус', 'Сумма', 'Начислено', 'Когда'].map(heading => <th key={heading} className="px-4 py-3">{heading}</th>)}</tr>
					</thead>
					<tbody className="divide-y divide-gray-100">
						{notices.map(row => <tr key={row.idAccount}>
							<td className="px-4 py-3">{row.accountNumber || row.idAccount}{row.testMode ? <div className="text-xs text-gray-500">тест</div> : null}</td>
							<td className="px-4 py-3">{email.get(row.userId) || row.userId}</td>
							<td className="px-4 py-3">{LABELS[row.status] || row.status}</td>
							<td className="px-4 py-3">{(row.amountKopecks / 100).toLocaleString('ru-RU')} ₽</td>
							<td className="px-4 py-3">{formatBillingRub(row.creditedMicros, rates.RUB, 2)}</td>
							<td className="px-4 py-3">{row.createdAt.toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda' })}</td>
						</tr>)}
						{notices.length === 0 && !dbError && <tr><td className="px-4 py-8 text-center text-gray-500" colSpan={6}>Платежей пока нет.</td></tr>}
					</tbody>
				</table>
			</div>
		</div>
	);
}
