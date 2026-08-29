import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { outboundEmail } from '../../src/lib/server/db/schema';
import { drainOutbox, enqueueEmail } from '../../src/lib/server/mail/queue';
import type { MailAdapter } from '../../src/lib/server/mail';
import type { Db } from '../../src/lib/server/db';

const FROM = 'trust-center@test.invalid';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});

afterAll(async () => {
	await close();
});

function mailerThat(behaviour: 'succeed' | 'fail'): { adapter: MailAdapter; sent: string[] } {
	const sent: string[] = [];

	return {
		sent,
		adapter: {
			async send(mail) {
				if (behaviour === 'fail') throw new Error('smtp is down');
				sent.push(mail.to);
				return { providerId: 'test-id' };
			}
		}
	};
}

async function enqueueOne(): Promise<string> {
	const to = `person-${randomUUID()}@acme.example`;

	await enqueueEmail(db, {
		to,
		template: 'verify_request',
		locale: 'en',
		payload: { url: 'https://t.example/a' }
	});

	return to;
}

async function rowFor(to: string) {
	const [row] = await db.select().from(outboundEmail).where(eq(outboundEmail.to, to));
	return row;
}

describe('drainOutbox', () => {
	it('sends a pending mail and marks it sent', async () => {
		const to = await enqueueOne();
		const mailer = mailerThat('succeed');

		const result = await drainOutbox(db, { limit: 50, mailer: mailer.adapter, from: FROM });

		expect(result.sent).toBeGreaterThanOrEqual(1);
		expect(mailer.sent).toContain(to);

		const row = await rowFor(to);
		expect(row?.status).toBe('sent');
		expect(row?.sentAt).not.toBeNull();
		expect(row?.providerId).toBe('test-id');
	});

	it('renders the mail at send time, in the row locale', async () => {
		const to = `person-${randomUUID()}@acme.example`;
		await enqueueEmail(db, {
			to,
			template: 'verify_request',
			locale: 'de',
			payload: { url: 'https://t.example/xyz' }
		});

		let body = '';
		await drainOutbox(db, {
			limit: 50,
			from: FROM,
			mailer: {
				async send(mail) {
					if (mail.to === to) body = mail.text;
					return { providerId: undefined };
				}
			}
		});

		expect(body).toContain('https://t.example/xyz');
		// German, because that is what the row says — not the ambient locale of
		// whatever request happened to run last.
		expect(body).toContain('Trust Center');
		expect(body).toMatch(/Bestätigen|einmalig/);
	});

	it('leaves a failed mail pending, with a backed-off next attempt', async () => {
		const to = await enqueueOne();

		await drainOutbox(db, { limit: 50, mailer: mailerThat('fail').adapter, from: FROM });

		const row = await rowFor(to);
		expect(row?.status).toBe('pending');
		expect(row?.attempts).toBe(1);
		expect(row?.lastError).toContain('smtp is down');
		// Backed off, so the next tick does not immediately retry it.
		expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
	});

	it('gives up after the attempt ceiling and marks the mail failed', async () => {
		const to = await enqueueOne();

		// Drive it to the ceiling rather than waiting out five backoffs.
		await db.update(outboundEmail).set({ attempts: 4 }).where(eq(outboundEmail.to, to));

		await drainOutbox(db, { limit: 50, mailer: mailerThat('fail').adapter, from: FROM });

		expect((await rowFor(to))?.status).toBe('failed');
	});

	it('does not hand the same row to two concurrent drains', async () => {
		// The whole point of FOR UPDATE SKIP LOCKED. Without it two replicas both
		// send, and the recipient gets the same magic link twice.
		const to = await enqueueOne();
		const first = mailerThat('succeed');
		const second = mailerThat('succeed');

		await Promise.all([
			drainOutbox(db, { limit: 50, mailer: first.adapter, from: FROM }),
			drainOutbox(db, { limit: 50, mailer: second.adapter, from: FROM })
		]);

		const delivered = [...first.sent, ...second.sent].filter((address) => address === to);
		expect(delivered).toHaveLength(1);
	});

	it('does not claim a mail whose next attempt is in the future', async () => {
		const to = await enqueueOne();
		await db
			.update(outboundEmail)
			.set({ nextAttemptAt: new Date(Date.now() + 60_000) })
			.where(eq(outboundEmail.to, to));

		const mailer = mailerThat('succeed');
		await drainOutbox(db, { limit: 50, mailer: mailer.adapter, from: FROM });

		expect(mailer.sent).not.toContain(to);
	});
});
