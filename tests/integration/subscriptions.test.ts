import { isRedirect } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { subscription, subscriptionTopic } from '../../src/lib/server/db/schema';
import type { UpdateKind } from '../../src/lib/content-types';
import { queryEvents } from '../../src/lib/server/audit';
import {
	confirmSubscription,
	saveSubscription,
	subscribe,
	subscriptionByManageToken,
	sweepUnconfirmedSubscriptions,
	unsubscribe
} from '../../src/lib/server/subscriptions';
// Imported directly rather than driven over HTTP: this suite runs plain
// Vitest against a Testcontainers Postgres with no SvelteKit server (see
// vitest.integration.config.ts), so there is no dev/preview server for these
// form actions to run behind. Calling the actions themselves — rather than
// the `subscribe`/`confirmSubscription`/etc. library functions above — still
// pins what the routes actually do: form parsing, rate limiting, and the
// audit call, in the order the route makes them.
import { actions as subscribeActions } from '../../src/routes/(portal)/subscribe/+page.server';
import { actions as confirmActions } from '../../src/routes/(portal)/subscribe/confirm/+page.server';
import { actions as manageActions } from '../../src/routes/(portal)/subscribe/manage/+page.server';
import { lastMailUrl, rejectionCause } from '../helpers/db';

let db: Db;
let close: () => Promise<void>;

// The four route actions call `getDb()` internally, which is a lazy,
// module-level singleton (spec: "lazy singletons") — left unmocked it would
// open a second, never-closed connection pool for the life of this process.
// Routing it to the same `db` this file already owns and closes in
// `afterAll` avoids that leak; the closure reads the outer `db` at call time,
// by which point `beforeAll` has assigned it.
vi.mock('$lib/server/db/instance', () => ({ getDb: () => db }));

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	// getConfig() (`$lib/server/config`) is also a lazy, process-wide
	// singleton, parsed from `process.env` on first call. The subscribe and
	// manage-save actions read it (baseUrl, locales, defaultLocale,
	// magicLinkTtlMinutes), so it has to be configured before either runs.
	// Vitest gives each integration test file its own module graph, so this
	// has no effect on any other file, and no other integration test calls
	// getConfig() today.
	Object.assign(process.env, {
		DATABASE_URL: url,
		BASE_URL: 'https://trust.example.test',
		LOCALES: 'de,en',
		DEFAULT_LOCALE: 'de',
		OIDC_ISSUER: 'https://idp.example.test',
		OIDC_CLIENT_ID: 'trust-center',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_ADMIN_GROUP: 'trust-center-admins'
	});
});

afterAll(async () => {
	await close();
});

describe('subscription check constraints', () => {
	it('accepts a well-formed unconfirmed row', async () => {
		const [row] = await db
			.insert(subscription)
			.values({
				email: `unconfirmed-${Date.now()}@example.test`,
				locale: 'de',
				confirmTokenHash: `hash-${Date.now()}`,
				confirmExpiresAt: new Date(Date.now() + 3_600_000)
			})
			.returning({ id: subscription.id });

		expect(row?.id).toBeTruthy();
		await db.delete(subscription).where(eq(subscription.id, row!.id));
	});

	it('accepts a well-formed confirmed row', async () => {
		const [row] = await db
			.insert(subscription)
			.values({
				email: `confirmed-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				manageToken: `manage-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
			.returning({ id: subscription.id });

		expect(row?.id).toBeTruthy();
		await db.delete(subscription).where(eq(subscription.id, row!.id));
	});

	it('rejects a confirmed row that kept its confirmation token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfa-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				confirmTokenHash: `hash-${Date.now()}`,
				manageToken: `manage-a-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_confirm_token_check');
	});

	// The constraint an earlier draft of the spec omitted (§8, §15 #7). Its
	// absence is invisible at runtime: the sweep filters `confirmed_at IS NULL`
	// first, so a confirmed row keeping a stale expiry is read by nothing.
	it('rejects a confirmed row that kept its confirmation expiry', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfb-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				confirmExpiresAt: new Date(),
				manageToken: `manage-b-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_confirm_expires_check');
	});

	it('rejects a confirmed row with no manage token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfc-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_manage_token_check');
	});

	it('rejects a confirmed row with no cursor', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfd-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				manageToken: `manage-d-${Date.now()}`
			})
		);
		expect(cause).toContain('subscription_cursor_check');
	});

	it('rejects an unconfirmed row that already has a manage token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfe-${Date.now()}@example.test`,
				locale: 'de',
				confirmTokenHash: `hash-e-${Date.now()}`,
				confirmExpiresAt: new Date(Date.now() + 3_600_000),
				manageToken: `manage-e-${Date.now()}`
			})
		);
		expect(cause).toContain('subscription_manage_token_check');
	});
});

async function topicsOf(id: string): Promise<string[]> {
	const rows = await db
		.select({ topic: subscriptionTopic.topic })
		.from(subscriptionTopic)
		.where(eq(subscriptionTopic.subscriptionId, id))
		.orderBy(asc(subscriptionTopic.topic));
	return rows.map((row) => row.topic);
}

describe('subscribe', () => {
	it('creates an unconfirmed row with its topics', async () => {
		const email = `create-${Date.now()}@example.test`;
		const result = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory', 'document'],
			ttlMinutes: 60
		});

		expect(result.kind).toBe('created');
		expect(await topicsOf(result.subscriptionId)).toEqual(['advisory', 'document']);
		await db.delete(subscription).where(eq(subscription.id, result.subscriptionId));
	});

	it('lowercases the address so the unique constraint is the real one', async () => {
		const stamp = Date.now();
		const first = await subscribe(db, {
			email: `Mixed-${stamp}@Example.Test`,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const second = await subscribe(db, {
			email: `mixed-${stamp}@example.test`,
			locale: 'de',
			topics: ['document'],
			ttlMinutes: 60
		});

		expect(second.subscriptionId).toBe(first.subscriptionId);
		expect(second.kind).toBe('resent');
		await db.delete(subscription).where(eq(subscription.id, first.subscriptionId));
	});

	it('replaces the topics and reissues the token on an unconfirmed row', async () => {
		const email = `resend-${Date.now()}@example.test`;
		const first = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const second = await subscribe(db, {
			email,
			locale: 'en',
			topics: ['certification', 'document'],
			ttlMinutes: 60
		});

		if (first.kind === 'already' || second.kind === 'already') {
			throw new Error('fixture produced the wrong outcome');
		}
		expect(second.kind).toBe('resent');
		expect(second.subscriptionId).toBe(first.subscriptionId);
		// The regenerated token kills the link the first mail carried. That is
		// the accepted trade of §4.3 — nobody has proven control of the mailbox,
		// so the row is indistinguishable from one created fresh.
		expect(second.confirmToken).not.toBe(first.confirmToken);
		expect(await topicsOf(first.subscriptionId)).toEqual(['certification', 'document']);

		const [row] = await db
			.select({ locale: subscription.locale })
			.from(subscription)
			.where(eq(subscription.id, first.subscriptionId));
		expect(row?.locale).toBe('en');

		await db.delete(subscription).where(eq(subscription.id, first.subscriptionId));
	});

	// P4.4: an unauthenticated endpoint must not let a stranger edit — or
	// detect — someone else's subscription. This is the case that matters.
	it('changes nothing when the address is already confirmed', async () => {
		const email = `already-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});

		await db
			.update(subscription)
			.set({
				confirmedAt: new Date(),
				confirmTokenHash: null,
				confirmExpiresAt: null,
				manageToken: `manage-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
			.where(eq(subscription.id, created.subscriptionId));

		const again = await subscribe(db, {
			email,
			locale: 'en',
			topics: ['document', 'subprocessor'],
			ttlMinutes: 60
		});

		expect(again.kind).toBe('already');
		expect(again.subscriptionId).toBe(created.subscriptionId);
		expect(await topicsOf(created.subscriptionId)).toEqual(['advisory']);

		const [row] = await db
			.select({ locale: subscription.locale, hash: subscription.confirmTokenHash })
			.from(subscription)
			.where(eq(subscription.id, created.subscriptionId));
		expect(row?.locale).toBe('de');
		expect(row?.hash).toBeNull();

		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});
});

describe('confirmSubscription', () => {
	it('confirms once, mints a manage token, and starts the cursor at now', async () => {
		const email = `confirm-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const token = created.kind === 'created' ? created.confirmToken : '';

		const before = Date.now();
		const confirmed = await confirmSubscription(db, token);

		expect(confirmed?.subscriptionId).toBe(created.subscriptionId);
		expect(confirmed?.email).toBe(email);
		expect(confirmed?.manageToken).toBeTruthy();

		const [row] = await db
			.select()
			.from(subscription)
			.where(eq(subscription.id, created.subscriptionId));
		expect(row?.confirmedAt).toBeTruthy();
		expect(row?.confirmTokenHash).toBeNull();
		expect(row?.confirmExpiresAt).toBeNull();
		expect(row?.manageToken).toBeTruthy();
		// P4.6: not null. A null cursor would hand a new subscriber the entire
		// back catalogue in their first mail.
		expect(row!.lastNotifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

		// Single-use by construction: the conditional update matches nothing the
		// second time, so a double-clicked button cannot confirm twice.
		expect(await confirmSubscription(db, token)).toBeNull();

		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});

	it('refuses an expired token', async () => {
		const email = `expired-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const token = created.kind === 'created' ? created.confirmToken : '';

		await db
			.update(subscription)
			.set({ confirmExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(subscription.id, created.subscriptionId));

		expect(await confirmSubscription(db, token)).toBeNull();
		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});

	it('refuses an unknown token', async () => {
		expect(await confirmSubscription(db, 'not-a-token')).toBeNull();
	});
});

describe('managing a subscription', () => {
	async function confirmed(topics: UpdateKind[] = ['advisory']) {
		const email = `manage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
		const created = await subscribe(db, { email, locale: 'de', topics, ttlMinutes: 60 });
		const token = created.kind === 'created' ? created.confirmToken : '';
		const result = await confirmSubscription(db, token);
		if (!result) throw new Error('fixture failed to confirm');
		return result;
	}

	it('reads a subscription back by its manage token', async () => {
		const it = await confirmed(['advisory', 'document']);
		const found = await subscriptionByManageToken(db, it.manageToken);

		expect(found?.id).toBe(it.subscriptionId);
		expect(found?.topics).toEqual(['advisory', 'document']);
		expect(await subscriptionByManageToken(db, 'wrong')).toBeNull();

		await db.delete(subscription).where(eq(subscription.id, it.subscriptionId));
	});

	// P4.18. Without this, a subscriber who adds a topic receives every post of
	// that kind published since they confirmed — P4.6's back catalogue, by a
	// second door. Unconditional on save, so narrow-then-widen cannot beat it.
	it('advances the cursor on every save', async () => {
		const it = await confirmed();
		await db
			.update(subscription)
			.set({ lastNotifiedAt: new Date('2020-01-01T00:00:00Z') })
			.where(eq(subscription.id, it.subscriptionId));

		const before = Date.now();
		await saveSubscription(db, it.subscriptionId, {
			locale: 'en',
			topics: ['document', 'subprocessor']
		});

		const [row] = await db
			.select()
			.from(subscription)
			.where(eq(subscription.id, it.subscriptionId));
		expect(row?.locale).toBe('en');
		expect(row!.lastNotifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
		expect(await topicsOf(it.subscriptionId)).toEqual(['document', 'subprocessor']);

		await db.delete(subscription).where(eq(subscription.id, it.subscriptionId));
	});

	it('deletes the row and cascades its topics on unsubscribe', async () => {
		const it = await confirmed(['advisory', 'document']);
		await unsubscribe(db, it.subscriptionId);

		const rows = await db.select().from(subscription).where(eq(subscription.id, it.subscriptionId));
		expect(rows).toHaveLength(0);
		expect(await topicsOf(it.subscriptionId)).toEqual([]);
	});
});

describe('sweepUnconfirmedSubscriptions', () => {
	it('deletes expired unconfirmed rows and spares confirmed ones', async () => {
		const stale = await subscribe(db, {
			email: `stale-${Date.now()}@example.test`,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		await db
			.update(subscription)
			.set({ confirmExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(subscription.id, stale.subscriptionId));

		const live = await subscribe(db, {
			email: `live-${Date.now()}@example.test`,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const confirmedRow = await confirmSubscription(
			db,
			live.kind === 'created' ? live.confirmToken : ''
		);

		await sweepUnconfirmedSubscriptions(db);

		expect(
			await db.select().from(subscription).where(eq(subscription.id, stale.subscriptionId))
		).toHaveLength(0);
		expect(
			await db.select().from(subscription).where(eq(subscription.id, confirmedRow!.subscriptionId))
		).toHaveLength(1);

		await db.delete(subscription).where(eq(subscription.id, confirmedRow!.subscriptionId));
	});
});

// Spec §14 asks for this suite by name; it did not exist before this fix.
// `audit_event` is append-only with no delete path (drizzle/0003, 0004), so an
// address written into `meta` here is unerasable — these tests exist to catch
// that regression, not merely to exercise the four writes.
describe('the audit trail the routes write (spec §10.1, §10.2, §14)', () => {
	// A minimal stand-in for SvelteKit's `RequestEvent`, covering only what the
	// four actions under test actually read: `request` (form body, headers),
	// `locals.locale`, and `getClientAddress`. Untyped on purpose — matching
	// the exact generic `RequestEvent<RouteParams, RouteId>` each action
	// expects would fight SvelteKit's generated types for no test value.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function fakeEvent(fields: Record<string, string | string[]>, locale = 'de'): any {
		const body = new URLSearchParams();
		for (const [key, value] of Object.entries(fields)) {
			for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
		}
		// A fresh, random IP per call: consumeRateLimit ties its 5/hour window to
		// this, and these tests call the subscribe action several times in one
		// file — a shared IP would trip the limiter meant for one real client.
		const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
		return {
			request: new Request('https://trust.example.test/', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'user-agent': 'vitest-audit-trail'
				},
				body: body.toString()
			}),
			locals: { locale },
			getClientAddress: () => ip,
			params: {},
			url: new URL('https://trust.example.test/'),
			setHeaders: () => {}
		};
	}

	// A redirect is the routes' success shape for `manage`'s two POST actions
	// (spec §9 step 7): `throw redirect(303, …)` after the audit write. Calling
	// the action directly means catching it ourselves.
	async function expectRedirect(run: () => unknown): Promise<void> {
		try {
			await run();
			throw new Error('expected the action to redirect');
		} catch (err) {
			if (!isRedirect(err)) throw err;
		}
	}

	function tokenFrom(url: string): string {
		return new URL(url).searchParams.get('token') ?? '';
	}

	async function idFor(email: string): Promise<string> {
		const [row] = await db
			.select({ id: subscription.id })
			.from(subscription)
			.where(eq(subscription.email, email));
		if (!row) throw new Error(`no subscription row for ${email}`);
		return row.id;
	}

	/** §10.2: the address lives in the row, never in `meta`. Checked as a
	 * string search rather than just asserting the expected shape, so a future
	 * field added to `meta` that happens to also match the expected keys does
	 * not slip an address past a narrower check. */
	function assertNoAddress(meta: unknown, email: string): void {
		expect(JSON.stringify(meta ?? null).toLowerCase()).not.toContain(email.toLowerCase());
	}

	async function confirmedSubscriber(
		email: string,
		topics: string[] = ['advisory']
	): Promise<{ id: string; manageToken: string }> {
		await subscribeActions.default!(fakeEvent({ email, topics }));
		const confirmUrl = await lastMailUrl(db, email, 'subscription_confirm');
		await confirmActions.default!(fakeEvent({ token: tokenFrom(confirmUrl) }));
		const id = await idFor(email);
		const [row] = await db
			.select({ manageToken: subscription.manageToken })
			.from(subscription)
			.where(eq(subscription.id, id));
		return { id, manageToken: row!.manageToken! };
	}

	it('records subscription.requested for a fresh address, with no address in meta', async () => {
		const email = `audit-req-${Date.now()}@example.test`;

		const result = await subscribeActions.default!(fakeEvent({ email, topics: ['advisory'] }));
		expect(result).toEqual({ submitted: true });

		const id = await idFor(email);
		const events = await queryEvents(db, { subjectType: 'subscription', subjectId: id });
		expect(events).toHaveLength(1);
		const [event] = events;

		expect(event!.action).toBe('subscription.requested');
		expect(event!.actorType).toBe('system');
		expect(event!.actorId).toBeNull();
		expect(event!.subjectType).toBe('subscription');
		expect(event!.subjectId).toBe(id);
		expect(event!.meta).toEqual({ topicCount: 1 });
		assertNoAddress(event!.meta, email);

		await db.delete(subscription).where(eq(subscription.id, id));
	});

	it('records subscription.confirmed with the subscription as actor and no meta', async () => {
		const email = `audit-conf-${Date.now()}@example.test`;
		const { id } = await confirmedSubscriber(email);

		const events = await queryEvents(db, {
			subjectType: 'subscription',
			subjectId: id,
			action: 'subscription.confirmed'
		});
		expect(events).toHaveLength(1);
		const [event] = events;

		expect(event!.actorType).toBe('subscriber');
		expect(event!.actorId).toBe(id);
		expect(event!.subjectType).toBe('subscription');
		expect(event!.subjectId).toBe(id);
		expect(event!.meta).toBeNull();
		assertNoAddress(event!.meta, email);

		await db.delete(subscription).where(eq(subscription.id, id));
	});

	it('records subscription.topics_changed on a manage save, with a count and locale but no address', async () => {
		const email = `audit-save-${Date.now()}@example.test`;
		const { id, manageToken } = await confirmedSubscriber(email);

		await expectRedirect(() =>
			manageActions.save!(
				fakeEvent({ token: manageToken, topics: ['document', 'subprocessor'], locale: 'de' })
			)
		);

		const events = await queryEvents(db, {
			subjectType: 'subscription',
			subjectId: id,
			action: 'subscription.topics_changed'
		});
		expect(events).toHaveLength(1);
		const [event] = events;

		expect(event!.actorType).toBe('subscriber');
		expect(event!.actorId).toBe(id);
		expect(event!.subjectType).toBe('subscription');
		expect(event!.subjectId).toBe(id);
		expect(event!.meta).toEqual({ topicCount: 2, locale: 'de' });
		assertNoAddress(event!.meta, email);

		await db.delete(subscription).where(eq(subscription.id, id));
	});

	it('records subscription.unsubscribed with no meta and no address', async () => {
		const email = `audit-unsub-${Date.now()}@example.test`;
		const { id, manageToken } = await confirmedSubscriber(email);

		await expectRedirect(() => manageActions.unsubscribe!(fakeEvent({ token: manageToken })));

		const events = await queryEvents(db, {
			subjectType: 'subscription',
			subjectId: id,
			action: 'subscription.unsubscribed'
		});
		expect(events).toHaveLength(1);
		const [event] = events;

		expect(event!.actorType).toBe('subscriber');
		expect(event!.actorId).toBe(id);
		expect(event!.subjectType).toBe('subscription');
		expect(event!.subjectId).toBe(id);
		expect(event!.meta).toBeNull();
		assertNoAddress(event!.meta, email);
		// The row is already gone (unsubscribe deletes it) — nothing left to clean up.
	});

	// P4.4, P4.17, and the negative §14 names explicitly: an unauthenticated
	// caller must not be able to append rows against a stranger's subscription
	// into a log with no delete path. Asserting the row count is unchanged is
	// the point — a later "fix" that adds a write here would pass every other
	// assertion in this file and only be caught by this one.
	it('writes no audit event when re-subscribing an already-confirmed address', async () => {
		const email = `audit-already-${Date.now()}@example.test`;
		const { id } = await confirmedSubscriber(email);

		const before = await queryEvents(db, { subjectType: 'subscription', subjectId: id });
		expect(before).toHaveLength(2); // requested, confirmed

		const result = await subscribeActions.default!(fakeEvent({ email, topics: ['document'] }));
		expect(result).toEqual({ submitted: true });

		const after = await queryEvents(db, { subjectType: 'subscription', subjectId: id });
		expect(after).toHaveLength(before.length);

		// The topics did not move either — the same invariant from the other
		// side, confirming the "already" branch was actually taken.
		const topics = await db
			.select({ topic: subscriptionTopic.topic })
			.from(subscriptionTopic)
			.where(eq(subscriptionTopic.subscriptionId, id));
		expect(topics.map((t) => t.topic)).toEqual(['advisory']);

		await db.delete(subscription).where(eq(subscription.id, id));
	});
});
