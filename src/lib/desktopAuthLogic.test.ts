import assert from 'node:assert/strict';
import test from 'node:test';
import {
	clientKeyHash,
	formatUserCode,
	hashSecret,
	nextFailedAttempt,
	normalizeUserCode,
	pollDecision,
	secretHashEquals,
	verificationUri,
} from './desktopAuthLogic.ts';

test('user code comparison ignores case, spaces, and the hyphen', () => {
	const code = formatUserCode('AB23EFGH');
	assert.equal(code, 'AB23-EFGH');
	assert.equal(secretHashEquals(hashSecret(normalizeUserCode(code)), normalizeUserCode(' ab23 ef-gh ')), true);
	assert.equal(secretHashEquals(hashSecret(normalizeUserCode(code)), normalizeUserCode('AB23-EFGJ')), false);
});

test('poll decisions cover pending, throttle, denial, expiry, and approval', () => {
	const base = { status: 'pending', expiresAt: 10_000, now: 1_000, lastPolledAt: null, intervalSec: 5 };
	assert.equal(pollDecision(base), 'pending');
	assert.equal(pollDecision({ ...base, lastPolledAt: 8_000, now: 9_000 }), 'slow_down');
	assert.equal(pollDecision({ ...base, lastPolledAt: 1_000, now: 7_000 }), 'pending');
	assert.equal(pollDecision({ ...base, status: 'denied' }), 'denied');
	assert.equal(pollDecision({ ...base, status: 'approved' }), 'approved');
	assert.equal(pollDecision({ ...base, now: 10_000 }), 'expired');
	assert.equal(pollDecision({ ...base, status: 'consumed' }), 'expired');
});

test('slow_down is reported before a denied or approved challenge is revealed', () => {
	const throttled = { status: 'approved', expiresAt: 20_000, now: 6_000, lastPolledAt: 5_000, intervalSec: 5 };
	assert.equal(pollDecision(throttled), 'slow_down');
});

test('five wrong codes deny the challenge', () => {
	assert.deepEqual(nextFailedAttempt(3), { attempts: 4, deny: false });
	assert.deepEqual(nextFailedAttempt(4), { attempts: 5, deny: true });
});

test('verification uri keeps only the public request id on the web origin', () => {
	const requestId = 'abcdefghijklmnopqrstuv';
	const uri = verificationUri('https://chat.arnion.kz/ignored?token=no#frag', requestId);
	const url = new URL(uri);
	assert.equal(url.origin, 'https://chat.arnion.kz');
	assert.equal(url.pathname, '/');
	assert.equal(url.searchParams.get('desktop_request'), requestId);
	assert.equal(url.searchParams.has('device_code'), false);
	assert.equal(url.hash, '');
	assert.equal(uri.includes('device_code'), false);
});

test('verification uri rejects non-https public origins and script urls', () => {
	const requestId = 'abcdefghijklmnopqrstuv';
	assert.throws(() => verificationUri('http://evil.example/path', requestId));
	assert.throws(() => verificationUri('javascript:alert(1)', requestId));
	assert.throws(() => verificationUri('not a url', requestId));
	assert.equal(new URL(verificationUri('http://localhost:5173/app', requestId)).origin, 'http://localhost:5173');
});

test('client key hash does not keep the raw address', () => {
	const hash = clientKeyHash('203.0.113.8, 10.0.0.1', null);
	assert.equal(hash.includes('203.0.113.8'), false);
	assert.equal(hash, clientKeyHash('203.0.113.8', '10.1.1.1'));
	assert.notEqual(hash, clientKeyHash('203.0.113.9', null));
});
