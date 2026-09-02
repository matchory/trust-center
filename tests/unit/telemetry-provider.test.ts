import { metrics, trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shutdownTelemetry, startTelemetry } from '../../src/lib/server/telemetry';

const off = { endpoint: undefined, serviceName: 'trust-center', headers: {}, sampleRatio: 1 };

// Port 9 is the discard port: well-formed, so `startTelemetry` builds a real
// exporter against it, but nothing listens there. The test below is careful
// to never queue anything for that exporter to send — see the comment on
// `first` — so this address is never actually dialled; it only has to be
// syntactically valid.
const on = {
	endpoint: 'http://127.0.0.1:9',
	serviceName: 'trust-center',
	headers: {},
	sampleRatio: 1
};

// `@opentelemetry/api` registers providers on `globalThis`, not per module
// graph, and tests/unit/telemetry-span.test.ts registers a recording tracer
// provider globally. If both files share a vitest worker process, the
// "registers nothing" assertion below would see that provider and fail for a
// reason unrelated to this file's code, so each disabled-path assertion here
// establishes its own precondition first.
beforeAll(() => {
	trace.disable();
	metrics.disable();
});

// Mirrors the beforeAll: the "is idempotent" test below registers a real,
// recording provider on the same shared globalThis. Left in place, it would
// make every other unit test file's spans recording ones, depending on run
// order — so this file leaves the API exactly as disabled as it found it.
afterAll(() => {
	trace.disable();
	metrics.disable();
});

describe('startTelemetry', () => {
	// The point of the whole design: a deployment with no collector loads no
	// SDK and registers no provider, so every call site stays a no-op.
	it('registers nothing when no endpoint is configured', async () => {
		await startTelemetry(off);

		// The API's own no-op provider has no `getActiveSpanProcessor`; asserting
		// on the delegate would couple to internals, so assert the observable
		// property instead: a span created now is not recording.
		const span = trace.getTracer('probe').startSpan('probe');
		expect(span.isRecording()).toBe(false);
		span.end();

		await shutdownTelemetry();
	});

	it('is idempotent, so a second call does not stack providers', async () => {
		await startTelemetry(on);

		// The inverse of the disabled-path assertion: a provider is genuinely
		// registered now, so a freshly created span records. Deliberately never
		// `.end()`ed: BatchSpanProcessor only enqueues a span on end, and an
		// empty queue means shutdown's flush has nothing to export — no HTTP
		// attempt, no retry backoff against the dead port below.
		const first = trace.getTracer('probe').startSpan('probe');
		expect(first.isRecording()).toBe(true);

		// A guard that only checked `!config.endpoint` would pass this call
		// through and register a second provider on top of the first; asserting
		// resolution alone (as the previous version of this test did) can't
		// distinguish that from the real no-stacking behaviour, since with no
		// endpoint the first disjunct always short-circuits before the second is
		// ever evaluated. Starting from a real, already-registered provider is
		// what makes the `started.length > 0` guard the thing actually under
		// test.
		await expect(startTelemetry(on)).resolves.toBeUndefined();

		// `first` was never ended, so nothing was ever queued in the batch
		// processor and there is nothing for shutdown's flush to export — no
		// HTTP attempt against the dead port above, so this resolves instead of
		// exercising the OTLP exporter's own retry/backoff.
		await expect(shutdownTelemetry()).resolves.toBeUndefined();

		// Shutdown must leave the module able to start again — i.e. tracing is
		// genuinely off, not just unflushed.
		const after = trace.getTracer('probe').startSpan('probe');
		expect(after.isRecording()).toBe(false);
		after.end();
	});
});
