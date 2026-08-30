import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { staffSession, staffUser } from '../db/schema';
import type { Db } from '../db';
import type { StaffRole } from './roles';

export const SESSION_COOKIE = '__Host-tc_staff_session';

/**
 * The `__Host-` prefix mandates `Secure`, `Path=/`, and no `Domain`; a browser
 * silently rejects any `Set-Cookie` for such a name that breaks one of them —
 * deletions included, which is why set and delete share this object rather
 * than spelling the attributes out at each call site and drifting.
 *
 * `secure: true` unconditionally is what makes the prefix mean anything, and
 * why this works on `http://localhost` (browsers treat it as a trustworthy
 * origin) but not on a plain-HTTP deployment. See docs/self-hosting.md §3.
 */
export const STAFF_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	sameSite: 'lax',
	secure: true
} as const;

export type StaffUser = typeof staffUser.$inferSelect;

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export async function upsertStaffUser(
	db: Db,
	input: { oidcSub: string; email: string; name: string; role: StaffRole }
): Promise<StaffUser> {
	const [row] = await db
		.insert(staffUser)
		.values({
			oidcSub: input.oidcSub,
			email: input.email,
			name: input.name,
			role: input.role,
			lastLoginAt: new Date()
		})
		.onConflictDoUpdate({
			target: staffUser.oidcSub,
			set: {
				email: input.email,
				name: input.name,
				role: input.role,
				lastLoginAt: new Date()
			}
		})
		.returning();

	if (!row) throw new Error('failed to upsert staff user');
	return row;
}

export async function createStaffSession(
	db: Db,
	input: { staffUserId: string; ttlHours: number; ip?: string; ua?: string }
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);

	await db.insert(staffSession).values({
		tokenHash: hashToken(token),
		staffUserId: input.staffUserId,
		expiresAt,
		ip: input.ip ?? null,
		ua: input.ua ?? null
	});

	return { token, expiresAt };
}

export async function validateStaffSession(
	db: Db,
	token: string
): Promise<{ user: StaffUser; expiresAt: Date } | null> {
	const [row] = await db
		.select({ session: staffSession, user: staffUser })
		.from(staffSession)
		.innerJoin(staffUser, eq(staffSession.staffUserId, staffUser.id))
		.where(and(eq(staffSession.tokenHash, hashToken(token)), isNull(staffSession.revokedAt)))
		.limit(1);

	if (!row) return null;
	if (row.session.expiresAt.getTime() <= Date.now()) return null;
	if (row.user.disabledAt !== null) return null;

	return { user: row.user, expiresAt: row.session.expiresAt };
}

/**
 * Called on every successful login. A staff member signing in fresh is the
 * natural moment to invalidate whatever else is holding a session for them —
 * a shared machine, a stolen laptop, a session minted before a role change.
 */
export async function revokeAllStaffSessions(db: Db, staffUserId: string): Promise<void> {
	await db
		.update(staffSession)
		.set({ revokedAt: new Date() })
		.where(and(eq(staffSession.staffUserId, staffUserId), isNull(staffSession.revokedAt)));
}

export async function revokeStaffSession(db: Db, token: string): Promise<void> {
	await db
		.update(staffSession)
		.set({ revokedAt: new Date() })
		.where(eq(staffSession.tokenHash, hashToken(token)));
}
