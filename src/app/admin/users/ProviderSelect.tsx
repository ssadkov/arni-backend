'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ProviderSelect({
	userId,
	value,
}: {
	userId: string;
	value: 'openrouter' | 'bedrock';
}) {
	const router = useRouter();
	const [current, setCurrent] = useState(value);
	const [busy, setBusy] = useState(false);

	async function change(next: string) {
		setBusy(true);
		try {
			const response = await fetch(`/api/admin/users/${userId}/provider`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: next }),
			});
			if (!response.ok) {
				window.alert(await response.text());
				return;
			}
			setCurrent(next as 'openrouter' | 'bedrock');
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<select
			value={current}
			disabled={busy}
			onChange={(event) => change(event.target.value)}
			className="block w-full max-w-[11rem] rounded-md border border-gray-300 bg-white py-1.5 pl-2 pr-8 text-sm text-gray-900 disabled:opacity-50"
		>
			<option value="openrouter">OpenRouter</option>
			<option value="bedrock">Bedrock (Claude)</option>
		</select>
	);
}
