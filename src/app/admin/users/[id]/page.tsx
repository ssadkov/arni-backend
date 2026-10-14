import Link from 'next/link';
import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import UserModels from './UserModels';
import UserBudget, { ReconcileReservation } from './UserBudget';
import { budgetSnapshot } from '@/lib/budget';

export const dynamic = 'force-dynamic';

export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const user = await prisma.user.findUnique({
		where: { id },
		include: { modelAccess: true, budget: { include: { entries: { orderBy: { createdAt: 'desc' }, take: 20 }, reservations: { orderBy: { createdAt: 'desc' }, take: 30 } } } },
	});
	if (!user) {
		notFound();
	}

	const [models, spent, apiUsage] = await Promise.all([
		prisma.bedrockModel.findMany(),
		prisma.usageLog.aggregate({
			where: { userId: id, NOT: { model: { endsWith: ':free' } }, OR: [{ accounting: null }, { accounting: 'legacy' }] },
			_sum: { promptTokens: true, completionTokens: true },
		}),
		prisma.usageLog.aggregate({ where: { userId: id, accounting: { in: ['reported', 'estimated'] } }, _sum: { costMicros: true, promptTokens: true, completionTokens: true } }),
	]);

	const spentTokens = (spent._sum.promptTokens || 0) + (spent._sum.completionTokens || 0);
	const grants = new Map(user.modelAccess.map((grant) => [grant.modelId, grant.enabled]));
	const budget = user.budget ? budgetSnapshot(user.budget) : null;
	const money = (micros: number) => `$${(micros / 1_000_000).toFixed(4)}`;
	models.sort((a, b) => {
		if (a.outputPerMillion == null && b.outputPerMillion == null) {
			return a.name.localeCompare(b.name);
		}
		if (a.outputPerMillion == null) {
			return 1;
		}
		if (b.outputPerMillion == null) {
			return -1;
		}
		return a.outputPerMillion - b.outputPerMillion || a.name.localeCompare(b.name);
	});

	return (
		<div className="space-y-6">
			<div>
				<Link href="/admin/users" className="text-sm text-indigo-600 hover:text-indigo-800">← Пользователи</Link>
				<h2 className="text-2xl font-bold text-gray-800 mt-2">{user.email}</h2>
			</div>

			{budget && <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
				<div className="bg-white border rounded-xl p-4"><div className="text-sm text-gray-500">Остаток API</div><div className="text-2xl font-mono">{money(budget.balanceMicros)}</div><div className="text-sm">{!budget.enabled ? 'Приостановлен' : budget.expired ? 'Срок истёк' : `До ${new Date(budget.validUntil).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda' })}`}</div></div>
				{[ ['5 часов', budget.fiveHour], ['Неделя', budget.weekly] ] .map(([label, value]) => {
					const window = value as typeof budget.fiveHour;
					return <div key={String(label)} className="bg-white border rounded-xl p-4"><div className="text-sm text-gray-500">{String(label)}</div><div className="font-mono">{money(window.usedMicros)} / {money(window.limitMicros)}</div><div className="text-sm">Запросы: {window.requests} / {window.requestLimit}</div><div className="text-xs text-gray-500">{window.resetsAt ? `Сброс ${new Date(window.resetsAt).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda' })}` : 'Начнётся с первого запроса'}</div></div>;
				})}
			</div>}
			<UserBudget userId={user.id} budget={user.budget ? { enabled: user.budget.enabled, fiveHourLimitMicros: user.budget.fiveHourLimitMicros, weeklyLimitMicros: user.budget.weeklyLimitMicros, fiveHourRequestLimit: user.budget.fiveHourRequestLimit, weeklyRequestLimit: user.budget.weeklyRequestLimit } : null} />
			{budget && <p className="text-sm text-gray-600">Всего в новом учёте: {money(apiUsage._sum.costMicros || 0)}; входных токенов {(apiUsage._sum.promptTokens || 0).toLocaleString('ru-RU')}, выходных {(apiUsage._sum.completionTokens || 0).toLocaleString('ru-RU')}. При отсутствии usage токены остаются неизвестными, расход помечается как оценочный.</p>}
			{user.budget && <div className="bg-white border rounded-xl p-4 space-y-4 overflow-x-auto">
				<h3 className="font-semibold">Последние расходы API</h3>
				<p className="text-xs text-gray-500">reported — usage провайдера; для Bedrock стоимость рассчитана по каталогу. estimated — usage не получен, удержан резерв. pending — выполняется или требует сверки. Через 10 минут резерв можно закрыть по оценке: вся сумма остаётся списанной, доступ к следующим запросам открывается. Тексты запросов не сохраняются.</p>
				<table className="w-full text-sm"><thead><tr><th className="text-left">Модель</th><th>Вход / выход</th><th>Стоимость</th><th>Учёт</th></tr></thead><tbody>{user.budget.reservations.map(row => <tr key={row.id}><td className="py-2">{row.model}<div className="text-xs text-gray-500">{row.createdAt.toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda' })} · {row.id}</div></td><td className="text-center">{row.promptTokens ?? '—'} / {row.completionTokens ?? '—'}</td><td className="text-center">{money(row.costMicros ?? row.reservedMicros)}</td><td className="text-center">{row.status}{row.status === 'pending' ? <ReconcileReservation userId={user.id} reservationId={row.id} /> : null}</td></tr>)}</tbody></table>
				<h3 className="font-semibold">Журнал баланса</h3>
				{user.budget.entries.map(entry => <div key={entry.id} className="flex justify-between gap-4 text-sm"><span>{entry.kind}: {entry.note}</span><span className="font-mono whitespace-nowrap">{money(entry.amountMicros)}</span></div>)}
			</div>}
			<div className="grid grid-cols-3 gap-4">
				<div className="bg-white rounded-xl border border-gray-100 p-4">
					<div className="text-xs uppercase text-gray-500">Старый баланс: выделено токенов</div>
					<div className="text-2xl font-mono">{(user.tokenBalance + spentTokens).toLocaleString('ru-RU')}</div>
				</div>
				<div className="bg-white rounded-xl border border-gray-100 p-4">
					<div className="text-xs uppercase text-gray-500">Потрачено</div>
					<div className="text-2xl font-mono">{spentTokens.toLocaleString('ru-RU')}</div>
				</div>
				<div className="bg-white rounded-xl border border-gray-100 p-4">
					<div className="text-xs uppercase text-gray-500">Осталось</div>
					<div className="text-2xl font-mono">{user.tokenBalance.toLocaleString('ru-RU')}</div>
				</div>
			</div>
			<p className="text-sm text-gray-500">
				Исторический токеновый баланс. После выдачи бюджета API новые запросы расходуют денежный бюджет, а токены сохраняются в истории. Старые токены автоматически в деньги не переводятся.
			</p>

			<UserModels
				userId={user.id}
				selected={user.bedrockModelId}
				rows={models.map((model) => {
					const grant = grants.get(model.id);
					return {
						id: model.id,
						name: model.name,
						inputPerMillion: model.inputPerMillion,
						outputPerMillion: model.outputPerMillion,
						globalEnabled: model.enabled,
						mode: grant === undefined ? 'default' as const : grant ? 'on' as const : 'off' as const,
					};
				})}
			/>
		</div>
	);
}
