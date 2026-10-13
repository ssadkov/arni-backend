import prisma from '@/lib/prisma';
import {
	fetchModelEndpointStatus,
	fetchOpenRouterKeyStatus,
	modelTrafficLight,
	probeModel,
	WATCHED_FREE_MODELS,
	type ModelEndpointStatus,
	type TrafficLight,
} from '@/lib/openRouterStatus';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60 * 1000;
const MODEL_ID = /^[\w.:-]{1,80}\/[\w.:-]{1,160}$/;
const TIME_ZONE = 'Asia/Yekaterinburg';

interface ModelStats {
	model: string;
	requests24h: number;
	ok24h: number;
	unavailable24h: number;
	other24h: number;
	completions7d: number;
}

function formatWhen(date: Date): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: TIME_ZONE,
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	}).format(date);
}

const TRAFFIC_DOT: Record<TrafficLight, string> = {
	green: 'bg-emerald-500',
	yellow: 'bg-amber-400',
	red: 'bg-red-500',
	unknown: 'bg-gray-300',
};

const TRAFFIC_LABEL: Record<TrafficLight, string> = {
	green: 'Green',
	yellow: 'Yellow',
	red: 'Red',
	unknown: 'Unknown',
};

function shortModelName(model: string): string {
	const slug = model.split('/').pop() ?? model;
	return slug.replace(/:free$/, '');
}

function formatUptime(value: number | null): string {
	return value === null ? 'n/a' : `${value.toFixed(1)}%`;
}

function availability(status: ModelEndpointStatus): { label: string; className: string } {
	if (!status.ok) {
		return { label: 'Unknown', className: 'bg-gray-100 text-gray-700' };
	}
	if (status.endpointCount === 0) {
		return { label: 'No providers', className: 'bg-red-100 text-red-800' };
	}
	if (status.bestStatus === 0) {
		return { label: 'Up', className: 'bg-emerald-100 text-emerald-800' };
	}
	if (status.bestStatus !== null && status.bestStatus < 0) {
		return { label: `Down (${status.bestStatus})`, className: 'bg-red-100 text-red-800' };
	}
	if (status.bestStatus !== null) {
		return { label: `Degraded (${status.bestStatus})`, className: 'bg-amber-100 text-amber-800' };
	}
	return { label: 'Unknown', className: 'bg-gray-100 text-gray-700' };
}

export default async function ModelsPage({
	searchParams,
}: {
	searchParams: Promise<{ probe?: string | string[] }>;
}) {
	const probeParam = (await searchParams).probe;
	const requestedProbe = Array.isArray(probeParam) ? probeParam[0] : probeParam;

	const since24h = new Date(Date.now() - DAY_MS);
	const since7d = new Date(Date.now() - 7 * DAY_MS);
	let dbError = false;

	const [key, attempts, completions, recent] = await Promise.all([
		fetchOpenRouterKeyStatus(),
		prisma.modelRequest.groupBy({
			by: ['model', 'statusCode'],
			where: { createdAt: { gte: since24h } },
			_count: { _all: true },
		}).catch(() => {
			dbError = true;
			return [];
		}),
		prisma.usageLog.groupBy({
			by: ['model'],
			where: { createdAt: { gte: since7d } },
			_count: { _all: true },
		}).catch(() => {
			dbError = true;
			return [];
		}),
		prisma.modelRequest.findMany({
			orderBy: { createdAt: 'desc' },
			take: 40,
			include: { user: { select: { email: true } } },
		}).catch(() => {
			dbError = true;
			return [];
		}),
	]);

	const stats = new Map<string, ModelStats>();
	const ensure = (model: string): ModelStats => {
		const existing = stats.get(model);
		if (existing) {
			return existing;
		}
		const created: ModelStats = {
			model,
			requests24h: 0,
			ok24h: 0,
			unavailable24h: 0,
			other24h: 0,
			completions7d: 0,
		};
		stats.set(model, created);
		return created;
	};

	for (const row of attempts) {
		const item = ensure(row.model);
		const count = row._count._all;
		item.requests24h += count;
		if (row.statusCode >= 200 && row.statusCode < 300) {
			item.ok24h += count;
		} else if (row.statusCode === 502 || row.statusCode === 503) {
			item.unavailable24h += count;
		} else {
			item.other24h += count;
		}
	}
	for (const row of completions) {
		ensure(row.model).completions7d = row._count._all;
	}

	const rows = [...stats.values()].sort((a, b) => (b.requests24h + b.completions7d) - (a.requests24h + a.completions7d));
	const watched = [...new Set<string>([...WATCHED_FREE_MODELS, ...rows.map(row => row.model)])]
		.filter(model => model.includes('/'))
		.slice(0, 12);
	const live = await Promise.all(watched.map(model => fetchModelEndpointStatus(model)));

	const probeAllowed = typeof requestedProbe === 'string'
		&& MODEL_ID.test(requestedProbe)
		&& requestedProbe.endsWith(':free')
		&& watched.includes(requestedProbe);
	const probe = probeAllowed ? await probeModel(requestedProbe) : null;

	return (
		<div className="space-y-6">
			<div>
				<h2 className="text-2xl font-bold text-gray-800">Models</h2>
				<p className="text-sm text-gray-500 mt-1">
					Provider uptime is live from OpenRouter. Request rows include failures and start with the next client call. Prompts are not stored. Times are UTC+5.
				</p>
			</div>

			{(() => {
				const preferred = WATCHED_FREE_MODELS.map((model, index) => {
					const status = live.find(item => item.model === model);
					const light = status ? modelTrafficLight(status) : 'unknown';
					return { model, index, status, light };
				});
				const current = preferred.find(item => item.light === 'green' || item.light === 'yellow') ?? preferred[0];
				const moved = current.index > 0;
				return (
					<section className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
						<div className="flex items-center gap-4">
							<span className={`h-14 w-14 rounded-full shrink-0 ${TRAFFIC_DOT[current.light]} ring-8 ring-black/5`} />
							<div>
								<h3 className="text-lg font-semibold text-gray-800">
									{moved ? `Requests use ${shortModelName(current.model)}` : `Default model is ${TRAFFIC_LABEL[current.light].toLowerCase()}`}
								</h3>
								<p className="text-sm text-gray-500 mt-1">
									New chats start on the first model here that is not red. A red model is not sent: the request uses the next green or yellow one.
								</p>
							</div>
						</div>
						<div className="mt-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
							{preferred.map(item => (
								<div key={item.model} className="flex items-center gap-3 rounded-lg border border-gray-100 px-3 py-3">
									<span className={`h-8 w-8 rounded-full shrink-0 ${TRAFFIC_DOT[item.light]}`} />
									<div className="min-w-0">
										<p className="text-sm font-medium text-gray-900 truncate">{item.index === 0 ? '1 · Default' : `${item.index + 1} · Picker`}</p>
										<p className="text-xs font-mono text-gray-500 truncate">{shortModelName(item.model)}</p>
										<p className="text-xs text-gray-400">
											{item.status?.bestStatus !== null && item.status?.bestStatus !== undefined && item.status.bestStatus < 0
												? `Provider marked down · ${formatUptime(item.status.uptimeLast5m)} / 5m`
												: item.status ? `${formatUptime(item.status.uptimeLast5m)} / 5m` : 'n/a'}
										</p>
									</div>
								</div>
							))}
						</div>
					</section>
				);
			})()}

			{dbError && (
				<div className="bg-red-50 border-l-4 border-red-500 p-4 text-red-700">
					Request history is unavailable. Apply the ModelRequest table before relying on these counts.
				</div>
			)}

			<div className="grid grid-cols-1 md:grid-cols-3 gap-6">
				<div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
					<h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">OpenRouter key</h3>
					<p className={`mt-2 text-lg font-semibold ${key.ok ? 'text-gray-900' : 'text-red-600'}`}>
						{key.ok ? (key.label || 'Connected') : 'Unavailable'}
					</p>
					<p className="text-xs text-gray-400 mt-1">{key.error || (key.isFreeTier ? 'Free-tier key' : 'Paid key')}</p>
				</div>
				<div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
					<h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Free models left today</h3>
					<p className="mt-2 text-3xl font-bold text-indigo-600">
						{key.freeDailyRemaining === null ? 'n/a' : key.freeDailyRemaining.toLocaleString('en-US')}
					</p>
					<p className="text-xs text-gray-400 mt-1">
						{key.freeDailyLimit === null ? 'Shared :free daily cap' : `of ${key.freeDailyLimit.toLocaleString('en-US')}, resets 05:00 UTC+5`}
					</p>
				</div>
				<div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
					<h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">Credit remaining</h3>
					<p className="mt-2 text-3xl font-bold text-emerald-600">
						{key.limitRemaining === null ? 'n/a' : `$${key.limitRemaining.toFixed(2)}`}
					</p>
					<p className="text-xs text-gray-400 mt-1">
						{key.usage === null ? 'Account usage not reported' : `Used $${key.usage.toFixed(2)}`}
					</p>
				</div>
			</div>

			{probe && (
				<div className={`border-l-4 p-4 ${probe.ok ? 'bg-emerald-50 border-emerald-500 text-emerald-800' : 'bg-amber-50 border-amber-500 text-amber-900'}`}>
					<p className="font-medium">Live probe {requestedProbe}: HTTP {probe.status || 'n/a'}</p>
					<p className="text-sm mt-1">{probe.error || probe.reply || 'The model accepted the request.'}</p>
				</div>
			)}

			<section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
				<div className="px-6 py-4 border-b border-gray-100">
					<h3 className="text-lg font-semibold text-gray-800">Availability</h3>
					<p className="text-sm text-gray-500">Best provider over the last 30 minutes. Status 0 means the provider is operational. A probe sends one short :free completion.</p>
				</div>
				<div className="overflow-x-auto">
					<table className="min-w-full divide-y divide-gray-200">
						<thead className="bg-gray-50">
							<tr>
								{['Model', 'Status', 'Provider', 'Uptime 5m', 'Uptime 30m', 'Uptime 1d', ''].map(heading => (
									<th key={heading} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{heading}</th>
								))}
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-100">
							{live.map(status => {
								const badge = availability(status);
								return (
									<tr key={status.model}>
										<td className="px-4 py-3 text-sm font-mono text-gray-900">{status.model}</td>
										<td className="px-4 py-3">
											<span className={`px-2 py-1 text-xs font-semibold rounded-full ${badge.className}`}>{badge.label}</span>
											{status.error && <p className="text-xs text-red-600 mt-1 max-w-xs">{status.error}</p>}
										</td>
										<td className="px-4 py-3 text-sm text-gray-700">{status.bestProvider || '—'}</td>
										<td className="px-4 py-3 text-sm text-gray-700">{formatUptime(status.uptimeLast5m)}</td>
										<td className="px-4 py-3 text-sm text-gray-700">{formatUptime(status.uptimeLast30m)}</td>
										<td className="px-4 py-3 text-sm text-gray-700">{formatUptime(status.uptimeLast1d)}</td>
										<td className="px-4 py-3 text-right">
											{status.model.endsWith(':free') && (
												<form>
													<input type="hidden" name="probe" value={status.model} />
													<button className="text-sm text-indigo-600 hover:text-indigo-800" type="submit">Probe</button>
												</form>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</section>

			<section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
				<div className="px-6 py-4 border-b border-gray-100">
					<h3 className="text-lg font-semibold text-gray-800">What people use</h3>
					<p className="text-sm text-gray-500">Attempts are the last 24 hours, including 503s. Completions are successful answers over 7 days.</p>
				</div>
				{rows.length === 0 ? (
					<p className="p-6 text-sm text-gray-500">No model traffic in the last 7 days.</p>
				) : (
					<div className="overflow-x-auto">
						<table className="min-w-full divide-y divide-gray-200">
							<thead className="bg-gray-50">
								<tr>
									{['Model', 'Attempts 24h', 'OK', '503/502', 'Other', 'Completions 7d'].map(heading => (
										<th key={heading} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{heading}</th>
									))}
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-100">
								{rows.map(row => (
									<tr key={row.model}>
										<td className="px-4 py-3 text-sm font-mono text-gray-900">{row.model}</td>
										<td className="px-4 py-3 text-sm text-gray-900">{row.requests24h}</td>
										<td className="px-4 py-3 text-sm text-emerald-700">{row.ok24h}</td>
										<td className="px-4 py-3 text-sm text-red-700">{row.unavailable24h}</td>
										<td className="px-4 py-3 text-sm text-gray-700">{row.other24h}</td>
										<td className="px-4 py-3 text-sm text-gray-900">{row.completions7d}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
				<div className="px-6 py-4 border-b border-gray-100">
					<h3 className="text-lg font-semibold text-gray-800">Recent requests</h3>
				</div>
				{recent.length === 0 ? (
					<p className="p-6 text-sm text-gray-500">No recorded attempts yet. The next client request will show up here, including a 503.</p>
				) : (
					<div className="overflow-x-auto">
						<table className="min-w-full divide-y divide-gray-200">
							<thead className="bg-gray-50">
								<tr>
									{['When', 'User', 'Model', 'Status', 'Time', 'Error'].map(heading => (
										<th key={heading} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{heading}</th>
									))}
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-100">
								{recent.map(request => (
									<tr key={request.id}>
										<td className="px-4 py-3 text-sm text-gray-700 whitespace-nowrap">{formatWhen(request.createdAt)}</td>
										<td className="px-4 py-3 text-sm text-gray-900">{request.user.email}</td>
										<td className="px-4 py-3 text-sm font-mono text-gray-800">
											{request.model}
											{request.routedFrom && <span className="block text-xs text-gray-500">from {request.routedFrom}</span>}
										</td>
										<td className={`px-4 py-3 text-sm font-semibold ${request.statusCode >= 200 && request.statusCode < 300 ? 'text-emerald-700' : 'text-red-700'}`}>{request.statusCode}</td>
										<td className="px-4 py-3 text-sm text-gray-700">{request.durationMs} ms</td>
										<td className="px-4 py-3 text-sm text-gray-600 max-w-md truncate">{request.error || '—'}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}
