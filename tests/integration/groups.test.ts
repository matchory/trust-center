import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	accessGrant,
	accessGroup,
	document,
	documentCategory,
	ndaTemplate,
	ndaTemplateVersion
} from '../../src/lib/server/db/schema';
import {
	createGroup,
	deleteGroup,
	getGroup,
	listGroups,
	setDocumentGroups,
	setGroupTranslation,
	updateGroup
} from '../../src/lib/server/access/groups';
import { createTemplate } from '../../src/lib/server/nda/templates';
import { seedDocument } from '../setup/fixtures';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

// Groups before templates: access_group.nda_template_id is ON DELETE RESTRICT,
// so a group naming a template holds it against deletion the same way a grant
// holds a group. A file that leaves a group naming a template breaks whichever
// file next tries to clear templates — nda-templates.test.ts runs right after
// this one alphabetically and does exactly that in its own beforeEach.
afterAll(async () => {
	await db.delete(accessGroup);
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await close();
});

describe('access groups', () => {
	beforeEach(async () => {
		await db.delete(document);
		await db.delete(documentCategory);
		// Before the groups: a grant naming one holds it against deletion, and
		// this file's whole premise is that no group exists when a case starts.
		await db.delete(accessGrant);
		await db.delete(accessGroup);
		await db.delete(ndaTemplateVersion);
		await db.delete(ndaTemplate);
	});

	it('creates a group and lists it with a zero document count', async () => {
		const id = await createGroup(db, { slug: 'customer-pack', position: 10 });

		const rows = await listGroups(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id, slug: 'customer-pack', position: 10 });
		expect(rows[0]?.documentCount).toBe(0);
	});

	it('stores one name and description per locale', async () => {
		const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
		await setGroupTranslation(db, id, 'en', {
			name: 'Customer pack',
			description: 'For customers'
		});
		await setGroupTranslation(db, id, 'de', { name: 'Kundenpaket', description: null });

		const detail = await getGroup(db, id);
		expect(detail?.names).toEqual({ en: 'Customer pack', de: 'Kundenpaket' });
		expect(detail?.descriptions).toEqual({ en: 'For customers' });
	});

	it('replaces a translation rather than duplicating it', async () => {
		const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
		await setGroupTranslation(db, id, 'en', { name: 'First', description: null });
		await setGroupTranslation(db, id, 'en', { name: 'Second', description: null });

		const detail = await getGroup(db, id);
		expect(detail?.names).toEqual({ en: 'Second' });
	});

	it('replaces membership wholesale, so removing means posting a shorter list', async () => {
		const groupA = await createGroup(db, { slug: 'a', position: 0 });
		const groupB = await createGroup(db, { slug: 'b', position: 1 });
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });

		await setDocumentGroups(db, documentId, [groupA, groupB]);
		expect((await getGroup(db, groupA))?.documentIds).toEqual([documentId]);
		expect((await getGroup(db, groupB))?.documentIds).toEqual([documentId]);

		await setDocumentGroups(db, documentId, [groupB]);
		expect((await getGroup(db, groupA))?.documentIds).toEqual([]);
		expect((await getGroup(db, groupB))?.documentIds).toEqual([documentId]);
	});

	it('counts members per group in the list', async () => {
		const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
		const first = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		const second = await seedDocument(db, { slug: 'pentest', tier: 'request' });
		await setDocumentGroups(db, first, [id]);
		await setDocumentGroups(db, second, [id]);

		const rows = await listGroups(db);
		expect(rows[0]?.documentCount).toBe(2);
	});

	it('drops membership and translations when the group is deleted', async () => {
		const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		await setGroupTranslation(db, id, 'en', { name: 'Customer pack', description: null });
		await setDocumentGroups(db, documentId, [id]);

		await deleteGroup(db, id);

		expect(await getGroup(db, id)).toBeNull();
		expect(await listGroups(db)).toEqual([]);
	});

	it('keeps the document when a group it belongs to is deleted', async () => {
		const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		await setDocumentGroups(db, documentId, [id]);

		await deleteGroup(db, id);

		// The cascade runs from the group to the membership row, never onward
		// to the document. A group is an organisational convenience; deleting
		// one must not delete published content.
		const rows = await db.query.document.findMany();
		expect(rows.map((row) => row.id)).toContain(documentId);
	});

	it('orders by position, then slug', async () => {
		await createGroup(db, { slug: 'zulu', position: 0 });
		await createGroup(db, { slug: 'alpha', position: 0 });
		await createGroup(db, { slug: 'first', position: -1 });

		const rows = await listGroups(db);
		expect(rows.map((row) => row.slug)).toEqual(['first', 'alpha', 'zulu']);
	});

	it('renames a group without disturbing its membership', async () => {
		const id = await createGroup(db, { slug: 'old', position: 0 });
		const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
		await setDocumentGroups(db, documentId, [id]);

		await updateGroup(db, id, { slug: 'new', position: 5 });

		const detail = await getGroup(db, id);
		expect(detail?.slug).toBe('new');
		expect(detail?.position).toBe(5);
		expect(detail?.documentIds).toEqual([documentId]);
	});

	it('refuses to delete a template a group still names', async () => {
		const templateId = await createTemplate(db, { slug: 'partner' });
		const groupId = await createGroup(db, { slug: 'partners', position: 0 });
		await updateGroup(db, groupId, { slug: 'partners', position: 0, ndaTemplateId: templateId });

		// The same shape as ScopeGroupInUse: the database refuses, and the operator
		// retires rather than deletes. drizzle wraps the driver error under
		// `.cause` here (`error.message` itself is just "Failed query: ..."), and
		// Postgres's own wording for a RESTRICT-blocked delete is "violates
		// RESTRICT setting of foreign key constraint" rather than the plainer
		// "violates foreign key constraint" an INSERT-side violation produces.
		await expect(
			db.delete(ndaTemplate).where(eq(ndaTemplate.id, templateId))
		).rejects.toMatchObject({
			cause: { message: expect.stringContaining('foreign key constraint') }
		});
	});

	it('carries the chosen agreement back out of the group', async () => {
		const templateId = await createTemplate(db, { slug: 'reseller' });
		const groupId = await createGroup(db, { slug: 'resellers', position: 0 });
		await updateGroup(db, groupId, { slug: 'resellers', position: 0, ndaTemplateId: templateId });

		expect((await getGroup(db, groupId))?.ndaTemplateId).toBe(templateId);
	});

	it('lets an operator clear the agreement again', async () => {
		const templateId = await createTemplate(db, { slug: 'temporary' });
		const groupId = await createGroup(db, { slug: 'temp', position: 0 });
		await updateGroup(db, groupId, { slug: 'temp', position: 0, ndaTemplateId: templateId });
		await updateGroup(db, groupId, { slug: 'temp', position: 0, ndaTemplateId: null });

		expect((await getGroup(db, groupId))?.ndaTemplateId).toBeNull();
	});
});
