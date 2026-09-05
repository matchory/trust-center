import { describe, expect, it } from 'vitest';
import { socketReason } from '../../src/lib/server/auditsink/syslog';

/**
 * A receiver that stalls for the full 30 s is too slow to hold a test against,
 * so the mapping is asserted directly rather than through a socket. It is worth
 * asserting: spec §5.4 separates `timeout` from `network` so an operator's
 * lookup points at a hung SIEM instead of at their firewall, and the adapter's
 * own timeout handler depends on this by tagging its error ETIMEDOUT.
 */
describe('socketReason', () => {
	it('maps a socket timeout to timeout, not network', () => {
		expect(socketReason(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })).reason).toBe(
			'timeout'
		);
	});

	it('maps a TLS failure to tls', () => {
		// Both codes were measured against a real receiver: OpenSSL reports the
		// refused client certificate, Node the unverifiable server certificate.
		expect(
			socketReason(
				Object.assign(new Error('x'), { code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED' })
			).reason
		).toBe('tls');
		expect(
			socketReason(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).reason
		).toBe('tls');
	});

	it('falls back to network for a bare socket error', () => {
		expect(socketReason(Object.assign(new Error('x'), { code: 'ECONNRESET' })).reason).toBe(
			'network'
		);
		expect(socketReason(new Error('socket hang up')).reason).toBe('network');
	});

	it('carries nothing from the cause into the reason', () => {
		// `last_error` is written to a table that forbids DELETE and is excluded
		// from retention, so a receiver's message there outlives every erasure
		// path (issue #11).
		const reason = socketReason(new Error('connect to siem.internal 10.0.0.7 failed'));

		expect(reason.message).toBe('network');
		expect(JSON.stringify(reason)).not.toContain('siem.internal');
	});
});
