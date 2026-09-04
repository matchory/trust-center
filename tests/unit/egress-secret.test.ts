import { describe, expect, it } from 'vitest';
import {
	canaryValue,
	endpointSecret,
	eventHeaders,
	signBody,
	signatureHeader
} from '../../src/lib/server/egress/secret';

const ROOT = 'x'.repeat(32);
const ID = '3f4a9c2e-0000-4000-8000-000000000001';

describe('endpointSecret', () => {
	it('is deterministic for a given id and version', () => {
		expect(endpointSecret(ROOT, ID, 1).toString('hex')).toBe(
			endpointSecret(ROOT, ID, 1).toString('hex')
		);
	});

	it('changes when the version is bumped', () => {
		expect(endpointSecret(ROOT, ID, 2).toString('hex')).not.toBe(
			endpointSecret(ROOT, ID, 1).toString('hex')
		);
	});

	it('changes with the endpoint id', () => {
		const other = '3f4a9c2e-0000-4000-8000-000000000002';
		expect(endpointSecret(ROOT, other, 1).toString('hex')).not.toBe(
			endpointSecret(ROOT, ID, 1).toString('hex')
		);
	});

	it('changes when the root key rotates', () => {
		expect(endpointSecret('y'.repeat(32), ID, 1).toString('hex')).not.toBe(
			endpointSecret(ROOT, ID, 1).toString('hex')
		);
	});
});

describe('signBody', () => {
	// The signed input is `${t}.${body}`, not the body alone: without the
	// timestamp in the signed material a captured body replays forever.
	it('covers the timestamp as well as the body', () => {
		const secret = endpointSecret(ROOT, ID, 1);
		expect(signBody(secret, 1756900000, '{"a":1}')).not.toBe(
			signBody(secret, 1756900001, '{"a":1}')
		);
	});

	it('is lowercase hex of a SHA-256 HMAC', () => {
		const signature = signBody(endpointSecret(ROOT, ID, 1), 1756900000, '{}');
		expect(signature).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('signatureHeader', () => {
	it('emits one v1 signature for a single secret', () => {
		const secret = endpointSecret(ROOT, ID, 1);
		expect(signatureHeader([secret], 1756900000, '{}')).toBe(
			`t=1756900000,v1=${signBody(secret, 1756900000, '{}')}`
		);
	});

	/**
	 * The rotation overlap. Without it a rotation makes every consumer return
	 * 401, which §5.3 makes terminal on the first attempt — so a routine key
	 * bump would fail every queued delivery (spec §7.2).
	 */
	it('emits both signatures during a rotation overlap', () => {
		const current = endpointSecret(ROOT, ID, 2);
		const previous = endpointSecret(ROOT, ID, 1);
		const header = signatureHeader([current, previous], 1756900000, '{}');

		expect(header).toBe(
			`t=1756900000,v1=${signBody(current, 1756900000, '{}')},v1=${signBody(previous, 1756900000, '{}')}`
		);
	});
});

/**
 * `signatureHeader` above proves the overlap is emitted when it is HANDED two
 * secrets. These prove the caller decides to hand it two, which is the half
 * that had drifted: the delivery path derived the previous version and the
 * test send did not, so the tool an operator reaches for right after rotating
 * a key was the one that could not prove the rotation worked (spec §7.2).
 */
describe('eventHeaders', () => {
	const base = {
		action: 'access_request.approved',
		deliveryId: '3f4a9c2e-0000-4000-8000-0000000000aa',
		endpointId: ID,
		body: '{"a":1}'
	};

	it('names the event and the delivery, signed or not', () => {
		const headers = eventHeaders({ ...base, secretVersion: 1, signingKey: undefined });

		expect(headers['x-trust-center-event']).toBe(base.action);
		expect(headers['x-trust-center-delivery']).toBe(base.deliveryId);
	});

	// Whether an unsigned delivery is ALLOWED is `requiresSigning`'s question,
	// asked before this is called — a header builder does not refuse.
	it('omits the signature entirely when no key is configured', () => {
		const headers = eventHeaders({ ...base, secretVersion: 1, signingKey: undefined });

		expect(headers['x-trust-center-signature']).toBeUndefined();
		expect(Object.keys(headers)).toHaveLength(2);
	});

	it('signs with the current secret alone at version 1', () => {
		const headers = eventHeaders({ ...base, secretVersion: 1, signingKey: ROOT });

		expect(headers['x-trust-center-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
	});

	it('carries the previous secret alongside the current one after a bump', () => {
		const headers = eventHeaders({ ...base, secretVersion: 2, signingKey: ROOT });
		const signature = headers['x-trust-center-signature'];
		// Narrowed by throwing rather than defaulted to '', so a header that went
		// missing entirely fails here instead of further down as an empty list.
		if (signature === undefined) throw new Error('no signature header was emitted');

		const [stamp = '', ...signatures] = signature.split(',');
		const timestamp = Number(stamp.slice('t='.length));

		// Asserted as the two derived secrets rather than as "two v1 parts", so a
		// header that signed twice with the SAME secret would still fail.
		expect(signatures).toEqual([
			`v1=${signBody(endpointSecret(ROOT, ID, 2), timestamp, base.body)}`,
			`v1=${signBody(endpointSecret(ROOT, ID, 1), timestamp, base.body)}`
		]);
	});
});

describe('canaryValue', () => {
	it('differs when the root key differs', () => {
		expect(canaryValue(ROOT)).not.toBe(canaryValue('y'.repeat(32)));
	});

	it('is stable for one root key', () => {
		expect(canaryValue(ROOT)).toBe(canaryValue(ROOT));
	});
});
