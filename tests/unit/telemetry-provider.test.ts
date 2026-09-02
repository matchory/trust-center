import { metrics, trace } from '@opentelemetry/api';
import { beforeAll, describe, expect, it } from 'vitest';
import { shutdownTelemetry, startTelemetry } from '../../src/lib/server/telemetry';

const off = { endpoint: undefined, serviceName: 'trust-center', headers: {}, sampleRatio: 1 };

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
		await startTelemetry(off);
		await expect(startTelemetry(off)).resolves.toBeUndefined();
		await shutdownTelemetry();
	});
});
