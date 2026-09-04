import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	auditEvent,
	eventDelivery,
	eventEndpoint,
	eventEndpointFilter,
	staffUser
} from '../../src/lib/server/db/schema';
import { currentHorizon } from '../../src/lib/server/audit';
import { parseAllowList } from '../../src/lib/server/egress/destination';
import {
	bumpSecretVersion,
	createEndpoint,
	deleteEndpoint,
	getEndpoint,
	listEndpoints,
	sendTestEvent,
	setEndpointEnabled,
	updateEndpoint
} from '../../src/lib/server/egress/endpoints';
import { createEndpoint as seedEndpointRow, webhookFixture } from '../helpers/egress';

let db: Db;
let close: () => Promise<void>;
let actor: { staffUserId: string; ip: string | null };

/**
 * `createEndpoint` and friends default their whole `options` object from
 * `getConfig()` when it is omitted, and the integration suite runs with no
 * `.env`. The environment is set here, before the first call rather than
 * before the import, for the reason delivery-serve.test.ts records: these are
 * lazy singletons reached for rather than passed in.
 */
beforeAll(async () => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL,
		BASE_URL: 'https://trust.example.com',
		LOCALES: 'de,en',
		DEFAULT_LOCALE: 'de',
		OIDC_ISSUER: 'https://idp.example.com',
		OIDC_CLIENT_ID: 'trust-center',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_ADMIN_GROUP: 'trust-center-admins',
		EVENT_SIGNING_KEY: 'k'.repeat(32)
	});

	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	const [staff] = await db
		.insert(staffUser)
		.values({
			oidcSub: `admin-${crypto.randomUUID()}`,
			email: 'admin@example.test',
			name: 'Endpoint Admin',
			role: 'admin'
		})
		.returning({ id: staffUser.id });
	actor = { staffUserId: staff!.id, ip: '198.51.100.1' };
});

afterAll(async () => {
	// Children before parents. `event_endpoint` cascades to its filters and
	// deliveries; `audit_event` is append-only and its rows stay, which is
	// harmless — every assertion below is scoped to a subject id this file
	// created. Without the staff_user delete, this file's fixture would outlive
	// the run and show up in another file's staff listing.
	await db.delete(eventEndpoint);
	await db.delete(staffUser).where(eq(staffUser.id, actor.staffUserId));
	await close();
});

beforeEach(async () => {
	await db.delete(eventEndpoint);
});

const webhook = webhookFixture();

afterEach(async () => {
	await webhook.closeAll();
});

/**
 * Three queued deliveries with distinct `audit_seq` values, as a day of
 * downtime would leave. `audit_id` is a reference and deliberately not a
 * foreign key, so no `audit_event` row has to exist for these.
 */
function eventDeliveryFixture(endpointId: string) {
	return sql`
		INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id)
		VALUES (${endpointId}::uuid, 9001, gen_random_uuid()),
		       (${endpointId}::uuid, 9002, gen_random_uuid()),
		       (${endpointId}::uuid, 9003, gen_random_uuid())
	`;
}

const VALID = {
	name: 'Ops Teams channel',
	url: 'https://hooks.example.test/webhook/abc',
	format: 'teams' as const,
	patterns: ['access_request.pending', 'access_grant.revoked']
};

describe('createEndpoint', () => {
	it('creates the endpoint with its filters and an audit event', async () => {
		const id = await createEndpoint(db, VALID, actor);

		const detail = await getEndpoint(db, id);
		expect(detail?.name).toBe(VALID.name);
		expect(detail?.patterns.sort()).toEqual([...VALID.patterns].sort());

		const [event] = await db.select().from(auditEvent).where(eq(auditEvent.subjectId, id));
		expect(event?.action).toBe('event_endpoint.created');
		expect(event?.actorType).toBe('staff');
		expect(event?.actorId).toBe(actor.staffUserId);
		expect(event?.subjectType).toBe('event_endpoint');
		// A URL has a query string, and a Teams Workflows URL carries its shared
		// secret in it (spec §9).
		expect(JSON.stringify(event?.meta)).not.toContain('hooks.example.test');
	});

	/**
	 * A new endpoint must not replay eighteen months of history into a Teams
	 * channel on its first tick. A one-line default with a disproportionate
	 * failure mode (spec §2.1).
	 */
	it('starts the cursor at the current horizon rather than at zero', async () => {
		const before = await currentHorizon(db);
		const id = await createEndpoint(db, VALID, actor);

		const [row] = await db
			.select({ xmin: eventEndpoint.cursorXmin, seq: eventEndpoint.cursorSeq })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, id));

		expect(row?.xmin).toBeGreaterThanOrEqual(before);
		expect(row?.seq).toBe(0n);
	});

	it('refuses an invalid URL, an unsupported format and a malformed pattern', async () => {
		await expect(
			createEndpoint(db, { ...VALID, url: 'https://u:p@x.test/a' }, actor)
		).rejects.toThrow();
		await expect(
			createEndpoint(db, { ...VALID, url: 'file:///etc/passwd' }, actor)
		).rejects.toThrow();
		await expect(
			createEndpoint(db, { ...VALID, patterns: ['*.approved'] }, actor)
		).rejects.toThrow();
	});

	/**
	 * A missing signing key means the thing happens *without its security
	 * property* — a payload carrying a prospect's name and address, POSTed to
	 * an endpoint with no authentication. Refused at save; at boot it is a
	 * delivery halt rather than an exit, because a database row must not be
	 * able to stop the container that serves the only UI for fixing it
	 * (spec §7.1, plan C4).
	 */
	it('refuses a generic endpoint when no signing key is configured', async () => {
		await expect(
			createEndpoint(db, { ...VALID, format: 'generic' }, actor, { signingKey: undefined })
		).rejects.toThrow(/EVENT_SIGNING_KEY/);

		// Teams verifies nothing, so a Teams-only operator needs no key.
		await expect(
			createEndpoint(db, { ...VALID, format: 'teams' }, actor, { signingKey: undefined })
		).resolves.toBeTypeOf('string');
	});
});

describe('updateEndpoint', () => {
	it('replaces the filter set and writes one audit event', async () => {
		const id = await createEndpoint(db, VALID, actor);
		await updateEndpoint(db, id, { ...VALID, patterns: ['document.downloaded'] }, actor);

		const detail = await getEndpoint(db, id);
		expect(detail?.patterns).toEqual(['document.downloaded']);

		const [row] = await db
			.select({ n: count() })
			.from(auditEvent)
			.where(and(eq(auditEvent.action, 'event_endpoint.updated'), eq(auditEvent.subjectId, id)));
		expect(Number(row?.n)).toBe(1);
	});
});

describe('setEndpointEnabled', () => {
	it('clears disabled_at and disabled_reason when re-enabled', async () => {
		const id = await createEndpoint(db, VALID, actor);
		await setEndpointEnabled(db, id, { enabled: false, reason: 'paused by an operator' }, actor);

		let [row] = await db.select().from(eventEndpoint).where(eq(eventEndpoint.id, id));
		expect(row?.enabled).toBe(false);
		// "Disabled" always carries its reason, whether a person or the job did
		// it (spec §2.1).
		expect(row?.disabledReason).toBe('paused by an operator');

		await setEndpointEnabled(db, id, { enabled: true }, actor);
		[row] = await db.select().from(eventEndpoint).where(eq(eventEndpoint.id, id));
		expect(row?.enabled).toBe(true);
		expect(row?.disabledAt).toBeNull();
		expect(row?.disabledReason).toBeNull();
	});

	/**
	 * Skipping is the option the UI presents first: a channel flooded with a
	 * day of stale notices is worse than a gap, and audit_event remains the
	 * record of record under either choice — nothing is lost, only un-notified.
	 * `skipped` exists as a status rather than a delete so the gap is visible
	 * afterwards (spec §5.5).
	 */
	it('jumps the cursor and terminates the backlog when re-enabled with skipBacklog', async () => {
		const id = await createEndpoint(db, VALID, actor);
		await db.execute(eventDeliveryFixture(id));
		await setEndpointEnabled(db, id, { enabled: false, reason: 'paused' }, actor);

		const beforeXmin = await currentHorizon(db);
		await setEndpointEnabled(db, id, { enabled: true, skipBacklog: true }, actor);

		const [row] = await db
			.select({ xmin: eventEndpoint.cursorXmin })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, id));
		expect(row?.xmin).toBeGreaterThanOrEqual(beforeXmin);

		const rows = await db
			.select({ status: eventDelivery.status })
			.from(eventDelivery)
			.where(eq(eventDelivery.endpointId, id));
		expect(rows).toHaveLength(3);
		expect(rows.every((entry) => entry.status === 'skipped')).toBe(true);
	});

	it('leaves the backlog pending when re-enabled to catch up', async () => {
		const id = await createEndpoint(db, VALID, actor);
		await db.execute(eventDeliveryFixture(id));
		await setEndpointEnabled(db, id, { enabled: false, reason: 'paused' }, actor);
		await setEndpointEnabled(db, id, { enabled: true }, actor);

		const rows = await db
			.select({ status: eventDelivery.status })
			.from(eventDelivery)
			.where(eq(eventDelivery.endpointId, id));
		expect(rows.every((entry) => entry.status === 'pending')).toBe(true);
	});
});

describe('bumpSecretVersion', () => {
	it('increments the version so the previous secret stays valid for the overlap', async () => {
		const id = await createEndpoint(db, VALID, actor);
		expect(await bumpSecretVersion(db, id, actor)).toBe(2);
		expect(await bumpSecretVersion(db, id, actor)).toBe(3);
	});
});

describe('deleteEndpoint', () => {
	it('removes the endpoint, its filters and its deliveries, and audits it', async () => {
		const id = await createEndpoint(db, VALID, actor);
		await db.execute(eventDeliveryFixture(id));

		await deleteEndpoint(db, id, actor);

		expect(await getEndpoint(db, id)).toBeUndefined();
		const filters = await db
			.select()
			.from(eventEndpointFilter)
			.where(eq(eventEndpointFilter.endpointId, id));
		expect(filters).toHaveLength(0);
		const [event] = await db
			.select()
			.from(auditEvent)
			.where(and(eq(auditEvent.action, 'event_endpoint.deleted'), eq(auditEvent.subjectId, id)));
		// The event outlives the row it names, which is the point of an
		// append-only log.
		expect(event?.subjectId).toBe(id);
	});
});

describe('listEndpoints', () => {
	it('reports the host only, never the full URL, plus the pending depth', async () => {
		const id = await createEndpoint(db, VALID, actor);
		await db.execute(eventDeliveryFixture(id));

		const [summary] = await listEndpoints(db);
		expect(summary?.host).toBe('hooks.example.test');
		expect(JSON.stringify(summary)).not.toContain('/webhook/abc');
		expect(summary?.pendingDepth).toBe(3);
	});
});

/**
 * The one risky property of the test send: it bypasses the cursor, the filter
 * and the queue, and **nothing else** (spec §11). An inline, admin-triggered
 * request that skipped §6.3 would be a hand-built SSRF probe with a UI, so
 * both halves of §6.3 are asserted here — the address classifier and the
 * scheme/port validator — against a real socket that must never be reached.
 *
 * To watch these fail: replace the `postEvent` call in `sendTestEvent` with a
 * plain `fetch(endpoint.url, { method: 'POST', body })`. Both cases then
 * deliver, `requests` is non-empty, and each fails on its own assertion.
 */
describe('sendTestEvent', () => {
	it('refuses a destination that resolves into a denied range, without connecting', async () => {
		const server = await webhook.serve((_request, response) => {
			response.writeHead(200);
			response.end();
		});
		const id = await seedEndpointRow(db, [], {
			name: 'metadata',
			url: server.url,
			format: 'generic'
		});

		const outcome = await sendTestEvent(db, id, {
			signingKey: 'k'.repeat(32),
			allow: parseAllowList(`127.0.0.1:${server.port}`),
			// The cloud metadata endpoint — the case §6.3 exists for. The host in
			// the URL is allow-listed; what is classified is what DNS returns.
			lookup: async () => [{ address: '169.254.169.254', family: 4 }]
		});

		expect(outcome).toEqual({ statusCode: null, reason: 'destination_denied' });
		expect(server.requests).toHaveLength(0);
	});

	it('refuses a port the validator does not permit, without connecting', async () => {
		const server = await webhook.serve((_request, response) => {
			response.writeHead(200);
			response.end();
		});
		// The fixture's OS-assigned port with no allow entry naming it: 80 and
		// 443 are the only ports permitted by default.
		const id = await seedEndpointRow(db, [], {
			name: 'odd port',
			url: server.url,
			format: 'generic'
		});

		const outcome = await sendTestEvent(db, id, {
			signingKey: 'k'.repeat(32),
			allow: [],
			lookup: async () => [{ address: '10.1.2.3', family: 4 }]
		});

		expect(outcome).toEqual({ statusCode: null, reason: 'url' });
		expect(server.requests).toHaveLength(0);
	});

	/**
	 * §11 names exactly three things the inline test send bypasses — the cursor,
	 * the filter and the queue — and says so exhaustively. The kill switch is not
	 * one of them. It used to be: `sendTestEvent` never consulted
	 * `EVENT_EGRESS_ENABLED`, so an admin could make the deployment call out to
	 * an operator-supplied host with egress switched off, contradicting both
	 * `.env.example` and the notice the same page renders. The fixture is a real
	 * reachable server, so a request that is never made is the assertion.
	 */
	it('sends nothing when the kill switch is off', async () => {
		const server = await webhook.serve((_request, response) => {
			response.writeHead(200);
			response.end();
		});
		const id = await seedEndpointRow(db, [], {
			name: 'reachable',
			url: server.url,
			format: 'generic'
		});

		const outcome = await sendTestEvent(db, id, {
			signingKey: 'k'.repeat(32),
			allow: parseAllowList(`127.0.0.1:${server.port}`),
			enabled: false,
			lookup: async () => [{ address: '10.1.2.3', family: 4 }]
		});

		expect(outcome).toEqual({ statusCode: null, reason: 'egress_disabled' });
		expect(server.requests).toHaveLength(0);
	});

	it('delivers inline when the destination passes, writing no delivery row', async () => {
		const server = await webhook.serve((_request, response) => {
			response.writeHead(204);
			response.end();
		});
		const id = await seedEndpointRow(db, [], {
			name: 'reachable',
			url: server.url,
			format: 'generic'
		});

		const outcome = await sendTestEvent(db, id, {
			signingKey: 'k'.repeat(32),
			allow: parseAllowList(`127.0.0.1:${server.port}`),
			lookup: async () => [{ address: '10.1.2.3', family: 4 }]
		});

		expect(outcome).toEqual({ statusCode: 204, reason: null });
		expect(server.requests).toHaveLength(1);
		expect(JSON.parse(server.requests[0]!.body).event).toBe('egress.test');
		// It bypasses the queue: no row is written, so nothing retries it and
		// nothing shows up as a delivery an operator has to explain.
		const rows = await db.select().from(eventDelivery).where(eq(eventDelivery.endpointId, id));
		expect(rows).toHaveLength(0);
	});
});
