import { eq, inArray, or } from 'drizzle-orm';
import { accessGroup, document, documentGroup } from '../db/schema';
import type { Db } from '../db';

/**
 * An `nda`-tier document with no default template configured cannot be
 * proposed or granted: resolution fails closed rather than silently granting an
 * ungated document (§4.4).
 */
export class DefaultTemplateMissing extends Error {}

export interface ScopedDocument {
	id: string;
	tier: string;
	/** Every group this document belongs to, by the agreement that group carries. */
	groupTemplateIds: readonly (string | null)[];
}

/**
 * The union of the groups' agreements **plus** the default where the document
 * sits at the `nda` tier. Union, not an `else` chain — see the tests.
 *
 * Pure, and separate from the query that feeds it, because this is the rule the
 * design argued hardest about and it deserves to be readable without a database.
 */
export function proposeFrom(
	documents: readonly ScopedDocument[],
	options: { defaultTemplateId: string | null }
): string[] {
	const proposed = new Set<string>();

	for (const doc of documents) {
		for (const templateId of doc.groupTemplateIds) {
			if (templateId) proposed.add(templateId);
		}

		if (doc.tier === 'nda') {
			if (!options.defaultTemplateId) {
				throw new DefaultTemplateMissing(
					`document ${doc.id} is at the nda tier and no default agreement is configured`
				);
			}
			proposed.add(options.defaultTemplateId);
		}
	}

	return [...proposed];
}

/**
 * The documents a *proposed* scope currently covers, and the agreements they
 * require. The same three sources `grantCoversDocument` unions — explicit
 * documents, whole tiers, whole groups — but asked of a scope the approver is
 * about to confirm rather than of a stored grant.
 *
 * One query, not one per document: the left join to `document_group` returns a
 * row per (document, group) pair and the rows are folded back into one
 * `ScopedDocument` each.
 *
 * The group predicate is a subquery rather than a condition on the joined row.
 * Filtering the join would keep only the pairs naming a granted group and drop
 * the document's *other* groups, losing exactly the agreements the union
 * exists to collect.
 *
 * Tiers and groups are future-inclusive, so this answers what the scope
 * requires *now* and cannot be the whole story — a document that joins a
 * granted group tomorrow is not here. That is why §7.3 re-checks live at
 * delivery.
 */
export async function proposeRequirements(
	db: Db,
	scope: {
		documentIds: readonly string[];
		tiers: readonly string[];
		groupIds: readonly string[];
	},
	options: { defaultTemplateId: string | null }
): Promise<string[]> {
	const inScope = [
		scope.documentIds.length > 0 ? inArray(document.id, [...scope.documentIds]) : undefined,
		scope.tiers.length > 0 ? inArray(document.tier, [...scope.tiers]) : undefined,
		scope.groupIds.length > 0
			? inArray(
					document.id,
					db
						.select({ documentId: documentGroup.documentId })
						.from(documentGroup)
						.where(inArray(documentGroup.groupId, [...scope.groupIds]))
				)
			: undefined
	].filter((clause) => clause !== undefined);

	// An empty scope covers nothing. Without this guard `or()` collapses to
	// `undefined`, the WHERE clause disappears, and the proposal is taken from
	// the whole catalogue.
	if (inScope.length === 0) return [];

	const rows = await db
		.select({ id: document.id, tier: document.tier, templateId: accessGroup.ndaTemplateId })
		.from(document)
		.leftJoin(documentGroup, eq(documentGroup.documentId, document.id))
		.leftJoin(accessGroup, eq(accessGroup.id, documentGroup.groupId))
		.where(or(...inScope));

	const documents = new Map<
		string,
		{ id: string; tier: string; groupTemplateIds: (string | null)[] }
	>();
	for (const row of rows) {
		const scoped = documents.get(row.id) ?? { id: row.id, tier: row.tier, groupTemplateIds: [] };
		scoped.groupTemplateIds.push(row.templateId);
		documents.set(row.id, scoped);
	}

	return proposeFrom([...documents.values()], options);
}
