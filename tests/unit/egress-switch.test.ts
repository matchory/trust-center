import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/lib/server/db';

/**
 * `EVENT_EGRESS_ENABLED` off means **nothing leaves the container**, however
 * many endpoints exist in the database. That is the sovereignty claim
 * `docs/self-hosting.md` §9 makes to a procurement reviewer, and until this
 * file existed only half of it was tested: `config.test.ts` asserts the flag
 * parses to `false` by default, and nothing asserted that the job honours it.
 *
 * Mocked rather than driven through a database, because the property is which
 * calls are NOT made — and a test that proves absence has to control every
 * collaborator to be worth anything.
 */
const egressEnabled = vi.fn(() => false);

vi.mock('../../src/lib/server/config', () => ({
	getConfig: () => ({
		baseUrl: 'https://trust.example.com',
		defaultLocale: 'de',
		egress: { enabled: egressEnabled(), signingKey: 'k'.repeat(32), allow: undefined }
	})
}));

const fanOut = vi.fn(async () => ({ enqueued: 0, paused: [] as string[] }));
const claimDeliveries = vi.fn(async () => []);
const deliverClaimed = vi.fn(async () => ({ delivered: 0, failed: 0, skipped: 0 }));
const disableStaleEndpoints = vi.fn(async () => ({ disabled: [] as string[] }));
const checkSigningKeyCanary = vi.fn(async () => 'ok' as const);

vi.mock('../../src/lib/server/egress/fanout', () => ({
	fanOut: () => fanOut(),
	currentHorizon: async () => 0n
}));

vi.mock('../../src/lib/server/egress/deliver', () => ({
	claimDeliveries: () => claimDeliveries(),
	deliverClaimed: () => deliverClaimed(),
	disableStaleEndpoints: () => disableStaleEndpoints()
}));

vi.mock('../../src/lib/server/egress/canary', () => ({
	checkSigningKeyCanary: () => checkSigningKeyCanary()
}));

// A transaction that runs its callback, so the claim phase is exercised
// whenever it is reached at all.
const db = { transaction: async (fn: (tx: Db) => unknown) => fn({} as Db) } as unknown as Db;

const { runEgressClaim, runEgressDeliveries } = await import('../../src/lib/server/egress');

beforeEach(() => {
	vi.clearAllMocks();
});

describe('the egress kill switch', () => {
	it('fans out nothing, claims nothing and checks no canary when egress is off', async () => {
		egressEnabled.mockReturnValue(false);

		await runEgressClaim(db);
		await runEgressDeliveries(db);

		expect(fanOut).not.toHaveBeenCalled();
		expect(claimDeliveries).not.toHaveBeenCalled();
		expect(deliverClaimed).not.toHaveBeenCalled();
		// Not merely "no HTTP": the tick returns before it reads the signing-key
		// canary, so a deployment with egress off touches none of this at all.
		expect(checkSigningKeyCanary).not.toHaveBeenCalled();
		// Auto-disable is gated on the same flag — an endpoint must not be
		// disabled for going quiet while the operator had egress switched off.
		expect(disableStaleEndpoints).not.toHaveBeenCalled();
	});

	/**
	 * The positive control. Without it the assertions above would pass just as
	 * well if the mock wiring were broken and nothing were reachable — which is
	 * the failure mode a test asserting absence is most prone to.
	 */
	it('fans out and claims when egress is on', async () => {
		egressEnabled.mockReturnValue(true);

		await runEgressClaim(db);
		await runEgressDeliveries(db);

		expect(fanOut).toHaveBeenCalled();
		expect(claimDeliveries).toHaveBeenCalled();
		expect(checkSigningKeyCanary).toHaveBeenCalled();
		expect(disableStaleEndpoints).toHaveBeenCalled();
	});
});
