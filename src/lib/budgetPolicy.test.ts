import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_REQUEST_DURATION_MS, STALE_RESERVATION_MS, staleReservationCutoff } from './budgetPolicy.ts';

test('a reservation turns stale only after the longest request could have finished', () => {
	const now = new Date('2026-11-11T08:00:00.000Z');
	assert.deepStrictEqual({
		outlivesRequests: STALE_RESERVATION_MS > MAX_REQUEST_DURATION_MS,
		cutoff: staleReservationCutoff(now).toISOString(),
	}, {
		outlivesRequests: true,
		cutoff: '2026-11-11T07:50:00.000Z',
	});
});
