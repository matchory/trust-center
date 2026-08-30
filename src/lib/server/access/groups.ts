import { asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accessGroup, accessGroupTranslation, documentGroup } from '../db/schema';
import { ScopeGroupInUse } from './scope';
import type { Db } from '../db';

export interface AdminGroupRow {
	id: string;
	slug: string;
	position: number;
	/** Locale → name. A group with no translation in a locale is shown by slug. */
	names: Record<string, string>;
	documentCount: number;
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
	position: z.coerce.number().int().min(-10_000).max(10_000)
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

	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		position: row.position,
		names: Object.fromEntries(
			names.filter((name) => name.groupId === row.id).map((name) => [name.locale, name.name])
		),
		documentCount: countByGroup.get(row.id) ?? 0
	}));
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
 */
export async function deleteGroup(db: Db, id: string): Promise<void> {
	try {
		await db.delete(accessGroup).where(eq(accessGroup.id, id));
	} catch (cause) {
		if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23503') {
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
