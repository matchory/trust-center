import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/server/config/parse';

const COMPILED = ['de', 'en'] as const;

const valid = {
	DATABASE_URL: 'postgres://tc:tc@localhost:5432/tc',
	BASE_URL: 'https://trust.example.com',
	LOCALES: 'de,en',
	DEFAULT_LOCALE: 'de',
	OIDC_ISSUER: 'https://idp.example.com',
	OIDC_CLIENT_ID: 'trust-center',
	OIDC_CLIENT_SECRET: 'secret',
	OIDC_ADMIN_GROUP: 'trust-center-admins'
};

describe('parseConfig', () => {
	it('parses a valid environment', () => {
		const config = parseConfig(valid, COMPILED);
		expect(config.databaseUrl).toBe('postgres://tc:tc@localhost:5432/tc');
		expect(config.baseUrl).toBe('https://trust.example.com');
		expect(config.oidc.adminGroup).toBe('trust-center-admins');
	});

	it('strips a trailing slash from BASE_URL, so paths concatenate cleanly', () => {
		expect(
			parseConfig({ ...valid, BASE_URL: 'https://trust.example.com/' }, COMPILED).baseUrl
		).toBe('https://trust.example.com');
	});

	it('parses the enabled locale set, trimming whitespace', () => {
		expect(parseConfig({ ...valid, LOCALES: ' de , en ' }, COMPILED).locales).toEqual(['de', 'en']);
	});

	it('accepts a proper subset of the compiled locales', () => {
		const config = parseConfig({ ...valid, LOCALES: 'de', DEFAULT_LOCALE: 'de' }, COMPILED);
		expect(config.locales).toEqual(['de']);
		expect(config.defaultLocale).toBe('de');
	});

	it('rejects a locale with no compiled catalog, naming it and the compiled set', () => {
		expect(() => parseConfig({ ...valid, LOCALES: 'de,fr' }, COMPILED)).toThrowError(
			/LOCALES[\s\S]*fr[\s\S]*de, en/
		);
	});

	it('rejects a default locale that is not enabled', () => {
		expect(() =>
			parseConfig({ ...valid, LOCALES: 'de', DEFAULT_LOCALE: 'en' }, COMPILED)
		).toThrowError(/DEFAULT_LOCALE/);
	});

	it('defaults the groups claim to "groups"', () => {
		expect(parseConfig(valid, COMPILED).oidc.groupsClaim).toBe('groups');
	});

	it('defaults the session TTL to 12 hours', () => {
		expect(parseConfig(valid, COMPILED).sessionTtlHours).toBe(12);
	});

	it('defaults the storage directory and the upload limit', () => {
		const config = parseConfig(valid, COMPILED);
		expect(config.storageDir).toBe('./data/storage');
		expect(config.maxUploadBytes).toBe(25 * 1024 * 1024);
	});

	it('converts MAX_UPLOAD_MB to bytes', () => {
		expect(parseConfig({ ...valid, MAX_UPLOAD_MB: '4' }, COMPILED).maxUploadBytes).toBe(4194304);
	});

	it('leaves the approver group undefined when unset', () => {
		expect(parseConfig(valid, COMPILED).oidc.approverGroup).toBeUndefined();
	});

	it('names every missing variable in one error', () => {
		expect(() => parseConfig({}, COMPILED)).toThrowError(
			/DATABASE_URL[\s\S]*LOCALES[\s\S]*OIDC_CLIENT_ID/
		);
	});

	it('rejects a non-URL issuer', () => {
		expect(() => parseConfig({ ...valid, OIDC_ISSUER: 'not-a-url' }, COMPILED)).toThrowError(
			/OIDC_ISSUER/
		);
	});
});
