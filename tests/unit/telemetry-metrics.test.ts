import { describe, expect, it } from 'vitest';
import {
	recordEgressDelivery,
	recordEgressFanout,
	recordJobTick,
	recordRequestDuration,
	requestAttributes
} from '../../src/lib/server/telemetry';
import { recordingMetrics } from '../helpers/telemetry';
import type { DataPoint, Histogram } from '@opentelemetry/sdk-metrics';

const metrics = recordingMetrics();

describe('recordRequestDuration', () => {
	it('exports http.server.request.duration with the route attributes', async () => {
		recordRequestDuration(
			requestAttributes({ method: 'GET', routeId: '/(portal)/[locale]', status: 200 }),
			0.125
		);

		const points = await metrics.points('http.server.request.duration');
		expect(points).toHaveLength(1);
		expect(points[0]?.attributes['http.route']).toBe('/(portal)/[locale]');
		expect(points[0]?.attributes['http.request.method']).toBe('GET');
	});

	// Same rule as the span: an unmatched path must not mint one time series
	// per probe.
	it('omits http.route for an unmatched request', async () => {
		await metrics.reset();
		recordRequestDuration(requestAttributes({ method: 'GET', routeId: null, status: 404 }), 0.01);

		const points = await metrics.points('http.server.request.duration');
		expect(points).toHaveLength(1);
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
	const points = (await metrics.points(name)) as DataPoint<Histogram>[];
	return points.at(0)?.value.buckets.boundaries;
}

describe('histogram bucket boundaries', () => {
	it('gives http.server.request.duration the second-shaped semconv boundaries', async () => {
		await metrics.reset();
		recordRequestDuration(
			requestAttributes({ method: 'GET', routeId: '/(portal)/[locale]', status: 200 }),
			0.4
		);

		expect(await histogramBoundaries('http.server.request.duration')).toEqual([
			0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10
		]);
	});

	// Wider tail than the request histogram on purpose: a job tick legitimately
	// runs for tens of seconds, and the request boundaries would put every real
	// mail drain in the overflow bucket.
	it('gives trustcenter.job.tick.duration a tail that reaches minutes', async () => {
		await metrics.reset();
		recordJobTick({ name: 'mail:drain', outcome: 'ok', seconds: 12 });

		expect(await histogramBoundaries('trustcenter.job.tick.duration')).toEqual([
			0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300
		]);
	});
});

describe('recordEgressDelivery', () => {
	/**
	 * §10 names the two attributes exhaustively, and the value of that rule is
	 * in what is *absent*: the endpoint's `name` is unvalidated operator free
	 * text and its host can be a literal IP, both of which §8 bans outright.
	 * Asserting the exact key set is what makes an added third attribute fail
	 * here rather than reaching a monitoring platform.
	 */
	it('labels the counter and the histogram with the endpoint UUID and outcome, and nothing else', async () => {
		await metrics.reset();
		const endpointId = '5c2a1e1e-0000-4000-8000-000000000001';
		recordEgressDelivery({ endpointId, outcome: 'failed', seconds: 0.4 });

		for (const name of ['trustcenter.egress.delivery', 'trustcenter.egress.delivery.duration']) {
			const points = await metrics.points(name);
			expect(points, name).toHaveLength(1);
			expect(Object.keys(points[0]!.attributes).sort(), name).toEqual([
				'egress.endpoint_id',
				'outcome'
			]);
			expect(points[0]?.attributes['egress.endpoint_id'], name).toBe(endpointId);
			expect(points[0]?.attributes['outcome'], name).toBe('failed');
		}
	});

	// One HTTP call on a 10 s timeout, so the request boundaries answer the same
	// question — and the job set's 300 s tail would put every real delivery in
	// the first three buckets.
	it('gives the duration histogram the request-shaped boundaries', async () => {
		await metrics.reset();
		recordEgressDelivery({
			endpointId: '5c2a1e1e-0000-4000-8000-000000000002',
			outcome: 'delivered',
			seconds: 0.4
		});

		expect(await histogramBoundaries('trustcenter.egress.delivery.duration')).toEqual([
			0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10
		]);
	});
});

describe('recordEgressFanout', () => {
	it('adds the enqueued count and exports nothing for an empty tick', async () => {
		await metrics.reset();
		recordEgressFanout(0);
		expect(await metrics.points('trustcenter.egress.fanout')).toHaveLength(0);

		// Most ticks enqueue nothing; a counter that emitted a zero-valued point
		// every fifteen seconds would be a time series carrying no information.
		recordEgressFanout(3);
		const points = await metrics.points('trustcenter.egress.fanout');
		expect(points).toHaveLength(1);
		expect(points[0]?.value).toBe(3);
	});
});
