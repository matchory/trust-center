import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { MarkdownNotInSubset } from '../../src/lib/markdown/subset';
import { ndaTemplate, ndaTemplateVersion } from '../../src/lib/server/db/schema';
import {
	createTemplate,
	createVersion,
	effectiveVersion,
	listTemplates,
	publishVersion,
	setTemplateTranslation,
	setVersionBody,
	VersionImmutable,
	VersionIncomplete
} from '../../src/lib/server/nda/templates';
import type { Db } from '../../src/lib/server/db';

const LOCALES = ['de', 'en'];

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});

// Children before parents: nda_template_version references nda_template with
// RESTRICT, so this order is load-bearing rather than cosmetic. A file that
// leaves a version behind breaks whichever file next tries to clear templates.
afterAll(async () => {
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
	await close();
});

beforeEach(async () => {
	await db.delete(ndaTemplateVersion);
	await db.delete(ndaTemplate);
});

describe('nda templates', () => {
	it('numbers versions from one, per template', async () => {
		const a = await createTemplate(db, { slug: 'mutual' });
		const b = await createTemplate(db, { slug: 'reseller' });

		expect((await createVersion(db, a)).version).toBe(1);
		expect((await createVersion(db, a)).version).toBe(2);
		expect((await createVersion(db, b)).version).toBe(1);
	});

	it('refuses to publish a version with a locale missing', async () => {
		const templateId = await createTemplate(db, { slug: 'mutual' });
		const { versionId } = await createVersion(db, templateId);
		await setVersionBody(db, versionId, 'de', '# Vertrag');

		await expect(publishVersion(db, versionId, LOCALES)).rejects.toBeInstanceOf(VersionIncomplete);
	});

	it('publishes when every enabled locale has a body', async () => {
		const templateId = await createTemplate(db, { slug: 'mutual' });
		const { versionId } = await createVersion(db, templateId);
		await setVersionBody(db, versionId, 'de', '# Vertrag');
		await setVersionBody(db, versionId, 'en', '# Agreement');

		await publishVersion(db, versionId, LOCALES);

		const effective = await effectiveVersion(db, templateId, LOCALES);
		expect(effective?.versionId).toBe(versionId);
		expect(effective?.bodies.en?.bodyMd).toBe('# Agreement');
	});

	it('refuses a body outside the subset', async () => {
		const templateId = await createTemplate(db, { slug: 'mutual' });
		const { versionId } = await createVersion(db, templateId);

		await expect(setVersionBody(db, versionId, 'de', '<script>x</script>')).rejects.toBeInstanceOf(
			MarkdownNotInSubset
		);
	});

	it('refuses to edit a body once the version has been accepted', async () => {
		const templateId = await createTemplate(db, { slug: 'mutual' });
		const { versionId } = await createVersion(db, templateId);
		await setVersionBody(db, versionId, 'de', '# Vertrag');
		await db
			.update(ndaTemplateVersion)
			.set({ firstAcceptedAt: new Date() })
			.where(eq(ndaTemplateVersion.id, versionId));

		await expect(setVersionBody(db, versionId, 'de', '# Anders')).rejects.toBeInstanceOf(
			VersionImmutable
		);
	});

	it('records a stable hash of the exact stored bytes', async () => {
		const templateId = await createTemplate(db, { slug: 'mutual' });
		const { versionId } = await createVersion(db, templateId);

		const first = await setVersionBody(db, versionId, 'de', '# Vertrag');
		const again = await setVersionBody(db, versionId, 'de', '# Vertrag');
		const other = await setVersionBody(db, versionId, 'en', '# Agreement');

		expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(again.sha256).toBe(first.sha256);
		expect(other.sha256).not.toBe(first.sha256);
	});

	it('ignores a draft and a retired version when resolving the effective one', async () => {
		const templateId = await createTemplate(db, { slug: 'mutual' });

		const one = await createVersion(db, templateId);
		await setVersionBody(db, one.versionId, 'de', '# Eins');
		await setVersionBody(db, one.versionId, 'en', '# One');
		await publishVersion(db, one.versionId, LOCALES);

		const two = await createVersion(db, templateId);
		await setVersionBody(db, two.versionId, 'de', '# Zwei');
		await setVersionBody(db, two.versionId, 'en', '# Two');
		await publishVersion(db, two.versionId, LOCALES);

		expect((await effectiveVersion(db, templateId, LOCALES))?.versionId).toBe(two.versionId);

		await db
			.update(ndaTemplateVersion)
			.set({ retiredAt: new Date() })
			.where(eq(ndaTemplateVersion.id, two.versionId));

		// Falls back to the newest still-effective version, not to nothing.
		expect((await effectiveVersion(db, templateId, LOCALES))?.versionId).toBe(one.versionId);
	});

	it('has no effective version while every version is a draft', async () => {
		const templateId = await createTemplate(db, { slug: 'mutual' });
		await setTemplateTranslation(db, templateId, 'en', { name: 'Mutual NDA', description: null });
		await createVersion(db, templateId);

		expect(await effectiveVersion(db, templateId, LOCALES)).toBeNull();
	});

	it('reports which locale blocks an otherwise-published version', async () => {
		// §5.2's second control. Without this the admin list says "version 1
		// effective" while the click-through refuses to render it, and the only
		// place the mismatch surfaces is a requester's dead end.
		const templateId = await createTemplate(db, { slug: 'mutual' });
		const { versionId } = await createVersion(db, templateId);
		await setVersionBody(db, versionId, 'de', '# Vertrag');
		await setVersionBody(db, versionId, 'en', '# Agreement');
		await publishVersion(db, versionId, LOCALES);

		const [row] = await listTemplates(db, ['de', 'en', 'fr']);
		expect(row?.effectiveVersionNumber).toBeNull();
		expect(row?.blockedLocales).toEqual(['fr']);
	});

	it('re-checks locale completeness at read time, so adding a locale unpublishes nothing silently', async () => {
		const templateId = await createTemplate(db, { slug: 'mutual' });
		const { versionId } = await createVersion(db, templateId);
		await setVersionBody(db, versionId, 'de', '# Vertrag');
		await setVersionBody(db, versionId, 'en', '# Agreement');
		await publishVersion(db, versionId, LOCALES);

		// A deployment that later enables `fr` has no French body for this
		// version. §5.2 requires the refusal to be visible rather than leaving a
		// requester on an "unavailable" page while their deadline ticks down.
		expect(await effectiveVersion(db, templateId, ['de', 'en', 'fr'])).toBeNull();
	});
});
