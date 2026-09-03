import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { blankPdf } from '../helpers/pdf';
import { fakeRequestEvent } from '../helpers/request-event';
import { expectNoSensitiveAttributes, recordingSpans } from '../helpers/telemetry';
import { seedDocument, seedRequester } from '../setup/fixtures';

/**
 * `serveDocumentFile` reaches for `getDb()`, `getConfig()` and `getStorage()` —
 * three lazy singletons that read `process.env` on first call — so the
 * environment has to be complete before the first call, not before the import.
 * That is what actually made this module look untestable: not the
 * `RequestEvent` (see tests/helpers/request-event.ts, which turned out to need
 * five fields), but three singletons reached for rather than passed in.
 *
 * Vitest runs integration files in isolated forks (`pool: 'forks'`,
 * `fileParallelism: false`), so owning `process.env` here affects no other file.
 */
beforeAll(async () => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL,
		BASE_URL: 'https://trust.example.com',
		LOCALES: 'de,en',
		DEFAULT_LOCALE: 'de',
		OIDC_ISSUER: 'https://idp.example.com',
		OIDC_CLIENT_ID: 'trust-center',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_ADMIN_GROUP: 'trust-center-admins',
		STORAGE_DIR: await mkdtemp(join(tmpdir(), 'delivery-serve-'))
	});
});

const spans = recordingSpans();

async function seedFile(
	tier: 'public' | 'request'
): Promise<{ fileId: string; documentId: string }> {
	const { getDb } = await import('../../src/lib/server/db/instance');
	const { getStorage, newStorageKey } = await import('../../src/lib/server/storage');
	const { documentFile } = await import('../../src/lib/server/db/schema');

	const db = getDb();
	const documentId = await seedDocument(db, { slug: `serve-${randomUUID()}`, tier });

	const key = newStorageKey();
	const stored = await getStorage().put(key, await blankPdf(3));

	const [row] = await db
		.insert(documentFile)
		.values({
			documentId,
			locale: 'de',
			version: 1,
			storageKey: key,
			sha256: stored.sha256,
			sizeBytes: stored.size,
			filename: 'policy.pdf',
			contentType: 'application/pdf',
			isCurrent: true
		})
		.returning({ id: documentFile.id });

	return { fileId: row!.id, documentId };
}

describe('the delivery span', () => {
	// Spec §7.2 singled out this path because it *buffers*. The public tier
	// streams and the gated tier buffers; both go through the same span, so the
	// two are comparable in one query.
	it('wraps the public stream, naming the tier and the stored size', async () => {
		const { serveDocumentFile } = await import('../../src/lib/server/delivery/serve');
		const { fileId } = await seedFile('public');

		const response = await serveDocumentFile(
			fakeRequestEvent({ params: { fileId }, locals: { locale: 'de' } }),
			{ tiers: ['public'], gated: false }
		);

		expect(response.status).toBe(200);

		const deliver = spans().filter((span) => span.name === 'document deliver');
		expect(deliver).toHaveLength(1);
		expect(deliver[0]?.attributes['document.tier']).toBe('public');
		expect(deliver[0]?.attributes['document.watermarked']).toBe(false);
		expect(deliver[0]?.attributes['document.size_bytes']).toBeGreaterThan(0);
		expectNoSensitiveAttributes(deliver[0]);
	});

	// The reason the span had to move up rather than stay on `stampPdf`: the
	// stamp span covers the CPU cost of stamping and nothing else, so the
	// storage read that precedes it — the thing §7.2 actually named — was
	// invisible. Asserting that the watermark span is a *child* of the delivery
	// span is what pins that: the difference between the two is the buffering.
	//
	// The recipient assertions ride along here rather than in a case of their
	// own, because a separate case would run after `beforeEach` reset the
	// exporter and would pass over an empty array — the vacuous shape this
	// branch's carry-over §4 exists to record.
	it('encloses the watermark span on the gated path, so the buffering is measurable', async () => {
		const { serveDocumentFile } = await import('../../src/lib/server/delivery/serve');
		const { getDb } = await import('../../src/lib/server/db/instance');
		const { createGrant } = await import('../../src/lib/server/access/grants');

		const db = getDb();
		const { fileId, documentId } = await seedFile('request');
		const requesterId = await seedRequester(db, { email: `holder-${randomUUID()}@acme.example` });

		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
			acceptanceDueAt: null
		});

		const response = await serveDocumentFile(
			fakeRequestEvent({
				params: { fileId },
				locals: {
					locale: 'de',
					requester: {
						id: requesterId,
						email: 'holder@acme.example',
						name: 'A Holder',
						company: 'Acme'
					}
				}
			}),
			{ tiers: ['request'], gated: true }
		);

		expect(response.status).toBe(200);

		const deliver = spans().find((span) => span.name === 'document deliver');
		const watermark = spans().find((span) => span.name === 'document watermark');
		expect(deliver).toBeDefined();
		expect(watermark).toBeDefined();
		expect(watermark?.parentSpanContext?.spanId).toBe(deliver?.spanContext().spanId);
		expect(deliver?.attributes['document.watermarked']).toBe(true);

		// Spec §8: this is the path that holds a name, a company and an email.
		expectNoSensitiveAttributes(deliver, 'Acme', 'A Holder');
		expectNoSensitiveAttributes(watermark, 'Acme', 'A Holder');
	});

	// A row whose object is gone must still 404 rather than 500, and the span
	// must close on that path — an open span leaks its context into whatever
	// runs next.
	it('ends the span when the stored object is missing', async () => {
		const { serveDocumentFile } = await import('../../src/lib/server/delivery/serve');
		const { getDb } = await import('../../src/lib/server/db/instance');
		const { documentFile } = await import('../../src/lib/server/db/schema');

		const { fileId } = await seedFile('public');
		await getDb()
			.update(documentFile)
			.set({ storageKey: 'ff/ff/ffffffff-ffff-4fff-8fff-ffffffffffff' })
			.where(eq(documentFile.id, fileId));

		await expect(
			serveDocumentFile(fakeRequestEvent({ params: { fileId }, locals: { locale: 'de' } }), {
				tiers: ['public'],
				gated: false
			})
		).rejects.toMatchObject({ status: 404 });

		const deliver = spans().filter((span) => span.name === 'document deliver');
		expect(deliver).toHaveLength(1);
		expect(deliver[0]?.status.code).toBe(2); // SpanStatusCode.ERROR
	});
});
