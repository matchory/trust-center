import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/server/config/parse';

const base = {
	DATABASE_URL: 'postgres://u:p@localhost:5432/db',
	BASE_URL: 'https://trust.example.com',
	LOCALES: 'de,en',
	DEFAULT_LOCALE: 'de',
	OIDC_ISSUER: 'https://idp.example.com',
	OIDC_CLIENT_ID: 'client',
	OIDC_CLIENT_SECRET: 'secret',
	OIDC_ADMIN_GROUP: 'trust-center-admins'
};

function parse(overrides: Record<string, string>) {
	return parseConfig({ ...base, ...overrides }, ['de', 'en']);
}

describe('the syslog sink configuration', () => {
	it('parses a tls URL into host, port and a tls flag', () => {
		const { syslog } = parse({ AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com:6514' }).auditSink;

		expect(syslog).toMatchObject({ host: 'siem.example.com', port: 6514, tls: true });
	});

	it('defaults the port per scheme — 6514 for tls, 514 for tcp', () => {
		expect(parse({ AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com' }).auditSink.syslog?.port).toBe(
			6514
		);
		expect(parse({ AUDIT_SINK_SYSLOG_URL: 'tcp://siem.example.com' }).auditSink.syslog?.port).toBe(
			514
		);
	});

	it('refuses udp outright', () => {
		// Spec §5.3: silent loss disqualifies a compliance record, and there is
		// no variable anywhere that re-enables it.
		expect(() => parse({ AUDIT_SINK_SYSLOG_URL: 'udp://siem.example.com:514' })).toThrow();
	});

	it('refuses a facility it cannot map', () => {
		expect(() =>
			parse({
				AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com',
				AUDIT_SINK_SYSLOG_FACILITY: 'kern'
			})
		).toThrow();
	});

	it('defaults the facility to local0 and the message cap to 8 KiB', () => {
		const { syslog } = parse({ AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com' }).auditSink;

		expect(syslog).toMatchObject({ facility: 'local0', maxMessageBytes: 8192 });
	});

	it('converts escaped newlines in a PEM variable into real ones', () => {
		// A PEM block is multi-line and `docker run -e` is not; without this the
		// CA variable is unusable in the shape this product ships in (D9).
		const { syslog } = parse({
			AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com',
			AUDIT_SINK_SYSLOG_CA: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----'
		}).auditSink;

		expect(syslog?.ca).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
	});

	it('leaves a PEM that already has real newlines alone', () => {
		const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
		const { syslog } = parse({
			AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com',
			AUDIT_SINK_SYSLOG_CA: pem
		}).auditSink;

		expect(syslog?.ca).toBe(pem);
	});

	it('requires the client certificate and key together, or neither', () => {
		expect(() =>
			parse({
				AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com',
				AUDIT_SINK_SYSLOG_CLIENT_CERT: '-----BEGIN CERTIFICATE-----'
			})
		).toThrow();
	});

	it('accepts the sink enabled with syslog alone and no S3', () => {
		// The B1 boot rule was S3-shaped: extended, not replaced, or enabling
		// the sink with syslog alone would refuse to boot (B1 carry-over §5).
		const { auditSink } = parse({
			AUDIT_SINK_ENABLED: 'true',
			AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com'
		});

		expect(auditSink.enabled).toBe(true);
		expect(auditSink.s3).toBeUndefined();
		expect(auditSink.syslog).toBeDefined();
	});

	it('still refuses the sink enabled with no sink at all', () => {
		expect(() => parse({ AUDIT_SINK_ENABLED: 'true' })).toThrow();
	});
});
