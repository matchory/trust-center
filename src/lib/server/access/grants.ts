import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { accessGrant, accessGrantDocument, document } from '../db/schema';
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
