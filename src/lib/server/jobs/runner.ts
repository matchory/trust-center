import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db';

/**
 * Postgres advisory locks are keyed by bigint, so the job name is hashed into
 * one. `pg_try_advisory_xact_lock` returns immediately rather than queueing: a
 * second replica whose tick overlaps should skip this round, not pile up behind
 * it.
 */
function lockKey(name: string): bigint {
	const digest = createHash('sha256').update(name).digest();
	// Signed 64-bit, which is what the advisory lock functions take.
	return digest.readBigInt64BE(0);
}

export interface JobResult {
	ran: boolean;
}

/**
 * Runs `fn` under a cluster-wide advisory lock named by `name`, so more than
 * one replica is safe: without it, two tickers would both send the same expiry
 * reminder. Returns `{ran: false}` when another holder has it.
 *
 * The transaction-scoped variant is deliberate — it releases on commit OR
 * rollback, so a throwing job cannot leak the lock and wedge that job forever.
 */
export async function runJob(db: Db, name: string, fn: () => Promise<void>): Promise<JobResult> {
	const key = lockKey(name);

	return db.transaction(async (tx) => {
		const rows = (await tx.execute(
			sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`
		)) as unknown as { locked: boolean }[];

		if (!rows[0]?.locked) return { ran: false };

		await fn();
		return { ran: true };
	});
}
