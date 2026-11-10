import { createHash, timingSafeEqual } from 'node:crypto';

export const DESKTOP_APP_NAME = 'Arni Lite';
export const DESKTOP_TTL_MS = 10 * 60 * 1000;
export const DESKTOP_POLL_INTERVAL_SEC = 5;
export const DESKTOP_MAX_CODE_ATTEMPTS = 5;
export const DESKTOP_START_LIMIT = 8;
export const DESKTOP_START_WINDOW_MS = 10 * 60 * 1000;
export const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const REQUEST_ID = /^[A-Za-z0-9_-]{22,128}$/;

export type PollDecision = 'pending' | 'slow_down' | 'denied' | 'expired' | 'approved';

export function hashSecret(value: string) {
	return createHash('sha256').update(value).digest('hex');
}

export function secretHashEquals(storedHex: string, candidate: string) {
	if (!/^[0-9a-f]{64}$/.test(storedHex)) {
		return false;
	}
	const actual = Buffer.from(hashSecret(candidate), 'hex');
	const expected = Buffer.from(storedHex, 'hex');
	return timingSafeEqual(actual, expected);
}

export function normalizeUserCode(input: string) {
	return input.toUpperCase().replace(/[\s-]/g, '');
}

export function formatUserCode(raw: string) {
	if (raw.length !== 8) {
		throw new Error('user code must be 8 characters');
	}
	return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function safeRequestId(value: string) {
	return REQUEST_ID.test(value);
}

export function clientKeyHash(forwardedFor: string | null, realIp: string | null) {
	const ip = (forwardedFor || '').split(',')[0].trim() || (realIp || '').trim() || 'unknown';
	return hashSecret(`desktop-auth-ip:${ip}`);
}

export function pollDecision(input: {
	status: string;
	expiresAt: number;
	now: number;
	lastPolledAt: number | null;
	intervalSec: number;
}): PollDecision {
	if (input.expiresAt <= input.now || (input.status !== 'pending' && input.status !== 'approved' && input.status !== 'denied')) {
		return 'expired';
	}
	if (input.lastPolledAt !== null && input.now - input.lastPolledAt < input.intervalSec * 1000) {
		return 'slow_down';
	}
	if (input.status === 'denied') {
		return 'denied';
	}
	if (input.status === 'approved') {
		return 'approved';
	}
	return 'pending';
}

export function nextFailedAttempt(current: number, max = DESKTOP_MAX_CODE_ATTEMPTS) {
	const attempts = current + 1;
	return { attempts, deny: attempts >= max };
}

/** Builds the browser page URL. Rejects anything that is not the known web origin. */
export function verificationUri(webOrigin: string, requestId: string) {
	if (!safeRequestId(requestId)) {
		throw new Error('invalid request id');
	}
	const url = new URL(webOrigin);
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.username || url.password || url.protocol === 'javascript:' || url.protocol === 'data:') {
		throw new Error('invalid origin');
	}
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
		throw new Error('invalid origin');
	}
	url.pathname = '/';
	url.search = '';
	url.hash = '';
	url.searchParams.set('desktop_request', requestId);
	return url.toString();
}
