import { trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const exporter = new InMemorySpanExporter();

beforeAll(async () => {
	Object.assign(process.env, {
		DATABASE_URL: 'postgres://tc:tc@localhost:5432/tc',
		BASE_URL: 'https://trust.example.com',
		LOCALES: 'de,en',
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
});

// Leaves the API as disabled as this file found it, so a real, recording
// provider registered here does not leak into another test file's spans.
afterAll(() => trace.disable());

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

		const values = exporter
			.getFinishedSpans()
			.flatMap((span) => [span.name, ...Object.values(span.attributes).map(String)]);

		expect(values.some((value) => value.includes('SUPERSECRETTOKENVALUE'))).toBe(false);
		expect(values.some((value) => value.includes('token='))).toBe(false);
		expect(values.some((value) => value.includes('@'))).toBe(false);
		expect(values.some((value) => /\d+\.\d+\.\d+\.\d+/.test(value))).toBe(false);
	});
});
