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
 */
export async function startTelemetry(config: AppConfig['telemetry']): Promise<void> {
	if (!config.endpoint || started.length > 0) return;

	const [
		{ resourceFromAttributes },
		{ ATTR_SERVICE_NAME },
		{ BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler },
		{ NodeTracerProvider },
		{ MeterProvider, PeriodicExportingMetricReader },
		{ OTLPTraceExporter },
		{ OTLPMetricExporter },
		{ metrics }
	] = await Promise.all([
		import('@opentelemetry/resources'),
		import('@opentelemetry/semantic-conventions'),
		import('@opentelemetry/sdk-trace-base'),
		import('@opentelemetry/sdk-trace-node'),
		import('@opentelemetry/sdk-metrics'),
		import('@opentelemetry/exporter-trace-otlp-http'),
		import('@opentelemetry/exporter-metrics-otlp-http'),
		import('@opentelemetry/api')
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
}

/**
 * Flushes and stops. Called from `sveltekit:shutdown`, which adapter-node
 * already emits after handling SIGTERM — without a flush every deploy drops
 * the last batch of spans and metrics on the floor.
 */
export async function shutdownTelemetry(): Promise<void> {
	const providers = started;
	started = [];
	await Promise.all(providers.map((provider) => provider.shutdown()));
}
