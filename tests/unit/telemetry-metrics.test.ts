import { metrics } from '@opentelemetry/api';
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
	type DataPoint
} from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordRequestDuration } from '../../src/lib/server/telemetry';
import { resetInstruments } from '../../src/lib/server/telemetry/metrics';

// Delta, not cumulative: a cumulative reader re-exports every attribute
// combination ever recorded on every collect, so `exporter.reset()` between
// cases would not stop the first case's `http.route` point from reappearing
// in the second case's export — the reset only clears the exporter's own
// buffer, not the reader's running aggregation.
const exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
const reader = new PeriodicExportingMetricReader({
	exporter,
	// Long enough that only the explicit forceFlush below exports.
	exportIntervalMillis: 600_000
});

beforeAll(() => {
	// `@opentelemetry/api` registers providers on `globalThis`, not per module
	// graph, and `registerGlobal` silently refuses a second registration — so
	// without this, a meter provider left registered by another test file
	// sharing this worker would make this file's own registration below a
	// no-op, and every recording here would go to nothing. See
	// tests/unit/telemetry-provider.test.ts for the same guard.
	metrics.disable();
	metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
	// The trap this exists for: an instrument built against the API's no-op
	// meter stays a no-op forever, so anything constructed before a provider
	// was registered would silently export nothing. `startTelemetry` calls this
	// for the same reason.
	resetInstruments();
});

// Leaves the API as disabled as this file found it, so a real, recording
// meter provider registered here does not leak into another test file's
// metrics.
afterAll(() => metrics.disable());

describe('recordRequestDuration', () => {
	it('exports http.server.request.duration with the route attributes', async () => {
		recordRequestDuration({
			method: 'GET',
			routeId: '/(portal)/[locale]',
			status: 200,
			seconds: 0.125
		});
		await reader.forceFlush();

		const points = exporter
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
		expect(points[0]?.attributes['http.route']).toBe('/(portal)/[locale]');
		expect(points[0]?.attributes['http.request.method']).toBe('GET');
	});

	// Same rule as the span: an unmatched path must not mint one time series
	// per probe.
	it('omits http.route for an unmatched request', async () => {
		exporter.reset();
		recordRequestDuration({ method: 'GET', routeId: null, status: 404, seconds: 0.01 });
		await reader.forceFlush();

		const points = exporter
			.getMetrics()
			.flatMap((resource) => resource.scopeMetrics)
			.flatMap((scope) => scope.metrics)
			.filter((metric) => metric.descriptor.name === 'http.server.request.duration')
			// `MetricData` is a union over the four aggregation shapes, and TS can't
			// unify their differently-typed `dataPoints` arrays through `flatMap` —
			// but `attributes` has the same shape on every one, which is all this
			// reads.
			.flatMap((metric) => metric.dataPoints as DataPoint<unknown>[]);

		expect(points.some((point) => 'http.route' in point.attributes)).toBe(false);
	});
});
