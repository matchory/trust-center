import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	accessGrant,
	accessGrantDocument,
	accessGrantGroup,
	accessGrantTier,
	document,
	documentGroup,
	requester,
	setting
} from '../db/schema';
import { groupByKey } from '../collections';
import { PHASE_TIERS, setGrantGroups, setGrantTiers } from './scope';
import type { ScopeTier } from '../../access-types';
import type { GrantState } from '../../nda-types';
import type { Db } from '../db';

export type { GrantState };

/**
 * `expiresAt` is required rather than defaulted from config, for the same
 * reason `drainOutbox` takes its settings as arguments: a module that calls
 * `getConfig()` cannot run without a fully configured environment, which makes
 * it untestable and tells it more than it needs to know. The caller owns the
 * lookup.
 */
export async function createGrant(
	db: Db,
	input: {
		requesterId: string;
		requestId: string | null;
		documentIds: readonly string[];
		tiers: readonly ScopeTier[];
		groupIds: readonly string[];
		expiresAt: Date;
		termDays: number;
	}
): Promise<{ grantId: string; expiresAt: Date }> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(accessGrant)
			.values({
				requesterId: input.requesterId,
				requestId: input.requestId,
				termDays: input.termDays,
				expiresAt: input.expiresAt
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

/**
 * How many documents one grant covers right now. Used by the expiry reminder,
 * which speaks about a single grant's scope — a requester holding two grants
 * must not be told the wrong number about the one that is ending — and by the
 * approval mail, which tells a requester what they just received.
 */
export async function countGrantDocuments(db: Db, grantId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(accessGrant)
		.innerJoin(document, grantConfersDocument())
		.where(eq(accessGrant.id, grantId));

	return row?.count ?? 0;
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
	documentId?: string
): Promise<{ documentId: string; expiresAt: Date }[]> {
	const rows = await db
		.select({ documentId: document.id, expiresAt: accessGrant.expiresAt })
		.from(accessGrant)
		.innerJoin(document, grantConfersDocument())
		.where(
			and(
				eq(accessGrant.requesterId, requesterId),
				documentId ? eq(document.id, documentId) : undefined
			)
		);

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
	documentId: string
): Promise<boolean> {
	return (await grantedDocuments(db, requesterId, documentId)).length > 0;
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
