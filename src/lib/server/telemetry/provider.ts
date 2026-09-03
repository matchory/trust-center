import { diag, DiagLogLevel, metrics, trace } from '@opentelemetry/api';
import type { AppConfig } from '../config';
import { registerQueueDepthGauge, resetInstruments } from './metrics';

/**
 * Held so shutdown can flush. Empty is the normal state: a deployment with no
 * collector never builds one.
 */
let started: { shutdown: () => Promise<void> }[] = [];

/**
 * Without a diag logger the OTLP exporter reports every export failure — a 404
 * from an endpoint that is nearly right, a 401 from a stale bearer token, a
 * refused connection — through the API's no-op, so a collector that accepts
 * nothing is indistinguishable from one that accepts everything. Spec §6 reads
 * these variables ourselves precisely so a typo refuses to boot rather than
 * degrading to silence; boot validation only covers what is checkable before
 * the first export, and this covers the rest.
 *
 * Installed only when telemetry is on: a deployment with no collector must stay
 * silent. The line shape is the structured JSON the background jobs already
 * write, so an operator's log pipeline needs no second parser. Only `error` can
 * fire at DiagLogLevel.ERROR — the API filters the rest before calling — so the
 * quieter levels are honestly no-ops rather than unreachable formatting.
 */
function installDiagLogger(): void {
	const noop = () => {};

	diag.setLogger(
		{
			error: (message, ...args) =>
				console.error(
					JSON.stringify({
						level: 'error',
						scope: 'telemetry',
						message: [message, ...args.map(String)].join(' ')
					})
				),
			warn: noop,
			info: noop,
			debug: noop,
			verbose: noop
		},
		DiagLogLevel.ERROR
	);
}

/**
 * A module-level function rather than a closure written inside `startTelemetry`:
 * the gauge holds its callback for the life of the process, and a closure
 * defined there would pin that entire scope — the ten destructured SDK modules,
 * the resource, both providers — for just as long.
 *
 * `getDb` and the mail module are imported here rather than at module scope:
 * `getDb` is lazy, but keeping the database out of this module's import graph
 * preserves the rule that importing telemetry never reaches for a connection.
 * The registry caches both after the first collection.
 */
async function readQueueDepth(): Promise<number> {
	const [{ getDb }, { pendingCount }] = await Promise.all([
		import('../db/instance'),
		import('../mail/queue')
	]);

	return pendingCount(getDb());
}

export async function startTelemetry(config: AppConfig['telemetry']): Promise<boolean> {
	if (!config.endpoint || started.length > 0) return false;

	installDiagLogger();

	const [
		{ resourceFromAttributes },
		{ ATTR_SERVICE_NAME },
		{ BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler },
		{ NodeTracerProvider },
		{ MeterProvider, PeriodicExportingMetricReader },
		{ OTLPTraceExporter },
		{ OTLPMetricExporter }
	] = await Promise.all([
		import('@opentelemetry/resources'),
		import('@opentelemetry/semantic-conventions'),
		import('@opentelemetry/sdk-trace-base'),
		import('@opentelemetry/sdk-trace-node'),
		import('@opentelemetry/sdk-metrics'),
		import('@opentelemetry/exporter-trace-otlp-http'),
		import('@opentelemetry/exporter-metrics-otlp-http')
	]);

	const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName });
	const headers = config.headers;

	const tracerProvider = new NodeTracerProvider({
		resource,
		// Parent-based so a trace context arriving from subsystem A, once it
		// exists, is honoured rather than re-decided halfway through a trace.
		sampler: new ParentBasedSampler({
			root: new TraceIdRatioBasedSampler(config.sampleRatio)
		}),
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces`, headers })
			)
		]
	});
	tracerProvider.register();

	const meterProvider = new MeterProvider({
		resource,
		readers: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics`, headers })
			})
		]
	});
	metrics.setGlobalMeterProvider(meterProvider);

	// Any instrument built before this point was built against the no-op meter
	// and would never export. Dropping them forces a rebuild against the real
	// provider on next use.
	resetInstruments();

	registerQueueDepthGauge(readQueueDepth);

	started = [tracerProvider, meterProvider];
	return true;
}

/**
 * Flushes and stops. Called from `sveltekit:shutdown`, which adapter-node
 * already emits after handling SIGTERM — without a flush every deploy drops
 * the last batch of spans and metrics on the floor.
 */
export async function shutdownTelemetry(): Promise<void> {
	const providers = started;
	started = [];
	if (providers.length === 0) return;

	try {
		await Promise.all(providers.map((provider) => provider.shutdown()));
	} finally {
		// `provider.shutdown()` only stops the exporters it owns; the API's
		// global delegate still points at the now-inert provider until it is
		// disabled too. Skipped, every span created after a shutdown would keep
		// reporting `isRecording() === true` while its data is silently
		// dropped, instead of falling back to the safe no-op tracer the rest of
		// this application is built to tolerate.
		trace.disable();
		metrics.disable();
		diag.disable();
		// The mirror of the rule `startTelemetry` follows above: an instrument
		// built against a provider that is gone would keep recording into it
		// instead of falling back to the no-op meter the rest of this application
		// is built to tolerate.
		resetInstruments();
	}
}
