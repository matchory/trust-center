import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { magicLink } from '../db/schema';
import type { MagicLinkPurpose } from '../db/schema';
import type { Db } from '../db';

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export async function issueMagicLink(
	db: Db,
	input: {
		purpose: MagicLinkPurpose;
		ttlMinutes: number;
		requesterId?: string;
		requestId?: string;
	}
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + input.ttlMinutes * 60 * 1000);

	await db.insert(magicLink).values({
		tokenHash: hashToken(token),
		purpose: input.purpose,
		requesterId: input.requesterId ?? null,
		requestId: input.requestId ?? null,
		expiresAt
	});

	return { token, expiresAt };
}

/**
 * Single-use by construction: the UPDATE that stamps `consumed_at` is also the
 * predicate that requires it to be null, so two concurrent consumptions of the
 * same token cannot both return a row — the second updates nothing. Doing this
 * as SELECT-then-UPDATE would be a race with a real prize.
 *
 * `purpose` is part of the WHERE clause rather than checked afterwards, so a
 * link presented for the wrong purpose is not consumed by the attempt.
 */
export async function consumeMagicLink(
	db: Db,
	token: string,
	purpose: MagicLinkPurpose
): Promise<{ magicLinkId: string; requesterId: string | null; requestId: string | null } | null> {
	const [row] = await db
		.update(magicLink)
		.set({ consumedAt: sql`now()` })
		.where(
			and(
				eq(magicLink.tokenHash, hashToken(token)),
				eq(magicLink.purpose, purpose),
				isNull(magicLink.consumedAt),
				gt(magicLink.expiresAt, sql`now()`)
			)
		)
		.returning({
			magicLinkId: magicLink.id,
			requesterId: magicLink.requesterId,
			requestId: magicLink.requestId
		});

	return row ?? null;
}
