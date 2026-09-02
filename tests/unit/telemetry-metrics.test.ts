import { metrics } from '@opentelemetry/api';
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
	type DataPoint,
	type Histogram
} from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordJobTick, recordRequestDuration } from '../../src/lib/server/telemetry';
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

/**
 * Both instruments record **seconds**, and the SDK's default explicit bucket
 * boundaries are shaped for milliseconds — so a histogram that does not declare
 * its own reports every request under five seconds in one bucket and makes p50,
 * p95 and p99 indistinguishable. The attribute tests above pass either way,
 * which is how that shipped once; these read the boundaries off an exported
 * data point, which is the only assertion that can tell the two apart.
 */
async function histogramBoundaries(name: string): Promise<number[] | undefined> {
	await reader.forceFlush();

	const point = exporter
		.getMetrics()
		.flatMap((resource) => resource.scopeMetrics)
		.flatMap((scope) => scope.metrics)
		.filter((metric) => metric.descriptor.name === name)
		.flatMap((metric) => metric.dataPoints as DataPoint<Histogram>[])
		.at(0);

	return point?.value.buckets.boundaries;
}

describe('histogram bucket boundaries', () => {
	it('gives http.server.request.duration the second-shaped semconv boundaries', async () => {
		exporter.reset();
		recordRequestDuration({
			method: 'GET',
			routeId: '/(portal)/[locale]',
			status: 200,
			seconds: 0.4
		});

		expect(await histogramBoundaries('http.server.request.duration')).toEqual([
			0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10
		]);
	});

	// Wider tail than the request histogram on purpose: a job tick legitimately
	// runs for tens of seconds, and the request boundaries would put every real
	// mail drain in the overflow bucket.
	it('gives trustcenter.job.tick.duration a tail that reaches minutes', async () => {
		exporter.reset();
		recordJobTick({ name: 'mail:drain', outcome: 'ok', seconds: 12 });

		const boundaries = await histogramBoundaries('trustcenter.job.tick.duration');

		expect(boundaries).toEqual([0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]);
		expect(boundaries?.at(-1)).toBeGreaterThan(10);
	});
});
