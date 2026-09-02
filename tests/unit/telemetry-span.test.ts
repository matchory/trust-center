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
trace.setGlobalTracerProvider(provider);

beforeEach(() => exporter.reset());
afterAll(async () => provider.shutdown());

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
	});

	it('exposes the active trace id inside the span and nothing outside it', async () => {
		const inside = await withSpan('outer', {}, async () => activeTraceId());

		expect(inside).toMatch(/^[0-9a-f]{32}$/);
		expect(activeTraceId()).toBeUndefined();
	});
});
