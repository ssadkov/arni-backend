/**
 * Same order as the client's picker (`PREFERRED_FREE_OPENROUTER_MODELS`).
 * Index 0 is the default for a new chat. The backend does not switch away from it.
 */
export const WATCHED_FREE_MODELS = [
	'nvidia/nemotron-3-ultra-550b-a55b:free',
	'poolside/laguna-s-2.1:free',
	'cohere/north-mini-code:free',
	'nex-agi/nex-n2.5-mini:free',
] as const;

export type TrafficLight = 'green' | 'yellow' | 'red' | 'unknown';

/** Green is healthy, yellow is shaky, red means a new chat on this model is likely to fail. */
export function modelTrafficLight(status: ModelEndpointStatus): TrafficLight {
	if (!status.ok) {
		return 'unknown';
	}
	if (status.endpointCount === 0 || (status.bestStatus !== null && status.bestStatus < 0)) {
		return 'red';
	}
	const uptime = status.uptimeLast5m ?? status.uptimeLast30m;
	if (status.bestStatus === 0) {
		if (uptime === null || uptime >= 95) {
			return 'green';
		}
		if (uptime >= 80) {
			return 'yellow';
		}
		return 'red';
	}
	if (status.bestStatus !== null && status.bestStatus > 0) {
		return 'yellow';
	}
	return 'unknown';
}

const OPENROUTER_ORIGIN = 'https://openrouter.ai/api/v1';

export interface OpenRouterKeyStatus {
	ok: boolean;
	label: string | null;
	limitRemaining: number | null;
	usage: number | null;
	isFreeTier: boolean | null;
	freeDailyLimit: number | null;
	freeDailyRemaining: number | null;
	error: string | null;
}

export interface ModelEndpointStatus {
	model: string;
	ok: boolean;
	error: string | null;
	endpointCount: number;
	bestProvider: string | null;
	/** 0 means the provider is operational. */
	bestStatus: number | null;
	uptimeLast5m: number | null;
	uptimeLast30m: number | null;
	uptimeLast1d: number | null;
}

interface EndpointPayload {
	provider_name?: unknown;
	status?: unknown;
	uptime_last_5m?: unknown;
	uptime_last_30m?: unknown;
	uptime_last_1d?: unknown;
}

function asNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function authHeaders(): Record<string, string> | null {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) {
		return null;
	}
	return {
		Authorization: `Bearer ${key}`,
		'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'https://arni-code.com',
		'X-Title': 'Arni Code IDE',
	};
}

function endpointsUrl(modelId: string): string | null {
	const slash = modelId.indexOf('/');
	if (slash <= 0 || slash === modelId.length - 1) {
		return null;
	}
	const author = encodeURIComponent(modelId.slice(0, slash));
	const slug = encodeURIComponent(modelId.slice(slash + 1));
	return `${OPENROUTER_ORIGIN}/models/${author}/${slug}/endpoints`;
}

export async function fetchOpenRouterKeyStatus(): Promise<OpenRouterKeyStatus> {
	const headers = authHeaders();
	if (!headers) {
		return {
			ok: false,
			label: null,
			limitRemaining: null,
			usage: null,
			isFreeTier: null,
			freeDailyLimit: null,
			freeDailyRemaining: null,
			error: 'OPENROUTER_API_KEY is not set',
		};
	}

	try {
		const response = await fetch(`${OPENROUTER_ORIGIN}/key`, { headers, cache: 'no-store' });
		const json = await response.json().catch(() => ({}));
		if (!response.ok) {
			const detail = typeof json?.error?.message === 'string' ? json.error.message : 'rejected';
			return {
				ok: false,
				label: null,
				limitRemaining: null,
				usage: null,
				isFreeTier: null,
				freeDailyLimit: null,
				freeDailyRemaining: null,
				error: `OpenRouter HTTP ${response.status}: ${detail}`,
			};
		}
		const data = json?.data ?? {};
		const freeDaily = data.free_model_daily_requests ?? {};
		return {
			ok: true,
			label: typeof data.label === 'string' ? data.label : null,
			limitRemaining: asNumber(data.limit_remaining),
			usage: asNumber(data.usage),
			isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
			freeDailyLimit: asNumber(freeDaily.limit),
			freeDailyRemaining: asNumber(freeDaily.remaining),
			error: null,
		};
	} catch (error) {
		return {
			ok: false,
			label: null,
			limitRemaining: null,
			usage: null,
			isFreeTier: null,
			freeDailyLimit: null,
			freeDailyRemaining: null,
			error: error instanceof Error ? error.message : 'Key status request failed',
		};
	}
}

export async function fetchModelEndpointStatus(model: string): Promise<ModelEndpointStatus> {
	const empty: ModelEndpointStatus = {
		model,
		ok: false,
		error: null,
		endpointCount: 0,
		bestProvider: null,
		bestStatus: null,
		uptimeLast5m: null,
		uptimeLast30m: null,
		uptimeLast1d: null,
	};
	const url = endpointsUrl(model);
	if (!url) {
		return { ...empty, error: 'Unrecognized model id' };
	}

	try {
		// The endpoints list is public. A stale local key must not hide provider status.
		const headers = authHeaders() ?? {};
		let response = await fetch(url, { headers, cache: 'no-store' });
		if (!response.ok && headers.Authorization) {
			response = await fetch(url, { cache: 'no-store' });
		}
		const json = await response.json().catch(() => ({}));
		if (!response.ok) {
			const message = typeof json?.error?.message === 'string' ? json.error.message : `HTTP ${response.status}`;
			return { ...empty, error: message };
		}
		const endpoints: EndpointPayload[] = Array.isArray(json?.data?.endpoints) ? json.data.endpoints : [];
		const ranked = [...endpoints].sort((a, b) => (asNumber(b.uptime_last_30m) ?? -1) - (asNumber(a.uptime_last_30m) ?? -1));
		const best = ranked[0];
		return {
			model,
			ok: true,
			error: null,
			endpointCount: endpoints.length,
			bestProvider: typeof best?.provider_name === 'string' ? best.provider_name : null,
			bestStatus: asNumber(best?.status),
			uptimeLast5m: asNumber(best?.uptime_last_5m),
			uptimeLast30m: asNumber(best?.uptime_last_30m),
			uptimeLast1d: asNumber(best?.uptime_last_1d),
		};
	} catch (error) {
		return { ...empty, error: error instanceof Error ? error.message : 'Endpoint status request failed' };
	}
}

const STATUS_TTL_MS = 30_000;
const statusCache = new Map<string, { at: number; status: ModelEndpointStatus }>();

export async function cachedEndpointStatus(model: string): Promise<ModelEndpointStatus> {
	const hit = statusCache.get(model);
	if (hit && Date.now() - hit.at < STATUS_TTL_MS) {
		return hit.status;
	}
	const status = await fetchModelEndpointStatus(model);
	statusCache.set(model, { at: Date.now(), status });
	return status;
}

/** Treat a model as red until the status cache expires, after OpenRouter just refused it. */
export function rememberUnavailable(model: string): void {
	statusCache.set(model, {
		at: Date.now(),
		status: {
			model,
			ok: true,
			error: null,
			endpointCount: 0,
			bestProvider: null,
			bestStatus: -2,
			uptimeLast5m: null,
			uptimeLast30m: null,
			uptimeLast1d: null,
		},
	});
}

export async function trafficByModel(models: readonly string[]): Promise<Map<string, TrafficLight>> {
	const unique = [...new Set(models)];
	const statuses = await Promise.all(unique.map(model => cachedEndpointStatus(model)));
	return new Map(statuses.map(status => [status.model, modelTrafficLight(status)]));
}

/**
 * A red free model is replaced by the first green or yellow model in the picker
 * order. Yellow stays. Unknown stays: a failed status check must not move everyone.
 * Paid models are never rewritten.
 */
export function chooseRoutedModel(requested: string, lights: ReadonlyMap<string, TrafficLight>, candidates: readonly string[] = WATCHED_FREE_MODELS): { model: string; routedFrom: string | null } {
	if (!requested.endsWith(':free') || lights.get(requested) !== 'red') {
		return { model: requested, routedFrom: null };
	}
	const healthy = candidates.find(model => {
		const light = lights.get(model);
		return model !== requested && (light === 'green' || light === 'yellow');
	});
	return healthy
		? { model: healthy, routedFrom: requested }
		: { model: requested, routedFrom: null };
}

export async function routeFreeModel(requested: string, candidates: readonly string[] = WATCHED_FREE_MODELS): Promise<{ model: string; routedFrom: string | null }> {
	if (!requested.endsWith(':free')) {
		return { model: requested, routedFrom: null };
	}
	const lights = await trafficByModel([requested, ...candidates]);
	return chooseRoutedModel(requested, lights, candidates);
}

/** A live completion burns the shared free-model budget, so the admin page only does this on demand. */
export async function probeModel(model: string): Promise<{ status: number; ok: boolean; error: string | null; reply: string | null }> {
	const headers = authHeaders();
	if (!headers) {
		return { status: 0, ok: false, error: 'OPENROUTER_API_KEY is not set', reply: null };
	}
	if (!model.endsWith(':free')) {
		return { status: 0, ok: false, error: 'Live probes are limited to :free models', reply: null };
	}

	try {
		const response = await fetch(`${OPENROUTER_ORIGIN}/chat/completions`, {
			method: 'POST',
			headers: { ...headers, 'Content-Type': 'application/json' },
			cache: 'no-store',
			body: JSON.stringify({
				model,
				max_tokens: 8,
				messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
			}),
		});
		const json = await response.json().catch(() => ({}));
		const error = typeof json?.error?.message === 'string'
			? json.error.message
			: response.ok ? null : `HTTP ${response.status}`;
		const reply = typeof json?.choices?.[0]?.message?.content === 'string' ? json.choices[0].message.content : null;
		return { status: response.status, ok: response.ok, error, reply };
	} catch (error) {
		return { status: 0, ok: false, error: error instanceof Error ? error.message : 'Probe failed', reply: null };
	}
}
