import { trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
	);
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
});
