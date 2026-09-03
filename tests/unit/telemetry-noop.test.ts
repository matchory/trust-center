import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeTraceId, withSpan } from '../../src/lib/server/telemetry';

/**
 * The one telemetry test file that deliberately registers **no** tracer
 * provider — the opposite precondition to every other one, and the shipped
 * default for any deployment that has not set OTEL_EXPORTER_OTLP_ENDPOINT.
 *
 * A context manager is still installed, and that is the whole point.
 * `activeTraceId()` has two guards: no active span at all, and an active span
 * whose context is the API's invalid, all-zero one. Without a context manager
 * the first guard catches everything and the second is never reached, which is
 * exactly the gap this file closes: the second guard is what stops
 * `audit_event.request_id` filling with a 32-zero constant that looks like a
 * correlation id on every deployment with telemetry off.
 */
beforeAll(() => {
	trace.disable();
	context.disable();
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterAll(() => {
	context.disable();
});

describe('activeTraceId with no provider registered', () => {
	it('returns undefined for an active span carrying the all-zero trace id', async () => {
		const { reported, raw } = await withSpan('probe', {}, async () => ({
			reported: activeTraceId(),
			raw: trace.getActiveSpan()?.spanContext().traceId
		}));

		// Non-vacuous, and the reason this file installs a context manager: a span
		// *is* active here, so this is not the `!span` guard being retested. The
		// no-op tracer hands out INVALID_SPAN_CONTEXT, and this is its trace id.
		expect(raw).toBe('00000000000000000000000000000000');

		// The guard under test: that constant must never reach a caller.
		expect(reported).toBeUndefined();
	});

	it('is undefined outside a span too, which is the other guard', async () => {
		expect(activeTraceId()).toBeUndefined();
	});
});
