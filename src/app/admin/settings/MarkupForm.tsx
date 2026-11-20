'use client';

import { useState, type FormEvent } from 'react';

type Row = { id: string; percent: number };

export default function MarkupForm({ rows }: { rows: Row[] }) {
	const value = (id: string) => rows.find(row => row.id === id)?.percent;
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState(false);
	const models = rows.filter(row => row.id.startsWith('model:'));

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		const optional = (name: string) => {
			const raw = String(form.get(name) ?? '').trim();
			return raw === '' ? null : Number(raw);
		};
		setBusy(true);
		setMessage('');
		try {
			const response = await fetch('/api/admin/billing/markup', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					global: Number(form.get('global')),
					providers: { bedrock: optional('bedrock'), openrouter: optional('openrouter'), image: optional('image') },
					model: String(form.get('modelId') ?? '').trim() ? { id: String(form.get('modelId')).trim(), percent: optional('modelPercent') } : null,
				}),
			});
			const result = await response.json();
			setMessage(response.ok ? 'Наценка сохранена.' : (result.error || 'Не удалось сохранить.'));
			if (response.ok) { window.location.reload(); }
		} catch {
			setMessage('Не удалось сохранить наценку.');
		} finally { setBusy(false); }
	}

	return <form onSubmit={submit} className="space-y-4">
		<p className="text-sm text-gray-500">100 означает цену в два раза выше, чем берёт провайдер. Пустое поле провайдера или модели снимает отдельную наценку. На бесплатные модели `:free` наценка не действует. Бесплатные начисления сотрудникам не умножаются.</p>
		<label className="block text-sm">Общая наценка, %
			<input name="global" type="number" min="0" max="1000" step="1" required defaultValue={value('global') ?? 100} className="mt-1 block w-full border rounded-md p-2" />
		</label>
		<div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
			<label className="text-sm">Bedrock, %<input name="bedrock" type="number" min="0" max="1000" step="1" defaultValue={value('provider:bedrock') ?? ''} placeholder="как общая" className="mt-1 block w-full border rounded-md p-2" /></label>
			<label className="text-sm">OpenRouter, %<input name="openrouter" type="number" min="0" max="1000" step="1" defaultValue={value('provider:openrouter') ?? ''} placeholder="как общая" className="mt-1 block w-full border rounded-md p-2" /></label>
			<label className="text-sm">Изображения, %<input name="image" type="number" min="0" max="1000" step="1" defaultValue={value('provider:image') ?? ''} placeholder="как общая" className="mt-1 block w-full border rounded-md p-2" /></label>
		</div>
		<div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
			<label className="text-sm">Модель, id<input name="modelId" className="mt-1 block w-full border rounded-md p-2" placeholder="anthropic.claude..." /></label>
			<label className="text-sm">Наценка модели, %<input name="modelPercent" type="number" min="0" max="1000" step="1" className="mt-1 block w-full border rounded-md p-2" placeholder="пусто — сбросить" /></label>
		</div>
		{models.length > 0 && <ul className="text-sm text-gray-600">{models.map(row => <li key={row.id}>{row.id.slice('model:'.length)} — {row.percent}%</li>)}</ul>}
		<button type="submit" disabled={busy} className="bg-indigo-600 text-white px-4 py-2 rounded-md disabled:opacity-50">{busy ? 'Сохранение…' : 'Сохранить наценку'}</button>
		<p className="text-sm text-gray-700">{message}</p>
	</form>;
}
