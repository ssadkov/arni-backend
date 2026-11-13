/** The desktop chat a request belongs to, from `X-Arni-Chat-Id`. Invalid values are ignored. */
export function chatIdHeader(headers: Headers): string | undefined {
	const value = headers.get('X-Arni-Chat-Id');
	return value && /^[a-zA-Z0-9:._/-]{1,200}$/.test(value) ? value : undefined;
}
