import {
	SpanStatusCode,
	isSpanContextValid,
	trace,
	type Attributes,
	type Span
} from '@opentelemetry/api';

/**
 * The instrumentation scope every span in this application is created under.
 * Permanent: a collector's pipeline may route on it.
 */
const TRACER_NAME = 'trust-center';

/**
 * Every call site in the server goes through here unconditionally. When no
 * provider is registered — which is every deployment that has not set
 * OTEL_EXPORTER_OTLP_ENDPOINT — the API returns a no-op tracer, so this costs
 * one function call and no allocation of anything exportable. That is what
 * lets the server carry instrumentation with no `if (enabled)` guards.
 */
export async function withSpan<T>(
	name: string,
	attributes: Attributes,
	fn: (span: Span) => Promise<T>
): Promise<T> {
	return trace.getTracer(TRACER_NAME).startActiveSpan(name, { attributes }, async (span) => {
		try {
			return await fn(span);
		} catch (cause) {
			// The message only — never the cause chain. `handleError` exists
			// because openid-client attaches the callback request, authorization
			// code and all, as an error's cause.
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: cause instanceof Error ? cause.message : String(cause)
			});
			throw cause;
		} finally {
			span.end();
		}
	});
}

/**
 * The active trace id, or undefined when tracing is off. The no-op tracer
 * still produces a span context, but an invalid one whose trace id is all
 * zeroes — writing that into `audit_event.request_id` would fill the column
 * with a constant that looks like data.
 */
export function activeTraceId(): string | undefined {
	const span = trace.getActiveSpan();
	if (!span) return undefined;

	const context = span.spanContext();
	return isSpanContextValid(context) ? context.traceId : undefined;
}
