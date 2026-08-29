import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { requester, requesterSession } from '../db/schema';
import type { Db } from '../db';

export const REQUESTER_SESSION_COOKIE = '__Secure-tc_requester_session';

/**
 * The gated subtree the requester cookie is scoped to. Scoping it here rather
 * than at `Path=/` is what keeps the public portal provably cookie-free and
 * unconditionally cacheable — and it is why this cookie carries the `__Secure-`
 * prefix rather than `__Host-`, which would mandate `Path=/`.
 */
export function accessCookiePath(locale: string): string {
	return `/${locale}/access`;
}

/**
 * The attributes the requester cookie is set with and — just as importantly —
 * deleted with. A browser rejects any `Set-Cookie` for a `__Secure-` prefixed
 * name that omits `Secure`, deletions included, so a delete that drops the
 * attribute silently leaves the session cookie in place. Kept in one function
 * so the two can never drift.
 *
 * `secure: true` is why this works on `http://localhost` but not on a
 * plain-HTTP deployment: browsers treat localhost as a trustworthy origin.
 */
export function requesterCookieOptions(locale: string) {
	return {
		path: accessCookiePath(locale),
		httpOnly: true,
		sameSite: 'lax',
		secure: true
	} as const;
}

export type Requester = typeof requester.$inferSelect;

/**
 * Same construction as the staff session's, deliberately duplicated rather than
 * shared: spec §6.3 keeps the two identity models strictly separate, and a
 * shared helper is the seam along which a requester eventually validates as
 * staff. A few lines is a cheaper price than that risk.
 */
function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** The domain a rule is matched against. Everything after the last `@`. */
export function domainOf(email: string): string {
	return email.toLowerCase().split('@').pop() ?? '';
}

export async function upsertRequester(
	db: Db,
	input: { email: string; name: string; company: string; locale: string }
): Promise<Requester> {
	const email = input.email.trim().toLowerCase();

	const [row] = await db
		.insert(requester)
		.values({
			email,
			name: input.name.trim(),
			company: input.company.trim(),
			companyDomain: domainOf(email),
			locale: input.locale
		})
		.onConflictDoUpdate({
			target: requester.email,
			// firstSeenAt is deliberately absent: it records the first
			// verification, and a returning prospect must not reset it. `locale`
			// IS refreshed — the language someone used most recently is the better
			// guess for the next mail we send them.
			set: { name: input.name.trim(), company: input.company.trim(), locale: input.locale }
		})
		.returning();

	if (!row) throw new Error('failed to upsert requester');
	return row;
}

export async function createRequesterSession(
	db: Db,
	input: { requesterId: string; ttlHours: number; ip?: string | null; ua?: string | null }
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);

	await db.insert(requesterSession).values({
		tokenHash: hashToken(token),
		requesterId: input.requesterId,
		expiresAt,
		ip: input.ip ?? null,
		ua: input.ua ?? null
	});

	return { token, expiresAt };
}

export async function validateRequesterSession(
	db: Db,
	token: string
): Promise<{ requester: Requester; expiresAt: Date } | null> {
	const [row] = await db
		.select({ session: requesterSession, requester })
		.from(requesterSession)
		.innerJoin(requester, eq(requesterSession.requesterId, requester.id))
		.where(
			and(eq(requesterSession.tokenHash, hashToken(token)), isNull(requesterSession.revokedAt))
		)
		.limit(1);

	if (!row) return null;
	if (row.session.expiresAt.getTime() <= Date.now()) return null;
	// A purged requester's sessions are revoked by purgeRequester, but check
	// here too: the guard that matters must not depend on a job having run.
	if (row.requester.purgedAt !== null) return null;

	return { requester: row.requester, expiresAt: row.session.expiresAt };
}

export async function revokeRequesterSession(db: Db, token: string): Promise<void> {
	await db
		.update(requesterSession)
		.set({ revokedAt: new Date() })
		.where(eq(requesterSession.tokenHash, hashToken(token)));
}

/** Used by purgeRequester, and whenever a requester re-authenticates. */
export async function revokeAllRequesterSessions(db: Db, requesterId: string): Promise<void> {
	await db
		.update(requesterSession)
		.set({ revokedAt: new Date() })
		.where(and(eq(requesterSession.requesterId, requesterId), isNull(requesterSession.revokedAt)));
}
