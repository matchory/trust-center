import { describe, expect, it } from 'vitest';
import { clientIp } from '../../src/lib/server/http/client-ip';

function eventWith(getClientAddress: () => string) {
	return { getClientAddress };
}

describe('clientIp', () => {
	it('returns the address when adapter-node can determine one', () => {
		expect(clientIp(eventWith(() => '203.0.113.5'))).toBe('203.0.113.5');
	});

	it('degrades to null rather than throwing', () => {
		// adapter-node throws exactly this when ADDRESS_HEADER names a header the
		// proxy does not send. Phase 1 lost an admin mutation to it, and the
		// public download path would 500 for every visitor.
		const event = eventWith(() => {
			throw new Error('Could not determine clientAddress');
		});

		expect(clientIp(event)).toBeNull();
	});
});
