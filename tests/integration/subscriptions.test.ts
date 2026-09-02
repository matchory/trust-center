import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { subscription } from '../../src/lib/server/db/schema';

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
