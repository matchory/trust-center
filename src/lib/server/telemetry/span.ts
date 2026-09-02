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
			// No message, and never the cause chain. An error's message is
			// arbitrary application text — an SMTP bounce routinely embeds the
			// recipient ("550 no such user <addr>") — and a span status is
			// exported like any other span data, on every failure path,
			// unreachable by `purgeRequester`. The same discipline `handleError`
			// already applies by refusing to log `error.cause`, because
			// openid-client attaches the callback request, authorization code and
			// all, as an error's cause. The trace id ties this span to the
			// matching log line, where an arbitrary error string belongs.
			span.setStatus({ code: SpanStatusCode.ERROR });
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
