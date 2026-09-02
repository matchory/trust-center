import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
