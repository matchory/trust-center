import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm';
import type { UpdateKind } from '../../content-types';
import { subscription, subscriptionTopic } from '../db/schema';
import type { Db } from '../db';

/** Drizzle's transaction handle is not exported anywhere, and `Db` is not
 * assignable to it. Derived from `Db` rather than re-declared so it cannot
 * drift from whatever `db.transaction` actually hands a callback. */
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** As `magic_link` does: a database disclosure hands the reader no working link. */
function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
	return randomBytes(32).toString('base64url');
}

/** The form submits the complete set, so an empty selection would clear it —
 * which §5 refuses at the form rather than here, because a subscription that
 * matches nothing is a row that exists to send no mail. */
async function replaceTopics(
	tx: DbTransaction,
	subscriptionId: string,
	topics: readonly UpdateKind[]
): Promise<void> {
	await tx.delete(subscriptionTopic).where(eq(subscriptionTopic.subscriptionId, subscriptionId));
	if (topics.length > 0) {
		await tx.insert(subscriptionTopic).values(topics.map((topic) => ({ subscriptionId, topic })));
	}
}

export type SubscribeResult =
	| { kind: 'created' | 'resent'; subscriptionId: string; confirmToken: string }
	| { kind: 'already'; subscriptionId: string };

/**
 * The three outcomes of spec §4.3. The caller mails exactly one thing in every
 * case and returns the same response, which is what makes the endpoint
 * enumeration-resistant: a stranger who guesses an address learns nothing.
 *
 * A confirmed row is never touched (P4.4). Replacing the topics on an
 * *unconfirmed* row is not the same act — nobody has proven control of that
 * mailbox, no mail is being delivered on its strength, and the row is
 * indistinguishable from one this submission created.
 */
export async function subscribe(
	db: Db,
	input: {
		email: string;
		locale: string;
		topics: readonly UpdateKind[];
		ttlMinutes: number;
	}
): Promise<SubscribeResult> {
	// Lowercased here rather than at the call site, as `upsertRequester` does,
	// so the unique constraint is the real one rather than a near-miss.
	const email = input.email.trim().toLowerCase();
	const token = newToken();
	const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);

	return db.transaction(async (tx) => {
		// Insert-or-nothing rather than select-then-insert: this endpoint is
		// unauthenticated, and two concurrent submissions for one address would
		// otherwise race into a unique violation that surfaces as a 500.
		const [inserted] = await tx
			.insert(subscription)
			.values({
				email,
				locale: input.locale,
				confirmTokenHash: hashToken(token),
				confirmExpiresAt: expiresAt
			})
			.onConflictDoNothing({ target: subscription.email })
			.returning({ id: subscription.id });

		if (inserted) {
			await replaceTopics(tx, inserted.id, input.topics);
			return { kind: 'created', subscriptionId: inserted.id, confirmToken: token };
		}

		const [existing] = await tx
			.select({ id: subscription.id, confirmedAt: subscription.confirmedAt })
			.from(subscription)
			.where(eq(subscription.email, email))
			.for('update');

		// The insert conflicted, so the row exists; a missing one here means the
		// row was deleted between the two statements, which only unsubscribing
		// does. Throwing is right: retrying would be a second surprise.
		if (!existing) throw new Error('subscription disappeared between insert and select');

		if (existing.confirmedAt) return { kind: 'already', subscriptionId: existing.id };

		await tx
			.update(subscription)
			.set({
				locale: input.locale,
				confirmTokenHash: hashToken(token),
				confirmExpiresAt: expiresAt
			})
			.where(eq(subscription.id, existing.id));
		await replaceTopics(tx, existing.id, input.topics);

		return { kind: 'resent', subscriptionId: existing.id, confirmToken: token };
	});
}

/**
 * The manage link for a confirmed subscription, for the one caller that needs
 * it without holding the token: the `already` branch of §4.3, which mails it to
 * the address rather than returning it. Never surface this to a response body.
 *
 * Returns the subscription's own locale alongside the token: spec §6.4 makes
 * the stored locale the rule for every subscriber-facing mail, not the
 * submitter's — a re-submission from a browser in a different language must
 * not mail the wrong language or link to it.
 */
export async function manageTokenFor(
	db: Db,
	id: string
): Promise<{ token: string; locale: string } | null> {
	const [row] = await db
		.select({ token: subscription.manageToken, locale: subscription.locale })
		.from(subscription)
		.where(eq(subscription.id, id));
	if (!row?.token) return null;
	return { token: row.token, locale: row.locale };
}

export interface ConfirmedSubscription {
	subscriptionId: string;
	email: string;
	locale: string;
	/** Stored as-is, not hashed — see §4.2. Every notice mail carries a link
	 * built from it, so it has to be recoverable. */
	manageToken: string;
}

/**
 * One conditional update, as `consumeMagicLink` does: two concurrent presses of
 * the same button cannot both return a row, because the second matches nothing.
 * That is what makes the confirmation token single-use without a second read.
 *
 * Returns null for an unknown, spent, or expired token — the page cannot tell
 * them apart and should not try.
 */
export async function confirmSubscription(
	db: Db,
	token: string
): Promise<ConfirmedSubscription | null> {
	const manageToken = newToken();
	const now = new Date();

	const [row] = await db
		.update(subscription)
		.set({
			confirmedAt: now,
			confirmTokenHash: null,
			confirmExpiresAt: null,
			manageToken,
			// `now()`, never null: this is what stops a new subscriber receiving
			// the entire back catalogue in their first mail (P4.6).
			lastNotifiedAt: now
		})
		.where(
			and(
				eq(subscription.confirmTokenHash, hashToken(token)),
				isNull(subscription.confirmedAt),
				gt(subscription.confirmExpiresAt, now)
			)
		)
		.returning({
			id: subscription.id,
			email: subscription.email,
			locale: subscription.locale
		});

	if (!row) return null;
	return { subscriptionId: row.id, email: row.email, locale: row.locale, manageToken };
}

export interface ManagedSubscription {
	id: string;
	email: string;
	locale: string;
	/** Carried so the manage page can rebuild its own URL after a locale
	 * change — the caller already holds it, so this exposes nothing new. */
	manageToken: string;
	topics: UpdateKind[];
}

/**
 * The management token is permanent and never rotated (P4.16): an unsubscribe
 * link in a mail from eighteen months ago must still work, and every mail
 * already sent carries this one. Compared directly rather than through a hash
 * — §4.2 explains why this one is not hashed and why the confirmation token is.
 */
export async function subscriptionByManageToken(
	db: Db,
	token: string
): Promise<ManagedSubscription | null> {
	const [row] = await db
		.select({
			id: subscription.id,
			email: subscription.email,
			locale: subscription.locale,
			manageToken: subscription.manageToken
		})
		.from(subscription)
		.where(eq(subscription.manageToken, token));

	if (!row) return null;

	const topics = await db
		.select({ topic: subscriptionTopic.topic })
		.from(subscriptionTopic)
		.where(eq(subscriptionTopic.subscriptionId, row.id))
		.orderBy(asc(subscriptionTopic.topic));

	// manageToken is nullable in the column type but never null on a confirmed
	// row, and only a confirmed row has one to match against.
	return {
		...row,
		manageToken: row.manageToken!,
		topics: topics.map((item) => item.topic as UpdateKind)
	};
}

/**
 * Advancing the cursor is not incidental to this write (P4.18). The cursor only
 * moves when a tick finds posts, so a subscriber whose topics matched nothing
 * for months still carries their confirmation-time cursor; adding a topic would
 * then deliver everything of that kind published since. Unconditional rather
 * than conditional on the set widening, because narrowing and widening again in
 * one sitting would slip past a comparison.
 */
export async function saveSubscription(
	db: Db,
	id: string,
	input: { locale: string; topics: readonly UpdateKind[] }
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.update(subscription)
			.set({ locale: input.locale, lastNotifiedAt: new Date() })
			.where(eq(subscription.id, id));
		await replaceTopics(tx, id, input.topics);
	});
}

/**
 * Deletion rather than a suppression record (P4.13). The subscription has no
 * dependents needing referential integrity, so deleting reaches the same place
 * pseudonymisation reaches for a requester: the audit events survive, and the
 * UUID in `actor_id` now points at nothing.
 */
export async function unsubscribe(db: Db, id: string): Promise<void> {
	await db.delete(subscription).where(eq(subscription.id, id));
}

/**
 * A row whose confirmation token has expired can never become confirmed, so it
 * is garbage holding an address nobody proved they control. Folded into
 * `retention:sweep` rather than becoming a sixth timer (spec §8).
 */
export async function sweepUnconfirmedSubscriptions(db: Db): Promise<{ deleted: number }> {
	const deleted = await db
		.delete(subscription)
		.where(and(isNull(subscription.confirmedAt), lt(subscription.confirmExpiresAt, new Date())))
		.returning({ id: subscription.id });

	return { deleted: deleted.length };
}
