import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	outboundEmail,
	subscription,
	updatePost,
	updatePostTranslation
} from '../../src/lib/server/db/schema';
import {
	confirmSubscription,
	saveSubscription,
	subscribe
} from '../../src/lib/server/subscriptions';
import { notifySubscribers } from '../../src/lib/server/subscriptions/notify';
import type { UpdateKind } from '../../src/lib/content-types';

let db: Db;
let close: () => Promise<void>;

const OPTIONS = {
	baseUrl: 'https://trust.example',
	enabledLocales: ['de', 'en'],
	defaultLocale: 'de'
};

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

// The tick's select is deliberately unscoped — it has to see every due
// subscriber and every matching post (that is the feature). Which means a
// post left over from an earlier test in this file is just as "due" for a
// later test's freshly-backdated cursor as the post that test meant to
// exercise. Unlike subscriptions.test.ts, which deletes only the rows it
// created, isolation here has to be a clean slate: nothing short of it stops
// cross-test contamination in a query with no per-test scoping to filter by.
beforeEach(async () => {
	await db.delete(subscription);
	await db.delete(updatePost);
});

async function makePost(kind: UpdateKind, publishedAt: Date | null): Promise<string> {
	const slug = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [row] = await db
		.insert(updatePost)
		.values({ slug, kind, publishedAt })
		.returning({ id: updatePost.id });
	await db.insert(updatePostTranslation).values([
		{ postId: row!.id, locale: 'de', title: `Titel ${slug}`, body: 'Rumpf' },
		{ postId: row!.id, locale: 'en', title: `Title ${slug}`, body: 'Body' }
	]);
	return row!.id;
}

async function makeSubscriber(topics: UpdateKind[], cursor: Date): Promise<string> {
	const email = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
	const created = await subscribe(db, { email, locale: 'de', topics, ttlMinutes: 60 });
	const confirmed = await confirmSubscription(
		db,
		created.kind === 'already' ? '' : created.confirmToken
	);
	await db
		.update(subscription)
		.set({ lastNotifiedAt: cursor })
		.where(eq(subscription.id, confirmed!.subscriptionId));
	return confirmed!.subscriptionId;
}

async function mailsFor(id: string): Promise<{ template: string; payload: unknown }[]> {
	const [row] = await db
		.select({ email: subscription.email })
		.from(subscription)
		.where(eq(subscription.id, id));
	if (!row) return [];
	return db
		.select({ template: outboundEmail.template, payload: outboundEmail.payload })
		.from(outboundEmail)
		.where(eq(outboundEmail.to, row.email))
		.orderBy(desc(outboundEmail.createdAt));
}

async function cursorOf(id: string): Promise<Date> {
	const [row] = await db
		.select({ at: subscription.lastNotifiedAt })
		.from(subscription)
		.where(eq(subscription.id, id));
	return row!.at!;
}

describe('notifySubscribers', () => {
	it('queues one mail per due subscriber and advances the cursor to the post date', async () => {
		const publishedAt = new Date(Date.now() - 60_000);
		await makePost('advisory', publishedAt);
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);

		const mails = await mailsFor(id);
		expect(mails.filter((mail) => mail.template === 'subscription_notice')).toHaveLength(1);
		expect((await cursorOf(id)).getTime()).toBe(publishedAt.getTime());
	});

	it('sends nothing on a second tick with no new posts', async () => {
		await makePost('advisory', new Date(Date.now() - 60_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);
		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(1);
	});

	it('ignores a post outside the subscriber topics', async () => {
		await makePost('certification', new Date(Date.now() - 60_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
	});

	// P4.8. Back-dating means "this was already announced"; the alternative is
	// mailing people about a change they were told about last week.
	it('never notifies about a back-dated post', async () => {
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));
		await makePost('advisory', new Date(Date.now() - 86_400_000));

		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
	});

	// §6.3, the mirror case: the same predicate giving the same answer. Pinned
	// so both directions are known rather than discovered.
	it('notifies again when a live post is re-dated forward', async () => {
		const postId = await makePost('advisory', new Date(Date.now() - 60_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);
		await db
			.update(updatePost)
			.set({ publishedAt: new Date(Date.now() - 1_000) })
			.where(eq(updatePost.id, postId));
		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(2);
	});

	it('ignores a scheduled post until its date passes', async () => {
		await makePost('advisory', new Date(Date.now() + 3_600_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
	});

	it('advances the cursor but queues nothing when every post is unsendable', async () => {
		const publishedAt = new Date(Date.now() - 60_000);
		const slug = `untranslated-${Date.now()}`;
		await db.insert(updatePost).values({ slug, kind: 'advisory', publishedAt });
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
		expect((await cursorOf(id)).getTime()).toBe(publishedAt.getTime());
	});

	// P4.18 end to end, and the regression test spec §14 asks for by name. The
	// unit test in Task 9 cannot reach this: it is the interaction between a
	// stale cursor, a save, and the next tick.
	it('sends nothing older than a save when a topic is added late', async () => {
		// A post the subscriber's topics did not match, so no tick ever moved
		// their cursor past it.
		await makePost('document', new Date(Date.now() - 86_400_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 172_800_000));

		await notifySubscribers(db, OPTIONS);
		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);

		// They now add `document`. Without the cursor advance in saveSubscription
		// this delivers a day of back catalogue in one mail.
		await saveSubscription(db, id, { locale: 'de', topics: ['advisory', 'document'] });
		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
	});

	it('stops at its bound and leaves the rest for the next tick', async () => {
		await makePost('advisory', new Date(Date.now() - 60_000));
		const ids = [
			await makeSubscriber(['advisory'], new Date(Date.now() - 7_200_000)),
			await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000))
		];

		const first = await notifySubscribers(db, { ...OPTIONS, limit: 1 });
		expect(first.queued).toBe(1);
		// Ordered by last_notified_at ascending: the most overdue goes first.
		expect(
			(await mailsFor(ids[0]!)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(1);
		expect(
			(await mailsFor(ids[1]!)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);

		await notifySubscribers(db, { ...OPTIONS, limit: 1 });
		expect(
			(await mailsFor(ids[1]!)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(1);
	});
});
