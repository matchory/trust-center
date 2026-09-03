import { describe, expect, it } from 'vitest';
import {
	classifyAddress,
	EgressDestinationRejected,
	parseAllowList,
	resolveDestination,
	validateEndpointUrl,
	type AllowEntry
} from '../../src/lib/server/egress/destination';

/** A stub resolver, so this whole table stays in the unit suite. */
function resolver(...addresses: string[]) {
	return async () =>
		addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

describe('classifyAddress', () => {
	it('denies loopback, link-local, unspecified and multicast', () => {
		for (const address of [
			'127.0.0.1',
			'127.1.2.3',
			'::1',
			'169.254.169.254',
			'169.254.0.1',
			'fe80::1',
			'0.0.0.0',
			'::',
			'224.0.0.1',
			'ff02::1'
		]) {
			expect(classifyAddress(address), address).toBe('denied');
		}
	});

	/**
	 * A classifier that is correct only for canonical input is not a
	 * classifier. `::ffff:169.254.169.254` is the cloud metadata endpoint
	 * wearing an IPv6 hat.
	 */
	it('normalises IPv4-mapped IPv6 before classifying', () => {
		expect(classifyAddress('::ffff:169.254.169.254')).toBe('denied');
		expect(classifyAddress('::ffff:127.0.0.1')).toBe('denied');
		expect(classifyAddress('::ffff:10.0.0.1')).toBe('private');
		expect(classifyAddress('::ffff:93.184.216.34')).toBe('public');
	});

	it('classifies RFC1918, CGNAT and ULA as private', () => {
		for (const address of [
			'10.0.0.1',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			// CGNAT, which is in scope precisely because Alibaba Cloud's metadata
			// service lives at 100.100.100.200 (spec §6.3).
			'100.64.0.1',
			'100.100.100.200',
			'fc00::1',
			'fd12:3456::1'
		]) {
			expect(classifyAddress(address), address).toBe('private');
		}
	});

	it('leaves ordinary public addresses public', () => {
		expect(classifyAddress('93.184.216.34')).toBe('public');
		expect(classifyAddress('172.32.0.1')).toBe('public');
		expect(classifyAddress('2606:2800:220:1::')).toBe('public');
	});
});

describe('validateEndpointUrl', () => {
	it('accepts an https URL on the default port', () => {
		expect(validateEndpointUrl('https://hooks.example.test/abc').hostname).toBe(
			'hooks.example.test'
		);
	});

	it('accepts an explicit port 80 or 443', () => {
		// Not asserted via `.port`: WHATWG strips a port equal to the scheme's
		// default straight back to `''`, so a scheme-default port can never be
		// read back off the URL itself. The effective port is covered instead
		// by the `resolveDestination` tests, which assert `pinned.port`.
		expect(() => validateEndpointUrl('https://hooks.example.test:443/a')).not.toThrow();
		expect(validateEndpointUrl('https://hooks.example.test:443/a').hostname).toBe(
			'hooks.example.test'
		);
		expect(() => validateEndpointUrl('http://n8n:80/webhook/x')).not.toThrow();
		expect(validateEndpointUrl('http://n8n:80/webhook/x').hostname).toBe('n8n');
	});

	/**
	 * A credential in a field §9 deliberately keeps out of the audit log, and a
	 * contradiction of "no credential is ever attached" (spec §6.2).
	 */
	it('rejects userinfo', () => {
		expect(() => validateEndpointUrl('https://user:pass@hooks.example.test/a')).toThrow(
			EgressDestinationRejected
		);
		expect(() => validateEndpointUrl('https://user@hooks.example.test/a')).toThrow();
	});

	it('rejects a non-http(s) scheme', () => {
		for (const raw of ['file:///etc/passwd', 'gopher://x/1', 'ftp://x/a', 'ws://x/a']) {
			expect(() => validateEndpointUrl(raw), raw).toThrow(EgressDestinationRejected);
		}
	});

	it('rejects a port outside 80 and 443 unless the allowlist names it', () => {
		expect(() => validateEndpointUrl('https://hooks.example.test:10250/a')).toThrow(
			EgressDestinationRejected
		);
		// Named in the allowlist, so the URL itself is acceptable; whether the
		// address is reachable is resolveDestination's question.
		expect(validateEndpointUrl('http://n8n:5678/webhook/x', parseAllowList('n8n:5678')).port).toBe(
			'5678'
		);
	});

	/**
	 * Decimal and octal IPv4 literals, which are the classic way to smuggle a
	 * denied address past a textual check.
	 */
	it('rejects a non-canonical numeric host', () => {
		for (const raw of [
			'https://2130706433/a',
			'https://0177.0.0.1/a',
			'https://0x7f.1/a',
			'https://[::ffff:7f00:1]/a'
		]) {
			expect(() => validateEndpointUrl(raw), raw).toThrow(EgressDestinationRejected);
		}
	});

	it('strips a trailing dot from the hostname', () => {
		expect(validateEndpointUrl('https://hooks.example.test./a').hostname).toBe(
			'hooks.example.test'
		);
	});
});

describe('resolveDestination', () => {
	const url = validateEndpointUrl('https://hooks.example.test/a');

	it('pins the first public address', async () => {
		const pinned = await resolveDestination(url, [], resolver('93.184.216.34'));
		expect(pinned).toEqual({ address: '93.184.216.34', family: 4, port: 443 });
	});

	/**
	 * Every returned address is classified, not just the one that would be
	 * used: a name that resolves to one public and one denied address is a
	 * rebinding attempt, and picking the good one leaves the attack live.
	 */
	it('refuses when any returned address is denied', async () => {
		await expect(
			resolveDestination(url, [], resolver('93.184.216.34', '169.254.169.254'))
		).rejects.toThrow(EgressDestinationRejected);
	});

	it('refuses a private address with an empty allowlist', async () => {
		await expect(resolveDestination(url, [], resolver('10.1.2.3'))).rejects.toThrow(
			EgressDestinationRejected
		);
	});

	it('permits a private address named by host and port in the allowlist', async () => {
		const target = validateEndpointUrl('http://n8n:5678/webhook/x', parseAllowList('n8n:5678'));
		const pinned = await resolveDestination(
			target,
			parseAllowList('n8n:5678'),
			resolver('10.1.2.3')
		);
		expect(pinned).toEqual({ address: '10.1.2.3', family: 4, port: 5678 });
	});

	it('permits a private address inside an allowlisted CIDR', async () => {
		const pinned = await resolveDestination(
			url,
			parseAllowList('10.1.0.0/16'),
			resolver('10.1.2.3')
		);
		expect(pinned.address).toBe('10.1.2.3');
	});

	it('does not permit an address outside the allowlisted CIDR', async () => {
		await expect(
			resolveDestination(url, parseAllowList('10.1.0.0/16'), resolver('10.2.2.3'))
		).rejects.toThrow(EgressDestinationRejected);
	});

	/**
	 * A BigInt `<<` by a negative amount right-shifts instead of throwing, so
	 * an out-of-range bits component (`/40` for an IPv4 base) collapses the
	 * mask to a single bit no address can ever have set: every comparison
	 * then reduces to `0n === 0n`, true for every address regardless of base
	 * — fail-open in the one module whose purpose is fail-closed destination
	 * control. `parseAllowList` rejects a CIDR this malformed before it ever
	 * reaches here (see the `parseAllowList` tests below), but this
	 * constructs the `AllowEntry` directly, bypassing that gate, to prove
	 * `resolveDestination`/`inCidr` also refuse to use it.
	 */
	it('does not let an out-of-range CIDR bit count allowlist an unrelated address', async () => {
		const allow: AllowEntry[] = [{ kind: 'cidr', cidr: '10.1.0.0/40' }];
		await expect(resolveDestination(url, allow, resolver('10.2.2.3'))).rejects.toThrow(
			EgressDestinationRejected
		);
	});

	/**
	 * The allowlist names destinations that may resolve into otherwise-denied
	 * space. It does not — and must not — reach the unconditional denials:
	 * no legitimate webhook lives at a metadata endpoint, and no configuration
	 * makes reaching one the operator's intent (spec §6.3).
	 */
	it('never permits an unconditionally denied address, allowlist or not', async () => {
		for (const allow of ['0.0.0.0/0', '169.254.0.0/16', 'hooks.example.test']) {
			await expect(
				resolveDestination(url, parseAllowList(allow), resolver('169.254.169.254')),
				allow
			).rejects.toThrow(EgressDestinationRejected);
		}
	});

	it('refuses plain http to a public address', async () => {
		const target = validateEndpointUrl('http://hooks.example.test:80/a');
		await expect(resolveDestination(target, [], resolver('93.184.216.34'))).rejects.toThrow(
			EgressDestinationRejected
		);
	});

	it('refuses when the name resolves to nothing', async () => {
		await expect(resolveDestination(url, [], resolver())).rejects.toThrow(
			EgressDestinationRejected
		);
	});
});

describe('parseAllowList', () => {
	it('is empty for an unset or blank value', () => {
		expect(parseAllowList(undefined)).toEqual([]);
		expect(parseAllowList('')).toEqual([]);
	});

	it('parses hosts, host:port and CIDRs', () => {
		expect(parseAllowList('n8n:5678, 10.1.0.0/16 ,hooks.internal')).toEqual([
			{ kind: 'host', host: 'n8n', port: 5678 },
			{ kind: 'cidr', cidr: '10.1.0.0/16' },
			{ kind: 'host', host: 'hooks.internal', port: undefined }
		]);
	});

	/**
	 * A malformed allowlist must halt delivery loudly rather than quietly
	 * widen or narrow it: a missing, non-numeric, or out-of-range bits
	 * component (0-32 for an IPv4 base, 0-128 for IPv6) is rejected here,
	 * before it can reach `inCidr`'s mask arithmetic.
	 */
	it('rejects a CIDR with a missing, non-numeric or out-of-range bits component', () => {
		for (const raw of ['10.1.0.0/', '10.1.0.0/abc', '10.1.0.0/40', 'fc00::/abc', 'fc00::/200']) {
			expect(() => parseAllowList(raw), raw).toThrow(EgressDestinationRejected);
		}
	});
});
