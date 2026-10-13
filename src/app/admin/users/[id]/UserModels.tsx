'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Row = {
	id: string;
	name: string;
	inputPerMillion: number | null;
	outputPerMillion: number | null;
	globalEnabled: boolean;
	mode: 'default' | 'on' | 'off';
};

function money(value: number | null) {
	if (value == null) {
		return '—';
	}
	return `$${value >= 1 ? value.toFixed(2) : value.toFixed(4)}`;
}

export default function UserModels({
	userId,
	selected,
	rows,
}: {
	userId: string;
	selected: string | null;
	rows: Row[];
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [current, setCurrent] = useState(selected ?? '');

	async function post(url: string, body: unknown) {
		setBusy(true);
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!response.ok) {
				window.alert(await response.text());
				return false;
			}
			router.refresh();
			return true;
		} finally {
			setBusy(false);
		}
	}

	const usable = rows.filter((row) => (row.mode === 'default' ? row.globalEnabled : row.mode === 'on'));

	return (
		<div className="space-y-4">
			<label className="block text-sm text-gray-700">
				Модель для запросов этого человека
				<select
					value={current}
					disabled={busy}
					onChange={async (event) => {
						const next = event.target.value;
						const ok = await post(`/api/admin/users/${userId}/bedrock-model`, { modelId: next || null });
						if (ok) {
							setCurrent(next);
						}
					}}
					className="mt-1 block w-full max-w-xl rounded-md border border-gray-300 bg-white py-2 pl-2 pr-8 text-sm"
				>
					<option value="">Самая дешёвая из доступных</option>
					{usable.map((row) => (
						<option key={row.id} value={row.id}>{row.name}</option>
					))}
				</select>
			</label>

			<div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
				<table className="min-w-full divide-y divide-gray-200">
					<thead className="bg-gray-50">
						<tr>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Модель</th>
							<th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">$/1M in</th>
							<th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">$/1M out</th>
							<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Доступ</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-gray-200">
						{rows.map((row) => (
							<tr key={row.id}>
								<td className="px-4 py-3">
									<div className="text-sm text-gray-900">{row.name}</div>
									<div className="text-xs text-gray-500 font-mono">{row.id}</div>
								</td>
								<td className="px-4 py-3 text-right text-sm font-mono">{money(row.inputPerMillion)}</td>
								<td className="px-4 py-3 text-right text-sm font-mono">{money(row.outputPerMillion)}</td>
								<td className="px-4 py-3">
									<select
										value={row.mode}
										disabled={busy}
										onChange={(event) => post(`/api/admin/users/${userId}/models`, {
											modelId: row.id,
											mode: event.target.value,
										})}
										className="rounded-md border border-gray-300 bg-white py-1.5 pl-2 pr-8 text-sm"
									>
										<option value="default">Как для всех ({row.globalEnabled ? 'вкл' : 'выкл'})</option>
										<option value="on">Включена</option>
										<option value="off">Выключена</option>
									</select>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
