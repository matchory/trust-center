import { metrics, trace } from '@opentelemetry/api';
import type { AppConfig } from '../config';

/**
 * Held so shutdown can flush. Empty is the normal state: a deployment with no
 * collector never builds one.
 */
let started: { shutdown: () => Promise<void> }[] = [];

/**
 * Imports the SDK dynamically and only when an endpoint is configured, for the
 * same reason `init` imports the migrator and the job runner that way: `vite
 * build` must need neither configuration nor a database, and an operator
 * running without telemetry should not pay to load an exporter they will never
 * use.
 *
 * Returns whether this call actually started providers, so a caller (or a
 * test) can observe the guard's effect directly instead of through
 * `globalThis` side effects that a second, redundant registration would
 * leave equally intact. `init` ignores it; a second call must still return
 * `false` rather than build a second `NodeTracerProvider`/`MeterProvider`
 * pair, since later tasks add a `PeriodicExportingMetricReader` with its own
 * live export timer, and orphaning one of those on every restart is a leak,
 * not a curiosity.
 */
export async function startTelemetry(config: AppConfig['telemetry']): Promise<boolean> {
	if (!config.endpoint || started.length > 0) return false;

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
	}
}
