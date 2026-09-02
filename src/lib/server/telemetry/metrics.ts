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

/** Called by `startTelemetry` after the real meter provider is registered. */
export function resetInstruments(): void {
	instruments = undefined;
}
