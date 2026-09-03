import { describe, expect, it } from 'vitest';
import {
	activeTraceId,
	requestAttributes,
	requestSpanName,
	withSpan
} from '../../src/lib/server/telemetry';
import { expectNoSensitiveAttributes, recordingSpans } from '../helpers/telemetry';

const spans = recordingSpans();

describe('requestAttributes', () => {
	it('carries route, method and status', () => {
		expect(
			requestAttributes({ method: 'GET', routeId: '/(portal)/[locale]', status: 200 })
		).toEqual({
			'http.request.method': 'GET',
			'http.route': '/(portal)/[locale]',
			'http.response.status_code': 200
		});
	});

	// An unmatched request has no route id. Emitting the raw path instead would
	// give a path scanner one attribute value per probe.
	it('omits http.route entirely for an unmatched request', () => {
		const attributes = requestAttributes({ method: 'GET', routeId: null, status: 404 });
		expect(attributes).not.toHaveProperty('http.route');
		expect(requestSpanName('GET', null)).toBe('GET unmatched');
	});
});

describe('withSpan', () => {
	it('returns the callback value and ends exactly one span', async () => {
		const result = await withSpan('unit', { 'job.name': 'x' }, async () => 42);

		expect(result).toBe(42);
		const finished = spans();
		expect(finished).toHaveLength(1);
		expect(finished[0]?.name).toBe('unit');
		expect(finished[0]?.attributes['job.name']).toBe('x');
	});

	// A span left open by a throwing callback leaks the active context into
	// whatever runs next, so the failure shows up somewhere unrelated.
	it('ends the span and marks it an error when the callback throws', async () => {
		await expect(
			withSpan('boom', {}, async () => {
				throw new Error('nope');
			})
		).rejects.toThrow('nope');

		const finished = spans();
		expect(finished).toHaveLength(1);
		expect(finished[0]?.status.code).toBe(2); // SpanStatusCode.ERROR
		expect(finished[0]?.status.message).toBeUndefined();
	});

	// An SMTP bounce routinely embeds the recipient ("550 no such user <addr>"),
	// so the error message on the failure path of every withSpan call site is
	// not safe to export verbatim — a span status is exported like any other
	// span data, and `purgeRequester` cannot reach it. This is the failure-path
	// counterpart to tests/unit/telemetry-request.test.ts's query-string case.
	it('carries the failing address nowhere when the callback throws with one in its message', async () => {
		await expect(
			withSpan('mail send', {}, async () => {
				// All three of the shapes the assertion screens for, in one message:
				// an address, a token, and an IP. A real SMTP failure can carry any.
				throw new Error('550 no such user <person@acme.example> token=SECRET from 10.0.0.4');
			})
		).rejects.toThrow();

		const finished = spans();
		expect(finished).toHaveLength(1);
		expectNoSensitiveAttributes(finished[0]);
	});

	it('exposes the active trace id inside the span and nothing outside it', async () => {
		const inside = await withSpan('outer', {}, async () => activeTraceId());

		expect(inside).toMatch(/^[0-9a-f]{32}$/);
		expect(activeTraceId()).toBeUndefined();
	});
});
