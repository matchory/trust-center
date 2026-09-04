import { count, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent } from '../../src/lib/server/audit';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent, eventEndpoint, setting } from '../../src/lib/server/db/schema';
import { checkSigningKeyCanary } from '../../src/lib/server/egress/canary';
import {
	claimDeliveries,
	deliverClaimed,
	disableStaleEndpoints
} from '../../src/lib/server/egress/deliver';
import { CANARY_SETTING_KEY } from '../../src/lib/server/egress/secret';
import { fanOut } from '../../src/lib/server/egress/fanout';
import { createEndpoint, deliverOptions, webhookFixture } from '../helpers/egress';

let db: Db;
let close: () => Promise<void>;

const webhooks = webhookFixture();

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	await db.delete(eventEndpoint);
	await db.delete(setting).where(eq(setting.key, CANARY_SETTING_KEY));
});

afterEach(async () => {
	await webhooks.closeAll();
});

// Sequential rather than random: (endpoint_id, audit_seq) is unique, and a
// random seq makes a collision a rare flake rather than never.
let syntheticSeq = 0;

/** One failed attempt in the window, which is the second half of the rule. */
async function addFailedAttempt(endpointId: string, hoursAgo: number) {
	syntheticSeq++;
	await db.execute(sql`
		INSERT INTO event_delivery
			(endpoint_id, audit_seq, audit_id, status, attempts, last_error, created_at, next_attempt_at)
		VALUES (${endpointId}::uuid, ${syntheticSeq}, gen_random_uuid(),
		        'failed', 5, 'http_status',
		        now() - make_interval(hours => ${hoursAgo}),
		        now() - make_interval(hours => ${hoursAgo}))
	`);
}

async function auditCount(action: string): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(auditEvent)
		.where(eq(auditEvent.action, action));
	return Number(row?.n ?? 0);
}

async function subjectCount(endpointId: string): Promise<number> {
	const [row] = await db
		.select({ n: count() })
		.from(auditEvent)
		.where(eq(auditEvent.subjectId, endpointId));
	return Number(row?.n ?? 0);
}

describe('disableStaleEndpoints', () => {
	it('disables an endpoint with no success in 24 hours and an attempt in that window', async () => {
		const endpointId = await createEndpoint(db, [], {
			lastSuccessAt: sql`now() - interval '30 hours'`
		});
		await addFailedAttempt(endpointId, 2);

		const before = await auditCount('event_endpoint.disabled');
		const result = await disableStaleEndpoints(db);

		expect(result.disabled).toEqual([endpointId]);

		const [row] = await db.select().from(eventEndpoint).where(eq(eventEndpoint.id, endpointId));
		expect(row?.enabled).toBe(false);
		expect(row?.disabledAt).toBeInstanceOf(Date);
		expect(row?.disabledReason).toBeTruthy();

		// The one exception to §9: safe because by the time it is written that
		// endpoint is disabled and cannot deliver it, and another endpoint
		// delivering it is desirable — "your Teams endpoint just went down" is
		// exactly the notice an operator wants in the channel that still works.
		expect(await auditCount('event_endpoint.disabled')).toBe(before + 1);
	});

	// The permanently-dead endpoint that never succeeded once, which a NULL
	// last_success_at would exempt forever (plan §Smaller corrections).
	it('disables an endpoint that has never succeeded, measured from created_at', async () => {
		const endpointId = await createEndpoint(db, [], {
			createdAt: sql`now() - interval '30 hours'`
		});
		await addFailedAttempt(endpointId, 1);

		expect((await disableStaleEndpoints(db)).disabled).toEqual([endpointId]);
	});

	it('leaves an endpoint alone while it is still succeeding', async () => {
		const endpointId = await createEndpoint(db, [], {
			lastSuccessAt: sql`now() - interval '1 hour'`
		});
		await addFailedAttempt(endpointId, 0);

		expect((await disableStaleEndpoints(db)).disabled).toEqual([]);
		const [row] = await db.select().from(eventEndpoint).where(eq(eventEndpoint.id, endpointId));
		expect(row?.enabled).toBe(true);
	});

	/**
	 * A quiet endpoint is not a broken one. Without the "at least one attempt in
	 * the window" half, an operator whose channel simply had no matching events
	 * for a day would find it disabled.
	 */
	it('leaves a quiet endpoint alone when nothing was attempted', async () => {
		await createEndpoint(db, [], {
			createdAt: sql`now() - interval '40 hours'`,
			lastSuccessAt: sql`now() - interval '30 hours'`
		});

		expect((await disableStaleEndpoints(db)).disabled).toEqual([]);
	});

	it('is idempotent — a disabled endpoint is not disabled twice', async () => {
		const endpointId = await createEndpoint(db, [], {
			lastSuccessAt: sql`now() - interval '30 hours'`
		});
		await addFailedAttempt(endpointId, 2);

		await disableStaleEndpoints(db);
		const after = await auditCount('event_endpoint.disabled');
		await disableStaleEndpoints(db);

		expect(await auditCount('event_endpoint.disabled')).toBe(after);
	});

	it('names the endpoint as the subject and keeps the URL out of meta', async () => {
		const endpointId = await createEndpoint(db, [], {
			url: 'https://hooks.example.test/a?secret=abc123',
			lastSuccessAt: sql`now() - interval '30 hours'`
		});
		await addFailedAttempt(endpointId, 1);
		await disableStaleEndpoints(db);

		const [event] = await db.select().from(auditEvent).where(eq(auditEvent.subjectId, endpointId));

		// Found by audit_event_subject_idx rather than by digging through meta.
		expect(event?.subjectType).toBe('event_endpoint');
		expect(event?.actorType).toBe('system');
		// A Teams Workflows URL carries its shared secret in the query string,
		// and this table cannot be deleted from (spec §9).
		expect(JSON.stringify(event?.meta)).not.toContain('secret=abc123');
		expect(JSON.stringify(event?.meta)).not.toContain('hooks.example.test');
		expect(event?.meta).toMatchObject({ name: 'n8n', format: 'generic' });
	});
});

describe('the loop-prevention rule', () => {
	/**
	 * GUARD — spec §13's third load-bearing guard, in the counting form it
	 * names: "a failed delivery writes no audit event, and a day of failures
	 * writes exactly one".
	 *
	 * An audit event written on delivery success or failure would match its own
	 * endpoint's filter, fan out into a new event_delivery, deliver or fail,
	 * write another audit event, and recur — an unbounded loop whose first
	 * symptom is an operator's Teams channel filling at 15-second intervals
	 * (spec §9).
	 *
	 * This drives the **real** delivery path — one 200 then four 500s — before
	 * the disable, which is what makes it discriminate: `deliverClaimed`'s
	 * success branch and its failure branch both run here, so a later
	 * contributor adding a generic "endpoint changed → record
	 * event_endpoint.updated" next to the `last_success_at` update is caught by
	 * the count. Verified by doing exactly that and watching this test fail.
	 */
	it('writes no audit event for a delivery, and exactly one for the disable', async () => {
		let calls = 0;
		const server = await webhooks.serve((_request, response) => {
			calls++;
			// The first attempt succeeds so the success branch — the one that
			// stamps last_success_at — actually executes; the rest fail.
			response.writeHead(calls === 1 ? 200 : 500).end();
		});
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });

		for (let i = 0; i < 5; i++) {
			await recordEvent(db, {
				action: 'certification.created',
				actor: { type: 'staff', id: crypto.randomUUID() },
				subjectType: 'certification',
				subjectId: crypto.randomUUID(),
				meta: { slug: 'iso-27001' }
			});
		}

		const claimed = await db.transaction(async (tx) => {
			await fanOut(tx);
			return claimDeliveries(tx);
		});
		const result = await deliverClaimed(db, claimed, deliverOptions(server.port));
		expect(result).toEqual({ delivered: 1, failed: 4, skipped: 0 });

		// Half one: neither branch of the delivery path is allowed to write.
		expect(await subjectCount(endpointId)).toBe(0);

		// The success above stamped last_success_at; a day of failures since is
		// what auto-disable measures.
		await db
			.update(eventEndpoint)
			.set({ lastSuccessAt: new Date(Date.now() - 30 * 60 * 60 * 1000) })
			.where(eq(eventEndpoint.id, endpointId));

		// Several ticks, as a real day would produce.
		await disableStaleEndpoints(db);
		await disableStaleEndpoints(db);
		await disableStaleEndpoints(db);

		// Half two: exactly one, and it is the disable.
		expect(await subjectCount(endpointId)).toBe(1);
		const [event] = await db.select().from(auditEvent).where(eq(auditEvent.subjectId, endpointId));
		expect(event?.action).toBe('event_endpoint.disabled');
		expect(event?.meta).toMatchObject({ lastStatusCode: 500 });
	});
});

describe('checkSigningKeyCanary', () => {
	it('stores the canary on first use and matches thereafter', async () => {
		expect(await checkSigningKeyCanary(db, 'k'.repeat(32))).toBe('ok');
		expect(await checkSigningKeyCanary(db, 'k'.repeat(32))).toBe('ok');
	});

	/**
	 * Restoring a backup into an environment with a different key silently
	 * re-keys every endpoint, and nothing detects it — the one property a
	 * stored secret gets for free and derivation otherwise loses. One row, and
	 * it converts a silent failure into a loud one (spec §7.1).
	 */
	it('reports a mismatch when the root key changed', async () => {
		await checkSigningKeyCanary(db, 'k'.repeat(32));
		expect(await checkSigningKeyCanary(db, 'j'.repeat(32))).toBe('mismatch');
	});

	it('reports absent when no key is configured', async () => {
		expect(await checkSigningKeyCanary(db, undefined)).toBe('absent');
	});

	it('does not store a canary for an absent key', async () => {
		await checkSigningKeyCanary(db, undefined);
		const rows = await db.select().from(setting).where(eq(setting.key, CANARY_SETTING_KEY));
		expect(rows).toHaveLength(0);
	});
});
