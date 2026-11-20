'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function DeepSeekBonusGrant({ userId }: { userId?: string }) {
	const router = useRouter();
	const [preview, setPreview] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');

	async function run(dryRun: boolean) {
		setBusy(true);
		setMessage('');
		try {
			const response = await fetch('/api/admin/deepseek-bonus/grant', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dryRun, userId }),
			});
			const result = await response.json();
			if (!response.ok) {
				setMessage(result.error || 'Не удалось проверить начисление.');
				return;
			}
			if (dryRun) {
				setPreview(result.count);
				return;
			}
			setPreview(null);
			setMessage(`Начислено ${result.created}. Уже получили ${result.skipped}. Недоступно ${result.unavailable}. Ошибок ${result.failed}.`);
			router.refresh();
		} catch {
			setMessage('Не удалось подтвердить результат. Начисление можно безопасно повторить.');
		} finally {
			setBusy(false);
		}
	}

	return <div className="space-y-2">
		{preview === null
			? <button type="button" disabled={busy} className="text-indigo-600 disabled:opacity-50" onClick={() => void run(true)}>
				{userId ? 'Начислить бонус DeepSeek' : 'Начислить бонус DeepSeek всем активным платным'}
			</button>
			: <div className="flex flex-wrap items-center gap-3">
				<p>Получат бонус: {preview}</p>
				{preview > 0 ? <button type="button" disabled={busy} className="text-indigo-600 disabled:opacity-50" onClick={() => void run(false)}>Подтвердить</button> : null}
				<button type="button" disabled={busy} className="text-gray-600" onClick={() => setPreview(null)}>Закрыть</button>
			</div>}
		<p role="status" className="text-sm">{message}</p>
	</div>;
}
