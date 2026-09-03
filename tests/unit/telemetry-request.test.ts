import { SpanKind } from '@opentelemetry/api';
import { beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server';
import { applyHandleEnv, fakeEvent, fakeResolve } from '../helpers/hooks';
import {
	expectNoSensitiveAttributes,
	recordingMetrics,
	recordingSpans
} from '../helpers/telemetry';

beforeAll(applyHandleEnv);

const spans = recordingSpans();
// This file needs both signals from one request: the throw-path case below
// asserts that a request `handle` never finishes still produces a span *and* a
// duration data point.
const metrics = recordingMetrics();

describe('the request span', () => {
	it('names the span for the route and carries route, method and status', async () => {
		const resolve = fakeResolve();

		await handle({
			event: fakeEvent('/de/documents', '', '/(portal)/[locale]/documents'),
			resolve
		});

		const finished = spans();
		expect(finished).toHaveLength(1);
		expect(finished[0]?.name).toBe('GET /(portal)/[locale]/documents');
		expect(finished[0]?.attributes['http.route']).toBe('/(portal)/[locale]/documents');
		expect(finished[0]?.attributes['http.response.status_code']).toBe(200);
	});

	// SERVER rather than the SDK's default INTERNAL — see `withSpan`'s `kind`
	// parameter for why the kind is as permanent as the span name.
	it('is a SERVER span, not the SDK default', async () => {
		await handle({ event: fakeEvent('/de', '', '/(portal)/[locale]'), resolve: fakeResolve() });

		expect(spans()[0]?.kind).toBe(SpanKind.SERVER);
	});
});

describe('no span attribute carries a secret or an identity', () => {
	// The magic-link and subscription-management tokens live in query strings,
	// so a span that recorded the URL would put a live credential into the
	// operator's monitoring platform — which `purgeRequester` cannot reach.
	// The attribute builder cannot express this (it never receives the URL);
	// this test defends everything the builder does not cover.
	it('records nothing from the query string of a verification link', async () => {
		await handle({
			event: fakeEvent(
				'/de/access/verify',
				'?token=SUPERSECRETTOKENVALUE&email=person%40acme.example',
				'/(portal)/access/verify'
			),
			resolve: fakeResolve()
		});

		const finished = spans();
		// The branch's permanent security regression test, so it must not be
		// satisfiable by emitting nothing: a `withSpan` that stopped producing a
		// span at all would otherwise have passed this file unchanged.
		expect(finished).toHaveLength(1);
		expectNoSensitiveAttributes(finished[0], 'SUPERSECRETTOKENVALUE');
	});
});

describe('a request that throws before resolve', () => {
	// `handle` itself throws the 404 for a compiled-but-disabled locale, and the
	// span used to be created after that point — so this entire class of request
	// was invisible in traces and in metrics at once. `resolve` throwing has the
	// same shape and was equally invisible.
	it('still emits a span and a duration data point, carrying the thrown status', async () => {
		const resolve = fakeResolve();

		// Drain whatever earlier cases recorded, so the read below sees only this
		// request's point.
		await metrics.reset();

		await expect(
			handle({ event: fakeEvent('/en/documents', '', null), resolve })
		).rejects.toMatchObject({ status: 404 });

		// The throw is `handle`'s own, before the locale is even resolved.
		expect(resolve).not.toHaveBeenCalled();

		const finished = spans();
		expect(finished).toHaveLength(1);
		expect(finished[0]?.attributes['http.request.method']).toBe('GET');
		expect(finished[0]?.attributes['http.response.status_code']).toBe(404);

		const points = await metrics.points('http.server.request.duration');
		expect(points).toHaveLength(1);
		expect(points[0]?.attributes['http.response.status_code']).toBe(404);
	});
});
