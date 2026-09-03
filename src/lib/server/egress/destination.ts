import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';

export type AllowEntry =
	{ kind: 'host'; host: string; port: number | undefined } | { kind: 'cidr'; cidr: string };

export type PinnedAddress = { address: string; family: 4 | 6; port: number };
export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;

export class EgressDestinationRejected extends Error {
	constructor(
		message: string,
		readonly reason: 'url' | 'destination_denied'
	) {
		super(message);
		this.name = 'EgressDestinationRejected';
	}
}

/**
 * A CIDR's bits component must be a plain integer within range for its
 * address family (0-32 for an IPv4 base, 0-128 for IPv6). Left unchecked, a
 * BigInt `<<` by a negative amount right-shifts instead of throwing, so an
 * out-of-range value (e.g. `/40` on an IPv4 base) collapses `inCidr`'s mask
 * to a single bit no address can ever have set — every comparison then
 * reduces to `0n === 0n`, matching every address regardless of base. A
 * malformed allowlist entry must halt delivery loudly rather than silently
 * widen it, so this throws instead of dropping the entry.
 */
function validateCidr(cidr: string): void {
	const [base, bitsRaw] = cidr.split('/');
	const bits =
		base !== undefined && bitsRaw !== undefined && /^\d+$/.test(bitsRaw)
			? Number(bitsRaw)
			: undefined;
	const max = base !== undefined && isIPv4(base) ? 32 : 128;

	if (bits === undefined || bits > max) {
		throw new EgressDestinationRejected(`${cidr} is not a valid CIDR`, 'url');
	}
}

/** `n8n:5678, 10.1.0.0/16, hooks.internal` — hosts, host:port, or CIDRs. */
export function parseAllowList(raw: string | undefined): AllowEntry[] {
	if (!raw) return [];

	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry): AllowEntry => {
			if (entry.includes('/')) {
				validateCidr(entry);
				return { kind: 'cidr', cidr: entry };
			}

			const colon = entry.lastIndexOf(':');
			// A bare IPv6 literal has colons too, so only a trailing all-digit
			// segment counts as a port.
			if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1)) && !isIP(entry)) {
				return {
					kind: 'host',
					host: entry.slice(0, colon).toLowerCase(),
					port: Number(entry.slice(colon + 1))
				};
			}

			return { kind: 'host', host: entry.toLowerCase(), port: undefined };
		});
}

/** IPv4 dotted quad to a 32-bit integer. Canonical input only — see `isIPv4`. */
function ipv4ToInt(address: string): bigint {
	return address
		.split('.')
		.reduce((accumulator, octet) => (accumulator << 8n) + BigInt(Number(octet)), 0n);
}

function ipv6ToInt(address: string): bigint {
	const [head, tail] = address.split('::');
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];

	return groups.reduce(
		(accumulator, group) => (accumulator << 16n) + BigInt(parseInt(group || '0', 16)),
		0n
	);
}

/**
 * `::ffff:169.254.169.254` is the cloud metadata endpoint wearing an IPv6 hat,
 * and a classifier correct only for canonical input is not a classifier
 * (spec §6.3). Every comparison below therefore runs on the IPv4 form when one
 * exists.
 */
function unmap(address: string): string {
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	return mapped ? mapped[1]! : address;
}

/**
 * `denied` is denied unconditionally — the allowlist cannot reach it.
 * `169.254.169.254` is the cloud metadata endpoint; no legitimate webhook
 * lives there and no configuration makes reaching it the operator's intent.
 * `private` needs an allowlist entry. Everything else is `public`.
 */
export function classifyAddress(address: string): 'denied' | 'private' | 'public' {
	const normalised = unmap(address).toLowerCase();

	if (isIPv4(normalised)) {
		const value = ipv4ToInt(normalised);
		const inRange = (cidr: string) => {
			const [base, bits] = cidr.split('/');
			const mask = (1n << 32n) - (1n << (32n - BigInt(bits!)));
			return (value & mask) === (ipv4ToInt(base!) & mask);
		};

		if (inRange('127.0.0.0/8')) return 'denied';
		if (inRange('169.254.0.0/16')) return 'denied';
		if (inRange('0.0.0.0/8')) return 'denied';
		if (inRange('224.0.0.0/4')) return 'denied';
		if (inRange('255.255.255.255/32')) return 'denied';
		// CGNAT is in scope because Alibaba Cloud's metadata service is at
		// 100.100.100.200, which the unconditional denials do not name.
		if (inRange('10.0.0.0/8') || inRange('172.16.0.0/12') || inRange('192.168.0.0/16')) {
			return 'private';
		}
		if (inRange('100.64.0.0/10')) return 'private';

		return 'public';
	}

	const value = ipv6ToInt(normalised);
	const inRange6 = (base: string, bits: number) => {
		const mask = (1n << 128n) - (1n << BigInt(128 - bits));
		return (value & mask) === (ipv6ToInt(base) & mask);
	};

	if (value === 0n) return 'denied'; // ::
	if (value === 1n) return 'denied'; // ::1
	if (inRange6('fe80::', 10)) return 'denied';
	if (inRange6('ff00::', 8)) return 'denied';
	if (inRange6('fc00::', 7)) return 'private';

	return 'public';
}

/** Letters, digits, hyphens and dots, with a non-numeric last label. */
const HOSTNAME =
	/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validated on save and re-validated at delivery. POST only, https — with
 * http permitted only when §6.3's allowlist covers the destination, since an
 * in-cluster n8n on a private address is the one case where TLS is reasonably
 * absent. Ports are 80, 443, or one the allowlist names explicitly.
 *
 * A numeric host must be a canonical IP literal: `2130706433` and `0177.0.0.1`
 * are 127.0.0.1 in decimal and octal, and admitting them would put the whole
 * of `classifyAddress` behind a string comparison that never runs.
 */
export function validateEndpointUrl(raw: string, allow: readonly AllowEntry[] = []): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new EgressDestinationRejected('not a URL', 'url');
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new EgressDestinationRejected(`scheme ${url.protocol} is not permitted`, 'url');
	}
	if (url.username !== '' || url.password !== '') {
		throw new EgressDestinationRejected('a URL with userinfo carries a credential', 'url');
	}

	// A trailing dot is a valid absolute name and resolves identically, so it is
	// normalised away rather than rejected — otherwise the saved string and the
	// classified host differ by a character.
	const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
	if (hostname.startsWith('[')) {
		throw new EgressDestinationRejected('an IPv6 literal destination is not permitted', 'url');
	}
	if (!HOSTNAME.test(hostname) && !isIPv4(hostname)) {
		throw new EgressDestinationRejected(`${url.hostname} is not a canonical host`, 'url');
	}
	// The WHATWG URL parser silently rewrites a numeric host — decimal, octal
	// or hex — to canonical dotted-decimal IPv4 while parsing, so by the time
	// `url.hostname` is read here, `2130706433` and `0177.0.0.1` already read
	// back identically to a legitimately-typed `127.0.0.1`; the check above
	// can no longer tell them apart. The rewrite only ever *produces* IPv4, so
	// it is enough to require that whenever the parsed hostname is IPv4, the
	// host text as the operator wrote it was already canonical IPv4 too.
	if (isIPv4(hostname)) {
		// A trailing dot is stripped for the same reason as above — compare
		// against the same normalised form, or a legitimately-typed
		// `127.0.0.1.` would be rejected as if it were smuggled.
		const rawHost = (
			/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]*)/i.exec(raw)?.[1] ?? ''
		).replace(/\.$/, '');
		if (!isIPv4(rawHost)) {
			throw new EgressDestinationRejected(`${raw} is not a canonical host`, 'url');
		}
	}
	url.hostname = hostname;

	const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
	const allowedPort =
		port === 80 ||
		port === 443 ||
		allow.some((entry) => entry.kind === 'host' && entry.port === port);
	if (!allowedPort) {
		throw new EgressDestinationRejected(`port ${port} is not permitted`, 'url');
	}

	return url;
}

/**
 * Resolution and connection are bound together: every returned address is
 * classified, and the *validated* address is what the caller hands to the
 * socket (`client.ts` passes it through `node:https`'s `lookup` option), so
 * the connection goes to the address that was checked rather than to whatever
 * a second resolution returns. That closes the DNS-rebinding window, which
 * against this threat model — a compromised admin, who chooses the hostname —
 * is the whole attack rather than an edge case (spec §6.3).
 */
export async function resolveDestination(
	url: URL,
	allow: readonly AllowEntry[],
	lookup: LookupAll = (host) => dnsLookup(host, { all: true })
): Promise<PinnedAddress> {
	const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);

	let resolved: { address: string; family: number }[];
	try {
		resolved = await lookup(url.hostname);
	} catch {
		throw new EgressDestinationRejected(`${url.hostname} did not resolve`, 'destination_denied');
	}

	if (resolved.length === 0) {
		throw new EgressDestinationRejected(
			`${url.hostname} resolved to nothing`,
			'destination_denied'
		);
	}

	const permitsHost = allow.some(
		(entry) =>
			entry.kind === 'host' &&
			entry.host === url.hostname &&
			(entry.port === undefined || entry.port === port)
	);

	for (const candidate of resolved) {
		const classification = classifyAddress(candidate.address);

		// Checked for EVERY returned address, not only the one that would be
		// used: a name resolving to one public and one denied address is a
		// rebinding attempt, and picking the good one leaves it live.
		if (classification === 'denied') {
			throw new EgressDestinationRejected(
				'the destination resolves into denied address space',
				'destination_denied'
			);
		}

		if (classification === 'private') {
			const permitted =
				permitsHost ||
				allow.some((entry) => entry.kind === 'cidr' && inCidr(candidate.address, entry.cidr));
			if (!permitted) {
				throw new EgressDestinationRejected(
					'the destination resolves into private address space and is not allowlisted',
					'destination_denied'
				);
			}
		}

		// Plain http is admitted only for an allowlisted destination — the
		// in-cluster n8n case (spec §6.2).
		if (url.protocol === 'http:' && classification === 'public') {
			throw new EgressDestinationRejected('http is permitted only inside the allowlist', 'url');
		}
	}

	const first = resolved[0]!;
	return { address: first.address, family: first.family === 6 ? 6 : 4, port };
}

function inCidr(address: string, cidr: string): boolean {
	const [base, bitsRaw] = cidr.split('/');
	if (!base || !bitsRaw || !/^\d+$/.test(bitsRaw)) return false;

	const normalised = unmap(address);
	const bits = Number(bitsRaw);

	// Defence in depth for a caller that builds an `AllowEntry` directly
	// rather than through `parseAllowList` — see `validateCidr` for why an
	// unranged bit count must never reach the mask arithmetic below.
	if (isIPv4(normalised) && isIPv4(base)) {
		if (bits > 32) return false;
		const mask = (1n << 32n) - (1n << (32n - BigInt(bits)));
		return (ipv4ToInt(normalised) & mask) === (ipv4ToInt(base) & mask);
	}
	if (!isIPv4(normalised) && !isIPv4(base)) {
		if (bits > 128) return false;
		const mask = (1n << 128n) - (1n << (128n - BigInt(bits)));
		return (ipv6ToInt(normalised) & mask) === (ipv6ToInt(base) & mask);
	}

	return false;
}
