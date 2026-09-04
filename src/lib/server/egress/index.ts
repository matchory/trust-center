import { getConfig } from '../config';
import { recordEgressFanout, withSpan } from '../telemetry';
import { checkSigningKeyCanary } from './canary';
import { claimDeliveries, deliverClaimed, disableStaleEndpoints } from './deliver';
import { fanOut } from './fanout';
import type { ClaimedDelivery } from './deliver';
import type { Db } from '../db';

/**
 * Phase one's output, handed to phase two of the same tick. Module-scoped
 * rather than threaded through the `Job` interface: one job needs it, and a
 * generic payload channel on every job is surface with nothing to buy. Safe
 * because the two phases of one tick never overlap — `runJob`'s advisory lock
 * makes a second tick skip rather than queue, and `startJobRunner` only calls
 * phase two on the tick that actually held it.
 */
let claimed: ClaimedDelivery[] = [];

/**
 * Phase one: under the advisory lock, in one transaction.
 *
 * The transaction is opened here rather than inherited from `runJob`.
 * `startJobRunner` passes `() => job.run(getDb())`, so the job body runs on a
 * *pooled* connection while the lock connection holds the transaction — the
 * lock is cluster-wide either way, but `claimDeliveries`' `FOR UPDATE SKIP
 * LOCKED` and the `next_attempt_at` push it pairs with are two statements, and
 * outside a transaction the row locks the first takes are released before the
 * second runs. Spec §5.1 says "in one transaction", `drainOutbox` opens its own
 * for the same claim, and this follows both.
 */
export async function runEgressClaim(db: Db): Promise<void> {
	claimed = [];
	const config = getConfig();
	if (!config.egress.enabled) return;

	// A changed root key means every signature is wrong; delivering anyway would
	// burn all five attempts on every queued event and then auto-disable every
	// endpoint (spec §7.1). Outside the transaction below but still under the
	// lock, which is what makes its first-use INSERT safe across replicas.
	if ((await checkSigningKeyCanary(db, config.egress.signingKey)) === 'mismatch') {
		console.error(
			JSON.stringify({
				level: 'error',
				job: 'egress:deliver',
				message: 'EVENT_SIGNING_KEY does not match the stored canary; egress is halted'
			})
		);
		return;
	}

	claimed = await db.transaction(async (tx) => {
		await withSpan('event fanout', {}, async (span) => {
			const result = await fanOut(tx);
			span.setAttribute('egress.enqueued', result.enqueued);
			recordEgressFanout(result.enqueued);
		});

		return claimDeliveries(tx);
	});
}

/**
 * Phase two: outside the lock and outside any transaction, because this is
 * where the network is (spec §5.1).
 */
export async function runEgressDeliveries(db: Db): Promise<void> {
	// Taken and cleared before the first await: a batch left in place would be
	// delivered a second time by a later tick whose own phase one returned
	// early, and a duplicate POST is not a no-op at the consumer.
	const batch = claimed;
	claimed = [];
	const config = getConfig();

	if (batch.length > 0) {
		await deliverClaimed(db, batch, {
			baseUrl: config.baseUrl,
			// The audience of an egress payload is the operator's own staff and
			// automation, not the requester — rendering a card in the requester's
			// locale would put a German card in an English-speaking team's channel
			// because of who happened to submit the form (spec §3.2).
			locale: config.defaultLocale,
			signingKey: config.egress.signingKey,
			allow: config.egress.allow
		});
	}

	// Evaluated per tick, after the batch, so an endpoint that just succeeded is
	// not disabled by a stale reading.
	if (config.egress.enabled) await disableStaleEndpoints(db);
}
