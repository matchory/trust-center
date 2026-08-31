import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	countGrantDocuments,
	createGrant,
	grantedDocuments,
	mayDownload
} from '../../src/lib/server/access/grants';
import { createGroup, setDocumentGroups } from '../../src/lib/server/access/groups';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessGroup,
	document,
	documentCategory,
	requester
} from '../../src/lib/server/db/schema';
import { seedDocument, seedRequester } from '../setup/fixtures';

let db: Db;
let close: () => Promise<void>;

const inNinetyDays = () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	// `access_grant_group.group_id` is ON DELETE RESTRICT, so a grant left
	// behind here makes every later file's `delete from access_group` fail.
	// Files run serially and share one container, so cleaning up is this file's
	// job, not the next one's.
	await db.delete(accessGrant);
	await close();
});

describe('grant resolution over sets', () => {
	beforeEach(async () => {
		await db.delete(accessGrant);
		await db.delete(document);
		await db.delete(documentCategory);
		await db.delete(accessGroup);
		await db.delete(requester);
	});

	it('covers a document named explicitly', async () => {
		const requesterId = await seedRequester(db);
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });

		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			expiresAt: inNinetyDays(),
			acceptanceDueAt: null,
			termDays: 90
		});

		expect(await mayDownload(db, requesterId, documentId)).toBe(true);
	});

	it('covers a whole tier, including a document published later', async () => {
		const requesterId = await seedRequester(db);

		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [],
			tiers: ['request'],
			groupIds: [],
			expiresAt: inNinetyDays(),
			acceptanceDueAt: null,
			termDays: 90
		});

		// Published after the grant was made. "Including documents published
		// later" is what a blanket means.
		const documentId = await seedDocument(db, { slug: 'later', tier: 'request' });
		expect(await mayDownload(db, requesterId, documentId)).toBe(true);
	});

	it('covers a whole group, including a document added to it later', async () => {
		const requesterId = await seedRequester(db);
		const groupId = await createGroup(db, { slug: 'customer', position: 0 });

		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [],
			tiers: [],
			groupIds: [groupId],
			expiresAt: inNinetyDays(),
			acceptanceDueAt: null,
			termDays: 90
		});

		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		expect(await mayDownload(db, requesterId, documentId)).toBe(false);

		await setDocumentGroups(db, documentId, [groupId]);
		expect(await mayDownload(db, requesterId, documentId)).toBe(true);
	});

	it('grants nothing from an empty scope', async () => {
		const requesterId = await seedRequester(db);
		await seedDocument(db, { slug: 'soc2', tier: 'request' });

		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [],
			tiers: [],
			groupIds: [],
			expiresAt: inNinetyDays(),
			acceptanceDueAt: null,
			termDays: 90
		});

		expect(await grantedDocuments(db, requesterId)).toEqual([]);
	});

	it('does not honour an nda tier entry in this phase', async () => {
		const requesterId = await seedRequester(db);
		const documentId = await seedDocument(db, { slug: 'pentest', tier: 'nda' });

		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: ['nda'],
			groupIds: [],
			expiresAt: inNinetyDays(),
			acceptanceDueAt: null,
			termDays: 90
		});

		// Storable, not yet honoured. Phase 3b is what makes this true, and
		// this assertion is what stops it becoming true by accident.
		expect(await mayDownload(db, requesterId, documentId)).toBe(false);
	});

	it('counts only live, unrevoked scope', async () => {
		const requesterId = await seedRequester(db);
		await seedDocument(db, { slug: 'soc2', tier: 'request' });

		const { grantId } = await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [],
			tiers: ['request'],
			groupIds: [],
			expiresAt: new Date(Date.now() - 1000),
			acceptanceDueAt: null,
			termDays: 90
		});

		// countGrantDocuments never filtered expiry or revocation. Its one
		// caller pre-filtered, so it was safe by accident; the expiry reminder
		// would otherwise tell somebody how many documents an expired grant
		// covers.
		expect(await countGrantDocuments(db, grantId)).toBe(0);
	});

	it('deduplicates a document covered by two sources', async () => {
		const requesterId = await seedRequester(db);
		const groupId = await createGroup(db, { slug: 'customer', position: 0 });
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		await setDocumentGroups(db, documentId, [groupId]);

		await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: ['request'],
			groupIds: [groupId],
			expiresAt: inNinetyDays(),
			acceptanceDueAt: null,
			termDays: 90
		});

		const granted = await grantedDocuments(db, requesterId);
		expect(granted).toHaveLength(1);
	});
});
