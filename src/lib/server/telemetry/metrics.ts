import { metrics } from '@opentelemetry/api';
import { requestAttributes } from './attributes';

const METER_NAME = 'trust-center';

/**
 * Instruments are created on first use rather than at module load. An
 * instrument built against the API's no-op meter stays a no-op for the life of
 * the process, so building them at import time — which happens before `init`
 * registers the real provider — would silently export nothing forever.
 */
let instruments: ReturnType<typeof build> | undefined;

function build() {
	const meter = metrics.getMeter(METER_NAME);

	return {
		requestDuration: meter.createHistogram('http.server.request.duration', {
			description: 'Duration of inbound HTTP requests',
			unit: 's'
		}),
		jobTickDuration: meter.createHistogram('trustcenter.job.tick.duration', {
			description: 'Duration of one background job tick',
			unit: 's'
		}),
		jobTick: meter.createCounter('trustcenter.job.tick', {
			description: 'Background job ticks by outcome'
		})
	};
}

function get() {
	return (instruments ??= build());
}

export function recordRequestDuration(input: {
	method: string;
	routeId: string | null;
	status: number;
	seconds: number;
}): void {
	// Shares `requestAttributes` with the span so the two never drift: same
	// request, same rule — including the unmatched-route omission, which keeps
	// an unmatched path from minting one time series per probe.
	get().requestDuration.record(
		input.seconds,
		requestAttributes({ method: input.method, routeId: input.routeId, status: input.status })
	);
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
	const attributes = { 'job.name': input.name, outcome: input.outcome };

	get().jobTickDuration.record(input.seconds, { 'job.name': input.name });
	get().jobTick.add(1, attributes);
}

/** Called by `startTelemetry` after the real meter provider is registered. */
export function resetInstruments(): void {
	instruments = undefined;
}
