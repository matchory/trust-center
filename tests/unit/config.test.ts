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

describe('optional variables left blank', () => {
	it('treats an empty value as unset rather than invalid', () => {
		// A .env conventionally spells "unset" as `KEY=`. Copying .env.example
		// verbatim must not produce a deployment that refuses to boot.
		const config = parseConfig(
			{
				...valid,
				SMTP_URL: '',
				STAFF_NOTIFICATION_EMAIL: '',
				OIDC_APPROVER_GROUP: ''
			},
			COMPILED
		);

		expect(config.mail.smtpUrl).toBeUndefined();
		expect(config.mail.staffNotificationEmail).toBeUndefined();
		expect(config.oidc.approverGroup).toBeUndefined();
	});

	it('still rejects a value that is present but malformed', () => {
		expect(() =>
			parseConfig({ ...valid, STAFF_NOTIFICATION_EMAIL: 'not-an-email' }, ['de', 'en'])
		).toThrow(/STAFF_NOTIFICATION_EMAIL/);
	});
});

describe('telemetry configuration', () => {
	it('is inert when no endpoint is set', () => {
		const config = parseConfig(valid, COMPILED);
		expect(config.telemetry.endpoint).toBeUndefined();
		expect(config.telemetry.serviceName).toBe('trust-center');
		expect(config.telemetry.headers).toEqual({});
		expect(config.telemetry.sampleRatio).toBe(1);
	});

	it('parses an endpoint, a service name and a ratio', () => {
		const config = parseConfig(
			{
				...valid,
				OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com:4318',
				OTEL_SERVICE_NAME: 'trust-center-staging',
				OTEL_TRACES_SAMPLER_ARG: '0.25'
			},
			COMPILED
		);
		expect(config.telemetry.endpoint).toBe('https://collector.example.com:4318');
		expect(config.telemetry.serviceName).toBe('trust-center-staging');
		expect(config.telemetry.sampleRatio).toBe(0.25);
	});

	it('parses headers into a record, keeping values containing "="', () => {
		const config = parseConfig(
			{ ...valid, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer a=b, x-tenant=acme' },
			COMPILED
		);
		expect(config.telemetry.headers).toEqual({
			authorization: 'Bearer a=b',
			'x-tenant': 'acme'
		});
	});

	it('refuses a header entry with no "=" rather than dropping it', () => {
		expect(() =>
			parseConfig({ ...valid, OTEL_EXPORTER_OTLP_HEADERS: 'garbage' }, COMPILED)
		).toThrow();
	});

	// `{'': 'v'}` is not a header the exporter can send, and this variable is
	// where the collector credential lives — so it refuses to boot rather than
	// authenticating with a nameless one.
	it('refuses a header entry with an empty key', () => {
		expect(() =>
			parseConfig({ ...valid, OTEL_EXPORTER_OTLP_HEADERS: '=secret' }, COMPILED)
		).toThrow();
	});

	// The parser skips a trailing comma; the validator used to reject it, so the
	// two disagreed about the same string. They now read it the same way.
	it('accepts a trailing comma, which the parser skips', () => {
		const config = parseConfig(
			{ ...valid, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer t,' },
			COMPILED
		);
		expect(config.telemetry.headers).toEqual({ authorization: 'Bearer t' });
	});

	// A value that parses to no headers at all is a typo, not a configuration.
	it('refuses a header string that yields no pairs', () => {
		expect(() => parseConfig({ ...valid, OTEL_EXPORTER_OTLP_HEADERS: ',' }, COMPILED)).toThrow();
	});

	// The exporters concatenate `/v1/traces` onto this, and a trailing slash is
	// the commonest form of the typo — the standard SDK tolerates it, so an
	// operator has no reason to expect a double slash and the 404 it earns.
	it('strips a trailing slash from the endpoint', () => {
		const config = parseConfig(
			{ ...valid, OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.internal:4318/' },
			COMPILED
		);
		expect(config.telemetry.endpoint).toBe('https://otel.internal:4318');
	});

	it('refuses an endpoint that is not a URL', () => {
		expect(() =>
			parseConfig({ ...valid, OTEL_EXPORTER_OTLP_ENDPOINT: 'collector:4318' }, COMPILED)
		).toThrow();
	});

	it('refuses a sampler ratio outside 0..1', () => {
		expect(() => parseConfig({ ...valid, OTEL_TRACES_SAMPLER_ARG: '2' }, COMPILED)).toThrow();
	});

	it('treats a blank sample ratio as the documented default 1, not as 0', () => {
		const config = parseConfig({ ...valid, OTEL_TRACES_SAMPLER_ARG: '' }, COMPILED);
		expect(config.telemetry.sampleRatio).toBe(1);
	});
});

describe('egress configuration', () => {
	it('is off by default', () => {
		const config = parseConfig(valid, COMPILED);
		expect(config.egress).toEqual({ enabled: false, signingKey: undefined, allow: [] });
	});

	it('reads the three variables', () => {
		const config = parseConfig(
			{
				...valid,
				EVENT_EGRESS_ENABLED: 'true',
				EVENT_SIGNING_KEY: 'k'.repeat(32),
				EVENT_EGRESS_ALLOW: 'n8n:5678,10.1.0.0/16'
			},
			COMPILED
		);

		expect(config.egress.enabled).toBe(true);
		expect(config.egress.signingKey).toBe('k'.repeat(32));
		expect(config.egress.allow).toEqual([
			{ kind: 'host', host: 'n8n', port: 5678 },
			{ kind: 'cidr', cidr: '10.1.0.0/16' }
		]);
	});

	// The reason the list is parsed here rather than per caller: a malformed
	// entry used to boot clean, then throw inside every delivery tick and 500 the
	// admin page an operator would go to in order to fix it.
	it('refuses to boot on a malformed allowlist entry', () => {
		expect(() => parseConfig({ ...valid, EVENT_EGRESS_ALLOW: '10.1.0.0/40' }, COMPILED)).toThrow(
			/EVENT_EGRESS_ALLOW/
		);
	});

	// A blank value is how a .env spells "unset" (blankAsUndefined's reason).
	it('treats a blank switch as off rather than refusing to boot', () => {
		expect(parseConfig({ ...valid, EVENT_EGRESS_ENABLED: '' }, COMPILED).egress.enabled).toBe(
			false
		);
	});

	/**
	 * A typo in the one switch that answers "does this deployment call out at
	 * all" must refuse to boot rather than silently reading as off — the same
	 * discipline the OTEL variables get, and for the same reason.
	 */
	it('refuses a switch that is neither true nor false', () => {
		expect(() => parseConfig({ ...valid, EVENT_EGRESS_ENABLED: '1' }, COMPILED)).toThrowError(
			/EVENT_EGRESS_ENABLED/
		);
	});

	it('refuses a signing key shorter than 32 characters', () => {
		expect(() => parseConfig({ ...valid, EVENT_SIGNING_KEY: 'short' }, COMPILED)).toThrowError(
			/EVENT_SIGNING_KEY/
		);
	});
});
