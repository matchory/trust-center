import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { controlGroup } from '../../src/lib/server/db/schema';
import {
	createControl,
	createControlGroup,
	getControlForAdmin,
	listPublicControlGroups,
	setControlEvidence,
	setControlGroupTranslation,
	setControlTranslation,
	updateControl
} from '../../src/lib/server/content/controls';
import {
	createCategory,
	createDocument,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';
import { documentCategory } from '../../src/lib/server/db/schema';

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
	await db.delete(controlGroup);
	await db.delete(documentCategory);
});

async function seedGroup() {
	const groupId = await createControlGroup(db, { slug: 'access', position: 0 });
	await setControlGroupTranslation(db, groupId, 'de', {
		name: 'Zugriffskontrolle',
		description: 'Wer worauf zugreifen darf.'
	});
	return groupId;
}

describe('control repository', () => {
	it('lists published controls under their group', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'mfa', groupId, status: 'implemented' });
		await setControlTranslation(db, controlId, 'de', {
			title: 'Mehr-Faktor-Authentifizierung',
			description: 'Für alle Mitarbeitendenkonten verpflichtend.'
		});
		await updateControl(db, controlId, { status: 'implemented', published: true });

		const groups = await listPublicControlGroups(db, { locale: 'de', defaultLocale: 'de' });

		expect(groups).toHaveLength(1);
		expect(groups[0]?.name).toBe('Zugriffskontrolle');
		expect(groups[0]?.controls[0]?.title).toBe('Mehr-Faktor-Authentifizierung');
		expect(groups[0]?.controls[0]?.status).toBe('implemented');
	});

	it('hides an unpublished control', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'draft', groupId, status: 'planned' });
		await setControlTranslation(db, controlId, 'de', { title: 'Entwurf', description: null });

		const groups = await listPublicControlGroups(db, { locale: 'de', defaultLocale: 'de' });
		expect(groups.flatMap((group) => group.controls)).toHaveLength(0);
	});

	it('falls back to the default locale and says so', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'mfa', groupId, status: 'implemented' });
		await setControlTranslation(db, controlId, 'de', { title: 'MFA', description: null });
		await updateControl(db, controlId, { published: true });

		const groups = await listPublicControlGroups(db, { locale: 'en', defaultLocale: 'de' });

		expect(groups[0]?.controls[0]?.isTranslationFallback).toBe(true);
	});

	it('links evidence documents and shows only the publicly visible ones', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'mfa', groupId, status: 'implemented' });
		await setControlTranslation(db, controlId, 'de', { title: 'MFA', description: null });
		await updateControl(db, controlId, { published: true });

		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		await setCategoryTranslation(db, categoryId, 'de', { name: 'Rechtliches' });

		const publicDoc = await createDocument(db, { slug: 'soa', categoryId, tier: 'public' });
		await setDocumentTranslation(db, publicDoc, 'de', {
			title: 'Erklärung zur Anwendbarkeit',
			summary: null
		});
		await updateDocument(db, publicDoc, { status: 'published' });

		const gatedDoc = await createDocument(db, { slug: 'pentest', categoryId, tier: 'request' });
		await setDocumentTranslation(db, gatedDoc, 'de', { title: 'Pentest-Bericht', summary: null });
		await updateDocument(db, gatedDoc, { status: 'published' });

		await setControlEvidence(db, controlId, [publicDoc, gatedDoc]);

		const groups = await listPublicControlGroups(db, { locale: 'de', defaultLocale: 'de' });
		const evidence = groups[0]?.controls[0]?.evidence ?? [];

		// A control may cite a gated document internally, but the portal must
		// not name one: it would leak both its existence and its title.
		expect(evidence.map((item) => item.slug)).toEqual(['soa']);
	});

	it('replaces the evidence set rather than appending to it', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'mfa', groupId, status: 'implemented' });
		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		const first = await createDocument(db, { slug: 'one', categoryId });
		const second = await createDocument(db, { slug: 'two', categoryId });

		await setControlEvidence(db, controlId, [first]);
		await setControlEvidence(db, controlId, [second]);

		const admin = await getControlForAdmin(db, controlId);
		expect(admin?.evidenceDocumentIds).toEqual([second]);
	});
});
