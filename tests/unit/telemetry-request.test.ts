import { metrics, SpanKind, trace } from '@opentelemetry/api';
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
	type DataPoint
} from '@opentelemetry/sdk-metrics';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetInstruments } from '../../src/lib/server/telemetry/metrics';

const exporter = new InMemorySpanExporter();

// This file needs both signals from one request: the throw-path case below
// asserts that a request `handle` never finishes still produces a span *and* a
// duration data point. Delta temporality for the same reason
// tests/unit/telemetry-metrics.test.ts uses it — a cumulative reader would
// re-export an earlier case's point on every collect.
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const reader = new PeriodicExportingMetricReader({
	exporter: metricExporter,
	// Long enough that only an explicit forceFlush exports.
	exportIntervalMillis: 600_000
});

beforeAll(async () => {
	Object.assign(process.env, {
		DATABASE_URL: 'postgres://tc:tc@localhost:5432/tc',
		BASE_URL: 'https://trust.example.com',
		// `de` only, though `de,en` are compiled (project.inlang/settings.json):
		// that gap is what makes the compiled-but-disabled 404 below reachable.
		LOCALES: 'de',
		DEFAULT_LOCALE: 'de',
		OIDC_ISSUER: 'https://idp.example.com',
		OIDC_CLIENT_ID: 'trust-center',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_ADMIN_GROUP: 'trust-center-admins'
	});
	// `@opentelemetry/api` registers providers on `globalThis`, not per module
	// graph, and tests/unit/telemetry-span.test.ts registers a recording
	// tracer provider globally. `registerGlobal` silently refuses a second
	// registration, so without this, this file's own provider would never take
	// effect if it ever shared a worker with that one — see
	// tests/unit/telemetry-provider.test.ts for the same guard.
	trace.disable();
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
	);

	// Same globalThis hazard, same guard — and `resetInstruments` after it,
	// because an instrument built against the API's no-op meter stays a no-op
	// forever, so anything recorded before this point would go nowhere.
	metrics.disable();
	metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
	resetInstruments();
});

// Leaves the API as disabled as this file found it, so a real, recording
// provider registered here does not leak into another test file's spans.
afterAll(() => {
	trace.disable();
	metrics.disable();
});

beforeEach(() => exporter.reset());

type Event = Parameters<import('@sveltejs/kit').Handle>[0]['event'];

function fakeEvent(pathname: string, search = '', routeId: string | null = null): Event {
	return {
		url: new URL(`https://trust.example.com${pathname}${search}`),
		request: new Request(`https://trust.example.com${pathname}${search}`),
		cookies: { get: () => undefined },
		locals: {} as App.Locals,
		route: { id: routeId }
	} as unknown as Event;
}

describe('the request span', () => {
	it('names the span for the route and carries route, method and status', async () => {
		const { handle } = await import('../../src/hooks.server');
		const resolve = vi.fn(async () => new Response(null, { status: 200, headers: new Headers() }));

		await handle({
			event: fakeEvent('/de/documents', '', '/(portal)/[locale]/documents'),
			resolve
		});

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('GET /(portal)/[locale]/documents');
		expect(spans[0]?.attributes['http.route']).toBe('/(portal)/[locale]/documents');
		expect(spans[0]?.attributes['http.response.status_code']).toBe(200);
	});

	// The SDK defaults to INTERNAL, and every trace backend plus the collector's
	// spanmetrics connector keys entry-point detection, service maps and RED
	// aggregation on the kind — so an INTERNAL root carrying http.route is the
	// entry point of no trace anywhere. As permanent as the span name.
	it('is a SERVER span, not the SDK default', async () => {
		const { handle } = await import('../../src/hooks.server');
		const resolve = vi.fn(async () => new Response(null, { status: 200, headers: new Headers() }));

		await handle({ event: fakeEvent('/de', '', '/(portal)/[locale]'), resolve });

		expect(exporter.getFinishedSpans()[0]?.kind).toBe(SpanKind.SERVER);
	});
});

describe('no span attribute carries a secret or an identity', () => {
	// The magic-link and subscription-management tokens live in query strings,
	// so a span that recorded the URL would put a live credential into the
	// operator's monitoring platform — which `purgeRequester` cannot reach.
	// The attribute builder cannot express this (it never receives the URL);
	// this test defends everything the builder does not cover.
	it('records nothing from the query string of a verification link', async () => {
		const { handle } = await import('../../src/hooks.server');
		const resolve = vi.fn(async () => new Response(null, { status: 200, headers: new Headers() }));

		await handle({
			event: fakeEvent(
				'/de/access/verify',
				'?token=SUPERSECRETTOKENVALUE&email=person%40acme.example',
				'/(portal)/access/verify'
			),
			resolve
		});

		const spans = exporter.getFinishedSpans();
		// The branch's permanent security regression test, so it must not be
		// satisfiable by emitting nothing: every `.some(...) === false` below is
		// trivially true over an empty array, and a `withSpan` that stopped
		// producing a span at all would have passed this file unchanged.
		expect(spans).toHaveLength(1);

		const values = spans.flatMap((span) => [
			span.name,
			...Object.values(span.attributes).map(String)
		]);

		expect(values.some((value) => value.includes('SUPERSECRETTOKENVALUE'))).toBe(false);
		expect(values.some((value) => value.includes('token='))).toBe(false);
		expect(values.some((value) => value.includes('@'))).toBe(false);
		expect(values.some((value) => /\d+\.\d+\.\d+\.\d+/.test(value))).toBe(false);
	});
});

describe('a request that throws before resolve', () => {
	// `handle` itself throws the 404 for a compiled-but-disabled locale, and the
	// span used to be created after that point — so this entire class of request
	// was invisible in traces and in metrics at once. `resolve` throwing has the
	// same shape and was equally invisible.
	it('still emits a span and a duration data point, carrying the thrown status', async () => {
		const { handle } = await import('../../src/hooks.server');
		const resolve = vi.fn(async () => new Response(null, { status: 200, headers: new Headers() }));

		// Drain whatever earlier cases recorded, so the flush below sees only
		// this request's point.
		await reader.forceFlush();
		metricExporter.reset();

		await expect(
			handle({ event: fakeEvent('/en/documents', '', null), resolve })
		).rejects.toMatchObject({ status: 404 });

		// The throw is `handle`'s own, before the locale is even resolved.
		expect(resolve).not.toHaveBeenCalled();

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.attributes['http.request.method']).toBe('GET');
		expect(spans[0]?.attributes['http.response.status_code']).toBe(404);

		await reader.forceFlush();
		const points = metricExporter
			.getMetrics()
			.flatMap((resource) => resource.scopeMetrics)
			.flatMap((scope) => scope.metrics)
			.filter((metric) => metric.descriptor.name === 'http.server.request.duration')
			// `MetricData` is a union over the four aggregation shapes, and TS can't
			// unify their differently-typed `dataPoints` arrays through `flatMap` —
			// but `attributes` has the same shape on every one, which is all this
			// reads.
			.flatMap((metric) => metric.dataPoints as DataPoint<unknown>[]);

		expect(points).toHaveLength(1);
		expect(points[0]?.attributes['http.response.status_code']).toBe(404);
	});
});
