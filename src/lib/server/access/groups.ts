import { asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { groupByKey } from '../collections';
import { accessGroup, accessGroupTranslation, documentGroup } from '../db/schema';
import { pgErrorCode } from '../db/errors';
import { ScopeGroupInUse } from './scope';
import type { Db } from '../db';

export interface AdminGroupRow {
	id: string;
	slug: string;
	position: number;
	/** Locale → name. A group with no translation in a locale is shown by slug. */
	names: Record<string, string>;
	documentCount: number;
	/** The agreement this group carries, if any (§4.4 — one of the union's two inputs). */
	ndaTemplateId: string | null;
}

export interface AdminGroupDetail extends AdminGroupRow {
	descriptions: Record<string, string>;
	documentIds: string[];
}

/**
 * The same slug shape every other content type uses. Rejected at the form
 * rather than discovered later, for the reason `RULE_PATTERN` is: a slug that
 * cannot be typed into a URL is a defect at entry, not at read time.
 */
export const groupSchema = z.object({
	slug: z
		.string()
		.trim()
		.min(1)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	position: z.coerce.number().int().min(-10_000).max(10_000),
	// Optional: the create form never sends it, and omitting the key on an
	// update leaves the column untouched rather than clearing it. Only the
	// group's own form sends an explicit value, including `null` to clear it.
	ndaTemplateId: z.string().uuid().nullable().optional()
});

export type GroupInput = z.output<typeof groupSchema>;

/** Ordered the way the admin list and every picker shows them. */
export async function listGroups(db: Db): Promise<AdminGroupRow[]> {
	const rows = await db
		.select()
		.from(accessGroup)
		.orderBy(asc(accessGroup.position), asc(accessGroup.slug));

	if (rows.length === 0) return [];

	const ids = rows.map((row) => row.id);

	const [names, counts] = await Promise.all([
		db.select().from(accessGroupTranslation).where(inArray(accessGroupTranslation.groupId, ids)),
		db
			.select({
				groupId: documentGroup.groupId,
				count: sql<number>`count(*)::int`
			})
			.from(documentGroup)
			.where(inArray(documentGroup.groupId, ids))
			.groupBy(documentGroup.groupId)
	]);

	const countByGroup = new Map(counts.map((row) => [row.groupId, row.count]));
	const namesByGroup = groupByKey(names, (name) => name.groupId);

	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		position: row.position,
		names: Object.fromEntries(
			(namesByGroup.get(row.id) ?? []).map((name) => [name.locale, name.name])
		),
		documentCount: countByGroup.get(row.id) ?? 0,
		ndaTemplateId: row.ndaTemplateId
	}));
}

/**
 * Group id → the name to show in `locale`, falling back to the slug. Every page
 * that renders a grant's scope needs exactly this, and resolving it in each
 * `load` is how two surfaces come to disagree about what a group is called.
 */
export async function groupNames(db: Db, locale: string): Promise<Record<string, string>> {
	const groups = await listGroups(db);
	return Object.fromEntries(groups.map((group) => [group.id, group.names[locale] ?? group.slug]));
}

export async function getGroup(db: Db, id: string): Promise<AdminGroupDetail | null> {
	const [row] = await db.select().from(accessGroup).where(eq(accessGroup.id, id)).limit(1);
	if (!row) return null;

	const [translations, members] = await Promise.all([
		db.select().from(accessGroupTranslation).where(eq(accessGroupTranslation.groupId, id)),
		db.select().from(documentGroup).where(eq(documentGroup.groupId, id))
	]);

	return {
		id: row.id,
		slug: row.slug,
		position: row.position,
		names: Object.fromEntries(translations.map((t) => [t.locale, t.name])),
		ndaTemplateId: row.ndaTemplateId,
		// Only locales that actually have one: an empty description is absence,
		// not an empty string, and the form must not render `""` as content.
		descriptions: Object.fromEntries(
			translations.filter((t) => t.description).map((t) => [t.locale, t.description!])
		),
		documentIds: members.map((member) => member.documentId),
		documentCount: members.length
	};
}

export async function createGroup(db: Db, input: GroupInput): Promise<string> {
	const [row] = await db.insert(accessGroup).values(input).returning({ id: accessGroup.id });
	if (!row) throw new Error('failed to create access group');
	return row.id;
}

export async function updateGroup(db: Db, id: string, input: GroupInput): Promise<void> {
	await db.update(accessGroup).set(input).where(eq(accessGroup.id, id));
}

/**
 * `access_grant_group.group_id` is ON DELETE RESTRICT, so a group a live grant
 * names cannot be removed. The Postgres error code is translated here rather
 * than in the route: which constraint fires is a fact about the tables, and a
 * route that has to know `23503` knows something it has no way to verify.
 *
 * This was written as `cause.code === '23503'` in 3a and was wrong twice over,
 * so deleting a group a live grant named returned a 500 rather than the message
 * the route has been rendering for it all along. Drizzle wraps the driver error,
 * so the code is not where `cause.code` looks for it — hence `pgErrorCode`. And
 * Postgres reports an explicit ON DELETE RESTRICT as 23001, not 23503; 23503 is
 * what NO ACTION raises. Both are the same fact — a row still references this
 * one — so both are matched, and neither reading depends on remembering which
 * clause a future column is declared with.
 */
export async function deleteGroup(db: Db, id: string): Promise<void> {
	try {
		await db.delete(accessGroup).where(eq(accessGroup.id, id));
	} catch (cause) {
		const code = pgErrorCode(cause);
		if (code === '23001' || code === '23503') {
			throw new ScopeGroupInUse('a grant still includes this group', { cause });
		}
		throw cause;
	}
}

export async function setGroupTranslation(
	db: Db,
	id: string,
	locale: string,
	values: { name: string; description: string | null }
): Promise<void> {
	await db
		.insert(accessGroupTranslation)
		.values({ groupId: id, locale, ...values })
		.onConflictDoUpdate({
			target: [accessGroupTranslation.groupId, accessGroupTranslation.locale],
			set: values
		});
}

/** The groups a document belongs to, beside the setter that writes them. */
export async function documentGroupIds(db: Db, documentId: string): Promise<string[]> {
	const rows = await db
		.select({ groupId: documentGroup.groupId })
		.from(documentGroup)
		.where(eq(documentGroup.documentId, documentId));

	return rows.map((row) => row.groupId);
}

/**
 * Membership is replaced wholesale rather than diffed, so removing a document
 * from a group means posting a shorter list. One transaction, because a
 * half-applied replacement would leave a document in neither the old set nor
 * the new one.
 */
export async function setDocumentGroups(
	db: Db,
	documentId: string,
	groupIds: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(documentGroup).where(eq(documentGroup.documentId, documentId));

		const unique = [...new Set(groupIds)];
		if (unique.length === 0) return;

		await tx.insert(documentGroup).values(unique.map((groupId) => ({ documentId, groupId })));
	});
}
