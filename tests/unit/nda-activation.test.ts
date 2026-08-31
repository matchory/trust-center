import { describe, expect, it } from 'vitest';
import { isActivatable } from '../../src/lib/server/nda/activation';

const now = new Date('2026-06-01T12:00:00Z');
const past = new Date('2026-05-01T12:00:00Z');
const future = new Date('2026-07-01T12:00:00Z');

const inert = {
	expiresAt: null,
	revokedAt: null,
	closedAt: null,
	acceptanceDueAt: future,
	required: ['acme']
};

describe('the activation predicate', () => {
	it('activates when every required agreement is satisfied', () => {
		expect(isActivatable(inert, new Set(['acme']), now)).toBe(true);
	});

	it('does not activate with a requirement outstanding', () => {
		expect(isActivatable(inert, new Set(), now)).toBe(false);
	});

	it('does not activate a grant that already has a clock', () => {
		expect(isActivatable({ ...inert, expiresAt: future }, new Set(['acme']), now)).toBe(false);
	});

	it('does not resurrect a grant past its acceptance deadline', () => {
		// A grant approved in March and never accepted still has expires_at NULL
		// and its requirement rows. Without this clause a click-through in
		// September for an unrelated request would find it "complete" and make an
		// approval that lapsed five months earlier live again.
		expect(isActivatable({ ...inert, acceptanceDueAt: past }, new Set(['acme']), now)).toBe(false);
	});

	it('does not resurrect a revoked grant', () => {
		// Otherwise activation writes an expiry onto a revoked inert grant,
		// producing a row grantState() reports as `revoked` while it carries an
		// active clock.
		expect(isActivatable({ ...inert, revokedAt: past }, new Set(['acme']), now)).toBe(false);
	});

	it('does not resurrect a closed grant', () => {
		expect(isActivatable({ ...inert, closedAt: past }, new Set(['acme']), now)).toBe(false);
	});

	it('ignores a waived requirement, because it is not required', () => {
		expect(isActivatable({ ...inert, required: [] }, new Set(), now)).toBe(true);
	});
});
