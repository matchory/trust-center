import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGrant, grantState } from '../../src/lib/server/access/grants';
import {
	closeUnacceptedGrants,
	sendAcceptanceReminders,
	sendExpiryReminders
} from '../../src/lib/server/access/expiry';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	documentCategory,
	document as documentTable,
	outboundEmail,
	requester
} from '../../src/lib/server/db/schema';

const LOCALES = ['de', 'en'];

let db: Db;
let close: () => Promise<void>;
let docId: string;

const REMINDER_DAYS = 7;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `cat-${randomUUID()}` })
		.returning();
	const [doc] = await db
		.insert(documentTable)
		.values({
			slug: `expiry-${randomUUID()}`,
			categoryId: category!.id,
			tier: 'request',
			status: 'published'
		})
		.returning();
	docId = doc!.id;
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	// Every case counts the queue for its own requester, but a stray row from a
	// prior case would still be picked up by the job's own query.
	await db.delete(outboundEmail);
});

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

async function seed(options: {
	expiresAt: Date | null;
	acceptanceDueAt?: Date | null;
	locale?: string;
	revoked?: boolean;
}): Promise<{ requesterId: string; email: string; grantId: string }> {
	const email = `expiry-${randomUUID()}@expiry.example`;
	const [person] = await db
		.insert(requester)
		.values({
			email,
			name: 'Expiry Fixture',
			company: 'Acme',
			companyDomain: 'expiry.example',
			locale: options.locale ?? 'de'
		})
		.returning({ id: requester.id });

	const { grantId } = await createGrant(db, {
		requesterId: person!.id,
		requestId: null,
		documentIds: [docId],
		tiers: [],
		groupIds: [],
		termDays: 30,
		expiresAt: options.expiresAt,
		acceptanceDueAt: options.acceptanceDueAt ?? null
	});

	if (options.revoked) {
		await db.update(accessGrant).set({ revokedAt: new Date() }).where(eq(accessGrant.id, grantId));
	}

	return { requesterId: person!.id, email, grantId };
}

async function reminders(email: string) {
	return db
		.select()
		.from(outboundEmail)
		.where(and(eq(outboundEmail.to, email), eq(outboundEmail.template, 'grant_expiring')));
}

describe('sendExpiryReminders', () => {
	it('queues one reminder for a grant inside the reminder window', async () => {
		const { email, grantId } = await seed({ expiresAt: days(3) });

		await sendExpiryReminders(db, { reminderDays: REMINDER_DAYS, locales: LOCALES });

		const queued = await reminders(email);
		expect(queued).toHaveLength(1);
		// Never "0 documents": the count is the grant's own scope.
		expect(queued[0]?.payload).toMatchObject({ documentCount: 1 });

		const [grant] = await db.select().from(accessGrant).where(eq(accessGrant.id, grantId));
		expect(grant?.expiryReminderSentAt).not.toBeNull();
	});

	it('does not queue a second reminder on the next run', async () => {
		// expiry_reminder_sent_at is what makes this true. Without it the job
		// mails the same person every tick until the grant lapses.
		const { email } = await seed({ expiresAt: days(3) });

		await sendExpiryReminders(db, { reminderDays: REMINDER_DAYS, locales: LOCALES });
		await sendExpiryReminders(db, { reminderDays: REMINDER_DAYS, locales: LOCALES });

		expect(await reminders(email)).toHaveLength(1);
	});

	it('ignores a grant that expires beyond the window', async () => {
		const { email } = await seed({ expiresAt: days(REMINDER_DAYS + 5) });

		await sendExpiryReminders(db, { reminderDays: REMINDER_DAYS, locales: LOCALES });

		expect(await reminders(email)).toHaveLength(0);
	});

	it('ignores a revoked grant', async () => {
		const { email } = await seed({ expiresAt: days(3), revoked: true });

		await sendExpiryReminders(db, { reminderDays: REMINDER_DAYS, locales: LOCALES });

		expect(await reminders(email)).toHaveLength(0);
	});

	it('ignores an already-expired grant', async () => {
		// A reminder after the fact is noise, and the lapse itself needs no job:
		// grantedDocuments filters on expiresAt, so access ends on its own.
		const { email } = await seed({ expiresAt: days(-1) });

		await sendExpiryReminders(db, { reminderDays: REMINDER_DAYS, locales: LOCALES });

		expect(await reminders(email)).toHaveLength(0);
	});

	it('ignores a purged requester', async () => {
		const { email, requesterId } = await seed({ expiresAt: days(3) });
		await db
			.update(requester)
			.set({ purgedAt: new Date(), email: `purged-${randomUUID()}@invalid` })
			.where(eq(requester.id, requesterId));

		await sendExpiryReminders(db, { reminderDays: REMINDER_DAYS, locales: LOCALES });

		expect(await reminders(email)).toHaveLength(0);
	});

	it('sends the reminder in the requester locale', async () => {
		const { email } = await seed({ expiresAt: days(3), locale: 'en' });

		await sendExpiryReminders(db, { reminderDays: REMINDER_DAYS, locales: LOCALES });

		const [queued] = await reminders(email);
		expect(queued?.locale).toBe('en');
	});
});

describe('the acceptance nudge and the closing sweep', () => {
	const soon = () => days(2);
	const past = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

	it('nudges an inert grant before its acceptance deadline, once', async () => {
		await seed({ expiresAt: null, acceptanceDueAt: soon() });

		expect((await sendAcceptanceReminders(db, { reminderDays: 3 })).queued).toBe(1);
		expect((await sendAcceptanceReminders(db, { reminderDays: 3 })).queued).toBe(0);
	});

	it('does not spend the expiry reminder on an inert grant', async () => {
		// Reusing expiry_reminder_sent_at would stamp it while the grant is inert,
		// and sendExpiryReminders filters isNull(expiryReminderSentAt) — so access
		// would later end with no warning, for every grant that went through an NDA,
		// with nothing failing and nothing logged.
		const { grantId } = await seed({ expiresAt: null, acceptanceDueAt: soon() });
		await sendAcceptanceReminders(db, { reminderDays: 3 });

		const [row] = await db.select().from(accessGrant).where(eq(accessGrant.id, grantId));
		expect(row?.acceptanceReminderSentAt).not.toBeNull();
		expect(row?.expiryReminderSentAt).toBeNull();
	});

	it('leaves live grants to the expiry reminder', async () => {
		await seed({ expiresAt: soon() });
		expect((await sendAcceptanceReminders(db, { reminderDays: 3 })).queued).toBe(0);
	});

	it('closes a grant past its acceptance deadline', async () => {
		const { grantId } = await seed({ expiresAt: null, acceptanceDueAt: past() });
		await closeUnacceptedGrants(db);

		const [row] = await db.select().from(accessGrant).where(eq(accessGrant.id, grantId));
		expect(row?.closedAt).not.toBeNull();
		// Correctness never depended on the sweep — the activation predicate already
		// excluded this grant. The row is what Phase 5 will count.
		expect(grantState(row!, new Date())).toBe('unaccepted');
	});
});
