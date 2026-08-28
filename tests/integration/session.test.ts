import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	createStaffSession,
	revokeStaffSession,
	upsertStaffUser,
	validateStaffSession
} from '../../src/lib/server/auth/session';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

describe('staff users', () => {
	it('creates a user on first login', async () => {
		const user = await upsertStaffUser(db, {
			oidcSub: 'sub-create',
			email: 'a@example.test',
			name: 'A',
			role: 'admin'
		});

		expect(user.id).toBeTruthy();
		expect(user.role).toBe('admin');
	});

	it('updates the role on subsequent login so IdP changes take effect', async () => {
		await upsertStaffUser(db, {
			oidcSub: 'sub-demote',
			email: 'b@example.test',
			name: 'B',
			role: 'admin'
		});

		const after = await upsertStaffUser(db, {
			oidcSub: 'sub-demote',
			email: 'b@example.test',
			name: 'B',
			role: 'approver'
		});

		expect(after.role).toBe('approver');
	});
});

describe('staff sessions', () => {
	it('issues a token that validates back to the user', async () => {
		const user = await upsertStaffUser(db, {
			oidcSub: 'sub-session',
			email: 'c@example.test',
			name: 'C',
			role: 'admin'
		});

		const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: 12 });
		const resolved = await validateStaffSession(db, token);

		expect(resolved?.user.id).toBe(user.id);
		expect(resolved?.user.role).toBe('admin');
	});

	it('never stores the token in plaintext', async () => {
		const user = await upsertStaffUser(db, {
			oidcSub: 'sub-hash',
			email: 'd@example.test',
			name: 'D',
			role: 'admin'
		});

		const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: 12 });
		const rows = await db
			.select()
			.from((await import('../../src/lib/server/db')).schema.staffSession);

		expect(rows.some((row) => row.tokenHash === token)).toBe(false);
	});

	it('rejects an unknown token', async () => {
		expect(await validateStaffSession(db, 'not-a-real-token')).toBeNull();
	});

	it('rejects an expired session', async () => {
		const user = await upsertStaffUser(db, {
			oidcSub: 'sub-expired',
			email: 'e@example.test',
			name: 'E',
			role: 'admin'
		});

		const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: -1 });

		expect(await validateStaffSession(db, token)).toBeNull();
	});

	it('rejects a revoked session immediately', async () => {
		const user = await upsertStaffUser(db, {
			oidcSub: 'sub-revoked',
			email: 'f@example.test',
			name: 'F',
			role: 'admin'
		});

		const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: 12 });
		await revokeStaffSession(db, token);

		expect(await validateStaffSession(db, token)).toBeNull();
	});

	it('rejects a session belonging to a disabled user', async () => {
		const user = await upsertStaffUser(db, {
			oidcSub: 'sub-disabled',
			email: 'g@example.test',
			name: 'G',
			role: 'admin'
		});

		const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: 12 });

		const { schema } = await import('../../src/lib/server/db');
		const { eq } = await import('drizzle-orm');
		await db
			.update(schema.staffUser)
			.set({ disabledAt: new Date() })
			.where(eq(schema.staffUser.id, user.id));

		expect(await validateStaffSession(db, token)).toBeNull();
	});
});
