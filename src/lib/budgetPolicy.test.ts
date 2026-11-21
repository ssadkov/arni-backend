import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_REQUEST_DURATION_MS, STALE_RESERVATION_MS, staleReservationCutoff, UsageParser } from './budgetPolicy.ts';

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

test('SSE records the first generation ID, host, last finish reason and error without usage', () => {
	const parser = new UsageParser();
	const encoder = new TextEncoder();
	parser.push(encoder.encode('data: {"id":"gen-first","provider":"Wafer"}\n\n'));
	parser.push(encoder.encode('data: {"id":"gen-second","choices":[{"finish_reason":"error"}],"error":{"code":502,"message":"provider disconnected"}}\n\n'));
	parser.push(encoder.encode('data: {"choices":[{"finish_reason":"error"}]}\n\n'));
	assert.deepEqual(parser.streamMetadata(), {
		generationId: 'gen-first', host: 'Wafer', streamError: '502: provider disconnected', finishReason: 'error', completed: false,
	});
	assert.equal(parser.usage, null);
});

test('SSE distinguishes length termination, nested errors and missing terminal markers', () => {
	const encoder = new TextEncoder();
	const length = new UsageParser();
	length.push(encoder.encode('data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DO'));
	length.push(encoder.encode('NE]\n\n'));
	assert.equal(length.streamMetadata().completed, true);
	assert.equal(length.streamMetadata().finishReason, 'length');
	assert.equal(length.streamMetadata().streamError, undefined);

	const error = new UsageParser();
	error.push(encoder.encode(`data: ${JSON.stringify({ choices: [{ error: { message: 'x'.repeat(1000) }, finish_reason: 'error' }] })}\n\n`));
	assert.equal(error.streamMetadata().streamError?.length, 300);
	const missing = new UsageParser();
	assert.equal(missing.streamMetadata().streamError, 'missing_done');
	assert.equal(missing.streamMetadata(true).streamError, 'transport_error');
});
