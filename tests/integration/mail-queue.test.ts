import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpanKind, trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { outboundEmail } from '../../src/lib/server/db/schema';
import { drainOutbox, enqueueEmail } from '../../src/lib/server/mail/queue';
import { createLocalStorage, newStorageKey } from '../../src/lib/server/storage/local';
import type { MailAdapter, OutgoingMail } from '../../src/lib/server/mail';
import type { Db } from '../../src/lib/server/db';
import type { StorageAdapter } from '../../src/lib/server/storage';

const FROM = 'trust-center@test.invalid';

let db: Db;
let close: () => Promise<void>;
let storage: StorageAdapter;
let exporter: InMemorySpanExporter;

beforeAll(async () => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
	storage = createLocalStorage(await mkdtemp(join(tmpdir(), 'mail-attachment-')));

	// `trace.setGlobalTracerProvider` silently refuses a second registration
	// (returns false, no throw) once one is already registered on globalThis —
	// disable first so this file's provider actually takes effect, and
	// register once here rather than per test so the second test's fresh
	// exporter is not silently ignored.
	trace.disable();
	exporter = new InMemorySpanExporter();
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
	);
});

beforeEach(() => exporter.reset());

afterAll(async () => {
	await close();
	// Leave the global tracing API as this file found it, for whichever test
	// file's `beforeAll` runs next in the same worker.
	trace.disable();
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

		const result = await drainOutbox(db, {
			limit: 50,
			mailer: mailer.adapter,
			from: FROM,
			storage
		});

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
			storage,
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

		await drainOutbox(db, { limit: 50, mailer: mailerThat('fail').adapter, from: FROM, storage });

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

		await drainOutbox(db, { limit: 50, mailer: mailerThat('fail').adapter, from: FROM, storage });

		expect((await rowFor(to))?.status).toBe('failed');
	});

	it('does not hand the same row to two concurrent drains', async () => {
		// The whole point of FOR UPDATE SKIP LOCKED. Without it two replicas both
		// send, and the recipient gets the same magic link twice.
		const to = await enqueueOne();
		const first = mailerThat('succeed');
		const second = mailerThat('succeed');

		await Promise.all([
			drainOutbox(db, { limit: 50, mailer: first.adapter, from: FROM, storage }),
			drainOutbox(db, { limit: 50, mailer: second.adapter, from: FROM, storage })
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
		await drainOutbox(db, { limit: 50, mailer: mailer.adapter, from: FROM, storage });

		expect(mailer.sent).not.toContain(to);
	});
});

describe('attachments', () => {
	// These two assert on exact sent/failed counts, so the queue starts empty
	// rather than carrying whatever the tests above left pending.
	beforeEach(async () => {
		await db.delete(outboundEmail);
	});

	it('sends a queued attachment by resolving its storage key at send time', async () => {
		const key = newStorageKey();
		await storage.put(key, new TextEncoder().encode('%PDF-1.7 fixture'));

		await enqueueEmail(db, {
			to: `signer-${randomUUID()}@acme.example`,
			template: 'nda_record',
			locale: 'en',
			payload: {
				agreement: 'Mutual NDA',
				attachments: [
					{ filename: 'acceptance.pdf', contentType: 'application/pdf', storageKey: key }
				]
			}
		});

		const sent: OutgoingMail[] = [];
		await drainOutbox(db, {
			limit: 5,
			from: FROM,
			mailer: {
				send: async (mail) => {
					sent.push(mail);
					return { providerId: 'x' };
				}
			},
			storage
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]?.attachments?.[0]?.filename).toBe('acceptance.pdf');
		expect(new TextDecoder().decode(sent[0]!.attachments![0]!.content)).toContain('%PDF');
	});

	it('fails the row rather than the send when the object is gone', async () => {
		// A record deleted by a purge between queueing and draining. The mail must
		// not go out with a missing attachment and must not retry forever.
		await enqueueEmail(db, {
			to: `signer-${randomUUID()}@acme.example`,
			template: 'nda_record',
			locale: 'en',
			payload: {
				agreement: 'Mutual NDA',
				attachments: [
					{ filename: 'a.pdf', contentType: 'application/pdf', storageKey: newStorageKey() }
				]
			}
		});

		const { sent, failed } = await drainOutbox(db, {
			limit: 5,
			from: FROM,
			mailer: {
				send: async () => {
					throw new Error('the mailer must not be reached');
				}
			},
			storage
		});

		expect(sent).toBe(0);
		expect(failed).toBe(1);
	});
});

describe('mail drain telemetry', () => {
	it('emits one span per send, naming the template and never the address', async () => {
		// `access_link` is not a real MailTemplate (the file has no such id, and
		// `renderTemplate`'s exhaustive switch would return undefined for it,
		// failing the row before the mailer is ever called) — `sign_in` is the
		// closest existing template with a matching `{ url }` payload shape.
		await db.insert(outboundEmail).values({
			to: 'telemetry-probe@example.test',
			template: 'sign_in',
			locale: 'de',
			payload: { url: 'https://trust.example/de/access' }
		});

		await drainOutbox(db, {
			limit: 10,
			mailer: mailerThat('succeed').adapter,
			from: FROM,
			storage
		});

		const sendSpans = exporter.getFinishedSpans().filter((span) => span.name === 'mail send');
		expect(sendSpans).toHaveLength(1);
		expect(sendSpans[0]?.attributes['mail.template']).toBe('sign_in');
		// CLIENT rather than the SDK's default INTERNAL: SMTP is the application's
		// only outbound egress, and a service map keys on the span kind.
		expect(sendSpans[0]?.kind).toBe(SpanKind.CLIENT);

		// Spec §8: the recipient is personal data and telemetry leaves the
		// boundary, so no attribute may carry it.
		const values = Object.values(sendSpans[0]?.attributes ?? {}).map(String);
		expect(values.some((value) => value.includes('@'))).toBe(false);
	});
});
