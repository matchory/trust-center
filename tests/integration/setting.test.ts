import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '../../src/lib/server/db';
import { ndaTemplate, setting } from '../../src/lib/server/db/schema';
import { createTemplate } from '../../src/lib/server/nda/templates';
import {
	ACCEPTANCE_SCOPE_SETTING_KEY,
	acceptanceDueDays,
	acceptanceScope,
	defaultTemplateId,
	setAcceptanceDueDays,
	setAcceptanceScope,
	setDefaultTemplateId
} from '../../src/lib/server/nda/settings';

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

// Half the cases here assert on the *absence* of a key — the state a fresh
// deployment is in — and `setting` is a single global table with no per-test
// axis to scope by. `nda-grants.test.ts` leaves `nda.default_template_id`
// behind, and Vitest's sequencer does not order files alphabetically, so
// whether that row is present when this file runs is a property of file
// ordering rather than of anything this file does. That is the whole of the
// intermittency: run after nda-grants and "has no default template" fails;
// run before it, or behind a file that clears the table, and it passes.
// Establish the precondition instead of inheriting it, the same clean slate
// subscription-notify.test.ts takes for the same reason.
beforeEach(async () => {
	await db.delete(schema.setting);
});

describe('setting table', () => {
	it('round-trips a jsonb value', async () => {
		await db.insert(schema.setting).values({ key: 'branding', value: { primary: '#0b3d2e' } });

		const rows = await db.select().from(schema.setting).where(eq(schema.setting.key, 'branding'));

		expect(rows).toHaveLength(1);
		expect(rows[0]?.value).toEqual({ primary: '#0b3d2e' });
	});

	it('rejects a duplicate key', async () => {
		await db.insert(schema.setting).values({ key: 'locales', value: ['de', 'en'] });

		await expect(
			db.insert(schema.setting).values({ key: 'locales', value: ['fr'] })
		).rejects.toThrow();
	});
});

describe('nda settings', () => {
	it('defaults the acceptance scope to person', async () => {
		expect(await acceptanceScope(db)).toBe('person');
	});

	it('round-trips an operator-chosen scope', async () => {
		await setAcceptanceScope(db, 'domain');
		expect(await acceptanceScope(db)).toBe('domain');
	});

	it('falls back rather than throwing on a malformed stored value', async () => {
		// Reachable only by editing the table by hand, and a malformed value must
		// not take the decision page down with it — the same rule defaultGrantDays
		// already follows.
		await db
			.insert(setting)
			.values({ key: ACCEPTANCE_SCOPE_SETTING_KEY, value: 'everyone' })
			.onConflictDoUpdate({ target: setting.key, set: { value: 'everyone' } });

		expect(await acceptanceScope(db)).toBe('person');
	});

	it('has no default template until an operator picks one', async () => {
		expect(await defaultTemplateId(db)).toBeNull();
	});

	it('round-trips a chosen default template, and clears it back to none', async () => {
		// `null` deletes the row rather than storing a JSON null: drizzle maps a JS
		// `null` parameter to SQL NULL for any column type, which the `value` NOT
		// NULL column rejects. Regression coverage for that, not in the brief.
		const templateId = await createTemplate(db, { slug: 'settings-default-template' });

		try {
			await setDefaultTemplateId(db, templateId);
			expect(await defaultTemplateId(db)).toBe(templateId);

			await setDefaultTemplateId(db, null);
			expect(await defaultTemplateId(db)).toBeNull();
		} finally {
			await db.delete(ndaTemplate).where(eq(ndaTemplate.id, templateId));
		}
	});

	it('round-trips the acceptance window in days', async () => {
		await setAcceptanceDueDays(db, 21);
		expect(await acceptanceDueDays(db, 14)).toBe(21);
	});
});
