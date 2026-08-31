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

/**
 * §7.4's nudge: one reminder before an inert grant's acceptance deadline, to a
 * requester who was approved and has not signed yet.
 *
 * It runs alongside `sendExpiryReminders` rather than widening it, because that
 * one filters `expires_at > now()` and an inert grant has no expiry at all —
 * the two queries want disjoint rows.
 *
 * The stamp is `acceptance_reminder_sent_at`, a column of its own. Reusing
 * `expiry_reminder_sent_at` would spend it here, while the grant is still
 * inert; `sendExpiryReminders` filters on that column being null, so access
 * would later end with no warning — for every grant that went through an
 * agreement, with nothing failing and nothing logged.
 */
export async function sendAcceptanceReminders(
	db: Db,
	options: { reminderDays: number }
): Promise<{ queued: number }> {
	const due = await db
		.select({
			grantId: accessGrant.id,
			acceptanceDueAt: accessGrant.acceptanceDueAt,
			email: requester.email,
			locale: requester.locale
		})
		.from(accessGrant)
		.innerJoin(requester, eq(accessGrant.requesterId, requester.id))
		.where(
			and(
				// Inert: waiting on an acceptance, no clock started.
				isNull(accessGrant.expiresAt),
				isNull(accessGrant.revokedAt),
				isNull(accessGrant.closedAt),
				isNull(accessGrant.acceptanceReminderSentAt),
				// Still open — a nudge after the deadline is noise...
				gt(accessGrant.acceptanceDueAt, sql`now()`),
				// ...but inside the window.
				lte(
					accessGrant.acceptanceDueAt,
					sql`now() + make_interval(days => ${options.reminderDays})`
				),
				// A purged requester's email column no longer names them, and
				// mailing whatever is left there is the one thing erasure must not do.
				isNull(requester.purgedAt)
			)
		);

	for (const row of due) {
		await enqueueEmail(db, {
			to: row.email,
			template: 'acceptance_expiring',
			locale: row.locale,
			payload: {
				// The `gt(acceptanceDueAt, now())` filter guarantees this row has one.
				dueAt: row.acceptanceDueAt!.toISOString().slice(0, 10)
			}
		});

		// Stamped per grant, immediately after queueing, so a crash mid-loop
		// resends at most one nudge rather than all of them.
		await db
			.update(accessGrant)
			.set({ acceptanceReminderSentAt: new Date() })
			.where(eq(accessGrant.id, row.grantId));
	}

	return { queued: due.length };
}

/**
 * Gives the terminal transition a row of its own: an approval whose acceptance
 * deadline passed is closed.
 *
 * Correctness never depended on this sweep — `isActivatable` already refuses a
 * grant whose deadline has passed, and `grantConfersDocument` already refuses
 * one with no expiry. What the column buys is a fact Phase 5 can count:
 * "approved and never accepted" is a funnel signal, and reconstructing it later
 * from the absence of other rows is not the same thing.
 */
export async function closeUnacceptedGrants(db: Db): Promise<{ closed: number }> {
	const closed = await db
		.update(accessGrant)
		.set({ closedAt: new Date() })
		.where(
			and(
				isNull(accessGrant.expiresAt),
				isNull(accessGrant.revokedAt),
				// Not re-closed: the first sweep is when the approval actually ended.
				isNull(accessGrant.closedAt),
				lte(accessGrant.acceptanceDueAt, sql`now()`)
			)
		)
		.returning({ id: accessGrant.id });

	return { closed: closed.length };
}
