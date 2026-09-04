import { metrics, type Attributes } from '@opentelemetry/api';

const METER_NAME = 'trust-center';

/**
 * Instruments are created on first use rather than at module load. An
 * instrument built against the API's no-op meter stays a no-op for the life of
 * the process, so building them at import time — which happens before `init`
 * registers the real provider — would silently export nothing forever.
 */
let instruments: ReturnType<typeof build> | undefined;

/**
 * The semantic-convention boundaries for `http.server.request.duration`. Both
 * histograms here declare their own, because the SDK's default set —
 * `[0, 5, 10, 25, …, 10000]` — is shaped for milliseconds. Recording seconds
 * against it puts every request faster than five seconds in the first bucket,
 * so p50, p95 and p99 all report as "≤ 5s" for essentially all traffic and
 * "which routes are slow" becomes unanswerable, which is one of the three
 * questions this subsystem exists to answer (spec §1).
 */
const REQUEST_DURATION_BUCKETS = [
	0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10
];

/**
 * Wider than the request set, and deliberately so: a request over ten seconds
 * is already a defect, but a job tick legitimately runs for tens of seconds —
 * `mail:drain` sends up to 25 messages through a remote SMTP server, and the
 * retention sweep scans. Sharing the request boundaries would pile every real
 * drain into the overflow bucket and hide exactly the growth an operator wants
 * to see coming.
 */
const JOB_TICK_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

function build() {
	const meter = metrics.getMeter(METER_NAME);

	return {
		requestDuration: meter.createHistogram('http.server.request.duration', {
			description: 'Duration of inbound HTTP requests',
			unit: 's',
			advice: { explicitBucketBoundaries: REQUEST_DURATION_BUCKETS }
		}),
		jobTickDuration: meter.createHistogram('trustcenter.job.tick.duration', {
			description: 'Duration of one background job tick',
			unit: 's',
			advice: { explicitBucketBoundaries: JOB_TICK_DURATION_BUCKETS }
		}),
		jobTick: meter.createCounter('trustcenter.job.tick', {
			description: 'Background job ticks by outcome'
		}),
		egressDelivery: meter.createCounter('trustcenter.egress.delivery', {
			description: 'Event deliveries by outcome'
		}),
		egressDeliveryDuration: meter.createHistogram('trustcenter.egress.delivery.duration', {
			description: 'Duration of one event delivery attempt',
			unit: 's',
			// The request set, not the job set: a delivery is one HTTP call on a
			// 10 s timeout, so the same boundaries answer the same question.
			advice: { explicitBucketBoundaries: REQUEST_DURATION_BUCKETS }
		}),
		egressFanout: meter.createCounter('trustcenter.egress.fanout', {
			description: 'Deliveries enqueued by fan-out'
		}),
		auditSinkBatch: meter.createCounter('trustcenter.auditsink.batch', {
			description: 'Audit batch shipments by sink and outcome'
		}),
		auditSinkDigestMismatch: meter.createCounter('trustcenter.auditsink.digest_mismatch', {
			description: 'Rebuilt batches whose digest no longer matches the recorded one'
		})
	};
}

function get() {
	return (instruments ??= build());
}

/**
 * Takes the attributes the caller already put on the span rather than building
 * its own, so the span and the data point are not merely built by the same rule
 * but are the same values — including the unmatched-route omission, which keeps
 * an unmatched path from minting one time series per probe.
 */
export function recordRequestDuration(attributes: Attributes, seconds: number): void {
	get().requestDuration.record(seconds, attributes);
}

/**
 * `locked` is not a failure: another replica held the advisory lock and this
 * tick correctly skipped. Distinguishing it from `ok` is what makes "the job
 * is not running anywhere" different from "the job is running elsewhere".
 */
export function recordJobTick(input: {
	name: string;
	outcome: 'ok' | 'locked' | 'error';
	seconds: number;
}): void {
	const { jobTickDuration, jobTick } = get();

	// The duration carries no `outcome`: it is the histogram an operator reads
	// for "is this job getting slower", and splitting it by outcome would put
	// the `locked` ticks — which do no work at all — in the same chart.
	jobTickDuration.record(input.seconds, { 'job.name': input.name });
	jobTick.add(1, { 'job.name': input.name, outcome: input.outcome });
}

/**
 * The endpoint's UUID, never its `name`, URL or host. A host can be a literal
 * IP address and §8 bans IP addresses from telemetry outright — an attribute
 * whose value is *sometimes* an IP cannot be sanitised into compliance, which
 * is C's carry-over §1.1 reasoning for dropping `server.address`. `name` is
 * unvalidated operator free text, and an operator who names an endpoint after
 * its URL or a contact address puts exactly that into a metric label. The UUID
 * costs one lookup and is not a judgement call (spec §10).
 *
 * Unlike `recordJobTick`, the duration keeps `outcome`: a `skipped` row makes
 * no HTTP request at all, so an operator asking "is delivery getting slower"
 * has to be able to exclude those — dropping the attribute would put a
 * sub-millisecond skip in the same distribution as a ten-second timeout with
 * no way to tell them apart. Three series per endpoint is the whole cost.
 */
export function recordEgressDelivery(input: {
	endpointId: string;
	outcome: 'delivered' | 'failed' | 'skipped';
	seconds: number;
}): void {
	const attributes: Attributes = {
		'egress.endpoint_id': input.endpointId,
		outcome: input.outcome
	};

	get().egressDelivery.add(1, attributes);
	get().egressDeliveryDuration.record(input.seconds, attributes);
}

/**
 * Unattributed on purpose: fan-out is per endpoint, but the endpoint a row was
 * enqueued *for* is already the `egress.endpoint_id` on every delivery this
 * counter's rows turn into, and splitting the total here would only duplicate
 * that at the cost of a series per endpoint on a counter nobody breaks down.
 */
export function recordEgressFanout(enqueued: number): void {
	if (enqueued > 0) get().egressFanout.add(enqueued);
}

/**
 * The sink name, never a key, bucket or endpoint: `sink` is a closed set of two
 * values (SINK_NAMES), so it cannot become a cardinality problem, and none of
 * the configuration around it belongs in a metric label (spec §9).
 *
 * No duration histogram beside it, unlike egress: a shipment's time is
 * dominated by the size of the batch, which the operator chose, so the number
 * would answer "how big are the batches" rather than "is the sink slow".
 */
export function recordAuditSinkBatch(input: { sink: string; outcome: 'shipped' | 'failed' }): void {
	get().auditSinkBatch.add(1, { 'auditsink.sink': input.sink, outcome: input.outcome });
}

/**
 * Unattributed: §4.3's mismatch is a property of the batch, not of a sink — the
 * bytes were rebuilt once and every sink would then report the same event.
 * Expected to be non-zero on any deployment that has honoured an erasure
 * request, which is why it is a counter to correlate rather than an alarm.
 */
export function recordAuditSinkDigestMismatch(): void {
	get().auditSinkDigestMismatch.add(1);
}

/** Called by `startTelemetry` after the real meter provider is registered. */
export function resetInstruments(): void {
	instruments = undefined;
}

/**
 * Registered by `startTelemetry` only when telemetry is on, so a deployment
 * with no collector never runs the query. Every queue in this application is
 * drained by a background job rather than written through inline, so a queue
 * that stops draining looks entirely healthy from the outside while it grows.
 * These gauges are what tell a stuck queue apart from a quiet one; the caller
 * names the queue, because the reason each one matters differs.
 */
export function registerQueueDepthGauge(
	name: string,
	description: string,
	read: () => Promise<number>
): void {
	const gauge = metrics.getMeter(METER_NAME).createObservableGauge(name, { description });

	gauge.addCallback(async (result) => {
		result.observe(await read());
	});
}
