import { describe, expect, it } from 'vitest';
import { grantState } from '../../src/lib/server/access/grants';

const now = new Date('2026-06-01T12:00:00Z');
const past = new Date('2026-05-01T12:00:00Z');
const future = new Date('2026-07-01T12:00:00Z');

describe('grantState', () => {
	it('is active while the clock runs', () => {
		expect(grantState({ revokedAt: null, expiresAt: future, acceptanceDueAt: null }, now)).toBe(
			'active'
		);
	});

	it('is expired once the clock passes', () => {
		expect(grantState({ revokedAt: null, expiresAt: past, acceptanceDueAt: null }, now)).toBe(
			'expired'
		);
	});

	it('is pending_acceptance while inert and inside the deadline', () => {
		expect(grantState({ revokedAt: null, expiresAt: null, acceptanceDueAt: future }, now)).toBe(
			'pending_acceptance'
		);
	});

	it('is unaccepted once the deadline passes', () => {
		// Distinct from `expired` on purpose: "approved but never accepted" is a
		// different fact from "used and lapsed", and Phase 5 counts them apart.
		expect(grantState({ revokedAt: null, expiresAt: null, acceptanceDueAt: past }, now)).toBe(
			'unaccepted'
		);
	});

	it('reports revoked over everything else', () => {
		// A person ended it, and that is what an auditor asks about — including
		// for a grant that was still inert when they did.
		expect(grantState({ revokedAt: past, expiresAt: null, acceptanceDueAt: future }, now)).toBe(
			'revoked'
		);
		expect(grantState({ revokedAt: past, expiresAt: past, acceptanceDueAt: null }, now)).toBe(
			'revoked'
		);
	});
});
