const CLIENTS = ['web', 'arni', 'arni-code'] as const;

export type RequestClient = typeof CLIENTS[number] | 'unknown';

/** Keeps only the three known apps. Missing and unexpected values stay unknown. */
export function requestClient(value: string | null | undefined): RequestClient {
	const normalized = value?.trim().toLowerCase() ?? '';
	return (CLIENTS as readonly string[]).includes(normalized) ? normalized as RequestClient : 'unknown';
}
