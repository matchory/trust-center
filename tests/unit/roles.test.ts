import { describe, expect, it } from 'vitest';
import { extractGroups, mapRole } from '../../src/lib/server/auth/roles';

describe('mapRole', () => {
	it('maps the admin group to admin', () => {
		expect(mapRole(['trust-center-admins'], 'trust-center-admins', 'trust-center-approvers')).toBe(
			'admin'
		);
	});

	it('maps the approver group to approver', () => {
		expect(
			mapRole(['trust-center-approvers'], 'trust-center-admins', 'trust-center-approvers')
		).toBe('approver');
	});

	it('prefers admin when the user is in both groups', () => {
		expect(
			mapRole(
				['trust-center-approvers', 'trust-center-admins'],
				'trust-center-admins',
				'trust-center-approvers'
			)
		).toBe('admin');
	});

	it('returns null when the user is in no mapped group', () => {
		expect(mapRole(['engineering'], 'trust-center-admins', 'trust-center-approvers')).toBeNull();
	});

	it('returns null for an empty group list', () => {
		expect(mapRole([], 'trust-center-admins', 'trust-center-approvers')).toBeNull();
	});

	it('returns null for the approver group when no approver group is configured', () => {
		expect(mapRole(['trust-center-approvers'], 'trust-center-admins', undefined)).toBeNull();
	});
});

describe('extractGroups', () => {
	it('reads a string array claim', () => {
		expect(extractGroups({ groups: ['a', 'b'] }, 'groups')).toEqual(['a', 'b']);
	});

	it('wraps a single string claim', () => {
		expect(extractGroups({ groups: 'a' }, 'groups')).toEqual(['a']);
	});

	it('honours a custom claim name', () => {
		expect(extractGroups({ roles: ['x'] }, 'roles')).toEqual(['x']);
	});

	it('returns an empty array when the claim is absent', () => {
		expect(extractGroups({}, 'groups')).toEqual([]);
	});

	it('discards non-string entries', () => {
		expect(extractGroups({ groups: ['a', 1, null, 'b'] }, 'groups')).toEqual(['a', 'b']);
	});
});
