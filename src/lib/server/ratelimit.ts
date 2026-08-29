import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { rateLimit } from './db/schema';
import type { Db } from './db';

/**
 * The scope prefix stays readable so an operator reading the table can tell
 * which limiter a row belongs to; the identifier is hashed so the table never
 * becomes an index of who asked for what.
 */
export function rateLimitKey(scope: string, identifier: string): string {
	const digest = createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex');
	return `${scope}:${digest.slice(0, 32)}`;
}

export interface RateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
}

/**
 * One statement, no read-then-write. The upsert either starts a new window
 * (because none exists, or the stored one has aged out) or increments the
 * current one, and returns the resulting count. Two concurrent callers
 * therefore cannot both observe "count 2, limit 3" and both proceed to 4 —
 * which is the failure mode that makes a limiter decorative.
 *
 * Counters live in Postgres rather than in memory because multi-replica is a
 * supported deployment (RUN_MIGRATIONS=false exists for it), and a per-replica
 * counter is not a limit.
 */
export async function consumeRateLimit(
	db: Db,
	input: { key: string; limit: number; windowSeconds: number }
): Promise<RateLimitResult> {
	const window = sql`make_interval(secs => ${input.windowSeconds})`;

	const rows = await db
		.insert(rateLimit)
		.values({ key: input.key, windowStart: sql`now()`, count: 1 })
		.onConflictDoUpdate({
			target: rateLimit.key,
			set: {
				windowStart: sql`CASE WHEN ${rateLimit.windowStart} + ${window} <= now()
				                      THEN now() ELSE ${rateLimit.windowStart} END`,
				count: sql`CASE WHEN ${rateLimit.windowStart} + ${window} <= now()
				                THEN 1 ELSE ${rateLimit.count} + 1 END`
			}
		})
		.returning({
			count: rateLimit.count,
			retryAfter: sql<number>`
				GREATEST(0, CEIL(EXTRACT(EPOCH FROM
					(${rateLimit.windowStart} + ${window}) - now()
				)))::int
			`
		});

	const row = rows[0];
	if (!row) throw new Error('rate limit upsert returned no row');

	return { allowed: row.count <= input.limit, retryAfterSeconds: row.retryAfter };
}
