import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { consumeMagicLink, issueMagicLink } from '../../src/lib/server/identity/magic-link';
import {
	createRequesterSession,
	revokeAllRequesterSessions,
	revokeRequesterSession,
	upsertRequester,
	validateRequesterSession
} from '../../src/lib/server/identity/requester';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});

afterAll(async () => {
	await close();
});

function email() {
	return `person-${randomUUID()}@acme.example`;
}

describe('upsertRequester', () => {
	it('lowercases the email and derives the domain', async () => {
		const address = email().toUpperCase();
		const row = await upsertRequester(db, {
			email: address,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});

		expect(row.email).toBe(address.toLowerCase());
		expect(row.companyDomain).toBe('acme.example');
	});

	it('is idempotent on email and refreshes the profile', async () => {
		const address = email();
		const first = await upsertRequester(db, {
			email: address,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		const second = await upsertRequester(db, {
			email: address,
			name: 'A. Person',
			company: 'Acme GmbH',
			locale: 'en'
		});

		expect(second.id).toBe(first.id);
		expect(second.name).toBe('A. Person');
		// The language someone used most recently is the better guess for the
		// next mail, so locale refreshes...
		expect(second.locale).toBe('en');
		// ...but firstSeenAt records the first verification and must not reset.
		expect(second.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
	});
});

describe('magic links', () => {
	it('consumes a link exactly once', async () => {
		const requestId = randomUUID();
		const { token } = await issueMagicLink(db, {
			purpose: 'verify_request',
			requestId,
			ttlMinutes: 30
		});

		const first = await consumeMagicLink(db, token, 'verify_request');
		expect(first?.requestId).toBe(requestId);

		const second = await consumeMagicLink(db, token, 'verify_request');
		expect(second).toBeNull();
	});

	it('refuses a link presented for the wrong purpose', async () => {
		const { token } = await issueMagicLink(db, {
			purpose: 'verify_request',
			requestId: randomUUID(),
			ttlMinutes: 30
		});

		expect(await consumeMagicLink(db, token, 'sign_in')).toBeNull();
		// ...and the failed attempt must not have burned it.
		expect(await consumeMagicLink(db, token, 'verify_request')).not.toBeNull();
	});

	it('refuses an expired link', async () => {
		const { token } = await issueMagicLink(db, {
			purpose: 'verify_request',
			requestId: randomUUID(),
			ttlMinutes: -1
		});

		expect(await consumeMagicLink(db, token, 'verify_request')).toBeNull();
	});

	it('refuses an unknown token without disclosing anything', async () => {
		expect(await consumeMagicLink(db, 'not-a-real-token', 'verify_request')).toBeNull();
	});

	it('issues a sign_in link bound to a requester', async () => {
		const row = await upsertRequester(db, {
			email: email(),
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		const { token } = await issueMagicLink(db, {
			purpose: 'sign_in',
			requesterId: row.id,
			ttlMinutes: 30
		});

		const consumed = await consumeMagicLink(db, token, 'sign_in');
		expect(consumed?.requesterId).toBe(row.id);
	});

	it('refuses a sign_in link with no requester, at the database', async () => {
		// magic_link_requester_check: a sign_in link that names nobody could not
		// mint a session for anyone, so it must not be storable.
		await expect(issueMagicLink(db, { purpose: 'sign_in', ttlMinutes: 30 })).rejects.toThrow();
	});
});

describe('requester sessions', () => {
	it('validates, then stops validating once revoked', async () => {
		const row = await upsertRequester(db, {
			email: email(),
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		const { token } = await createRequesterSession(db, {
			requesterId: row.id,
			ttlHours: 24,
			ip: '203.0.113.5',
			ua: 'test'
		});

		expect((await validateRequesterSession(db, token))?.requester.id).toBe(row.id);

		await revokeRequesterSession(db, token);
		expect(await validateRequesterSession(db, token)).toBeNull();
	});

	it('refuses an expired session', async () => {
		const row = await upsertRequester(db, {
			email: email(),
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		const { token } = await createRequesterSession(db, { requesterId: row.id, ttlHours: -1 });

		expect(await validateRequesterSession(db, token)).toBeNull();
	});

	it('revokes every live session for one requester', async () => {
		const row = await upsertRequester(db, {
			email: email(),
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		const a = await createRequesterSession(db, { requesterId: row.id, ttlHours: 24 });
		const b = await createRequesterSession(db, { requesterId: row.id, ttlHours: 24 });

		await revokeAllRequesterSessions(db, row.id);

		expect(await validateRequesterSession(db, a.token)).toBeNull();
		expect(await validateRequesterSession(db, b.token)).toBeNull();
	});
});
