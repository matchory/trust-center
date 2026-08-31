import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	accessGrant,
	accessGrantDocument,
	accessGrantGroup,
	accessGrantNda,
	accessGrantTier,
	document,
	documentGroup,
	requester,
	setting
} from '../db/schema';
import { groupByKey } from '../collections';
import { validAcceptance } from '../nda/acceptance';
import { requirementsByDocument } from '../nda/requirements';
import { acceptanceScope, defaultTemplateId } from '../nda/settings';
import { PHASE_TIERS, setGrantGroups, setGrantTiers } from './scope';
import type { ScopeTier } from '../../access-types';
import type { GrantState } from '../../nda-types';
import type { Db } from '../db';

/**
 * `locales` decides which version of an agreement is the effective one, and so
 * whether an acceptance of it is still valid (§6.2). An argument rather than a
 * `getConfig()` call, as everything below the route layer is.
 */
export interface DeliveryOptions {
	locales: readonly string[];
}

export type { GrantState };

/**
 * `expiresAt` is required rather than defaulted from config, for the same
 * reason `drainOutbox` takes its settings as arguments: a module that calls
 * `getConfig()` cannot run without a fully configured environment, which makes
 * it untestable and tells it more than it needs to know. The caller owns the
 * lookup.
 *
 * A null `expiresAt` mints an **inert** grant — one waiting on an acceptance —
 * and then `acceptanceDueAt` must say when that wait ends; the pairing is
 * `access_grant_inert_check`. Both are stated by the caller rather than
 * inferred here: which one applies follows from the requirements the approver
 * confirmed, and inferring it would re-derive their decision from this
 * function's own arguments.
 */
export async function createGrant(
	db: Db,
	input: {
		requesterId: string;
		requestId: string | null;
		documentIds: readonly string[];
		tiers: readonly ScopeTier[];
		groupIds: readonly string[];
		expiresAt: Date | null;
		acceptanceDueAt: Date | null;
		termDays: number;
	}
): Promise<{ grantId: string; expiresAt: Date | null }> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(accessGrant)
			.values({
				requesterId: input.requesterId,
				requestId: input.requestId,
				termDays: input.termDays,
				expiresAt: input.expiresAt,
				acceptanceDueAt: input.acceptanceDueAt
			})
			.returning({ id: accessGrant.id });

		if (!row) throw new Error('failed to create grant');

		if (input.documentIds.length > 0) {
			await tx
				.insert(accessGrantDocument)
				.values(
					[...new Set(input.documentIds)].map((documentId) => ({ grantId: row.id, documentId }))
				);
		}

		await setGrantTiers(tx, row.id, input.tiers);
		await setGrantGroups(tx, row.id, input.groupIds);

		return { grantId: row.id, expiresAt: input.expiresAt };
	});
}

/**
 * Whether a grant row covers a document row. Named once because it is the
 * definition of scope: three parallel sources, none implying any other. An
 * explicit document, a whole tier, or a whole group — the latter two both
 * meaning "including documents that join later".
 */
function grantCoversDocument() {
	return or(
		sql`EXISTS (
			SELECT 1 FROM ${accessGrantDocument}
			WHERE ${accessGrantDocument.grantId} = ${accessGrant.id}
			  AND ${accessGrantDocument.documentId} = ${document.id}
		)`,
		sql`EXISTS (
			SELECT 1 FROM ${accessGrantTier}
			WHERE ${accessGrantTier.grantId} = ${accessGrant.id}
			  AND ${accessGrantTier.tier} = ${document.tier}
		)`,
		sql`EXISTS (
			SELECT 1 FROM ${accessGrantGroup}
			JOIN ${documentGroup}
			  ON ${documentGroup.groupId} = ${accessGrantGroup.groupId}
			WHERE ${accessGrantGroup.grantId} = ${accessGrant.id}
			  AND ${documentGroup.documentId} = ${document.id}
		)`
	)!;
}

/**
 * Whether a grant confers a document *right now*: it covers it, the grant is
 * live, and the document is one this phase will hand over. Every caller adds
 * only which grants it is asking about.
 *
 * This is the whole definition, named once. Splitting it — coverage here,
 * liveness pasted into each caller — is what let `countGrantDocuments` ship
 * without the expiry and revocation predicates: it was safe only because its
 * single caller pre-filtered.
 *
 * The tier and status filters are applied here rather than at grant time on
 * purpose. A document unpublished, or moved out of a granted tier, must stop
 * being downloadable immediately, without anybody revisiting existing grants.
 */
function grantConfersDocument() {
	return and(
		isNull(accessGrant.revokedAt),
		gt(accessGrant.expiresAt, sql`now()`),
		eq(document.status, 'published'),
		inArray(document.tier, [...PHASE_TIERS]),
		grantCoversDocument()
	)!;
}

/** One (grant, document) pair the scope query conferred, before the live re-check. */
interface ConferredRow {
	grantId: string;
	requesterId: string;
	documentId: string;
	expiresAt: Date | null;
}

/**
 * §7.3's second layer. A document is deliverable only if every agreement it
 * *currently* requires is either waived on that grant or satisfied by a valid
 * acceptance.
 *
 * **This may only remove rows, never add one.** It is a filter over what the
 * scope query already conferred, which is what makes live evaluation consistent
 * with the domain-drift rule: that rule forbids recomputation which *widens* a
 * past decision, and narrowing-only is already the established pattern — it is
 * exactly what the tier filter in `grantConfersDocument` does. The invariant is
 * a test in `nda-delivery.test.ts`.
 *
 * The requirement lookup is one query over the conferred documents, and in the
 * overwhelmingly common case — no document in the set carries an agreement — it
 * is the only extra work a download pays for. Only when something is actually
 * required does this go on to read waivers and acceptances.
 *
 * "Currently requires" is `proposeFrom`, the same rule the approver's proposal
 * used, rather than a second expression of it here; "a valid acceptance" is
 * `validAcceptance`, which owns the person-versus-domain scope and the
 * `auto_approve` bound §6.3 needs. Restating either one in SQL would be a
 * second implementation of a rule that gates access, and the two would drift.
 */
async function narrowByAgreements(
	db: Db,
	rows: readonly ConferredRow[],
	options: DeliveryOptions
): Promise<ConferredRow[]> {
	if (rows.length === 0) return [];

	// These four are independent of each other, and this is the gated download
	// path — they go together rather than one round trip at a time.
	const [defaultTemplate, waivers, scope, people] = await Promise.all([
		defaultTemplateId(db),
		db
			.select({ grantId: accessGrantNda.grantId, templateId: accessGrantNda.ndaTemplateId })
			.from(accessGrantNda)
			.where(
				and(
					inArray(
						accessGrantNda.grantId,
						rows.map((row) => row.grantId)
					),
					eq(accessGrantNda.disposition, 'waived')
				)
			),
		acceptanceScope(db),
		db
			.select({ id: requester.id, companyDomain: requester.companyDomain })
			.from(requester)
			.where(inArray(requester.id, [...new Set(rows.map((row) => row.requesterId))]))
	]);

	const { required, unresolvable } = await requirementsByDocument(
		db,
		[...new Set(rows.map((row) => row.documentId))],
		{ defaultTemplateId: defaultTemplate }
	);

	// Nothing carries an agreement — the state every deployment is in until an
	// operator sets one up, and every row passes untouched.
	if (unresolvable.size === 0 && [...required.values()].every((list) => list.length === 0)) {
		return [...rows];
	}

	// One flat set rather than a map of sets: the question asked below is always
	// about a (grant, template) pair, never about a grant's waivers as a group.
	const waived = new Set(waivers.map((row) => `${row.grantId}:${row.templateId}`));
	const domains = new Map(people.map((row) => [row.id, row.companyDomain]));

	// One lookup per (person, agreement), not per row: a requester's grants
	// routinely confer many documents behind the same agreement.
	const held = new Map<string, boolean>();
	const holds = async (requesterId: string, templateId: string): Promise<boolean> => {
		const cacheKey = `${requesterId}:${templateId}`;
		const cached = held.get(cacheKey);
		if (cached !== undefined) return cached;

		const companyDomain = domains.get(requesterId);
		const valid =
			companyDomain !== undefined &&
			(await validAcceptance(db, {
				requesterId,
				companyDomain,
				templateId,
				scope,
				locales: options.locales
			})) !== null;

		held.set(cacheKey, valid);
		return valid;
	};

	const delivered: ConferredRow[] = [];

	for (const row of rows) {
		if (unresolvable.has(row.documentId)) continue;

		let satisfied = true;
		for (const templateId of required.get(row.documentId) ?? []) {
			if (waived.has(`${row.grantId}:${templateId}`)) continue;
			if (await holds(row.requesterId, templateId)) continue;
			satisfied = false;
			break;
		}

		if (satisfied) delivered.push(row);
	}

	return delivered;
}

/**
 * How many documents one grant covers right now. Used by the expiry reminder,
 * which speaks about a single grant's scope — a requester holding two grants
 * must not be told the wrong number about the one that is ending — and by the
 * approval mail, which tells a requester what they just received.
 */
export async function countGrantDocuments(
	db: Db,
	grantId: string,
	options: DeliveryOptions
): Promise<number> {
	const rows = await db
		.select({
			grantId: accessGrant.id,
			requesterId: accessGrant.requesterId,
			documentId: document.id,
			expiresAt: accessGrant.expiresAt
		})
		.from(accessGrant)
		.innerJoin(document, grantConfersDocument())
		.where(eq(accessGrant.id, grantId));

	return (await narrowByAgreements(db, rows, options)).length;
}

/**
 * Every document a requester may currently download. One query, because scope
 * is a join rather than an opaque column: three sources — explicit documents,
 * whole tiers, whole groups — unioned, and filtered to live grants and
 * documents this phase honours.
 *
 * `documentId` narrows the same question to one document, so `mayDownload` asks
 * Postgres about the row it cares about instead of fetching the whole catalogue
 * and filtering in JS.
 */
export async function grantedDocuments(
	db: Db,
	requesterId: string,
	options: DeliveryOptions & { documentId?: string }
): Promise<{ documentId: string; expiresAt: Date }[]> {
	const conferred = await db
		.select({
			grantId: accessGrant.id,
			requesterId: accessGrant.requesterId,
			documentId: document.id,
			expiresAt: accessGrant.expiresAt
		})
		.from(accessGrant)
		.innerJoin(document, grantConfersDocument())
		.where(
			and(
				eq(accessGrant.requesterId, requesterId),
				options.documentId ? eq(document.id, options.documentId) : undefined
			)
		);

	const rows = await narrowByAgreements(db, conferred, options);

	// `grantConfersDocument` requires `expires_at > now()`, so every row here has
	// one — the `!` states what the join already guarantees, not a fresh
	// assumption.
	// Two live grants can cover the same document, and one grant can cover it
	// from more than one source. The portal shows a document once, with the date
	// access actually ends, so the latest expiry wins.
	const latest = new Map<string, Date>();
	for (const row of rows) {
		const expiresAt = row.expiresAt!;
		const seen = latest.get(row.documentId);
		if (!seen || expiresAt > seen) latest.set(row.documentId, expiresAt);
	}

	return [...latest].map(([documentId, expiresAt]) => ({ documentId, expiresAt }));
}

/** True when this requester may download this specific document. */
export async function mayDownload(
	db: Db,
	requesterId: string,
	documentId: string,
	options: DeliveryOptions
): Promise<boolean> {
	return (await grantedDocuments(db, requesterId, { ...options, documentId })).length > 0;
}

export async function revokeGrant(db: Db, grantId: string, staffUserId: string): Promise<void> {
	// The `revoked_at IS NULL` predicate keeps a second revocation from moving
	// the timestamp — the first one is when access actually ended.
	await db
		.update(accessGrant)
		.set({ revokedAt: new Date(), revokedByStaffId: staffUserId })
		.where(and(eq(accessGrant.id, grantId), isNull(accessGrant.revokedAt)));
}

export interface AdminGrantRow {
	id: string;
	requesterId: string;
	email: string;
	name: string;
	company: string;
	tiers: ScopeTier[];
	groupIds: string[];
	documentCount: number;
	grantedAt: Date;
	expiresAt: Date | null;
	acceptanceDueAt: Date | null;
	revokedAt: Date | null;
	state: GrantState;
}

/**
 * State is derived rather than stored: a grant that lapses does so by the clock
 * passing its expiry, and a column would have to be written by something to
 * stay true.
 *
 * The order of the branches is the priority order, and it is not arbitrary.
 * Revocation wins because a person ended it. `expires_at IS NULL` then means
 * exactly one thing — waiting on an acceptance — and the deadline separates the
 * two ways that can end.
 */
export function grantState(
	row: { revokedAt: Date | null; expiresAt: Date | null; acceptanceDueAt: Date | null },
	now: Date
): GrantState {
	if (row.revokedAt) return 'revoked';

	if (row.expiresAt === null) {
		// The CHECK guarantees a deadline exists here; the `??` is for the type
		// checker, not for a row the database admits.
		return (row.acceptanceDueAt ?? now) <= now ? 'unaccepted' : 'pending_acceptance';
	}

	return row.expiresAt <= now ? 'expired' : 'active';
}

export async function listGrantsForAdmin(db: Db, now = new Date()): Promise<AdminGrantRow[]> {
	const rows = await db
		.select({
			id: accessGrant.id,
			requesterId: accessGrant.requesterId,
			grantedAt: accessGrant.grantedAt,
			expiresAt: accessGrant.expiresAt,
			acceptanceDueAt: accessGrant.acceptanceDueAt,
			revokedAt: accessGrant.revokedAt,
			email: requester.email,
			name: requester.name,
			company: requester.company
		})
		.from(accessGrant)
		.innerJoin(requester, eq(accessGrant.requesterId, requester.id))
		.orderBy(desc(accessGrant.grantedAt));

	if (rows.length === 0) return [];

	// Three batched queries, not three per row: the grants page lists every
	// grant there has ever been, and a per-row query would be one round trip
	// per grant for the same answer.
	const ids = rows.map((row) => row.id);

	const [counts, tierRows, groupRows] = await Promise.all([
		// Counted in Postgres rather than by shipping one row per membership and
		// counting them here: this page lists every grant there has ever been.
		db
			.select({ grantId: accessGrantDocument.grantId, count: sql<number>`count(*)::int` })
			.from(accessGrantDocument)
			.where(inArray(accessGrantDocument.grantId, ids))
			.groupBy(accessGrantDocument.grantId),
		db
			.select({ grantId: accessGrantTier.grantId, tier: accessGrantTier.tier })
			.from(accessGrantTier)
			.where(inArray(accessGrantTier.grantId, ids))
			.orderBy(asc(accessGrantTier.tier)),
		db
			.select({ grantId: accessGrantGroup.grantId, groupId: accessGrantGroup.groupId })
			.from(accessGrantGroup)
			.where(inArray(accessGrantGroup.grantId, ids))
	]);

	const countByGrant = new Map(counts.map((row) => [row.grantId, row.count]));
	const tiers = groupByKey(tierRows, (row) => row.grantId);
	const groups = groupByKey(groupRows, (row) => row.grantId);

	return rows.map((row) => ({
		...row,
		tiers: (tiers.get(row.id) ?? []).map((tier) => tier.tier as ScopeTier),
		groupIds: (groups.get(row.id) ?? []).map((group) => group.groupId),
		documentCount: countByGrant.get(row.id) ?? 0,
		state: grantState(row, now)
	}));
}

export const GRANT_DEFAULT_DAYS_SETTING_KEY = 'access.grant_default_days';

const grantDays = z.number().int().positive().max(3650);

/**
 * How long a grant lasts when nobody names an expiry. The stored setting wins
 * over the environment's `ACCESS_GRANT_DEFAULT_DAYS`, so an operator can change
 * the term without a redeploy.
 *
 * `fallback` is an argument rather than a `getConfig()` call, for the same
 * reason `createGrant` requires `expiresAt`: a module that needs a fully
 * configured environment to answer a question about a row is untestable, and
 * the routes already own the lookup.
 *
 * A stored value that fails validation falls back rather than throwing. It is
 * reachable only by editing the table by hand, and a malformed one must not
 * take the decision page down with it.
 */
export async function defaultGrantDays(db: Db, fallback: number): Promise<number> {
	const [row] = await db
		.select()
		.from(setting)
		.where(eq(setting.key, GRANT_DEFAULT_DAYS_SETTING_KEY))
		.limit(1);

	const parsed = grantDays.safeParse(row?.value);
	return parsed.success ? parsed.data : fallback;
}

export async function setDefaultGrantDays(db: Db, days: number): Promise<void> {
	await db
		.insert(setting)
		.values({ key: GRANT_DEFAULT_DAYS_SETTING_KEY, value: grantDays.parse(days) })
		.onConflictDoUpdate({
			target: setting.key,
			set: { value: grantDays.parse(days), updatedAt: new Date() }
		});
}
