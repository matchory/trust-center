import { metrics, type Attributes } from '@opentelemetry/api';

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
	// Same rule as the span: no route id means no attribute, so an unmatched
	// path cannot mint one time series per probe.
	const attributes: Attributes = {
		'http.request.method': input.method,
		'http.response.status_code': input.status,
		...(input.routeId === null ? {} : { 'http.route': input.routeId })
	};

	get().requestDuration.record(input.seconds, attributes);
}

/** Called by `startTelemetry` after the real meter provider is registered. */
export function resetInstruments(): void {
	instruments = undefined;
}
