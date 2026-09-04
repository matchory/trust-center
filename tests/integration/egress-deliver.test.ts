import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { recordEvent } from '../../src/lib/server/audit';
import {
	accessGrant,
	eventDelivery,
	eventEndpoint,
	requester
} from '../../src/lib/server/db/schema';
import { claimDeliveries, deliverClaimed } from '../../src/lib/server/egress/deliver';
import { parseAllowList } from '../../src/lib/server/egress/destination';
import { fanOut } from '../../src/lib/server/egress/fanout';
import { expectNoSensitiveAttributes, recordingSpans } from '../helpers/telemetry';
import { createEndpoint, deliverOptions, webhookFixture } from '../helpers/egress';
import { startWebhookServer } from '../helpers/webhook-server';

let db: Db;
let close: () => Promise<void>;

const webhooks = webhookFixture();

const spans = recordingSpans();

const OPTIONS = {
	baseUrl: 'https://trust.example.com',
	locale: 'en',
	signingKey: 'k'.repeat(32),
	allow: parseAllowList('127.0.0.1/32')
};

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
});

afterEach(async () => {
	await webhooks.closeAll();
});

/** One `certification.created` event, which takes the fallback path. */
async function emitFallbackEvent() {
	await recordEvent(db, {
		action: 'certification.created',
		actor: { type: 'staff', id: crypto.randomUUID() },
		subjectType: 'certification',
		subjectId: crypto.randomUUID(),
		meta: { slug: 'iso-27001' }
	});
}

async function tick(...ports: number[]) {
	const claimed = await db.transaction(async (tx) => {
		await fanOut(tx);
		return claimDeliveries(tx);
	});
	return deliverClaimed(db, claimed, deliverOptions(...ports));
}

async function deliveryRow(endpointId: string) {
	const [row] = await db
		.select()
		.from(eventDelivery)
		.where(eq(eventDelivery.endpointId, endpointId))
		.limit(1);
	return row;
}

describe('deliverClaimed', () => {
	it('POSTs the formatted body with the signature and delivery headers', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(204).end());
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });
		await emitFallbackEvent();

		const result = await tick(server.port);

		expect(result).toEqual({ delivered: 1, failed: 0, skipped: 0 });
		expect(server.requests).toHaveLength(1);

		const request = server.requests[0]!;
		expect(request.headers['x-trust-center-event']).toBe('certification.created');
		expect(request.headers['x-trust-center-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
		expect(JSON.parse(request.body).event).toBe('certification.created');

		const row = await deliveryRow(endpointId);
		expect(row?.status).toBe('delivered');
		expect(row?.attempts).toBe(1);
		expect(row?.lastStatusCode).toBe(204);
		expect(row?.deliveredAt).toBeInstanceOf(Date);

		// The delivery id is the idempotency key: because retries re-render, a
		// consumer cannot deduplicate on a body hash (spec §7.2).
		expect(request.headers['x-trust-center-delivery']).toBe(row?.id);
		expect(JSON.parse(request.body).delivery_id).toBe(row?.id);
	});

	it('stamps last_success_at on the endpoint', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });
		await emitFallbackEvent();
		await tick(server.port);

		const [row] = await db
			.select({ lastSuccessAt: eventEndpoint.lastSuccessAt })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));
		expect(row?.lastSuccessAt).toBeInstanceOf(Date);
	});

	it('retries a 503 on the 1/2/4/8 schedule and fails after five attempts', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(503).end());
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });
		await emitFallbackEvent();

		for (let attempt = 1; attempt <= 5; attempt++) {
			// Each pass claims the row again: the claim pushes next_attempt_at
			// forward, so it is pulled back here rather than waiting minutes.
			await db.update(eventDelivery).set({ nextAttemptAt: new Date(Date.now() - 1000) });
			const result = await tick(server.port);
			expect(result.failed, `attempt ${attempt}`).toBe(1);

			const row = await deliveryRow(endpointId);
			expect(row?.attempts).toBe(attempt);
			expect(row?.status).toBe(attempt === 5 ? 'failed' : 'pending');
			expect(row?.lastError).toBe('http_status');
			expect(row?.lastStatusCode).toBe(503);
		}

		expect(server.requests).toHaveLength(5);
	});

	/**
	 * Retrying a 404 five times over fifteen minutes buys nothing and delays
	 * the operator seeing a misconfiguration by a quarter of an hour
	 * (spec §5.3).
	 */
	it('fails a 404 on the first attempt', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(404).end());
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });
		await emitFallbackEvent();

		await tick(server.port);

		const row = await deliveryRow(endpointId);
		expect(row?.status).toBe('failed');
		expect(row?.attempts).toBe(1);
		expect(server.requests).toHaveLength(1);
	});

	it('never stores a response body', async () => {
		const server = await webhooks.serve((_request, response) =>
			// The shape that matters: a receiver echoing its input.
			response.writeHead(500).end('requester dana@acme.example could not be created')
		);
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });
		await emitFallbackEvent();
		await tick(server.port);

		const row = await deliveryRow(endpointId);
		expect(row?.lastError).toBe('http_status');
		// A replacer, not a plain JSON.stringify(row): eventDelivery.auditSeq is a
		// bigint column, and JSON.stringify throws on a native BigInt rather than
		// silently dropping it — this would fail the assertion for the wrong
		// reason (an uncaught TypeError) instead of the one under test.
		const serialized = JSON.stringify(row, (_key, value) =>
			typeof value === 'bigint' ? String(value) : value
		);
		expect(serialized).not.toContain('acme.example');
	});

	/**
	 * GUARD — a purged subject is `skipped`, not blanked, and no request is
	 * made. A consumer receiving `name: ""`, `email: ""` cannot distinguish it
	 * from a person with no name, and n8n → HubSpot will create a junk contact,
	 * error, or upsert by an empty email and overwrite an unrelated record
	 * (spec §4.5).
	 *
	 * The subject must be a *real* access_grant belonging to the purged
	 * requester — a random subjectId would return `skip: 'missing'`, which
	 * satisfies the same assertions for the wrong reason and never reaches the
	 * purge branch in `enrich.ts`'s `identity()`.
	 *
	 * To watch this fail: make enrich.ts return the blank row instead of
	 * `{ kind: 'skip' }`.
	 */
	it('skips a delivery whose subject was purged, without making a request', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(db, ['access_grant.*'], { url: server.url });

		const [person] = await db
			.insert(requester)
			.values({
				email: `p-${crypto.randomUUID()}@acme.example`,
				name: 'Dana Vogel',
				company: 'Acme GmbH',
				companyDomain: 'acme.example',
				locale: 'en'
			})
			.returning({ id: requester.id });
		const [grant] = await db
			.insert(accessGrant)
			.values({
				requesterId: person!.id,
				termDays: 30,
				// The inert-grant check requires one of these two columns: a live
				// grant always has an expiry, and this one is not testing lifecycle.
				expiresAt: new Date(Date.now() + 30 * 86_400_000)
			})
			.returning({ id: accessGrant.id });
		await recordEvent(db, {
			action: 'access_grant.revoked',
			actor: { type: 'staff', id: crypto.randomUUID() },
			subjectType: 'access_grant',
			subjectId: grant!.id
		});
		await db.update(requester).set({ purgedAt: new Date() }).where(eq(requester.id, person!.id));

		const result = await tick(server.port);

		expect(result.skipped).toBe(1);
		expect(server.requests).toHaveLength(0);
		const row = await deliveryRow(endpointId);
		// Terminal, so it is never retried, and visible afterwards, so the gap
		// can be explained.
		expect(row?.status).toBe('skipped');
		expect(row?.attempts).toBe(0);
	});

	/**
	 * Round-robin. Without it a single black-holing endpoint delays every other
	 * endpoint's deliveries by the full tick — and §5.1's own justification for
	 * a 15 s interval is that a late notice is a defect.
	 */
	it('delivers to a healthy endpoint in the same tick as a black-holing one', async () => {
		const blackhole = await webhooks.serve(() => {
			/* never responds */
		});
		const healthy = await startWebhookServer((_request, response) => response.writeHead(200).end());

		try {
			await createEndpoint(db, ['certification.*'], { url: blackhole.url });
			const healthyId = await createEndpoint(db, ['certification.*'], { url: healthy.url });
			await emitFallbackEvent();

			const claimed = await db.transaction(async (tx) => {
				await fanOut(tx);
				return claimDeliveries(tx);
			});

			// Both endpoints are represented in one claim.
			expect(new Set(claimed.map((row) => row.endpointId)).size).toBe(2);

			await deliverClaimed(db, claimed, deliverOptions(blackhole.port, healthy.port));
			expect(healthy.requests).toHaveLength(1);

			const row = await deliveryRow(healthyId);
			expect(row?.status).toBe('delivered');
		} finally {
			await healthy.close();
		}
	}, 30_000);

	it('claims at most five rows per endpoint and twenty-five overall', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });
		for (let index = 0; index < 8; index++) await emitFallbackEvent();

		const claimed = await db.transaction(async (tx) => {
			await fanOut(tx);
			return claimDeliveries(tx);
		});

		expect(claimed).toHaveLength(5);
		expect(claimed.every((row) => row.endpointId === endpointId)).toBe(true);
	});

	it('does not claim a row a concurrent tick already claimed', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(200).end());
		await createEndpoint(db, ['certification.*'], { url: server.url });
		await emitFallbackEvent();

		const first = await db.transaction(async (tx) => {
			await fanOut(tx);
			return claimDeliveries(tx);
		});
		const second = await db.transaction((tx) => claimDeliveries(tx));

		// The claim pushes next_attempt_at forward, so a second tick walks past
		// the row rather than delivering it twice (drainOutbox's reasoning).
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(0);
	});

	/**
	 * Spec §5.5: a disabled endpoint neither fans out nor delivers. Fan-out
	 * already enforces this (Task 9); this is the delivery half.
	 *
	 * This asserts the deterministic invariant — a pending delivery on an
	 * already-disabled endpoint is never claimed — rather than racing a disable
	 * into the narrow window between claimDeliveries's two internal queries.
	 * That race (the locked fetch re-checking `e.enabled` because the two
	 * queries take separate snapshots even inside one transaction) is real but
	 * not reliably reproducible from a test without an artificial delay between
	 * the two queries. Disabling before claiming at all, as this test does,
	 * means the row is already excluded by the *first* (unlocked, ranking)
	 * query's own `e.enabled = true` predicate — so this test alone would not
	 * catch the `e.enabled = true` predicate being dropped from the *second*
	 * (locked) query specifically, which is what regressed. It still guards
	 * the end-to-end invariant the two queries exist to jointly uphold, and a
	 * regression in either one's predicate that left both checks equally wrong
	 * would still be caught here.
	 */
	it('does not claim a pending delivery on an already-disabled endpoint', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });
		await emitFallbackEvent();

		// Fan out without claiming, so the row is pending and due before the
		// endpoint is disabled.
		await db.transaction((tx) => fanOut(tx));
		await db
			.update(eventEndpoint)
			.set({ enabled: false, disabledAt: new Date(), disabledReason: 'test' })
			.where(eq(eventEndpoint.id, endpointId));

		const claimed = await db.transaction((tx) => claimDeliveries(tx));

		expect(claimed).toHaveLength(0);
	});

	it('records signing_key_missing without making a request when a generic endpoint has no key', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(db, ['certification.*'], { url: server.url });
		await emitFallbackEvent();

		const claimed = await db.transaction(async (tx) => {
			await fanOut(tx);
			return claimDeliveries(tx);
		});
		const result = await deliverClaimed(db, claimed, { ...OPTIONS, signingKey: undefined });

		expect(result.failed).toBe(1);
		expect(server.requests).toHaveLength(0);
		const row = await deliveryRow(endpointId);
		expect(row?.lastError).toBe('signing_key_missing');
	});

	it('refuses a destination that resolves into denied space at delivery time', async () => {
		// Saved when the allowlist permitted it, delivered after it did not —
		// the check runs at delivery, not only on save (spec §6.3).
		const endpointId = await createEndpoint(db, ['certification.*'], {
			url: 'https://metadata.example.test/a'
		});
		await emitFallbackEvent();

		const claimed = await db.transaction(async (tx) => {
			await fanOut(tx);
			return claimDeliveries(tx);
		});
		const result = await deliverClaimed(db, claimed, {
			...OPTIONS,
			lookup: async () => [{ address: '169.254.169.254', family: 4 }]
		});

		expect(result.failed).toBe(1);
		const row = await deliveryRow(endpointId);
		expect(row?.status).toBe('failed');
		expect(row?.lastError).toBe('destination_denied');
		expect(row?.attempts).toBe(1);
	});
});

/**
 * §8's rule asserted over a span the delivery path actually emitted. It could
 * not be asserted anywhere else: `deliverClaimed` needs a database and a
 * socket, and a hand-constructed span in the unit suite would satisfy
 * `expectNoSensitiveAttributes` while proving nothing about the attributes
 * `withSpan` is really called with.
 */
describe('delivery telemetry', () => {
	it('carries no address, token, IP or endpoint name on the event deliver span', async () => {
		const server = await webhooks.serve((_request, response) => response.writeHead(204).end());
		// Every shape §8 bans, in the two operator-controlled strings this path
		// has to hand: `name` is unvalidated free text and the URL's query string
		// is where a Teams Workflows secret lives (spec §10).
		const name = 'alerts@acme.example via 10.1.2.3';
		const endpointId = await createEndpoint(db, ['certification.*'], {
			url: `${server.url}?token=SECRET`,
			name
		});
		await emitFallbackEvent();

		expect(await tick(server.port)).toEqual({ delivered: 1, failed: 0, skipped: 0 });

		const span = spans().find((finished) => finished.name === 'event deliver');
		expectNoSensitiveAttributes(span, name, 'SECRET', '127.0.0.1');
		// The positive half: the span is not clean by being empty. The UUID is
		// what §10 says stands in for every one of the strings above.
		expect(span?.attributes['egress.endpoint_id']).toBe(endpointId);
		expect(span?.attributes['egress.action']).toBe('certification.created');
		expect(span?.attributes['egress.format']).toBe('generic');
		expect(span?.attributes['http.response.status_code']).toBe(204);
	});
});
