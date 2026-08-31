import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { createGroup, setDocumentGroups, updateGroup } from '../../src/lib/server/access/groups';
import { grantedDocuments, mayDownload } from '../../src/lib/server/access/grants';
import { setGrantTiers } from '../../src/lib/server/access/scope';
import {
	accessGrant,
	accessGroup,
	document,
	documentCategory,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateVersion,
	requester,
	setting,
	staffUser
} from '../../src/lib/server/db/schema';
import { recordAcceptance } from '../../src/lib/server/nda/acceptance';
import { recordRequirements } from '../../src/lib/server/nda/requirements';
import { setDefaultTemplateId } from '../../src/lib/server/nda/settings';
import {
	seedAgreement,
	seedDocument,
	seedGrant,
	seedRequester,
	seedStaff
} from '../setup/fixtures';

const LOCALES = ['de', 'en'];
const options = { locales: LOCALES };

let db: Db;
let close: () => Promise<void>;

let requesterId: string;
let staffId: string;
let documentId: string;
let grantId: string;
let groupId: string;
let acme: string;
let acmeVersionId: string;
let acmeSha: string;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

async function reset(): Promise<void> {
	// Children before parents throughout: `access_group.nda_template_id` and
	// `nda_acceptance.version_id` are both ON DELETE RESTRICT.
	await db.delete(accessGrant);
	await db.delete(ndaAcceptance);
	await db.delete(document);
	await db.delete(documentCategory);
	await db.delete(accessGroup);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await db.delete(setting);
	await db.delete(requester);
	await db.delete(staffUser);
}

afterAll(async () => {
	await reset();
	await close();
});

beforeEach(async () => {
	await reset();

	({
		templateId: acme,
		versionId: acmeVersionId,
		sha256: acmeSha
	} = await seedAgreement(db, { slug: `acme-${randomUUID().slice(0, 8)}`, locales: LOCALES }));

	requesterId = await seedRequester(db);
	staffId = await seedStaff(db);

	// Path 1 of §7.3: tiers {request}, no requirements, clock already running.
	documentId = await seedDocument(db, {
		slug: `pack-${randomUUID().slice(0, 8)}`,
		tier: 'request'
	});
	grantId = await seedGrant(db, { requesterId });
	await setGrantTiers(db, grantId, ['request']);

	groupId = await createGroup(db, { slug: `acme-${randomUUID().slice(0, 8)}`, position: 0 });
});

/** Puts the document in a group that carries the agreement. */
async function gateTheDocument(): Promise<void> {
	await updateGroup(db, groupId, {
		slug: `acme-${randomUUID().slice(0, 8)}`,
		position: 0,
		ndaTemplateId: acme
	});
	await setDocumentGroups(db, documentId, [groupId]);
}

describe('live delivery', () => {
	it('stops delivering a document that gains an agreement after approval', async () => {
		expect(await mayDownload(db, requesterId, documentId, options)).toBe(true);

		await gateTheDocument();

		// The operator's protective action takes effect the same day, not in ninety.
		expect(await mayDownload(db, requesterId, documentId, options)).toBe(false);
	});

	it('keeps delivering when the grant records a waiver for that agreement', async () => {
		// A recorded waiver is the grant's answer to a requirement the document
		// still carries. An omitted requirement would be silently re-imposed here,
		// which is what would make the bypass useless.
		await gateTheDocument();
		await recordRequirements(
			db,
			grantId,
			[{ templateId: acme, disposition: 'waived', reason: 'paper' }],
			staffId,
			{ locales: LOCALES }
		);

		expect(await mayDownload(db, requesterId, documentId, options)).toBe(true);
	});

	it('keeps delivering when the requester holds a valid acceptance', async () => {
		await gateTheDocument();
		await recordAcceptance(db, {
			requesterId,
			versionId: acmeVersionId,
			typedName: 'A',
			sha256: acmeSha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

		expect(await mayDownload(db, requesterId, documentId, options)).toBe(true);
	});

	it('stops delivering a document moved to the nda tier', async () => {
		// Path 3, and the one that reverses a guarantee Phase 2 shipped on purpose:
		// grants.ts states that the tier filter is applied at query time "so a
		// document moved from request to nda must stop being downloadable
		// immediately, without anybody remembering to revisit existing grants".
		await setDefaultTemplateId(db, acme);
		await setGrantTiers(db, grantId, ['request', 'nda']);
		await db.update(document).set({ tier: 'nda' }).where(eq(document.id, documentId));

		expect(await mayDownload(db, requesterId, documentId, options)).toBe(false);
	});

	it('refuses an nda-tier document when no default agreement is configured', async () => {
		// §4.4 fails closed: an ungated nda-tier document is the one outcome the
		// resolution rule exists to prevent.
		await setGrantTiers(db, grantId, ['request', 'nda']);
		await db.update(document).set({ tier: 'nda' }).where(eq(document.id, documentId));

		expect(await mayDownload(db, requesterId, documentId, options)).toBe(false);
	});

	it('never adds a document the grant did not already cover', async () => {
		// The invariant, stated as a test: live evaluation may only narrow.
		const unrelated = await seedDocument(db, {
			slug: `unrelated-${randomUUID().slice(0, 8)}`,
			tier: 'nda'
		});
		const before = (await grantedDocuments(db, requesterId, options)).map((row) => row.documentId);

		await recordRequirements(db, grantId, [], staffId, { locales: LOCALES });
		const after = (await grantedDocuments(db, requesterId, options)).map((row) => row.documentId);

		expect(after.every((id) => before.includes(id))).toBe(true);
		expect(after).not.toContain(unrelated);
	});
});
