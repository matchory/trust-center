import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { setting } from '../db/schema';
import type { Db } from '../db';
import { ACCEPTANCE_SCOPES } from '../../nda-types';
import type { AcceptanceScope } from '../../nda-types';

// Re-exported so server modules read unchanged, exactly as
// `server/access/scope.ts` reads `SCOPE_TIERS` from `access-types.ts`.
export { ACCEPTANCE_SCOPES };
export type { AcceptanceScope };

export const DEFAULT_TEMPLATE_SETTING_KEY = 'nda.default_template_id';
export const ACCEPTANCE_SCOPE_SETTING_KEY = 'nda.acceptance_scope';
export const ACCEPTANCE_DUE_DAYS_SETTING_KEY = 'nda.acceptance_due_days';

const templateIdSchema = z.string().uuid().nullable();
const acceptanceScopeSchema = z.enum(ACCEPTANCE_SCOPES);
const acceptanceDueDaysSchema = z.number().int().positive().max(3650);

/**
 * Which template covers the `nda` tier when nobody names one. `null` is a
 * valid, correct configuration — it is the state a fresh deployment is in —
 * so unlike `acceptanceDueDays` this has no caller-supplied fallback: `null`
 * *is* the default.
 *
 * A stored value that fails validation falls back to `null` rather than
 * throwing, for the same reason `defaultGrantDays` does: it is reachable only
 * by editing the table by hand, and a malformed value must not take the
 * decision page down with it.
 */
export async function defaultTemplateId(db: Db): Promise<string | null> {
	const [row] = await db
		.select()
		.from(setting)
		.where(eq(setting.key, DEFAULT_TEMPLATE_SETTING_KEY))
		.limit(1);

	const parsed = templateIdSchema.safeParse(row?.value);
	return parsed.success ? parsed.data : null;
}

/**
 * `id: null` deletes the row rather than storing a JSON `null`: drizzle maps a
 * JS `null` parameter to SQL NULL regardless of column type (`sql.ts`'s
 * `chunk.value === null ? null : ...`), which the `setting.value` NOT NULL
 * column then rejects. Deleting also matches the getter, which already reads
 * "no row" as "no default" — the state a fresh deployment is in.
 */
export async function setDefaultTemplateId(db: Db, id: string | null): Promise<void> {
	const value = templateIdSchema.parse(id);

	if (value === null) {
		await db.delete(setting).where(eq(setting.key, DEFAULT_TEMPLATE_SETTING_KEY));
		return;
	}

	await db
		.insert(setting)
		.values({ key: DEFAULT_TEMPLATE_SETTING_KEY, value })
		.onConflictDoUpdate({
			target: setting.key,
			set: { value, updatedAt: new Date() }
		});
}

/**
 * Whether an acceptance is valid per person or per company domain (§6.3).
 * `person` is the literal default — the safe one, where every signature names
 * somebody — so this takes no caller-supplied fallback either.
 *
 * A stored value that fails validation falls back to `person` rather than
 * throwing, for the same reason `defaultGrantDays` does.
 */
export async function acceptanceScope(db: Db): Promise<AcceptanceScope> {
	const [row] = await db
		.select()
		.from(setting)
		.where(eq(setting.key, ACCEPTANCE_SCOPE_SETTING_KEY))
		.limit(1);

	const parsed = acceptanceScopeSchema.safeParse(row?.value);
	return parsed.success ? parsed.data : 'person';
}

export async function setAcceptanceScope(db: Db, scope: AcceptanceScope): Promise<void> {
	const value = acceptanceScopeSchema.parse(scope);
	await db
		.insert(setting)
		.values({ key: ACCEPTANCE_SCOPE_SETTING_KEY, value })
		.onConflictDoUpdate({
			target: setting.key,
			set: { value, updatedAt: new Date() }
		});
}

/**
 * How many days a requester has to accept before an approval lapses (§7.4).
 *
 * `fallback` is an argument rather than a `getConfig()` call, for the same
 * reason `defaultGrantDays` takes one: a module that needs a fully configured
 * environment to answer a question about a row is untestable, and the route
 * already owns the lookup.
 *
 * A stored value that fails validation falls back rather than throwing, for
 * the same reason `defaultGrantDays` does.
 */
export async function acceptanceDueDays(db: Db, fallback: number): Promise<number> {
	const [row] = await db
		.select()
		.from(setting)
		.where(eq(setting.key, ACCEPTANCE_DUE_DAYS_SETTING_KEY))
		.limit(1);

	const parsed = acceptanceDueDaysSchema.safeParse(row?.value);
	return parsed.success ? parsed.data : fallback;
}

export async function setAcceptanceDueDays(db: Db, days: number): Promise<void> {
	const value = acceptanceDueDaysSchema.parse(days);
	await db
		.insert(setting)
		.values({ key: ACCEPTANCE_DUE_DAYS_SETTING_KEY, value })
		.onConflictDoUpdate({
			target: setting.key,
			set: { value, updatedAt: new Date() }
		});
}
