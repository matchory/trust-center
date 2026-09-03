import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
	activeTraceId,
	requestAttributes,
	requestSpanName,
	withSpan
} from '../../src/lib/server/telemetry';

// `trace.setGlobalTracerProvider` does not install a context manager, and
// without one `context.active()` never propagates — `startActiveSpan` creates
// the span but cannot make it active, so `getActiveSpan()` returns undefined.
// `NodeTracerProvider.register()` does this for us in the real server; a
// BasicTracerProvider in a test has to do it by hand.
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)]
});
// `registerGlobal` silently refuses a second registration (returns false, no
// throw) once a provider is on globalThis, so without this the file's own
// provider would never take effect when it shares a worker with another that
// registered one. Every other telemetry test file takes this guard against
// *this* file by name; this file has to take it too.
trace.disable();
trace.setGlobalTracerProvider(provider);

beforeEach(() => exporter.reset());
afterAll(async () => {
	await provider.shutdown();
	// Shutting the provider down does not unregister it: left as it was, the
	// API's global delegate still points at a dead recording provider for
	// whichever test file runs next in this worker.
	trace.disable();
});

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
		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('unit');
		expect(spans[0]?.attributes['job.name']).toBe('x');
	});

	// A span left open by a throwing callback leaks the active context into
	// whatever runs next, so the failure shows up somewhere unrelated.
	it('ends the span and marks it an error when the callback throws', async () => {
		await expect(
			withSpan('boom', {}, async () => {
				throw new Error('nope');
			})
		).rejects.toThrow('nope');

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.status.code).toBe(2); // SpanStatusCode.ERROR
		expect(spans[0]?.status.message).toBeUndefined();
	});

	// An SMTP bounce routinely embeds the recipient ("550 no such user <addr>"),
	// so the error message on the failure path of every withSpan call site is
	// not safe to export verbatim — a span status is exported like any other
	// span data, and `purgeRequester` cannot reach it. This is the failure-path
	// counterpart to tests/unit/telemetry-request.test.ts's query-string case.
	it('carries the failing address nowhere when the callback throws with one in its message', async () => {
		await expect(
			withSpan('mail send', {}, async () => {
				// All three of the shapes the request-path case screens for, in one
				// message: an address, a token, and an IP. A real SMTP failure can
				// carry any of them.
				throw new Error('550 no such user <person@acme.example> token=SECRET from 10.0.0.4');
			})
		).rejects.toThrow();

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);

		const values = [
			spans[0]?.name,
			spans[0]?.status.message,
			...Object.values(spans[0]?.attributes ?? {}).map(String)
		].filter((value): value is string => typeof value === 'string');

		// Non-vacuous: the span name is always here, so an empty span could not
		// satisfy these by emitting nothing.
		expect(values).not.toHaveLength(0);
		expect(values.some((value) => value.includes('@'))).toBe(false);
		expect(values.some((value) => value.includes('token='))).toBe(false);
		expect(values.some((value) => /\d+\.\d+\.\d+\.\d+/.test(value))).toBe(false);
	});

	it('exposes the active trace id inside the span and nothing outside it', async () => {
		const inside = await withSpan('outer', {}, async () => activeTraceId());

		expect(inside).toMatch(/^[0-9a-f]{32}$/);
		expect(activeTraceId()).toBeUndefined();
	});
});
