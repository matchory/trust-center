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

/** Called by `startTelemetry` after the real meter provider is registered. */
export function resetInstruments(): void {
	instruments = undefined;
}

/**
 * Registered by `startTelemetry` only when telemetry is on, so a deployment
 * with no collector never runs the query. Nothing in this application sends
 * mail inline: a deployment whose SMTP is misconfigured looks entirely healthy
 * from the outside while the queue grows, and one with no SMTP_URL at all is a
 * supported configuration whose queue grows by design. This gauge is what
 * tells those two apart.
 */
export function registerQueueDepthGauge(read: () => Promise<number>): void {
	const gauge = metrics.getMeter(METER_NAME).createObservableGauge('trustcenter.mail.queue.depth', {
		description: 'Outbound emails queued and not yet sent'
	});

	gauge.addCallback(async (result) => {
		result.observe(await read());
	});
}
