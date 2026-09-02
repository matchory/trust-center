import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	answer,
	certification,
	documentCategory,
	subprocessor,
	updatePost,
	updatePostSubprocessor
} from '../../src/lib/server/db/schema';
import {
	createCertification,
	listPublicCertifications,
	setCertificationTranslation,
	updateCertification
} from '../../src/lib/server/content/certifications';
import {
	createCategory,
	createDocument,
	updateDocument
} from '../../src/lib/server/content/documents';
import {
	createAnswer,
	listPublicAnswers,
	setAnswerTranslation,
	updateAnswer
} from '../../src/lib/server/content/answers';
import {
	createUpdate,
	deleteUpdate,
	getUpdateForAdmin,
	listPublicUpdates,
	setUpdateSubprocessors,
	setUpdateTranslation,
	updateUpdate
} from '../../src/lib/server/content/updates';
import {
	createSubprocessor,
	deleteSubprocessor,
	listPublicSubprocessors,
	setSubprocessorTranslation,
	updateSubprocessor
} from '../../src/lib/server/content/subprocessors';

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

describe('certifications', () => {
	beforeEach(async () => {
		await db.delete(certification);
		await db.delete(documentCategory);
	});

	it('lists published certifications with scope and validity', async () => {
		const id = await createCertification(db, {
			slug: 'iso-27001',
			framework: 'ISO/IEC 27001:2022',
			issuer: 'TÜV Süd',
			validFrom: new Date('2025-04-01T00:00:00Z'),
			validUntil: new Date('2028-03-31T00:00:00Z'),
			certificateDocumentId: null
		});
		await setCertificationTranslation(db, id, 'de', { scope: 'Betrieb der Matchory-Plattform' });
		await updateCertification(db, id, { published: true });

		const items = await listPublicCertifications(db, { locale: 'de', defaultLocale: 'de' });

		expect(items).toHaveLength(1);
		expect(items[0]?.framework).toBe('ISO/IEC 27001:2022');
		expect(items[0]?.scope).toBe('Betrieb der Matchory-Plattform');
		expect(items[0]?.isScopeFallback).toBe(false);
	});

	it('hides an unpublished certification', async () => {
		const id = await createCertification(db, {
			slug: 'draft',
			framework: 'SOC 2',
			issuer: 'X',
			validFrom: null,
			validUntil: null,
			certificateDocumentId: null
		});
		await setCertificationTranslation(db, id, 'de', { scope: 'x' });

		expect(await listPublicCertifications(db, { locale: 'de', defaultLocale: 'de' })).toHaveLength(
			0
		);
	});

	it('does not link a certificate document that is not publicly visible', async () => {
		const categoryId = await createCategory(db, { slug: 'certs', position: 0 });
		const gated = await createDocument(db, { slug: 'iso-cert', categoryId, tier: 'request' });
		await updateDocument(db, gated, { status: 'published' });

		const id = await createCertification(db, {
			slug: 'iso-27001',
			framework: 'ISO/IEC 27001:2022',
			issuer: 'TÜV Süd',
			validFrom: null,
			validUntil: null,
			certificateDocumentId: gated
		});
		await setCertificationTranslation(db, id, 'de', { scope: 'x' });
		await updateCertification(db, id, { published: true });

		expect(
			(await listPublicCertifications(db, { locale: 'de', defaultLocale: 'de' }))[0]
				?.certificateFileId
		).toBeNull();
	});
});

describe('subprocessors', () => {
	beforeEach(async () => {
		await db.delete(subprocessor);
	});

	async function seed(overrides: Partial<{ endedAt: Date | null; published: boolean }> = {}) {
		const id = await createSubprocessor(db, {
			slug: 'hetzner',
			name: 'Hetzner Online GmbH',
			legalEntity: 'Hetzner Online GmbH',
			country: 'DE',
			region: 'EU',
			hostingProvider: null,
			dpaUrl: 'https://www.hetzner.com/dpa',
			startedAt: new Date('2023-01-01T00:00:00Z'),
			endedAt: overrides.endedAt ?? null
		});
		await setSubprocessorTranslation(db, id, 'de', {
			purpose: 'Hosting der Anwendung',
			dataCategories: 'Sämtliche Kundendaten'
		});
		await updateSubprocessor(db, id, { published: overrides.published ?? true });
		return id;
	}

	it('lists a current subprocessor with purpose and data categories', async () => {
		await seed();

		const { current, former } = await listPublicSubprocessors(db, {
			locale: 'de',
			defaultLocale: 'de'
		});

		expect(former).toHaveLength(0);
		expect(current[0]?.name).toBe('Hetzner Online GmbH');
		expect(current[0]?.purpose).toBe('Hosting der Anwendung');
		expect(current[0]?.country).toBe('DE');
	});

	it('moves an ended subprocessor to the former list rather than dropping it', async () => {
		await seed({ endedAt: new Date('2026-01-01T00:00:00Z') });

		const { current, former } = await listPublicSubprocessors(db, {
			locale: 'de',
			defaultLocale: 'de'
		});

		expect(current).toHaveLength(0);
		expect(former).toHaveLength(1);
	});

	it('hides an unpublished subprocessor entirely', async () => {
		await seed({ published: false });

		const { current, former } = await listPublicSubprocessors(db, {
			locale: 'de',
			defaultLocale: 'de'
		});

		expect([...current, ...former]).toHaveLength(0);
	});
});

describe('answers', () => {
	beforeEach(async () => {
		await db.delete(answer);
	});

	it('groups public answers by category', async () => {
		const first = await createAnswer(db, { slug: 'where-hosted', category: 'infrastructure' });
		await setAnswerTranslation(db, first, 'de', {
			question: 'Wo werden die Daten gehostet?',
			answer: 'In Deutschland, bei Hetzner.'
		});
		await updateAnswer(db, first, { visibility: 'public' });

		const second = await createAnswer(db, { slug: 'internal-only', category: 'infrastructure' });
		await setAnswerTranslation(db, second, 'de', { question: 'Intern?', answer: 'Ja.' });

		const groups = await listPublicAnswers(db, { locale: 'de', defaultLocale: 'de' });

		expect(groups).toHaveLength(1);
		expect(groups[0]?.category).toBe('infrastructure');
		expect(groups[0]?.answers).toHaveLength(1);
		expect(groups[0]?.answers[0]?.question).toBe('Wo werden die Daten gehostet?');
	});

	it('never exposes an internal answer, which is the default', async () => {
		const id = await createAnswer(db, { slug: 'secret', category: 'general' });
		await setAnswerTranslation(db, id, 'de', { question: 'Geheim?', answer: 'Ja.' });

		const groups = await listPublicAnswers(db, { locale: 'de', defaultLocale: 'de' });
		expect(groups.flatMap((group) => group.answers)).toHaveLength(0);
	});
});

describe('updates', () => {
	beforeEach(async () => {
		await db.delete(updatePost);
	});

	it('lists published updates newest first', async () => {
		for (const [slug, when] of [
			['older', '2026-01-01T00:00:00Z'],
			['newer', '2026-06-01T00:00:00Z']
		] as const) {
			const id = await createUpdate(db, { slug, kind: 'advisory' });
			await setUpdateTranslation(db, id, 'de', { title: slug, body: 'Text' });
			await updateUpdate(db, id, { publishedAt: new Date(when) });
		}

		const posts = await listPublicUpdates(db, { locale: 'de', defaultLocale: 'de' });
		expect(posts.map((post) => post.slug)).toEqual(['newer', 'older']);
	});

	it('hides an update with no publication date and one dated in the future', async () => {
		const unpublished = await createUpdate(db, { slug: 'draft', kind: 'advisory' });
		await setUpdateTranslation(db, unpublished, 'de', { title: 'Entwurf', body: 'x' });

		const scheduled = await createUpdate(db, { slug: 'scheduled', kind: 'advisory' });
		await setUpdateTranslation(db, scheduled, 'de', { title: 'Geplant', body: 'x' });
		await updateUpdate(db, scheduled, { publishedAt: new Date(Date.now() + 86_400_000) });

		expect(await listPublicUpdates(db, { locale: 'de', defaultLocale: 'de' })).toHaveLength(0);
	});
});

describe('update post subprocessor links', () => {
	it('replaces the set wholesale and reads it back', async () => {
		const stamp = `${Date.now()}`;
		const postId = await createUpdate(db, { slug: `link-${stamp}`, kind: 'subprocessor' });
		const first = await createSubprocessor(db, {
			slug: `sub-a-${stamp}`,
			name: 'A',
			legalEntity: 'A GmbH',
			country: 'DE',
			region: 'EU',
			hostingProvider: null,
			dpaUrl: null,
			startedAt: null,
			endedAt: null
		});
		const second = await createSubprocessor(db, {
			slug: `sub-b-${stamp}`,
			name: 'B',
			legalEntity: 'B GmbH',
			country: 'DE',
			region: 'EU',
			hostingProvider: null,
			dpaUrl: null,
			startedAt: null,
			endedAt: null
		});

		await setUpdateSubprocessors(db, postId, [first, second]);
		expect((await getUpdateForAdmin(db, postId))?.subprocessorIds.sort()).toEqual(
			[first, second].sort()
		);

		// The form submits the complete set every time, so an empty selection
		// clears it — the same contract `setControlEvidence` already has.
		await setUpdateSubprocessors(db, postId, []);
		expect((await getUpdateForAdmin(db, postId))?.subprocessorIds).toEqual([]);

		await deleteUpdate(db, postId);
		await deleteSubprocessor(db, first);
		await deleteSubprocessor(db, second);
	});

	it('drops the link when the post is deleted', async () => {
		const stamp = `${Date.now()}-cascade`;
		const postId = await createUpdate(db, { slug: `link-${stamp}`, kind: 'subprocessor' });
		const subId = await createSubprocessor(db, {
			slug: `sub-${stamp}`,
			name: 'C',
			legalEntity: 'C GmbH',
			country: 'DE',
			region: 'EU',
			hostingProvider: null,
			dpaUrl: null,
			startedAt: null,
			endedAt: null
		});
		await setUpdateSubprocessors(db, postId, [subId]);

		await deleteUpdate(db, postId);

		const rows = await db
			.select()
			.from(updatePostSubprocessor)
			.where(eq(updatePostSubprocessor.subprocessorId, subId));
		expect(rows).toHaveLength(0);

		await deleteSubprocessor(db, subId);
	});
});
