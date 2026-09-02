import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { subscription, subscriptionTopic } from '../../src/lib/server/db/schema';
import { confirmSubscription, subscribe } from '../../src/lib/server/subscriptions';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

async function rejectionCause(query: PromiseLike<unknown>): Promise<string> {
	try {
		await query;
	} catch (error) {
		const wrapped = error as Error & { cause?: Error };
		return wrapped.cause?.message ?? wrapped.message;
	}
	throw new Error('expected the query to be rejected, but it succeeded');
}

describe('subscription check constraints', () => {
	it('accepts a well-formed unconfirmed row', async () => {
		const [row] = await db
			.insert(subscription)
			.values({
				email: `unconfirmed-${Date.now()}@example.test`,
				locale: 'de',
				confirmTokenHash: `hash-${Date.now()}`,
				confirmExpiresAt: new Date(Date.now() + 3_600_000)
			})
			.returning({ id: subscription.id });

		expect(row?.id).toBeTruthy();
		await db.delete(subscription).where(eq(subscription.id, row!.id));
	});

	it('accepts a well-formed confirmed row', async () => {
		const [row] = await db
			.insert(subscription)
			.values({
				email: `confirmed-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				manageToken: `manage-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
			.returning({ id: subscription.id });

		expect(row?.id).toBeTruthy();
		await db.delete(subscription).where(eq(subscription.id, row!.id));
	});

	it('rejects a confirmed row that kept its confirmation token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfa-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				confirmTokenHash: `hash-${Date.now()}`,
				manageToken: `manage-a-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_confirm_token_check');
	});

	// The constraint an earlier draft of the spec omitted (§8, §15 #7). Its
	// absence is invisible at runtime: the sweep filters `confirmed_at IS NULL`
	// first, so a confirmed row keeping a stale expiry is read by nothing.
	it('rejects a confirmed row that kept its confirmation expiry', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfb-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				confirmExpiresAt: new Date(),
				manageToken: `manage-b-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_confirm_expires_check');
	});

	it('rejects a confirmed row with no manage token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfc-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_manage_token_check');
	});

	it('rejects a confirmed row with no cursor', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfd-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				manageToken: `manage-d-${Date.now()}`
			})
		);
		expect(cause).toContain('subscription_cursor_check');
	});

	it('rejects an unconfirmed row that already has a manage token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfe-${Date.now()}@example.test`,
				locale: 'de',
				confirmTokenHash: `hash-e-${Date.now()}`,
				confirmExpiresAt: new Date(Date.now() + 3_600_000),
				manageToken: `manage-e-${Date.now()}`
			})
		);
		expect(cause).toContain('subscription_manage_token_check');
	});
});

async function topicsOf(id: string): Promise<string[]> {
	const rows = await db
		.select({ topic: subscriptionTopic.topic })
		.from(subscriptionTopic)
		.where(eq(subscriptionTopic.subscriptionId, id))
		.orderBy(asc(subscriptionTopic.topic));
	return rows.map((row) => row.topic);
}

describe('subscribe', () => {
	it('creates an unconfirmed row with its topics', async () => {
		const email = `create-${Date.now()}@example.test`;
		const result = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory', 'document'],
			ttlMinutes: 60
		});

		expect(result.kind).toBe('created');
		expect(await topicsOf(result.subscriptionId)).toEqual(['advisory', 'document']);
		await db.delete(subscription).where(eq(subscription.id, result.subscriptionId));
	});

	it('lowercases the address so the unique constraint is the real one', async () => {
		const stamp = Date.now();
		const first = await subscribe(db, {
			email: `Mixed-${stamp}@Example.Test`,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const second = await subscribe(db, {
			email: `mixed-${stamp}@example.test`,
			locale: 'de',
			topics: ['document'],
			ttlMinutes: 60
		});

		expect(second.subscriptionId).toBe(first.subscriptionId);
		expect(second.kind).toBe('resent');
		await db.delete(subscription).where(eq(subscription.id, first.subscriptionId));
	});

	it('replaces the topics and reissues the token on an unconfirmed row', async () => {
		const email = `resend-${Date.now()}@example.test`;
		const first = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const second = await subscribe(db, {
			email,
			locale: 'en',
			topics: ['certification', 'document'],
			ttlMinutes: 60
		});

		if (first.kind === 'already' || second.kind === 'already') {
			throw new Error('fixture produced the wrong outcome');
		}
		expect(second.kind).toBe('resent');
		expect(second.subscriptionId).toBe(first.subscriptionId);
		// The regenerated token kills the link the first mail carried. That is
		// the accepted trade of §4.3 — nobody has proven control of the mailbox,
		// so the row is indistinguishable from one created fresh.
		expect(second.confirmToken).not.toBe(first.confirmToken);
		expect(await topicsOf(first.subscriptionId)).toEqual(['certification', 'document']);

		const [row] = await db
			.select({ locale: subscription.locale })
			.from(subscription)
			.where(eq(subscription.id, first.subscriptionId));
		expect(row?.locale).toBe('en');

		await db.delete(subscription).where(eq(subscription.id, first.subscriptionId));
	});

	// P4.4: an unauthenticated endpoint must not let a stranger edit — or
	// detect — someone else's subscription. This is the case that matters.
	it('changes nothing when the address is already confirmed', async () => {
		const email = `already-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});

		await db
			.update(subscription)
			.set({
				confirmedAt: new Date(),
				confirmTokenHash: null,
				confirmExpiresAt: null,
				manageToken: `manage-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
			.where(eq(subscription.id, created.subscriptionId));

		const again = await subscribe(db, {
			email,
			locale: 'en',
			topics: ['document', 'subprocessor'],
			ttlMinutes: 60
		});

		expect(again.kind).toBe('already');
		expect(again.subscriptionId).toBe(created.subscriptionId);
		expect(await topicsOf(created.subscriptionId)).toEqual(['advisory']);

		const [row] = await db
			.select({ locale: subscription.locale, hash: subscription.confirmTokenHash })
			.from(subscription)
			.where(eq(subscription.id, created.subscriptionId));
		expect(row?.locale).toBe('de');
		expect(row?.hash).toBeNull();

		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});
});

describe('confirmSubscription', () => {
	it('confirms once, mints a manage token, and starts the cursor at now', async () => {
		const email = `confirm-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const token = created.kind === 'created' ? created.confirmToken : '';

		const before = Date.now();
		const confirmed = await confirmSubscription(db, token);

		expect(confirmed?.subscriptionId).toBe(created.subscriptionId);
		expect(confirmed?.email).toBe(email);
		expect(confirmed?.manageToken).toBeTruthy();

		const [row] = await db
			.select()
			.from(subscription)
			.where(eq(subscription.id, created.subscriptionId));
		expect(row?.confirmedAt).toBeTruthy();
		expect(row?.confirmTokenHash).toBeNull();
		expect(row?.confirmExpiresAt).toBeNull();
		expect(row?.manageToken).toBeTruthy();
		// P4.6: not null. A null cursor would hand a new subscriber the entire
		// back catalogue in their first mail.
		expect(row!.lastNotifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

		// Single-use by construction: the conditional update matches nothing the
		// second time, so a double-clicked button cannot confirm twice.
		expect(await confirmSubscription(db, token)).toBeNull();

		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});

	it('refuses an expired token', async () => {
		const email = `expired-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const token = created.kind === 'created' ? created.confirmToken : '';

		await db
			.update(subscription)
			.set({ confirmExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(subscription.id, created.subscriptionId));

		expect(await confirmSubscription(db, token)).toBeNull();
		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});

	it('refuses an unknown token', async () => {
		expect(await confirmSubscription(db, 'not-a-token')).toBeNull();
	});
});
