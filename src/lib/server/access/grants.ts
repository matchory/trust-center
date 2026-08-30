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
import { PHASE_TIERS, setGrantGroups, setGrantTiers } from './scope';
import type { ScopeTier } from './scope';
import type { Db } from '../db';

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
 * How many documents one grant covers right now. Used by the expiry reminder,
 * which speaks about a single grant's scope — a requester holding two grants
 * must not be told the wrong number about the one that is ending.
 */
export async function countGrantDocuments(db: Db, grantId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(accessGrant)
		.innerJoin(document, grantCoversDocument())
		.where(
			and(
				eq(accessGrant.id, grantId),
				// Neither predicate was here. The single caller pre-filtered, so it
				// was safe by accident rather than by construction — and a second
				// caller is exactly what this phase adds.
				isNull(accessGrant.revokedAt),
				gt(accessGrant.expiresAt, sql`now()`),
				eq(document.status, 'published'),
				inArray(document.tier, [...PHASE_TIERS])
			)
		);

	return row?.count ?? 0;
}

/**
 * Every document a requester may currently download. One query, because scope
 * is a join rather than an opaque column: explicit grant rows union the
 * all-request-tier grants, and both are filtered to live grants and published
 * request-tier documents.
 *
 * The tier filter is applied here rather than at grant time on purpose. A
 * document moved out of a granted tier must stop being downloadable
 * immediately, without anybody remembering to revisit existing grants.
 */
export async function grantedDocuments(
	db: Db,
	requesterId: string
): Promise<{ documentId: string; expiresAt: Date }[]> {
	const rows = await db
		.select({ documentId: document.id, expiresAt: accessGrant.expiresAt })
		.from(accessGrant)
		.innerJoin(document, grantCoversDocument())
		.where(
			and(
				eq(accessGrant.requesterId, requesterId),
				isNull(accessGrant.revokedAt),
				gt(accessGrant.expiresAt, sql`now()`),
				eq(document.status, 'published'),
				inArray(document.tier, [...PHASE_TIERS])
			)
		);

	// Two live grants can cover the same document — an explicit one and an
	// all-tier one. The portal shows a document once, with the date access
	// actually ends, so the latest expiry wins.
	const latest = new Map<string, Date>();
	for (const row of rows) {
		const seen = latest.get(row.documentId);
		if (!seen || row.expiresAt > seen) latest.set(row.documentId, row.expiresAt);
	}

	return [...latest].map(([documentId, expiresAt]) => ({ documentId, expiresAt }));
}

/** True when this requester may download this specific document. */
export async function mayDownload(
	db: Db,
	requesterId: string,
	documentId: string
): Promise<boolean> {
	const granted = await grantedDocuments(db, requesterId);
	return granted.some((row) => row.documentId === documentId);
}

export async function revokeGrant(db: Db, grantId: string, staffUserId: string): Promise<void> {
	// The `revoked_at IS NULL` predicate keeps a second revocation from moving
	// the timestamp — the first one is when access actually ended.
	await db
		.update(accessGrant)
		.set({ revokedAt: new Date(), revokedByStaffId: staffUserId })
		.where(and(eq(accessGrant.id, grantId), isNull(accessGrant.revokedAt)));
}

export type GrantState = 'active' | 'expired' | 'revoked';

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
	expiresAt: Date;
	revokedAt: Date | null;
	state: GrantState;
}

/**
 * State is derived rather than stored: a grant that lapses does so by the clock
 * passing its expiry, and a column would have to be written by something to
 * stay true. Revocation wins over expiry — a revoked grant that later passes
 * its expiry was still ended by a person, and that is what an auditor asks
 * about.
 */
export function grantState(
	row: { revokedAt: Date | null; expiresAt: Date },
	now: Date
): GrantState {
	if (row.revokedAt) return 'revoked';
	return row.expiresAt <= now ? 'expired' : 'active';
}

export async function listGrantsForAdmin(db: Db, now = new Date()): Promise<AdminGrantRow[]> {
	const rows = await db
		.select({
			id: accessGrant.id,
			requesterId: accessGrant.requesterId,
			grantedAt: accessGrant.grantedAt,
			expiresAt: accessGrant.expiresAt,
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

	const [scopes, tierRows, groupRows] = await Promise.all([
		db
			.select({ grantId: accessGrantDocument.grantId })
			.from(accessGrantDocument)
			.where(inArray(accessGrantDocument.grantId, ids)),
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

	const counts = new Map<string, number>();
	for (const scope of scopes) counts.set(scope.grantId, (counts.get(scope.grantId) ?? 0) + 1);

	const tiers = new Map<string, ScopeTier[]>();
	for (const row of tierRows) {
		const tier = row.tier as ScopeTier;
		tiers.set(row.grantId, [...(tiers.get(row.grantId) ?? []), tier]);
	}

	const groups = new Map<string, string[]>();
	for (const row of groupRows) {
		groups.set(row.grantId, [...(groups.get(row.grantId) ?? []), row.groupId]);
	}

	return rows.map((row) => ({
		...row,
		tiers: tiers.get(row.id) ?? [],
		groupIds: groups.get(row.id) ?? [],
		documentCount: counts.get(row.id) ?? 0,
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
