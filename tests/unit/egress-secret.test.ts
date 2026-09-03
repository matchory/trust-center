import { describe, expect, it } from 'vitest';
import {
	canaryValue,
	endpointSecret,
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

describe('canaryValue', () => {
	it('differs when the root key differs', () => {
		expect(canaryValue(ROOT)).not.toBe(canaryValue('y'.repeat(32)));
	});

	it('is stable for one root key', () => {
		expect(canaryValue(ROOT)).toBe(canaryValue(ROOT));
	});
});
