import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { outboundEmail, rateLimit } from '../../src/lib/server/db/schema';
import { redactDeliveredMail, sweepRateLimits } from '../../src/lib/server/retention';

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

beforeEach(async () => {
	await db.delete(rateLimit);
	await db.delete(outboundEmail);
});

const hoursAgo = (n: number) => sql`now() - make_interval(hours => ${n})`;
const daysAgo = (n: number) => sql`now() - make_interval(days => ${n})`;

describe('sweepRateLimits', () => {
	it('deletes a counter whose window is long past', async () => {
		await db
			.insert(rateLimit)
			.values({ key: `stale-${randomUUID()}`, windowStart: hoursAgo(48), count: 5 });

		await sweepRateLimits(db, { olderThanHours: 24 });

		expect(await db.select().from(rateLimit)).toHaveLength(0);
	});

	it('keeps a counter still inside the retention window', async () => {
		// Deleting a live counter would forgive a flood mid-window, which is the
		// one direction this sweep must never move in.
		const key = `fresh-${randomUUID()}`;
		await db.insert(rateLimit).values({ key, windowStart: hoursAgo(1), count: 5 });

		await sweepRateLimits(db, { olderThanHours: 24 });

		const [row] = await db.select().from(rateLimit).where(eq(rateLimit.key, key));
		expect(row?.count).toBe(5);
	});
});

describe('redactDeliveredMail', () => {
	async function seed(options: { status: string; ageDays: number }): Promise<string> {
		const to = `retention-${randomUUID()}@example.test`;
		await db.insert(outboundEmail).values({
			to,
			template: 'verify_request',
			locale: 'de',
			payload: { url: 'https://trust.example.test/de/access/verify?token=secret' },
			status: options.status,
			createdAt: daysAgo(options.ageDays)
		});
		return to;
	}

	it('blanks the address and payload of a delivered notification', async () => {
		const to = await seed({ status: 'sent', ageDays: 120 });

		await redactDeliveredMail(db, { retentionDays: 90 });

		const [row] = await db
			.select()
			.from(outboundEmail)
			.where(eq(outboundEmail.template, 'verify_request'));
		expect(row?.to).toBe('');
		expect(row?.payload).toEqual({});
		// The row survives: that a notification went out is a fact about the
		// system rather than about the person, and the payload held a token.
		expect(row?.status).toBe('sent');
		expect(row?.template).toBe('verify_request');
		expect(to).not.toBe('');
	});

	it('leaves a notification inside the retention window alone', async () => {
		const to = await seed({ status: 'sent', ageDays: 10 });

		await redactDeliveredMail(db, { retentionDays: 90 });

		const [row] = await db.select().from(outboundEmail);
		expect(row?.to).toBe(to);
	});

	it('never touches a pending notification, however old', async () => {
		// A pending row has not been delivered. Blanking its address would strand
		// the mail rather than retire it — and the drain would then fail forever.
		const to = await seed({ status: 'pending', ageDays: 365 });

		await redactDeliveredMail(db, { retentionDays: 90 });

		const [row] = await db.select().from(outboundEmail);
		expect(row?.to).toBe(to);
	});

	it('redacts a permanently failed notification too', async () => {
		await seed({ status: 'failed', ageDays: 120 });

		await redactDeliveredMail(db, { retentionDays: 90 });

		const [row] = await db.select().from(outboundEmail);
		expect(row?.to).toBe('');
	});
});
