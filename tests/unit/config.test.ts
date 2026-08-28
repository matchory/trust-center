import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/server/config/parse';

const valid = {
	DATABASE_URL: 'postgres://tc:tc@localhost:5432/tc',
	PUBLIC_BASE_URL: 'https://trust.example.com',
	OIDC_ISSUER: 'https://idp.example.com',
	OIDC_CLIENT_ID: 'trust-center',
	OIDC_CLIENT_SECRET: 'secret',
	OIDC_ADMIN_GROUP: 'trust-center-admins'
};

describe('parseConfig', () => {
	it('parses a valid environment', () => {
		const config = parseConfig(valid);
		expect(config.databaseUrl).toBe('postgres://tc:tc@localhost:5432/tc');
		expect(config.oidc.adminGroup).toBe('trust-center-admins');
	});

	it('defaults the groups claim to "groups"', () => {
		expect(parseConfig(valid).oidc.groupsClaim).toBe('groups');
	});

	it('defaults the session TTL to 12 hours', () => {
		expect(parseConfig(valid).sessionTtlHours).toBe(12);
	});

	it('leaves the approver group undefined when unset', () => {
		expect(parseConfig(valid).oidc.approverGroup).toBeUndefined();
	});

	it('names every missing variable in one error', () => {
		expect(() => parseConfig({})).toThrowError(
			/DATABASE_URL[\s\S]*OIDC_CLIENT_ID[\s\S]*PUBLIC_BASE_URL/
		);
	});

	it('rejects a non-URL issuer', () => {
		expect(() => parseConfig({ ...valid, OIDC_ISSUER: 'not-a-url' })).toThrowError(/OIDC_ISSUER/);
	});

	it('rejects a non-numeric session TTL', () => {
		expect(() => parseConfig({ ...valid, SESSION_TTL_HOURS: 'twelve' })).toThrowError(
			/SESSION_TTL_HOURS/
		);
	});
});
