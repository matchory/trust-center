import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/lib/server/db';
import type { JobResult } from '../../src/lib/server/jobs/runner';

/**
 * `runJob` and the pool are mocked so `startJobRunner`'s wiring can be
 * exercised with no database: the property under test is which phase runs when,
 * not what either phase does.
 */
const runJob = vi.fn<(db: Db, name: string, fn: () => Promise<void>) => Promise<JobResult>>();

vi.mock('../../src/lib/server/jobs/runner', () => ({
	runJob: (db: Db, name: string, fn: () => Promise<void>) => runJob(db, name, fn)
}));

vi.mock('../../src/lib/server/db/instance', () => ({
	getDb: () => ({}) as Db
}));

// Only the egress entry's two phases are wanted here; every other job body
// would reach for `getConfig()`, which needs an environment the unit suite
// deliberately does not have.
const runEgressClaim = vi.fn(async () => {});
const runEgressDeliveries = vi.fn(async () => {});

vi.mock('../../src/lib/server/egress', () => ({
	runEgressClaim: () => runEgressClaim(),
	runEgressDeliveries: () => runEgressDeliveries()
}));

const { JOBS, startJobRunner, stopJobRunner } = await import('../../src/lib/server/jobs');

/**
 * Runs `egress:deliver` only. Every other timer still fires, and letting their
 * bodies run would call `getConfig()`; reporting the lock as held elsewhere is
 * how they are kept inert without asserting anything about them.
 */
let deliveriesBeforeLockReleased = -1;

function onlyEgress(ran: boolean) {
	deliveriesBeforeLockReleased = -1;
	runJob.mockImplementation(async (_db, name, fn) => {
		if (name !== 'egress:deliver') return { ran: false };
		if (!ran) return { ran: false };
		await fn();
		// Read at the moment `runJob`'s body finishes — that is, while the real
		// `runJob` would still be inside `db.transaction` holding the lock.
		deliveriesBeforeLockReleased = runEgressDeliveries.mock.calls.length;
		return { ran: true };
	});
}

afterEach(() => {
	stopJobRunner();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('JOBS', () => {
	it('registers egress:deliver with a phase that runs outside the lock', () => {
		const job = JOBS.find((entry) => entry.name === 'egress:deliver');

		expect(job).toBeDefined();
		// Fifteen seconds, matching mail:drain: a Teams notice fifteen minutes
		// late is a defect (spec §5.1).
		expect(job?.everyMs).toBe(15_000);
		// The property that matters: the HTTP phase is a separate hook, so it is
		// not inside runJob's transaction (spec §5.1).
		expect(job?.afterLock).toBeTypeOf('function');
	});

	it('registers auditsink:batch on a minute, shipping outside the lock', () => {
		const job = JOBS.find((entry) => entry.name === 'auditsink:batch');

		expect(job).toBeDefined();
		// A minute rather than fifteen seconds: the sink's latency budget is
		// minutes to hours (audit sink spec §3.1).
		expect(job?.everyMs).toBe(60_000);
		// Same property as egress: shipping talks to operator-supplied storage,
		// so it must not run inside runJob's transaction.
		expect(job?.afterLock).toBeTypeOf('function');
	});
});

describe('startJobRunner', () => {
	it('runs the egress HTTP phase after the locked phase, not inside it', async () => {
		vi.useFakeTimers();
		onlyEgress(true);

		startJobRunner();
		await vi.advanceTimersByTimeAsync(15_000);

		expect(runEgressClaim).toHaveBeenCalledTimes(1);
		expect(runEgressDeliveries).toHaveBeenCalledTimes(1);
		// The whole point of the two-phase shape, and the only assertion here
		// that pins it: nothing had been delivered by the time `runJob`'s body
		// returned, so the network phase runs after the transaction holding the
		// advisory lock commits (spec §5.1). Asserting merely that claim ran
		// before deliveries would pass just as well for a single-phase job that
		// awaited both inside `run` — which is the shape this exists to forbid.
		expect(deliveriesBeforeLockReleased).toBe(0);
	});

	it('skips the HTTP phase when another replica held the lock', async () => {
		vi.useFakeTimers();
		onlyEgress(false);

		startJobRunner();
		await vi.advanceTimersByTimeAsync(15_000);

		// This replica claimed nothing, so it has nothing to deliver — and
		// delivering the *previous* tick's batch a second time would be a
		// duplicate POST rather than a no-op.
		expect(runEgressClaim).not.toHaveBeenCalled();
		expect(runEgressDeliveries).not.toHaveBeenCalled();
	});

	it('does not run the HTTP phase when the locked phase throws', async () => {
		vi.useFakeTimers();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		runEgressClaim.mockRejectedValueOnce(new Error('fan-out failed'));
		onlyEgress(true);

		startJobRunner();
		await vi.advanceTimersByTimeAsync(15_000);

		// A rolled-back claim left no rows claimed, so phase two would deliver a
		// batch nothing pushed `next_attempt_at` forward for.
		expect(runEgressDeliveries).not.toHaveBeenCalled();
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});
});
