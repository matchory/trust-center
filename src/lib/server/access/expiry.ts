import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { countGrantDocuments } from './grants';
import { accessGrant, requester } from '../db/schema';
import { enqueueEmail } from '../mail/queue';
import type { Db } from '../db';

/**
 * Access ends by itself — `grantedDocuments` filters on `expiresAt`, so there
 * is no "expire the grant" job and no window in which a lapsed grant still
 * works. This job only sends the notice that precedes it.
 *
 * `reminderDays` and `locales` are arguments rather than `getConfig()` calls,
 * as in `drainOutbox` and `sweepUnverifiedRequests`: the job that calls this
 * owns the lookup, and a function that needs a fully configured environment to
 * answer a question about rows is untestable.
 */
export async function sendExpiryReminders(
	db: Db,
	options: { reminderDays: number; locales: readonly string[] }
): Promise<{ queued: number }> {
	const due = await db
		.select({
			grantId: accessGrant.id,
			expiresAt: accessGrant.expiresAt,
			email: requester.email,
			locale: requester.locale
		})
		.from(accessGrant)
		.innerJoin(requester, eq(accessGrant.requesterId, requester.id))
		.where(
			and(
				isNull(accessGrant.revokedAt),
				isNull(accessGrant.expiryReminderSentAt),
				// Still live — a reminder after the fact is noise...
				gt(accessGrant.expiresAt, sql`now()`),
				// ...but inside the window.
				lte(accessGrant.expiresAt, sql`now() + make_interval(days => ${options.reminderDays})`),
				// A purged requester's email column no longer names them, and
				// mailing whatever is left there is the one thing erasure must not do.
				isNull(requester.purgedAt)
			)
		);

	for (const row of due) {
		await enqueueEmail(db, {
			to: row.email,
			template: 'grant_expiring',
			locale: row.locale,
			payload: {
				// The `gt(expiresAt, now())` filter above guarantees this row has one.
				expiresAt: row.expiresAt!.toISOString().slice(0, 10),
				documentCount: await countGrantDocuments(db, row.grantId, { locales: options.locales })
			}
		});

		// Stamped per grant, immediately after queueing, so a crash mid-loop
		// resends at most one reminder rather than all of them.
		await db
			.update(accessGrant)
			.set({ expiryReminderSentAt: new Date() })
			.where(eq(accessGrant.id, row.grantId));
	}

	return { queued: due.length };
}
