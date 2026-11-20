import Link from 'next/link';
import { notFound } from 'next/navigation';
import prisma from '@/lib/prisma';
import UserModels from './UserModels';
import UserBudget, { ReconcileReservation } from './UserBudget';
import DeepSeekBonusGrant from '../DeepSeekBonusGrant';
import { budgetSnapshot } from '@/lib/budget';
import { deepSeekBonusConfig, DEEPSEEK_BONUS_LEDGER, readDeepSeekBonus } from '@/lib/deepSeekBonus';
import { billingRates, formatBillingRub } from '@/lib/billingCurrency';

export const dynamic = 'force-dynamic';

async function readUserCard(id: string) {
	try {
		const user = await prisma.user.findUnique({
			where: { id },
			include: { modelAccess: true, budget: { include: {
				entries: { where: { NOT: [{ key: { startsWith: `${DEEPSEEK_BONUS_LEDGER}:` } }, { note: { startsWith: `${DEEPSEEK_BONUS_LEDGER}:` } }] },
					orderBy: { createdAt: 'desc' }, take: 20 },
				reservations: { orderBy: { createdAt: 'desc' }, take: 30 },
			} } },
		});
		if (!user) {
			return null;
		}
		const [models, spent, apiUsage, rates, wallet] = await Promise.all([
			prisma.bedrockModel.findMany(),
			prisma.usageLog.aggregate({
				where: { userId: id, NOT: { model: { endsWith: ':free' } }, OR: [{ accounting: null }, { accounting: 'legacy' }] },
				_sum: { promptTokens: true, completionTokens: true },
			}),
			prisma.usageLog.aggregate({ where: { userId: id, accounting: { in: ['reported', 'estimated'] } }, _sum: { costMicros: true, promptTokens: true, completionTokens: true } }),
			billingRates(),
			user.budget ? readDeepSeekBonus(id) : null,
		]);
		const bonusSpends = wallet ? await prisma.usageLog.findMany({
			where: { userId: id, walletMicros: { gt: 0 }, createdAt: { gte: wallet.createdAt } },
			orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, createdAt: true, walletMicros: true },
		}) : [];
		return { user, models, spent, apiUsage, rates, wallet, bonusSpends };
	} catch {
		return 'error' as const;
	}
}

export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const card = await readUserCard(id);
	if (card === 'error') {
		return (
			<div className="space-y-6">
				<Link href="/admin/users" className="text-sm text-indigo-600 hover:text-indigo-800">← Пользователи</Link>
				<div className="bg-red-50 border-l-4 border-red-500 p-4 text-red-700">
					<p>Карточка не открылась: запрос к базе не прошёл. Обновите схему и перезагрузите страницу.</p>
				</div>
			</div>
		);
	}
	if (!card) {
		notFound();
	}
	const { user, models, spent, apiUsage, rates, wallet, bonusSpends } = card;

	const spentTokens = (spent._sum.promptTokens || 0) + (spent._sum.completionTokens || 0);
	const grants = new Map(user.modelAccess.map((grant) => [grant.modelId, grant.enabled]));
	const budget = user.budget ? budgetSnapshot(user.budget, new Date(), wallet) : null;
	const bonus = budget?.bonus;
	const campaign = deepSeekBonusConfig();
	const money = (micros: number) => formatBillingRub(micros, rates.RUB);
	const modelPrice = (usd: number | null) => formatBillingRub(usd === null ? null : usd * 1_000_000, rates.RUB);
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
				<div className="bg-white border rounded-xl p-4"><div className="text-sm text-gray-500">Остаток API</div><div className="text-2xl font-mono">{money(budget.balanceMicros)}</div><div className="text-sm">{!budget.enabled ? 'Приостановлен' : budget.expired ? 'Срок истёк' : new Date(budget.validUntil).getUTCFullYear() >= 2099 ? 'Без срока' : `До ${new Date(budget.validUntil).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda' })}`}{budget.limitsEnabled === false ? ' · лимиты сняты' : ''}</div></div>
				{[ ['5 часов', budget.fiveHour], ['Неделя', budget.weekly] ] .map(([label, value]) => {
					const window = value as typeof budget.fiveHour;
					return <div key={String(label)} className="bg-white border rounded-xl p-4"><div className="text-sm text-gray-500">{String(label)}</div><div className="font-mono">{money(window.usedMicros)} / {money(window.limitMicros)}</div><div className="text-sm">Запросы: {window.requests} / {window.requestLimit}</div><div className="text-xs text-gray-500">{window.resetsAt ? `Сброс ${new Date(window.resetsAt).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda' })}` : 'Начнётся с первого запроса'}</div></div>;
				})}
			</div>}
			<UserBudget key={rates.RUB ?? 'USD'} userId={user.id} rubRate={rates.RUB} budget={user.budget ? { enabled: user.budget.enabled, limitsEnabled: user.budget.limitsEnabled, fiveHourLimitMicros: user.budget.fiveHourLimitMicros, weeklyLimitMicros: user.budget.weeklyLimitMicros, fiveHourRequestLimit: user.budget.fiveHourRequestLimit, weeklyRequestLimit: user.budget.weeklyRequestLimit } : null} />
			{bonus || (campaign && campaign.expiresAt > new Date() && budget?.enabled && !budget.expired && !user.isBanned) ? <div className="bg-white border rounded-xl p-4 space-y-2">
				<h3 className="font-semibold">Бонус DeepSeek</h3>
				{bonus ? <>
					<p>{money(bonus.balanceMicros)} из {money(bonus.grantedMicros)} · {bonus.expired ? 'срок истёк' : `до ${new Date(bonus.expiresAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })}`}</p>
					<p className="text-sm">За 5 часов {money(bonus.fiveHour.usedMicros)} из {money(bonus.fiveHour.limitMicros)} · За неделю {money(bonus.weekly.usedMicros)} из {money(bonus.weekly.limitMicros)}</p>
					{bonusSpends.length ? <ul className="text-sm">{bonusSpends.map(row => <li key={row.id}>
						{row.createdAt.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })} · {money(row.walletMicros)}
					</li>)}</ul> : null}
				</> : <DeepSeekBonusGrant userId={user.id} />}
			</div> : null}
			{budget && <p className="text-sm text-gray-600">Всего в новом учёте: {money(apiUsage._sum.costMicros || 0)}; входных токенов {(apiUsage._sum.promptTokens || 0).toLocaleString('ru-RU')}, выходных {(apiUsage._sum.completionTokens || 0).toLocaleString('ru-RU')}. При отсутствии usage токены остаются неизвестными, расход помечается как оценочный.</p>}
			{user.budget && <div className="bg-white border rounded-xl p-4 space-y-4 overflow-x-auto">
				<h3 className="font-semibold">Последние расходы API</h3>
				<p className="text-xs text-gray-500">reported — usage провайдера; для Bedrock стоимость рассчитана по каталогу. estimated — usage не получен, удержан резерв. pending — выполняется или требует сверки. Через 10 минут резерв можно закрыть по оценке: вся сумма остаётся списанной, доступ к следующим запросам открывается. Тексты запросов не сохраняются.</p>
				<table className="w-full text-sm"><thead><tr><th className="text-left">Модель</th><th>Вход / выход</th><th>Стоимость</th><th>Учёт</th></tr></thead><tbody>{user.budget.reservations.map(row => <tr key={row.id}><td className="py-2">{row.model}<div className="text-xs text-gray-500">{row.createdAt.toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda' })} · {row.id}</div></td><td className="text-center">{row.promptTokens ?? '—'} / {row.completionTokens ?? '—'}</td><td className="text-center">{money(row.costMicros ?? row.reservedMicros)}{row.providerCostMicros != null ? <div className="text-xs text-gray-500">себестоимость {money(row.providerCostMicros)}</div> : null}</td><td className="text-center">{row.status}{row.status === 'pending' ? <ReconcileReservation userId={user.id} reservationId={row.id} /> : null}</td></tr>)}</tbody></table>
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
						inputPrice: modelPrice(model.inputPerMillion),
						outputPrice: modelPrice(model.outputPerMillion),
						globalEnabled: model.enabled,
						mode: grant === undefined ? 'default' as const : grant ? 'on' as const : 'off' as const,
					};
				})}
			/>
		</div>
	);
}
