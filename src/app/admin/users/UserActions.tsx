'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function UserActions({ userId, isBanned }: { userId: string; isBanned: boolean }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	async function credit() {
		const raw = window.prompt('How many tokens to add?', '1000000');
		if (!raw) {
			return;
		}
		const amount = Number(raw.replace(/\s/g, ''));
		if (!Number.isFinite(amount) || amount <= 0) {
			window.alert('Enter a positive number.');
			return;
		}
		setBusy(true);
		try {
			const response = await fetch(`/api/admin/users/${userId}/credit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ amount }),
			});
			if (!response.ok) {
				window.alert(await response.text());
				return;
			}
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	async function toggleBan() {
		setBusy(true);
		try {
			const response = await fetch(`/api/admin/users/${userId}/ban`, { method: 'POST' });
			if (!response.ok) {
				window.alert(await response.text());
				return;
			}
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<button
				type="button"
				disabled={busy}
				onClick={credit}
				className="text-indigo-600 hover:text-indigo-900 mr-3 disabled:opacity-50"
			>
				Начислить
			</button>
			<button
				type="button"
				disabled={busy}
				onClick={toggleBan}
				className="text-red-600 hover:text-red-900 disabled:opacity-50"
			>
				{isBanned ? 'Разбанить' : 'Забанить'}
			</button>
		</>
	);
}
