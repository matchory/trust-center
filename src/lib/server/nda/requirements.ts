import { asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { accessGrantNda, accessGroup, document, documentGroup } from '../db/schema';
import { effectiveVersion } from './templates';
import type { NdaDisposition } from '../../nda-types';
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

	return proposeFrom(await scopedDocuments(db, or(...inScope)!), options);
}

/**
 * The documents a predicate selects, each folded together with the agreements
 * its groups carry — the shape `proposeFrom` reads.
 *
 * Shared because "which agreements does a document's groups carry" is asked
 * from two directions: of a scope an approver is about to confirm, and of the
 * documents a grant already confers (§7.3's delivery re-check). The rule was
 * already named once in `proposeFrom`; this is the read that feeds it, named
 * once for the same reason.
 *
 * The left joins return a row per (document, group) pair, and the rows fold
 * back into one `ScopedDocument` each.
 */
async function scopedDocuments(db: Db, where: SQL): Promise<ScopedDocument[]> {
	const rows = await db
		.select({ id: document.id, tier: document.tier, templateId: accessGroup.ndaTemplateId })
		.from(document)
		.leftJoin(documentGroup, eq(documentGroup.documentId, document.id))
		.leftJoin(accessGroup, eq(accessGroup.id, documentGroup.groupId))
		.where(where);

	const documents = new Map<
		string,
		{ id: string; tier: string; groupTemplateIds: (string | null)[] }
	>();
	for (const row of rows) {
		const scoped = documents.get(row.id) ?? { id: row.id, tier: row.tier, groupTemplateIds: [] };
		scoped.groupTemplateIds.push(row.templateId);
		documents.set(row.id, scoped);
	}

	return [...documents.values()];
}

/**
 * What each of these documents requires *right now*, asked per document rather
 * than as a union — §7.3's delivery check answers one document at a time, and a
 * union would take one gated document and close the rest.
 *
 * A document at the `nda` tier with no default agreement configured cannot be
 * resolved at all, and lands in `unresolvable` rather than throwing: §4.4 fails
 * closed, and at delivery that means undeliverable rather than ungated.
 */
export async function requirementsByDocument(
	db: Db,
	documentIds: readonly string[],
	options: { defaultTemplateId: string | null }
): Promise<{ required: Map<string, string[]>; unresolvable: Set<string> }> {
	const required = new Map<string, string[]>();
	const unresolvable = new Set<string>();

	if (documentIds.length === 0) return { required, unresolvable };

	for (const scoped of await scopedDocuments(db, inArray(document.id, [...documentIds]))) {
		try {
			required.set(scoped.id, proposeFrom([scoped], options));
		} catch (cause) {
			if (!(cause instanceof DefaultTemplateMissing)) throw cause;
			unresolvable.add(scoped.id);
		}
	}

	return { required, unresolvable };
}

/**
 * Raised when an approver requires an agreement nobody could be shown: the
 * template has no currently-effective, locale-complete version (§5.2).
 */
export class RequirementNotRenderable extends Error {}

/** One line of the approver's confirmed set. */
export interface RequirementChoice {
	templateId: string;
	disposition: NdaDisposition;
	reason: string | null;
}

export interface RequirementRow extends RequirementChoice {
	grantId: string;
	ndaTemplateId: string;
	decidedByStaffId: string | null;
}

/**
 * Freeze the approver's confirmed set onto the grant (P3.9). What is stored is
 * what they confirmed — waivers included, as rows — because §7.3 re-derives
 * what a document requires at delivery, and a requirement omitted here would be
 * silently re-imposed there.
 *
 * A `required` entry whose template has no renderable version is refused, so
 * the failure lands at the decision, where a person is present, rather than at
 * the click-through, where one is not and the requester's deadline is already
 * running. A `waived` entry is not checked: nobody will be shown it.
 *
 * `locales` is an argument rather than a `getConfig()` call, as everything
 * below the route layer is.
 */
export async function recordRequirements(
	db: Db,
	grantId: string,
	choices: readonly RequirementChoice[],
	staffUserId: string,
	options: { locales: readonly string[] }
): Promise<void> {
	// Checked before the transaction opens rather than inside it: the check is a
	// read per template and refusing early keeps a doomed decision from holding
	// write locks on the grant.
	for (const choice of choices) {
		if (choice.disposition !== 'required') continue;
		if (await effectiveVersion(db, choice.templateId, options.locales)) continue;

		throw new RequirementNotRenderable(
			`agreement ${choice.templateId} has no effective version in every enabled locale`
		);
	}

	// Replaced wholesale rather than diffed, in one transaction, for the reason
	// the scope setters are: a half-applied set is neither what it was nor what
	// the approver confirmed.
	await db.transaction(async (tx) => {
		await tx.delete(accessGrantNda).where(eq(accessGrantNda.grantId, grantId));
		if (choices.length === 0) return;

		const byTemplate = new Map(choices.map((choice) => [choice.templateId, choice]));
		await tx.insert(accessGrantNda).values(
			[...byTemplate.values()].map((choice) => ({
				grantId,
				ndaTemplateId: choice.templateId,
				disposition: choice.disposition,
				decidedByStaffId: staffUserId,
				reason: choice.reason
			}))
		);
	});
}

/** The frozen set, as the approver left it. */
export async function grantRequirements(db: Db, grantId: string): Promise<RequirementRow[]> {
	const rows = await db
		.select()
		.from(accessGrantNda)
		.where(eq(accessGrantNda.grantId, grantId))
		.orderBy(asc(accessGrantNda.ndaTemplateId));

	return rows.map((row) => ({
		...row,
		templateId: row.ndaTemplateId,
		disposition: row.disposition as NdaDisposition
	}));
}
