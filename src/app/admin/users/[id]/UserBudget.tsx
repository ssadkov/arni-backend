'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

type BudgetConfig = { enabled: boolean; fiveHourLimitMicros: number; weeklyLimitMicros: number; fiveHourRequestLimit: number; weeklyRequestLimit: number };

export default function UserBudget({ userId, budget }: { userId: string; budget: BudgetConfig | null }) {
	const router = useRouter();
	const pending = useRef<{ key: string; payload: string } | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const payload = JSON.stringify({ grantUsd: Number(form.get('grantUsd')), fiveHourUsd: Number(form.get('fiveHourUsd')),
			weeklyUsd: Number(form.get('weeklyUsd')), fiveHourRequests: Number(form.get('fiveHourRequests')),
			weeklyRequests: Number(form.get('weeklyRequests')), days: Number(form.get('days')), enabled: form.get('enabled') === 'on', note: form.get('note') });
		if (!pending.current || pending.current.payload !== payload) { pending.current = { key: crypto.randomUUID(), payload }; }
		setBusy(true);
		setMessage('');
		try {
			const response = await fetch(`/api/admin/users/${userId}/budget`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...JSON.parse(payload), key: pending.current.key }) });
			const result = await response.json();
			if (!response.ok) { setMessage(result.error || 'Не удалось выдать доступ.'); return; }
			pending.current = null;
			setMessage('Сохранено. Начисление записано в журнал.');
			router.refresh();
		} catch { setMessage('Не удалось подтвердить результат. Повторите без изменения полей: повтор не начислит сумму дважды.'); }
		finally { setBusy(false); }
	}

	return <form onSubmit={submit} className="bg-white border border-gray-100 rounded-xl p-5 space-y-4">
		<h3 className="font-semibold text-gray-800">Доступ за счёт компании</h3>
		<p className="text-sm text-gray-500">Бюджет API в USD. Начисление бесплатно для сотрудника. Лимиты общие для всех его моделей; окна начинаются с первого запроса.</p>
		<fieldset disabled={busy} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 disabled:opacity-50">
			<label className="text-sm">Начислить, $<input name="grantUsd" type="number" min="0" max="1000" step="0.01" defaultValue={budget ? 0 : 20} required className="block border rounded-md p-2 w-full" /></label>
			<label className="text-sm">Лимит на 5 часов, $<input name="fiveHourUsd" type="number" min="0" max="1000" step="0.01" defaultValue={budget ? budget.fiveHourLimitMicros / 1_000_000 : 2} required className="block border rounded-md p-2 w-full" /></label>
			<label className="text-sm">Лимит на неделю, $<input name="weeklyUsd" type="number" min="0" max="1000" step="0.01" defaultValue={budget ? budget.weeklyLimitMicros / 1_000_000 : 5} required className="block border rounded-md p-2 w-full" /></label>
			<label className="text-sm">Запросов за 5 часов<input name="fiveHourRequests" type="number" min="1" max="100000" defaultValue={budget?.fiveHourRequestLimit ?? 150} required className="block border rounded-md p-2 w-full" /></label>
			<label className="text-sm">Запросов за неделю<input name="weeklyRequests" type="number" min="1" max="100000" defaultValue={budget?.weeklyRequestLimit ?? 1000} required className="block border rounded-md p-2 w-full" /></label>
			<label className="text-sm">Срок от начисления, дней<input name="days" type="number" min="1" max="365" defaultValue={30} required className="block border rounded-md p-2 w-full" /></label>
			<label className="text-sm sm:col-span-2">Основание<input name="note" maxLength={300} defaultValue="Внутренний тест сотрудника" required className="block border rounded-md p-2 w-full" /></label>
			<label className="text-sm flex items-center gap-2"><input name="enabled" type="checkbox" defaultChecked={budget?.enabled ?? true} />Доступ включён</label>
		</fieldset>
		<p className="text-xs text-gray-500">Для изменения лимитов без начисления оставьте сумму 0. Начисление продлевает доступ на выбранный срок от текущего момента и сохраняет остаток. Автопродления нет.</p>
		<button type="submit" disabled={busy} className="bg-indigo-600 text-white px-4 py-2 rounded-md disabled:opacity-50">{busy ? 'Сохранение…' : 'Сохранить доступ'}</button>
		<p role="status" className="text-sm text-gray-700">{message}</p>
	</form>;
}

export function ReconcileReservation({ userId, reservationId }: { userId: string; reservationId: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');
	async function reconcile() {
		setBusy(true);
		try {
			const response = await fetch(`/api/admin/users/${userId}/budget/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reservationId }) });
			const payload = await response.json();
			if (!response.ok) { setMessage(payload.error || 'Не удалось закрыть резерв.'); return; }
			router.refresh();
		} catch { setMessage('Не удалось подтвердить закрытие. Можно повторить.'); }
		finally { setBusy(false); }
	}
	return <div><button type="button" onClick={reconcile} disabled={busy} className="text-indigo-600 disabled:opacity-50">Закрыть по оценке</button><p role="status">{message}</p></div>;
}
