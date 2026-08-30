import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accessGrant, accessGrantDocument, document, requester, setting } from '../db/schema';
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
		allRequestTier: boolean;
		expiresAt: Date;
	}
): Promise<{ grantId: string; expiresAt: Date }> {
	const [row] = await db
		.insert(accessGrant)
		.values({
			requesterId: input.requesterId,
			requestId: input.requestId,
			allRequestTier: input.allRequestTier,
			expiresAt: input.expiresAt
		})
		.returning({ id: accessGrant.id });

	if (!row) throw new Error('failed to create grant');

	if (input.documentIds.length > 0) {
		await db
			.insert(accessGrantDocument)
			.values(
				[...new Set(input.documentIds)].map((documentId) => ({ grantId: row.id, documentId }))
			);
	}

	return { grantId: row.id, expiresAt: input.expiresAt };
}

/**
 * Every document a requester may currently download. One query, because scope
 * is a join rather than an opaque column: explicit grant rows union the
 * all-request-tier grants, and both are filtered to live grants and published
 * request-tier documents.
 *
 * The tier filter is applied here rather than at grant time on purpose. A
 * document moved from `request` to `nda` must stop being downloadable
 * immediately, without anybody remembering to revisit existing grants.
 */
export async function grantedDocuments(
	db: Db,
	requesterId: string
): Promise<{ documentId: string; expiresAt: Date }[]> {
	const rows = await db
		.select({ documentId: document.id, expiresAt: accessGrant.expiresAt })
		.from(accessGrant)
		.innerJoin(
			document,
			or(
				// An all-request-tier grant covers every published request-tier
				// document, including ones published after the grant was made.
				and(eq(accessGrant.allRequestTier, true), eq(document.tier, 'request')),
				// ...or the document is named explicitly.
				sql`EXISTS (
					SELECT 1 FROM ${accessGrantDocument}
					WHERE ${accessGrantDocument.grantId} = ${accessGrant.id}
					  AND ${accessGrantDocument.documentId} = ${document.id}
				)`
			)!
		)
		.where(
			and(
				eq(accessGrant.requesterId, requesterId),
				isNull(accessGrant.revokedAt),
				gt(accessGrant.expiresAt, sql`now()`),
				eq(document.status, 'published'),
				eq(document.tier, 'request')
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
	allRequestTier: boolean;
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
			allRequestTier: accessGrant.allRequestTier,
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

	const scopes = await db
		.select({ grantId: accessGrantDocument.grantId })
		.from(accessGrantDocument)
		.where(
			inArray(
				accessGrantDocument.grantId,
				rows.map((row) => row.id)
			)
		);

	const counts = new Map<string, number>();
	for (const scope of scopes) counts.set(scope.grantId, (counts.get(scope.grantId) ?? 0) + 1);

	return rows.map((row) => ({
		...row,
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
