import { createHmac } from 'node:crypto';

/**
 * Where the canary lives in `setting`. Permanent: an operator restoring a
 * backup into an environment with a different key is exactly who this row is
 * for, and a renamed key would read as "never set" to them.
 */
export const CANARY_SETTING_KEY = 'egress.signing_key_canary';

/**
 * `event_endpoint` has no secret column. What that buys is narrower than it
 * first looks — `subscription.manage_token` is already stored unhashed, with
 * its own written rationale, so this is not the codebase's only readable-back
 * secret. What derivation actually buys is that **a database-only compromise
 * yields no signing material**: a leaked backup, a read replica or a
 * SQL-injection read gives an attacker every endpoint row and still no ability
 * to forge a signature (spec §7.1).
 */
export function endpointSecret(rootKey: string, endpointId: string, version: number): Buffer {
	return createHmac('sha256', rootKey).update(`${endpointId}:${version}`).digest();
}

/**
 * Signs `${t}.${body}`. Each attempt re-signs with a fresh `t`, because a retry
 * re-renders from live state and is not byte-identical to the attempt before
 * it — so a stored signature could not be replayed even if we wanted to (spec
 * §7). A consumer should reject a timestamp outside a few minutes' tolerance;
 * our own retries span at most fifteen minutes but never reuse a `t`, so a
 * tight tolerance does not conflict with the backoff.
 */
export function signBody(secret: Buffer, timestampSeconds: number, body: string): string {
	return createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
}

/**
 * `t=<seconds>,v1=<hex>[,v1=<hex>]` — the comma-separated form consumer
 * libraries already expect, which is what lets a rotation emit the new secret
 * and the previous one together for a grace period.
 */
export function signatureHeader(
	secrets: readonly Buffer[],
	timestampSeconds: number,
	body: string
): string {
	const signatures = secrets.map((secret) => `v1=${signBody(secret, timestampSeconds, body)}`);
	return [`t=${timestampSeconds}`, ...signatures].join(',');
}

/**
 * Stored on first use and compared at the head of every delivery tick — NOT
 * at boot; `checkSigningKeyCanary`'s own docstring records why a database row
 * must not be able to stop the container. Without it, restoring a
 * backup into an environment with a different or absent EVENT_SIGNING_KEY
 * silently re-keys every endpoint and nothing detects it — the one property a
 * stored secret gets for free and derivation otherwise loses. One row, and it
 * converts a silent failure into a loud one (spec §7.1).
 */
export function canaryValue(rootKey: string): string {
	return createHmac('sha256', rootKey).update('canary').digest('hex');
}
