import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGroup, setDocumentGroups } from '../../src/lib/server/access/groups';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessGroup,
	document,
	documentCategory,
	ndaTemplate,
	ndaTemplateVersion,
	requester
} from '../../src/lib/server/db/schema';
import { DefaultTemplateMissing, proposeRequirements } from '../../src/lib/server/nda/requirements';
import { seedAgreement, seedDocument } from '../setup/fixtures';

const LOCALES = ['de', 'en'];

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

// Children before parents: `access_group.nda_template_id` and
// `nda_template_version.template_id` are both ON DELETE RESTRICT, so a group or
// a version left behind here makes every later file's template cleanup fail.
afterAll(async () => {
	await db.delete(accessGrant);
	await db.delete(document);
	await db.delete(documentCategory);
	await db.delete(accessGroup);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await close();
});

beforeEach(async () => {
	await db.delete(accessGrant);
	await db.delete(document);
	await db.delete(documentCategory);
	await db.delete(accessGroup);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await db.delete(requester);
});

/**
 * What the unit tests cannot reach: that the *rows* handed to `proposeFrom`
 * are the ones the scope actually covers.
 *
 * Both blanket sources are future-inclusive — a document that joins a granted
 * group or tier tomorrow is not in today's proposal — so this is deliberately
 * only half the gate. §7.3's live per-document check at delivery is the other
 * half, and Task 16 is where it lands.
 */
describe('proposing the agreements a scope requires', () => {
	it('proposes nothing for an empty scope', async () => {
		// Not merely "nothing configured": with no predicate at all the query
		// would propose from the whole catalogue.
		await seedDocument(db, { slug: 'soc2', tier: 'nda' });
		const { templateId } = await seedAgreement(db, { slug: 'mutual', locales: LOCALES });

		expect(
			await proposeRequirements(
				db,
				{ documentIds: [], tiers: [], groupIds: [] },
				{ defaultTemplateId: templateId }
			)
		).toEqual([]);
	});

	it('takes the agreement of a group a covered document belongs to', async () => {
		const { templateId } = await seedAgreement(db, { slug: 'acme', locales: LOCALES });
		const documentId = await seedDocument(db, { slug: 'pack', tier: 'request' });
		const groupId = await createGroup(db, { slug: 'acme', position: 0, ndaTemplateId: templateId });
		await setDocumentGroups(db, documentId, [groupId]);

		expect(
			await proposeRequirements(
				db,
				{ documentIds: [documentId], tiers: [], groupIds: [] },
				{ defaultTemplateId: null }
			)
		).toEqual([templateId]);
	});

	it('takes every group a document belongs to, not only the one it was reached through', async () => {
		// The document is reached through `acme`, but it also sits in `bosch`.
		// Filtering the join to the granted group rather than the document would
		// silently drop Bosch's agreement from the proposal.
		const acme = await seedAgreement(db, { slug: 'acme', locales: LOCALES });
		const bosch = await seedAgreement(db, { slug: 'bosch', locales: LOCALES });
		const documentId = await seedDocument(db, { slug: 'pack', tier: 'request' });
		const acmeGroup = await createGroup(db, {
			slug: 'acme',
			position: 0,
			ndaTemplateId: acme.templateId
		});
		const boschGroup = await createGroup(db, {
			slug: 'bosch',
			position: 1,
			ndaTemplateId: bosch.templateId
		});
		await setDocumentGroups(db, documentId, [acmeGroup, boschGroup]);

		expect(
			(
				await proposeRequirements(
					db,
					{ documentIds: [], tiers: [], groupIds: [acmeGroup] },
					{ defaultTemplateId: null }
				)
			).sort()
		).toEqual([acme.templateId, bosch.templateId].sort());
	});

	it('adds the default agreement for an nda-tier document reached through a tier blanket', async () => {
		const { templateId } = await seedAgreement(db, { slug: 'mutual', locales: LOCALES });
		await seedDocument(db, { slug: 'pentest', tier: 'nda' });
		await seedDocument(db, { slug: 'soc2', tier: 'request' });

		expect(
			await proposeRequirements(
				db,
				{ documentIds: [], tiers: ['request', 'nda'], groupIds: [] },
				{ defaultTemplateId: templateId }
			)
		).toEqual([templateId]);
	});

	it('ignores a document outside the scope', async () => {
		const { templateId } = await seedAgreement(db, { slug: 'acme', locales: LOCALES });
		const outside = await seedDocument(db, { slug: 'other', tier: 'request' });
		const groupId = await createGroup(db, { slug: 'acme', position: 0, ndaTemplateId: templateId });
		await setDocumentGroups(db, outside, [groupId]);
		const documentId = await seedDocument(db, { slug: 'pack', tier: 'request' });

		expect(
			await proposeRequirements(
				db,
				{ documentIds: [documentId], tiers: [], groupIds: [] },
				{ defaultTemplateId: null }
			)
		).toEqual([]);
	});

	it('fails closed when the scope reaches an nda-tier document and no default is configured', async () => {
		await seedDocument(db, { slug: 'pentest', tier: 'nda' });

		await expect(
			proposeRequirements(
				db,
				{ documentIds: [], tiers: ['nda'], groupIds: [] },
				{ defaultTemplateId: null }
			)
		).rejects.toBeInstanceOf(DefaultTemplateMissing);
	});
});
