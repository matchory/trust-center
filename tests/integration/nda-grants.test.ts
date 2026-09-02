import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	countGrantDocuments,
	createGrant,
	grantedDocuments
} from '../../src/lib/server/access/grants';
import { createGroup, setDocumentGroups } from '../../src/lib/server/access/groups';
import { decideRequest } from '../../src/lib/server/access/requests';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessGrantAcceptance,
	accessGroup,
	document,
	documentCategory,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateVersion,
	requester,
	staffUser
} from '../../src/lib/server/db/schema';
import {
	DefaultTemplateMissing,
	grantRequirements,
	proposeRequirements,
	recordRequirements,
	RequirementNotRenderable
} from '../../src/lib/server/nda/requirements';
import { recordAcceptance } from '../../src/lib/server/nda/acceptance';
import { activateGrants } from '../../src/lib/server/nda/activation';
import { setDefaultTemplateId } from '../../src/lib/server/nda/settings';
import { createTemplate } from '../../src/lib/server/nda/templates';
import {
	seedAgreement,
	seedDocument,
	seedGrant,
	seedInertGrant,
	seedRequest,
	seedRequester
} from '../setup/fixtures';

const LOCALES = ['de', 'en'];

let db: Db;
let close: () => Promise<void>;
let staffId: string;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	const [staff] = await db
		.insert(staffUser)
		.values({
			oidcSub: `sub-${randomUUID()}`,
			email: `approver-${randomUUID()}@matchory.example`,
			name: 'An Approver',
			role: 'approver'
		})
		.returning({ id: staffUser.id });
	staffId = staff!.id;
});

// Children before parents: `access_group.nda_template_id` and
// `nda_template_version.template_id` are both ON DELETE RESTRICT, so a group or
// a version left behind here makes every later file's template cleanup fail.
afterAll(async () => {
	await db.delete(accessGrant);
	await db.delete(ndaAcceptance);
	await db.delete(document);
	await db.delete(documentCategory);
	await db.delete(accessGroup);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await close();
});

beforeEach(async () => {
	await db.delete(accessGrant);
	await db.delete(ndaAcceptance);
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

describe('recording what a grant is waiting on', () => {
	let requesterId: string;
	let acme: string;
	let bosch: string;

	beforeEach(async () => {
		requesterId = await seedRequester(db);
		({ templateId: acme } = await seedAgreement(db, { slug: 'acme', locales: LOCALES }));
		({ templateId: bosch } = await seedAgreement(db, { slug: 'bosch', locales: LOCALES }));
	});

	it('mints an inert grant when a requirement is outstanding', async () => {
		const { grantId } = await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [],
			tiers: ['request'],
			groupIds: [],
			termDays: 30,
			expiresAt: null,
			acceptanceDueAt: new Date(Date.now() + 14 * 86_400_000)
		});

		const [row] = await db.select().from(accessGrant).where(eq(accessGrant.id, grantId));
		expect(row?.expiresAt).toBeNull();

		// Inert by construction, not by remembering: both download gates filter
		// `expires_at > now()`, and SQL's NULL comparison excludes the row.
		expect(await grantedDocuments(db, requesterId, { locales: LOCALES })).toEqual([]);
	});

	it('refuses a grant that is neither live nor waiting', async () => {
		// The constraint name is on the driver's `cause`, not on the wrapper
		// message drizzle throws — the same shape `groups.test.ts` asserts on.
		await expect(
			db.insert(accessGrant).values({ requesterId, termDays: 30, expiresAt: null })
		).rejects.toMatchObject({
			cause: { message: expect.stringContaining('access_grant_inert_check') }
		});
	});

	it('records a waiver as a row, with the approver and the reason', async () => {
		const grantId = await seedGrant(db, { requesterId });
		await recordRequirements(
			db,
			grantId,
			[
				{ templateId: acme, disposition: 'required', reason: null },
				{ templateId: bosch, disposition: 'waived', reason: 'signed on paper 2026-05-02' }
			],
			staffId,
			{ locales: LOCALES }
		);

		const rows = await grantRequirements(db, grantId);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.ndaTemplateId === bosch)).toMatchObject({
			disposition: 'waived',
			reason: 'signed on paper 2026-05-02',
			decidedByStaffId: staffId
		});
	});

	it('refuses to record a requirement whose template has no renderable version', async () => {
		// §5.2: the failure lands at the decision, where a person is present,
		// rather than at the click-through, where one is not — and where the
		// requester would sit on an "unavailable" page while their deadline ticked
		// down.
		const draftOnly = await createTemplate(db, { slug: 'unpublished' });
		const grantId = await seedGrant(db, { requesterId });

		await expect(
			recordRequirements(
				db,
				grantId,
				[{ templateId: draftOnly, disposition: 'required', reason: null }],
				staffId,
				{ locales: LOCALES }
			)
		).rejects.toBeInstanceOf(RequirementNotRenderable);
	});

	it('mints a live grant when every requirement is waived', async () => {
		// Nothing is outstanding, so nothing is waited on. The clock starts now.
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		const requestId = await seedRequest(db, { requesterId });

		const { status, grantId } = await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'approve',
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			reason: null,
			requirements: [{ templateId: acme, disposition: 'waived', reason: 'on paper' }],
			acceptanceDueDays: 14,
			locales: LOCALES,
			acceptanceScope: 'person'
		});

		expect(status).toBe('approved');
		const [row] = await db.select().from(accessGrant).where(eq(accessGrant.id, grantId!));
		expect(row?.expiresAt).not.toBeNull();
		expect(row?.acceptanceDueAt).toBeNull();
	});

	it('mints an inert grant with a deadline when a requirement stands', async () => {
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		const requestId = await seedRequest(db, { requesterId });

		const { grantId } = await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'approve',
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			reason: null,
			requirements: [{ templateId: acme, disposition: 'required', reason: null }],
			acceptanceDueDays: 14,
			locales: LOCALES,
			acceptanceScope: 'person'
		});

		const [row] = await db.select().from(accessGrant).where(eq(accessGrant.id, grantId!));
		expect(row?.expiresAt).toBeNull();
		expect(row?.acceptanceDueAt).not.toBeNull();
		// The frozen set travels with the grant, waivers and all.
		expect(await grantRequirements(db, grantId!)).toHaveLength(1);
	});
});

describe('counting what a grant confers', () => {
	it('counts a grant that touches no agreement without narrowing it', async () => {
		// The aggregate path. A document in two groups, neither carrying an
		// agreement: the left joins multiply the row, so a plain count(*) would
		// report two documents where there is one.
		const documentId = await seedDocument(db, { slug: 'handbook', tier: 'request' });
		const first = await createGroup(db, { slug: 'acme', position: 0, ndaTemplateId: null });
		const second = await createGroup(db, { slug: 'bosch', position: 1, ndaTemplateId: null });
		await setDocumentGroups(db, documentId, [first, second]);

		const requesterId = await seedRequester(db);
		const { grantId } = await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
			acceptanceDueAt: null,
			termDays: 30
		});

		expect(await countGrantDocuments(db, grantId, { locales: LOCALES })).toBe(1);
	});

	it('counts a grant behind an unaccepted agreement as delivering nothing', async () => {
		// The narrowing path, which the aggregate must not short-circuit.
		const { templateId } = await seedAgreement(db, { slug: 'mutual', locales: LOCALES });
		await setDefaultTemplateId(db, templateId);
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'nda' });

		const requesterId = await seedRequester(db);
		const { grantId } = await createGrant(db, {
			requesterId,
			requestId: null,
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
			acceptanceDueAt: null,
			termDays: 30
		});

		expect(await countGrantDocuments(db, grantId, { locales: LOCALES })).toBe(0);
	});
});

describe('activating what an acceptance completes', () => {
	let requesterId: string;
	let templateId: string;
	let versionId: string;
	let bodySha: string;

	beforeEach(async () => {
		requesterId = await seedRequester(db);
		({
			templateId,
			versionId,
			sha256: bodySha
		} = await seedAgreement(db, {
			slug: 'acme',
			locales: LOCALES
		}));
	});

	const accept = () =>
		recordAcceptance(db, {
			requesterId,
			versionId,
			typedName: 'A',
			sha256: bodySha,
			ip: null,
			ua: null,
			locales: LOCALES
		});

	it('activates in one step for a requester who already holds a valid acceptance', async () => {
		// §9.9's return-visit fast path — and it is the ordinary activation call
		// made at approval, not a path of its own.
		await accept();

		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		const requestId = await seedRequest(db, { requesterId });

		const { grantId } = await decideRequest(db, {
			requestId,
			staffUserId: staffId,
			decision: 'approve',
			documentIds: [documentId],
			tiers: [],
			groupIds: [],
			termDays: 30,
			reason: null,
			requirements: [{ templateId, disposition: 'required', reason: null }],
			acceptanceDueDays: 14,
			locales: LOCALES,
			acceptanceScope: 'person'
		});

		const [row] = await db.select().from(accessGrant).where(eq(accessGrant.id, grantId!));
		expect(row?.expiresAt).not.toBeNull();
		expect(row?.acceptanceDueAt).toBeNull();

		const joins = await db
			.select()
			.from(accessGrantAcceptance)
			.where(eq(accessGrantAcceptance.grantId, grantId!));
		expect(joins).toHaveLength(1);
	});

	it('activates every eligible grant of that requester from one acceptance', async () => {
		// A prospect who asked twice before signing once. One acceptance, two
		// grants — which is why activation is a set operation.
		const first = await seedInertGrant(db, { requesterId, requires: [templateId] });
		const second = await seedInertGrant(db, { requesterId, requires: [templateId] });
		await accept();

		const { activated } = await activateGrants(db, requesterId, {
			scope: 'person',
			locales: LOCALES,
			now: new Date()
		});

		expect(activated.sort()).toEqual([first, second].sort());
	});

	it('leaves a grant whose acceptance deadline has passed alone', async () => {
		// The clause that stops an unrelated click-through in September making an
		// approval that lapsed in March live again.
		const lapsed = await seedInertGrant(db, { requesterId, requires: [templateId], dueInDays: -1 });
		await accept();

		const { activated } = await activateGrants(db, requesterId, {
			scope: 'person',
			locales: LOCALES,
			now: new Date()
		});

		expect(activated).toEqual([]);
		const [row] = await db.select().from(accessGrant).where(eq(accessGrant.id, lapsed));
		expect(row?.expiresAt).toBeNull();
	});
});
