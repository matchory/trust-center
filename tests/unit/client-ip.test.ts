import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Every `.ts` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('the raw getClientAddress()', () => {
	it('is called nowhere but the helper that catches it', () => {
		// The helper exists because adapter-node's throw does not merely cost an
		// audit attribution — it takes the surrounding mutation with it, and on a
		// download path it 500s for every visitor. A route that calls the raw
		// function has opted out of that protection without saying so, which is
		// invisible in review and only shows up as a misconfigured deployment
		// losing writes. Grepping is the only way to state the invariant.
		const offenders = sourceFiles('src/routes').filter((path) =>
			readFileSync(path, 'utf8').includes('getClientAddress()')
		);

		expect(offenders).toEqual([]);
	});
});
