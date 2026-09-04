import { eventEndpoint, eventEndpointFilter } from '../../src/lib/server/db/schema';
import type { Db } from '../../src/lib/server/db';
import { currentHorizon } from '../../src/lib/server/audit';
import { parseAllowList } from '../../src/lib/server/egress/destination';

/**
 * An endpoint whose cursor starts where a real one does: the live horizon.
 * A test that needs a reachable URL passes one through `overrides`; the
 * default is unroutable on purpose, so a test that means to deliver has to
 * say so.
 */
export async function createEndpoint(
	db: Db,
	patterns: string[] = [],
	overrides: Record<string, unknown> = {}
): Promise<string> {
	const horizon = await currentHorizon(db);
	const [row] = await db
		.insert(eventEndpoint)
		.values({
			name: 'n8n',
			url: 'https://hooks.example.test/a',
			format: 'generic',
			cursorXmin: horizon,
			cursorSeq: 0n,
			...overrides
		})
		.returning({ id: eventEndpoint.id });

	for (const pattern of patterns) {
		await db.insert(eventEndpointFilter).values({ endpointId: row!.id, pattern });
	}
	return row!.id;
}

/**
 * `classifyAddress` denies 127.0.0.0/8 unconditionally — the allowlist cannot
 * reach it — and the webhook fixture listens there, so a real delivery is
 * exercised through the one seam that exists for it: `lookup` is stubbed to a
 * private address that a `127.0.0.1:<port>` allow entry admits by host, and
 * Node's own connection logic bypasses a custom `lookup` entirely once the
 * hostname is already a literal IP (as it is here), so the socket still
 * reaches the fixture rather than the stub address. `validateEndpointUrl`
 * separately requires the fixture's OS-assigned port to be named explicitly,
 * which a bare CIDR entry never satisfies — hence one allow entry per active
 * fixture port, built fresh per test rather than once per module.
 */
export function deliverOptions(...ports: number[]) {
	return {
		baseUrl: 'https://trust.example.com',
		locale: 'en',
		signingKey: 'k'.repeat(32),
		allow: parseAllowList(ports.map((port) => `127.0.0.1:${port}`).join(',')),
		// The switch a real deployment reads from `EVENT_EGRESS_ENABLED`. On here
		// because these suites are about what delivery does when it is allowed to
		// run; `egress-switch.test.ts` owns the off case.
		enabled: true,
		lookup: async () => [{ address: '10.1.2.3', family: 4 }]
	};
}

// Re-exported so the integration suites keep importing their egress helpers
// from one module; it lives in `webhook-server.ts` because the unit suite needs
// it without this module's Drizzle imports.
export { webhookFixture } from './webhook-server';
