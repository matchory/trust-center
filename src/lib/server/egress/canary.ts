import { eq } from 'drizzle-orm';
import { setting } from '../db/schema';
import { CANARY_SETTING_KEY, canaryValue } from './secret';
import type { Db } from '../db';

/**
 * Compared before every tick — NOT at boot. Nothing calls this from `init`,
 * and the "validated at boot" sentence in spec §7.1 is about a different
 * check: that EVENT_SIGNING_KEY is *present* when an endpoint uses
 * `format = 'generic'`. A mismatch is caught at the head of the next tick,
 * where §7.1's "delivery halts" is what the caller does with the answer.
 *
 * `event_endpoint` holds no secret, so nothing else would notice that
 * EVENT_SIGNING_KEY changed —
 * restoring a backup into an environment with a different or absent key
 * silently re-keys every endpoint and every consumer starts returning 401,
 * which §5.3 makes terminal on the first attempt (spec §7.1).
 *
 * Stored on first use rather than at boot, so a deployment that never enables
 * egress never writes the row.
 */
export async function checkSigningKeyCanary(
	db: Db,
	signingKey: string | undefined
): Promise<'ok' | 'mismatch' | 'absent'> {
	if (signingKey === undefined) return 'absent';

	const expected = canaryValue(signingKey);
	const [row] = await db
		.select({ value: setting.value })
		.from(setting)
		.where(eq(setting.key, CANARY_SETTING_KEY))
		.limit(1);

	if (!row) {
		await db.insert(setting).values({ key: CANARY_SETTING_KEY, value: expected });
		return 'ok';
	}

	// `setting.value` is jsonb, so the hex digest round-trips as a JSON string
	// and reads back typed `unknown`. Anything that is not the expected string —
	// including a hand-edited row of some other shape — is a mismatch, which is
	// the same loud failure a changed root key produces.
	return row.value === expected ? 'ok' : 'mismatch';
}
