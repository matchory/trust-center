import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
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
	SimpleSpanProcessor,
	type ReadableSpan
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { resetInstruments } from '../../src/lib/server/telemetry/metrics';

/**
 * Installs a recording tracer provider for the calling file and returns an
 * accessor for the spans it captured.
 *
 * `@opentelemetry/api` registers providers on `globalThis`, not per module
 * graph, and `registerGlobal` silently refuses a second registration — returns
 * false, no throw. So a provider another file left behind would make this one a
 * no-op and every assertion would read an empty exporter: hence the `disable()`
 * before, and the `disable()` after so the next file in the worker inherits
 * nothing. Every telemetry-touching test file shares this one copy of the rule
 * rather than restating it, so instrumenting a further module cannot drift from
 * it.
 */
export function recordingSpans(): () => ReadableSpan[] {
	const exporter = new InMemorySpanExporter();

	beforeAll(() => {
		trace.disable();
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
		);
		// `setGlobalTracerProvider` installs no context manager, and without one
		// `context.active()` never propagates: `startActiveSpan` creates the span
		// but cannot make it the active one, so `activeTraceId()` returns
		// undefined inside `withSpan`. `NodeTracerProvider.register()` does this
		// for us in the real server; a BasicTracerProvider has to be told.
		context.disable();
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
	});

	beforeEach(() => exporter.reset());

	afterAll(() => {
		trace.disable();
		context.disable();
	});

	return () => exporter.getFinishedSpans();
}

/**
 * The metrics counterpart of `recordingSpans`, guarding the same `globalThis`
 * hazard — plus `resetInstruments`, because an instrument built against the
 * API's no-op meter stays a no-op for the life of the process, so anything
 * constructed before this registration would silently record into nothing.
 * `startTelemetry` calls it for exactly that reason.
 *
 * Delta rather than cumulative temporality: a cumulative reader re-exports
 * every attribute combination ever recorded on every collect, so one case's
 * `http.route` point would reappear in the next case's export — `reset` clears
 * the exporter's buffer, never the reader's running aggregation.
 */
export function recordingMetrics(): {
	points: (name: string) => Promise<DataPoint<unknown>[]>;
	reset: () => Promise<void>;
} {
	const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
	const reader = new PeriodicExportingMetricReader({
		exporter,
		// Long enough that only an explicit flush below exports.
		exportIntervalMillis: 600_000
	});

	beforeAll(() => {
		metrics.disable();
		metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
		resetInstruments();
	});

	afterAll(() => metrics.disable());

	return {
		async points(name) {
			await reader.forceFlush();

			return (
				exporter
					.getMetrics()
					.flatMap((resource) => resource.scopeMetrics)
					.flatMap((scope) => scope.metrics)
					.filter((metric) => metric.descriptor.name === name)
					// `MetricData` is a union over the four aggregation shapes, and TS
					// cannot unify their differently-typed `dataPoints` arrays through
					// `flatMap` — but `attributes` and `value` have the same shape on
					// every one, which is all a caller reads.
					.flatMap((metric) => metric.dataPoints as DataPoint<unknown>[])
			);
		},

		async reset() {
			// Flush before clearing: under delta temporality an unflushed
			// aggregation is still pending in the reader, and clearing only the
			// exporter's buffer would let it surface in the next collect.
			await reader.forceFlush();
			exporter.reset();
		}
	};
}

/**
 * Spec §8's permanent regression net: telemetry leaves the boundary
 * `purgeRequester` can reach, so no span may carry a requester's identity or a
 * live credential. Scans the span name and status message alongside the
 * attribute values — the name is always present, so a span that stopped
 * carrying attributes could not satisfy this by emitting nothing.
 *
 * One definition of the rule rather than one per call site, so a site cannot
 * quietly screen for less than the others.
 */
export function expectNoSensitiveAttributes(
	span: ReadableSpan | undefined,
	...alsoForbidden: string[]
): void {
	expect(span).toBeDefined();

	const values = [
		span?.name,
		span?.status.message,
		...Object.values(span?.attributes ?? {}).map(String)
	].filter((value): value is string => typeof value === 'string');

	expect(values).not.toHaveLength(0);
	expect(values.some((value) => value.includes('@'))).toBe(false);
	expect(values.some((value) => value.includes('token='))).toBe(false);
	expect(values.some((value) => /\d+\.\d+\.\d+\.\d+/.test(value))).toBe(false);

	for (const forbidden of alsoForbidden) {
		expect(values.some((value) => value.includes(forbidden))).toBe(false);
	}
}
