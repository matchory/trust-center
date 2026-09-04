import { describe, expect, it } from 'vitest';
import { isValidPattern, matchesPattern } from '../../src/lib/server/egress/filter';

describe('matchesPattern', () => {
	it('matches an exact action', () => {
		expect(matchesPattern('access_request.approved', 'access_request.approved')).toBe(true);
		expect(matchesPattern('access_request.approved', 'access_request.denied')).toBe(false);
	});

	it('matches every segment below a trailing wildcard', () => {
		expect(matchesPattern('a.*', 'a.b')).toBe(true);
		expect(matchesPattern('a.*', 'a.b.c')).toBe(true);
	});

	it('does not match the prefix itself', () => {
		expect(matchesPattern('a.*', 'a')).toBe(false);
	});

	it('does not match a longer first segment', () => {
		expect(matchesPattern('a.*', 'ab.c')).toBe(false);
	});

	/**
	 * The LIKE-underscore trap (spec §4.1). This log contains both
	 * `staff.login_failed` and `staff.login.denied`, so a LIKE-based filter on
	 * the former also matches a hypothetical `staff.loginXfailed` — a silent
	 * widening of an egress filter, which is the one class of bug this
	 * subsystem cannot afford.
	 */
	it('treats an underscore as a literal, not a wildcard', () => {
		expect(matchesPattern('staff.login_failed', 'staff.login_failed')).toBe(true);
		expect(matchesPattern('staff.login_failed', 'staff.loginXfailed')).toBe(false);
		expect(matchesPattern('staff.login_failed', 'staff.login.denied')).toBe(false);
	});

	it('does not treat a dot as a regex wildcard', () => {
		expect(matchesPattern('a.b', 'aXb')).toBe(false);
	});
});

describe('isValidPattern', () => {
	it('accepts an exact name and a trailing wildcard', () => {
		expect(isValidPattern('access_request.approved')).toBe(true);
		expect(isValidPattern('access_request.*')).toBe(true);
		expect(isValidPattern('control.*')).toBe(true);
	});

	it('rejects anything a general pattern engine would need', () => {
		for (const pattern of ['*', '*.approved', 'a.*.b', 'a.**', 'a.b*', '', 'a b', 'a.B']) {
			expect(isValidPattern(pattern), pattern).toBe(false);
		}
	});
});
