import { describe, expect, it } from 'vitest';
import {
	buildMessage,
	facilityCode,
	frame,
	MessageTooLarge,
	SYSLOG_FACILITIES
} from '../../src/lib/server/auditsink/syslog-message';

const params = {
	facility: 'local0',
	hostname: 'trust.example.com',
	procId: '11111111-1111-4111-8111-111111111111',
	msgId: 'audit',
	timestamp: new Date('2026-09-04T12:00:00.123Z'),
	message: '{"a":1}'
};

describe('facilityCode', () => {
	it('maps the RFC 5424 names to their numbers', () => {
		expect(facilityCode('local0')).toBe(16);
		expect(facilityCode('local7')).toBe(23);
		expect(facilityCode('daemon')).toBe(3);
		expect(facilityCode('authpriv')).toBe(10);
	});

	it('offers exactly the names it can map', () => {
		for (const name of SYSLOG_FACILITIES) expect(facilityCode(name)).toBeTypeOf('number');
	});
});

describe('buildMessage', () => {
	it('builds a version-1 header with a nil structured-data field', () => {
		// PRI is facility * 8 + severity, and severity is notice (5), not info:
		// notice survives the `*.info` filters SIEM operators routinely apply,
		// and a compliance record dropped by a default filter is the failure
		// this subsystem exists to prevent (decision D1).
		expect(buildMessage(params)).toBe(
			'<133>1 2026-09-04T12:00:00.123Z trust.example.com trustcenter ' +
				'11111111-1111-4111-8111-111111111111 audit - \ufeff{"a":1}'
		);
	});

	it('moves PRI with the facility', () => {
		expect(buildMessage({ ...params, facility: 'local7' })).toMatch(/^<189>1 /);
	});

	it('prefixes the message with a UTF-8 BOM so the receiver reads it as UTF-8', () => {
		// RFC 5424 §6.4. The wire bytes are therefore not byte-identical to the
		// canonical line, which costs nothing: §5.3 already records that the
		// digest is not reproducible from what a SIEM stored (decision D7).
		const message = buildMessage(params);
		expect(message.slice(message.indexOf('- ') + 2)).toBe('\ufeff{"a":1}');
	});

	it('emits a nil value for a field it has nothing to put in', () => {
		expect(buildMessage({ ...params, procId: '' })).toContain(' trustcenter - audit - ');
	});
});

describe('frame', () => {
	it('prefixes the octet count and a space, per RFC 6587', () => {
		expect(frame('abc')).toEqual(Buffer.from('3 abc', 'utf8'));
	});

	it('counts octets, not characters', () => {
		// 'ä' is two octets in UTF-8. A length-prefixed frame that counted
		// characters would desynchronise the receiver's stream for every
		// subsequent message on the connection.
		expect(frame('ä').toString('utf8')).toBe('2 ä');
	});
});

describe('MessageTooLarge', () => {
	it('carries no receiver data', () => {
		const error = new MessageTooLarge(9999);
		expect(error.bytes).toBe(9999);
		expect(error.message).not.toContain('9999');
		expect(error.name).toBe('MessageTooLarge');
	});
});
