'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ImportCatalog() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');

	async function run() {
		setBusy(true);
		setMessage('');
		try {
			const response = await fetch('/api/admin/models/import', { method: 'POST' });
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) {
				setMessage(payload.error || 'Не удалось загрузить каталог');
				return;
			}
			setMessage(`Загружено моделей: ${payload.imported}`);
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex items-center gap-3">
			<button
				type="button"
				disabled={busy}
				onClick={run}
				className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md font-medium transition disabled:opacity-50"
			>
				Загрузить каталог
			</button>
			{message && <span className="text-sm text-gray-600">{message}</span>}
		</div>
	);
}

export function ModelToggle({ id, enabled }: { id: string; enabled: boolean }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [on, setOn] = useState(enabled);

	async function change(next: boolean) {
		setBusy(true);
		try {
			const response = await fetch('/api/admin/models', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, enabled: next }),
			});
			if (!response.ok) {
				window.alert(await response.text());
				return;
			}
			setOn(next);
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<button
			type="button"
			disabled={busy}
			onClick={() => change(!on)}
			className={`px-3 py-1 rounded-full text-xs font-semibold ${on ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'} disabled:opacity-50`}
		>
			{on ? 'Включена для всех' : 'Выключена'}
		</button>
	);
}
