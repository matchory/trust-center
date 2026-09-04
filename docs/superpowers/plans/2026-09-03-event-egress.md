# Event Egress (Integrations Subsystem A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Business events leave the application as signed HTTP POSTs to operator-configured endpoints, filtered per endpoint, retried, and auto-disabled on sustained failure — with no vendor connector code.

**Architecture:** A new `src/lib/server/egress/` module in three layers — `enrich` (reads live domain state), `format` (pure functions per wire shape), `deliver` (a hardened HTTP client that pins the address it validated). One job, `egress:deliver`, fans out from `audit_event` under a transaction watermark and then delivers **outside** any transaction. Endpoints are database rows; a deploy-time environment switch gates whether any of them can deliver at all.

**Tech Stack:** SvelteKit + Drizzle + postgres-js on Postgres 18; `node:https`/`node:http` (not `fetch`) for the pinned-address connection; `node:crypto` HMAC-SHA256 for signing; vitest (unit + Testcontainers integration) and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-03-event-egress-design.md`
Governing design: `docs/superpowers/specs/2026-08-28-trust-center-design.md`
Decomposition note: `docs/superpowers/specs/2026-08-31-integrations-decomposition.md` §9 A

---

## Global Constraints

- **Tabs, single quotes, no trailing commas, 100-column print width** (`.prettierrc`). Run `pnpm format` before every commit.
- **Comments explain why a decision was made**, naming the failure mode prevented or the spec section (`spec §6.5`). Never restate the code.
- **`pnpm build` and `pnpm check` must pass with an empty environment.** No module in this subsystem may open a connection or require configuration at import time. Config reaches code through `getConfig()`, storage through `getStorage()`, the database through `getDb()` — and below the route layer, all three are passed in as arguments (`purge.ts`, `drainOutbox`).
- **No new runtime dependency.** The pinned-address connection uses `node:https`; the signature uses `node:crypto`.
- **Audit action names are permanent once written.** The four in this plan are `event_endpoint.created`, `event_endpoint.updated`, `event_endpoint.deleted`, `event_endpoint.disabled`. Nothing else. `egress.test` is deliberately *not* an audit action.
- **Requester personal data appears in `audit_event` only in `ip`, `ua`, `actor_id`** — never in `meta`, never in `subject_id`. This plan writes four new audit events and none of them may break that.
- **Nothing in `event_delivery` may hold personal data.** `audit_seq`/`audit_id` are references; `last_error` is a fixed reason phrase from a closed set. This is what keeps `purgeRequester` a single path.
- **Drizzle regenerates check constraints rather than altering them**, so constraint text in a schema file and the hand-written `ALTER` in a migration are kept in sync by hand (`audit_event_actor_type_check` records the same caveat).
- **Telemetry never carries an address, name, company, IP, token or query string** (subsystem C §8). Endpoint identity in telemetry is the UUID, never `name`, never the URL or its host.
- Timeout **10 s**; **5 attempts**; backoff **1/2/4/8 minutes**; claim **25 rows/tick globally, ≤5 per endpoint**; fan-out **500 rows/tick**; backpressure at **1000 pending**; auto-disable after **24 h** with no success; terminal `event_delivery` rows swept after **30 days**. All constants, no environment variables.
- Three environment variables and no more: `EVENT_EGRESS_ENABLED` (default `false`), `EVENT_SIGNING_KEY` (≥32 chars), `EVENT_EGRESS_ALLOW` (empty).

---

## Corrections to the spec this plan encodes

The spec was reviewed against the code on 2026-09-03 and five claims did not survive. **This plan implements the corrected behaviour**, and Task 14 writes the corrections back into the spec as a §18 revision entry. Where this plan and the spec differ, the plan is right and the spec is stale until Task 14 lands.

### C1 — §5.2's watermark is unsound; the cursor moves to `xmin`, not `seq` (blocking)

The spec's invariant — *"A row below the horizon was inserted by a transaction that can no longer commit anything beneath it, so no lower `seq` can still appear"* — is false. `xmin < horizon` excludes rows from *still-running* transactions. It does not exclude rows from transactions that started **later**, committed **already**, and are excluded by that same predicate — and those can hold a lower `seq`, because a transaction's xid is assigned at its first write while its `seq` is assigned when `recordEvent` runs last.

| t | |
|---|---|
| t0−ε | `T_early` BEGIN, first write → **xid 499** |
| t0 | `T_slow` BEGIN, first write → **xid 500** (still running at the tick) |
| t1 | `T_fast` autocommit `recordEvent` → xid 501, **seq 50**, commits |
| t2 | `T_early` calls `recordEvent` → **seq 51** (xmin 499), commits |
| t4 | Tick: horizon = 500. seq 51 (xmin 499 < 500) scanned; seq 50 (xmin 501) excluded. **Cursor → 51.** |

Seq 50 is committed, visible, and permanently below the cursor: dropped. Advancing to "lowest excluded seq − 1" fixes this case but not the mirror case where the blocking row is *invisible* and no visible row is excluded — and that gap is indistinguishable from the permanent gaps rollbacks and sequence caching leave behind. **A `seq` high-watermark cannot be made exactly correct.**

The fix is a composite keyset on `(xmin, seq)`:

- `event_endpoint` carries `cursor_xmin bigint not null` and `cursor_seq bigint not null` — together one keyset cursor, not two facts.
- Fan-out selects `WHERE xmin::text::bigint < horizon AND (xmin::text::bigint, seq) > (cursor_xmin, cursor_seq) ORDER BY xmin::text::bigint, seq LIMIT 500`, and advances the cursor to the **last row returned**.
- **The invariant that makes this sound:** the cursor is only ever set to a row whose `xmin` was strictly below the horizon observed in that tick. Every unconsumed row — invisible (in-flight, so `xmin ≥ horizon`) or visible-but-excluded (`xmin ≥ horizon`) — therefore has a key strictly greater than the cursor. Each row is consumed exactly once, in the tick where the horizon crosses its `xmin`.
- Two consequences to write down rather than discover: delivery order becomes commit-ish order rather than `seq` order (§15 already promises no ordering guarantee; `seq` in the payload still makes gaps detectable, but a consumer must not assume monotonicity), and `purgeRequester`'s `UPDATE audit_event` bumps `xmin`, so a pseudonymized row is re-scanned — harmless, because the fan-out insert is `ON CONFLICT DO NOTHING` against the unique `(endpoint_id, audit_seq)`.
- Residual: a row frozen by vacuum before being consumed has `xmin = 2` and sorts below any cursor. Only reachable for rows older than `vacuum_freeze_min_age` (50M transactions), which are long consumed. Goes in §16.

**Rejected alternative, recorded because it is the obvious one:** a trigger on `audit_event` INSERT writing `event_delivery` rows in the same transaction deletes the watermark problem entirely — visibility is inherited from the commit. It is rejected because it puts egress on the critical path of every audited action: a fan-out bug or a missing egress table would then roll back an access approval. The audit write must not be able to fail because egress is misconfigured.

### C2 — §11's role-gate premise is wrong, in the direction that simplifies it

`src/routes/(admin)/admin/audit/+page.server.ts:31` already gates on `locals.staff?.role !== 'admin'`, and `src/lib/admin/sections.ts:12` already carries `role?: 'admin' | 'approver'` documented as *"The nav hides what the route would refuse, so an approver is never offered a link that 403s."* This is an established two-part pattern, not a deviation. Both parts are implemented in Task 12; §11's justification paragraph shrinks to a sentence.

### C3 — §5.1's two-phase tick is not expressible as a `JOBS` entry (blocking)

`runJob` wraps `fn()` in `db.transaction` (`jobs/runner.ts:38`) and `startJobRunner` passes `() => job.run(getDb())` (`jobs/index.ts`), so the whole body runs inside the lock's transaction on a different pooled connection. Nesting `runJob` inside `job.run` is worse: postgres-js turns the inner `db.transaction` into a savepoint, so `pg_try_advisory_xact_lock` is held until the *outer* transaction ends. `Job` therefore grows an optional `afterLock` phase (Task 11).

### C4 — "`EVENT_SIGNING_KEY` required at boot" would let one row brick the container

§7.1 wants the key required "at save time and at boot", by analogy with `OIDC_CLIENT_SECRET`. But `parseConfig` has no database, and the precondition is a *database row* — so enforcing it in `hooks.server.ts`'s init means a `format = 'generic'` endpoint plus an unset key exits the process on start, and the only way to fix either one is the admin UI that container serves. That is a bootstrap deadlock. Enforced instead as: hard refusal **at save time** (the admin action), and at boot a **delivery halt** on the same path as a canary mismatch — logged, surfaced in the admin UI, container healthy. Task 8 and Task 12.

### C5 — A public-tier `document.downloaded` has no requester at all

`delivery/serve.ts:166` writes `actor: { type: 'requester', id: requester?.id ?? null }`, and `/api/documents/{fileId}` is the cookie-free public path — so this event is routinely written with a null actor and no requester row. §4.2 says its `data` carries "requester identity", and §4.5 would then mark every public download `skipped` as a missing subject, silently dropping the notifications an operator subscribed to. The enricher distinguishes three cases, not two: **enriched** (a live requester), **anonymous** (no requester id — deliver with `subject`/`data` describing the document and `actor.id: null`), and **skipped** (a requester id that resolves to a purged row, or a subject row that is gone). Task 6.

Its subject is also not what §4.2 implies: `subjectType` is `document_file` and `subjectId` is a `document_file.id`, so the enricher resolves file → document → translation for the title.

### Smaller corrections, folded into their tasks

- **`last_success_at` NULL is undefined** and it drives auto-disable — an endpoint that has never succeeded never disables, which is the dead-endpoint case §5.4 exists for. Auto-disable uses `coalesce(last_success_at, created_at)` (Task 10).
- **§4.5 ownership:** the check lives in the enricher only. `purgeRequester` is not modified — §4.5's "it is the same step" reads as a change to `purge.ts`, and two implementations of one rule is the second path §2.3 exists to avoid. The signal is `requester.purged_at IS NOT NULL`, **not** blank columns: `purgeRequester` writes `email = 'purged-<id>@invalid'`, so testing for an empty email gets the one field a CRM upserts on wrong (Task 6).
- **§12's "parsed through `config/parse.ts` like everything else" is not the precedent** — `RUN_JOBS` is read straight from `process.env` in `hooks.server.ts:107` and `parse.ts` has no boolean helper. `EVENT_EGRESS_ENABLED` goes in `parse.ts` (it is consulted per delivery, not only at boot) and becomes the schema's first boolean, with a comment saying why the two run-flags stay outside (Task 8).
- **§2.1's cursor initialisation** carries the same hazard it is protecting against, harmlessly: a row in flight at endpoint creation commits below the new cursor and is never seen. Under C1 this is stated exactly — creation sets `cursor_xmin` to the current horizon, so "everything already below the horizon is treated as consumed" is the precise form of "do not replay history". Same for §5.5's skip-the-backlog jump. Goes in §16 (Task 14).

### Adjacent, out of scope, mentioned not fixed

`outbound_email.last_error` stores raw SMTP messages (`mail/queue.ts:132`); `purgeRequester` overwrites it only for `pending` rows and `redactDeliveredMail` does not clear it at all, so a rejection like `550 5.1.1 <alice@acme.example> unknown user` outlives both a purge and the retention window. Pre-existing, unrelated to egress. **Do not fix it in this branch.**

---

## File structure

**New module — `src/lib/server/egress/`.** Split by responsibility, one concern each, so the two files that carry security properties (`destination.ts`, `client.ts`) can be read whole.

| File | Responsibility |
| --- | --- |
| `src/lib/server/db/schema/egress.ts` | The three tables, their constraints and indexes |
| `src/lib/server/egress/filter.ts` | Pattern matching (`a.*`), and the SQL predicate form |
| `src/lib/server/egress/secret.ts` | Secret derivation, the canary, the signature header |
| `src/lib/server/egress/destination.ts` | URL validation, address classification, the allowlist, resolution |
| `src/lib/server/egress/client.ts` | The one POST: pinned address, no redirects, bounded discarded body, retry classification |
| `src/lib/server/egress/model.ts` | `EventModel` — the stable seam, and nothing else |
| `src/lib/server/egress/enrich.ts` | Enricher registry, the audit-row fallback, enriched/anonymous/skipped |
| `src/lib/server/egress/format/index.ts` | The formatter registry and `EGRESS_FORMATS` |
| `src/lib/server/egress/format/escape.ts` | Per-target escaping |
| `src/lib/server/egress/format/generic.ts` | `application/json`, the model rendered directly |
| `src/lib/server/egress/format/teams.ts` | Adaptive Card 1.4 in the Workflows envelope |
| `src/lib/server/egress/fanout.ts` | The C1 watermark, fan-out, backpressure |
| `src/lib/server/egress/deliver.ts` | Claim, deliver, record, retry, auto-disable |
| `src/lib/server/egress/endpoints.ts` | Endpoint CRUD for the admin routes, with its audit events |

**Modified:** `src/lib/server/db/schema/index.ts` (export), `src/lib/server/config/parse.ts` (three variables), `src/lib/server/jobs/runner.ts` + `index.ts` (the `afterLock` phase, the job, the retention fold-in), `src/lib/server/telemetry/metrics.ts` (three instruments), `src/lib/admin/sections.ts` (nav entry), `messages/en.json` + `messages/de.json`, `docs/self-hosting.md`, both spec documents.

**Created routes:** `src/routes/(admin)/admin/settings/integrations/{+page.server.ts,+page.svelte}` and `.../integrations/[id]/{+page.server.ts,+page.svelte}`.

**Created tests:** `tests/unit/egress-{filter,secret,destination,format,retry}.test.ts`, `tests/integration/egress-{schema,fanout,enrich,deliver,audit}.test.ts`, `tests/helpers/webhook-server.ts`, `tests/e2e/admin-integrations.spec.ts`.

---

### Task 1: Schema and migration

**Files:**
- Create: `src/lib/server/db/schema/egress.ts`
- Modify: `src/lib/server/db/schema/index.ts` (add one export line)
- Create: `drizzle/0026_*.sql` (generated, then hand-extended)
- Test: `tests/integration/egress-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `eventEndpoint`, `eventEndpointFilter`, `eventDelivery` Drizzle tables; `EGRESS_FORMATS = ['generic', 'teams'] as const`; `EVENT_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'skipped'] as const`; `DELIVERY_ERROR_REASONS` (the closed set `last_error` may hold); types `EventEndpointRow = typeof eventEndpoint.$inferSelect`, `EventDeliveryRow = typeof eventDelivery.$inferSelect`.

- [ ] **Step 1: Write the failing test**

`tests/integration/egress-schema.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { eventEndpoint } from '../../src/lib/server/db/schema';
import { rejectionCause } from '../helpers/db';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

/** A minimal valid endpoint. The cursor is the one column with no default. */
async function insertEndpoint(overrides: Record<string, unknown> = {}): Promise<string> {
	const [row] = await db
		.insert(eventEndpoint)
		.values({
			name: 'Teams',
			url: 'https://hooks.example.test/abc',
			format: 'teams',
			cursorXmin: 1000n,
			cursorSeq: 0n,
			...overrides
		})
		.returning({ id: eventEndpoint.id });
	return row!.id;
}

describe('event_endpoint', () => {
	it('accepts a valid row and defaults it to enabled', async () => {
		const id = await insertEndpoint();
		const [row] = await db.select().from(eventEndpoint).where(sql`id = ${id}::uuid`);

		expect(row?.enabled).toBe(true);
		expect(row?.disabledAt).toBeNull();
		expect(row?.lastSuccessAt).toBeNull();
	});

	it('rejects a format outside the registry', async () => {
		const message = await rejectionCause(insertEndpoint({ format: 'slack' }));
		expect(message).toContain('event_endpoint_format_check');
	});

	// The state lives in two columns, so the constraint says they agree — the
	// shape subscription's five confirmation columns use.
	it('rejects enabled = false without a disabled_at', async () => {
		const message = await rejectionCause(insertEndpoint({ enabled: false }));
		expect(message).toContain('event_endpoint_disabled_check');
	});

	it('rejects enabled = true with a disabled_at', async () => {
		const message = await rejectionCause(insertEndpoint({ disabledAt: new Date() }));
		expect(message).toContain('event_endpoint_disabled_check');
	});
});

describe('event_endpoint_filter', () => {
	it('cascades from the endpoint', async () => {
		const id = await insertEndpoint();
		await db.execute(
			sql`INSERT INTO event_endpoint_filter (endpoint_id, pattern) VALUES (${id}::uuid, 'access_request.*')`
		);

		await db.execute(sql`DELETE FROM event_endpoint WHERE id = ${id}::uuid`);

		const rows = (await db.execute(
			sql`SELECT count(*)::int AS n FROM event_endpoint_filter WHERE endpoint_id = ${id}::uuid`
		)) as unknown as { n: number }[];
		expect(rows[0]?.n).toBe(0);
	});
});

describe('event_delivery', () => {
	it('makes a second fan-out of the same event a no-op', async () => {
		const endpointId = await insertEndpoint();
		const insert = sql`
			INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id)
			VALUES (${endpointId}::uuid, 4711, gen_random_uuid())
			ON CONFLICT (endpoint_id, audit_seq) DO NOTHING
		`;

		await db.execute(insert);
		await db.execute(insert);

		const rows = (await db.execute(
			sql`SELECT count(*)::int AS n FROM event_delivery WHERE endpoint_id = ${endpointId}::uuid`
		)) as unknown as { n: number }[];
		expect(rows[0]?.n).toBe(1);
	});

	it('rejects a status outside the closed set', async () => {
		const endpointId = await insertEndpoint();
		const message = await rejectionCause(
			db.execute(sql`
				INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id, status)
				VALUES (${endpointId}::uuid, 99, gen_random_uuid(), 'sent')
			`)
		);
		expect(message).toContain('event_delivery_status_check');
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/egress-schema.test.ts`
Expected: FAIL — `relation "event_endpoint" does not exist`, or a TypeScript error on the missing `eventEndpoint` export.

- [ ] **Step 3: Write the schema**

`src/lib/server/db/schema/egress.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid
} from 'drizzle-orm/pg-core';

/**
 * The wire shapes a formatter exists for. A column rather than two branches so
 * adding Slack later is one file, one entry here, and one value in the
 * migration's ALTER — see the sync caveat on the check constraint below.
 */
export const EGRESS_FORMATS = ['generic', 'teams'] as const;
export type EgressFormat = (typeof EGRESS_FORMATS)[number];

export const EVENT_DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'skipped'] as const;
export type EventDeliveryStatus = (typeof EVENT_DELIVERY_STATUSES)[number];

/**
 * The closed set `last_error` may hold. A fixed phrase and never a response
 * body: a receiver that echoes its input — n8n's "respond with incoming
 * items", most webhook debuggers — would otherwise write a requester's name
 * and address into a column purgeRequester does not know about, creating the
 * second erasure path this table's reference-not-payload shape exists to
 * avoid (spec §2.3, §6.4).
 */
export const DELIVERY_ERROR_REASONS = [
	'http_status',
	'redirect_refused',
	'destination_denied',
	'timeout',
	'network',
	'signing_key_missing',
	'body_too_large'
] as const;
export type DeliveryErrorReason = (typeof DELIVERY_ERROR_REASONS)[number];

/**
 * The noun is "endpoint" throughout: `subscription` is already the portal's
 * update mailing list, and two unrelated concepts sharing a name in one schema
 * is how a later reader joins the wrong table (spec §2).
 */
export const eventEndpoint = pgTable(
	'event_endpoint',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// The operator's label. Deliberately NOT a telemetry attribute (spec §10):
		// unvalidated free text in a metric label is how an address ends up in a
		// monitoring platform.
		name: text('name').notNull(),
		url: text('url').notNull(),
		format: text('format').notNull(),
		// Bumping this re-keys this endpoint alone; rotating EVENT_SIGNING_KEY
		// re-keys every endpoint at once (spec §7.1).
		secretVersion: integer('secret_version').notNull().default(1),
		enabled: boolean('enabled').notNull().default(true),
		/**
		 * One keyset cursor over audit_event in two columns, ordered
		 * `(xmin, seq)`. NOT a `seq` high-watermark: `nextval()` is consumed at
		 * INSERT and a row becomes visible at COMMIT, and because recordEvent is
		 * called last in a transaction those two orders diverge — a seq cursor
		 * silently drops an event committed out of order (plan C1, spec §5.2).
		 *
		 * Set at creation to the current xmin horizon, which is what makes "a new
		 * endpoint does not replay eighteen months of history into a Teams
		 * channel" a property of the insert rather than a hope.
		 */
		cursorXmin: bigint('cursor_xmin', { mode: 'bigint' }).notNull(),
		cursorSeq: bigint('cursor_seq', { mode: 'bigint' }).notNull().default(0n),
		lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
		disabledAt: timestamp('disabled_at', { withTimezone: true }),
		disabledReason: text('disabled_reason'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// Kept in sync with the migration's hand-written ALTER by hand, for the
		// reason audit_event_actor_type_check records: Drizzle regenerates check
		// constraints rather than altering them.
		check('event_endpoint_format_check', sql`${table.format} IN ('generic', 'teams')`),
		// "Disabled" is ONE state, not two columns that usually agree. A manual
		// disable and an auto-disable both carry a reason, so the UI never shows a
		// disabled endpoint with nothing to say about why.
		check(
			'event_endpoint_disabled_check',
			sql`(${table.enabled} = false) = (${table.disabledAt} IS NOT NULL)`
		)
	]
);

/**
 * An exact action name (`access_request.approved`) or one trailing wildcard
 * segment (`access_request.*`). Deliberately not a glob, for the reason
 * `access_rule.pattern` gives for the same restriction: a general pattern
 * engine invites expressions nobody can reason about, and this one is
 * evaluated at the moment an event carrying a prospect's name leaves the
 * building.
 *
 * An endpoint with no rows here receives nothing. Silence is the safe reading
 * of an empty set.
 */
export const eventEndpointFilter = pgTable(
	'event_endpoint_filter',
	{
		endpointId: uuid('endpoint_id')
			.notNull()
			.references(() => eventEndpoint.id, { onDelete: 'cascade' }),
		pattern: text('pattern').notNull()
	},
	(table) => [primaryKey({ columns: [table.endpointId, table.pattern] })]
);

/**
 * A reference to an audit event, never a rendered body. That is the whole of
 * this subsystem's erasure story and the reason it is structural rather than
 * maintained: had we enriched at fan-out time, `outbound_email`'s purge path
 * would become the first of two rather than the only one — and a second one is
 * the kind that rots silently when somebody adds a field (spec §2.3).
 */
export const eventDelivery = pgTable(
	'event_delivery',
	{
		// Handed to the consumer as the idempotency key: because retries
		// re-render from live state, a consumer cannot deduplicate on a body
		// hash (spec §7.2).
		id: uuid('id').primaryKey().defaultRandom(),
		endpointId: uuid('endpoint_id')
			.notNull()
			.references(() => eventEndpoint.id, { onDelete: 'cascade' }),
		auditSeq: bigint('audit_seq', { mode: 'bigint' }).notNull(),
		// Travels in the payload so a gap is detectable by the consumer.
		auditId: uuid('audit_id').notNull(),
		status: text('status').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
		lastStatusCode: integer('last_status_code'),
		// One of DELIVERY_ERROR_REASONS. Never bytes the receiver chose.
		lastError: text('last_error'),
		deliveredAt: timestamp('delivered_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// What makes a replayed fan-out a no-op, so a crash between the fan-out
		// insert and the cursor update is safe — and what absorbs the re-scan
		// purgeRequester's UPDATE of audit_event causes (plan C1).
		unique('event_delivery_endpoint_seq_key').on(table.endpointId, table.auditSeq),
		// The claim predicate. Partial, the same shape and the same reason as
		// outbound_email_claim_idx: the index stays small as delivered rows
		// accumulate.
		index('event_delivery_claim_idx')
			.on(table.nextAttemptAt)
			.where(sql`${table.status} = 'pending'`),
		// Pending depth per endpoint, for backpressure and the admin list.
		index('event_delivery_endpoint_idx')
			.on(table.endpointId, table.status)
			.where(sql`${table.status} = 'pending'`),
		check(
			'event_delivery_status_check',
			sql`${table.status} IN ('pending', 'delivered', 'failed', 'skipped')`
		)
	]
);

export type EventEndpointRow = typeof eventEndpoint.$inferSelect;
export type EventDeliveryRow = typeof eventDelivery.$inferSelect;
```

Then add to `src/lib/server/db/schema/index.ts`, after the `./subscriptions` line:

```ts
export * from './egress';
```

- [ ] **Step 4: Generate and read the migration**

Run: `pnpm db:generate`

Then **read `drizzle/0026_*.sql` before committing it** (CLAUDE.md — several migrations are hand-extended and the snapshot in `drizzle/meta/` must stay consistent). Confirm it contains the two `event_endpoint` check constraints, `event_delivery_status_check`, the unique constraint, and all three indexes with their `WHERE` clauses. Drizzle sometimes omits partial-index predicates; if either partial index is missing its `WHERE`, hand-edit the migration to match the schema file exactly and leave a comment saying the two are kept in sync by hand.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:integration tests/integration/egress-schema.test.ts`
Expected: PASS, 7 tests.

Then `pnpm check` — expected: no errors.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/db/schema/egress.ts src/lib/server/db/schema/index.ts drizzle tests/integration/egress-schema.test.ts
git commit -m "feat(egress): add the endpoint, filter and delivery tables"
```

---

### Task 2: Filter matching

**Files:**
- Create: `src/lib/server/egress/filter.ts`
- Test: `tests/unit/egress-filter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `matchesPattern(pattern: string, action: string): boolean`; `isValidPattern(pattern: string): boolean`.

**One implementation, in TypeScript, deliberately.** Fan-out reads a bounded window (500 rows) and filters it in process (Task 9), so there is no SQL twin of this rule to keep in agreement. That is the point: the `LIKE`-underscore trap below exists *because* someone would write the SQL version, and two implementations of an egress filter that disagree at the edges is the failure this subsystem cannot afford.

- [ ] **Step 1: Write the failing test**

`tests/unit/egress-filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isValidPattern, matchesPattern } from '../../src/lib/server/egress/filter';

describe('matchesPattern', () => {
	it('matches an exact action', () => {
		expect(matchesPattern('access_request.approved', 'access_request.approved')).toBe(true);
		expect(matchesPattern('access_request.approved', 'access_request.denied')).toBe(false);
	});

	it('matches every segment below a trailing wildcard', () => {
		expect(matchesPattern('a.*', 'a.b')).toBe(true);
		expect(matchesPattern('a.*', 'a.b.c')).toBe(true);
	});

	it('does not match the prefix itself', () => {
		expect(matchesPattern('a.*', 'a')).toBe(false);
	});

	it('does not match a longer first segment', () => {
		expect(matchesPattern('a.*', 'ab.c')).toBe(false);
	});

	/**
	 * The LIKE-underscore trap (spec §4.1). This log contains both
	 * `staff.login_failed` and `staff.login.denied`, so a LIKE-based filter on
	 * the former also matches a hypothetical `staff.loginXfailed` — a silent
	 * widening of an egress filter, which is the one class of bug this
	 * subsystem cannot afford.
	 */
	it('treats an underscore as a literal, not a wildcard', () => {
		expect(matchesPattern('staff.login_failed', 'staff.login_failed')).toBe(true);
		expect(matchesPattern('staff.login_failed', 'staff.loginXfailed')).toBe(false);
		expect(matchesPattern('staff.login_failed', 'staff.login.denied')).toBe(false);
	});

	it('does not treat a dot as a regex wildcard', () => {
		expect(matchesPattern('a.b', 'aXb')).toBe(false);
	});
});

describe('isValidPattern', () => {
	it('accepts an exact name and a trailing wildcard', () => {
		expect(isValidPattern('access_request.approved')).toBe(true);
		expect(isValidPattern('access_request.*')).toBe(true);
		expect(isValidPattern('control.*')).toBe(true);
	});

	it('rejects anything a general pattern engine would need', () => {
		for (const pattern of ['*', '*.approved', 'a.*.b', 'a.**', 'a.b*', '', 'a b', 'a.B']) {
			expect(isValidPattern(pattern), pattern).toBe(false);
		}
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:unit tests/unit/egress-filter.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/filter`.

- [ ] **Step 3: Write the implementation**

`src/lib/server/egress/filter.ts`:

```ts
/** The vocabulary audit actions are drawn from: `noun.verb`, lowercase. */
const SEGMENT = '[a-z0-9_-]+';
const PATTERN = new RegExp(`^${SEGMENT}(\\.${SEGMENT})*(\\.\\*)?$`);

/**
 * An operator subscribes by pattern rather than by picking from a list this
 * subsystem controls (spec §4.1) — an operator who wants `control.*` in a
 * channel should not have to wait for us. What is restricted is the *shape*: an
 * exact name, or one trailing wildcard segment. A leading or interior wildcard
 * is rejected for the reason access_rule.pattern rejects the same thing.
 */
export function isValidPattern(pattern: string): boolean {
	return PATTERN.test(pattern);
}

/**
 * `a.*` matches `a.b` and `a.b.c`; it does not match `a`, and it does not match
 * `ab.c`. Comparison is on segment boundaries rather than on a string prefix,
 * so `ab.c` cannot slip through the `a.` prefix test.
 */
export function matchesPattern(pattern: string, action: string): boolean {
	if (!pattern.endsWith('.*')) return pattern === action;

	const prefix = pattern.slice(0, -1); // keeps the trailing dot
	return action.startsWith(prefix) && action.length > prefix.length;
}
```

Note what this is deliberately **not**: a `LIKE` predicate. `LIKE` treats `_` as a single-character wildcard, and this log contains both `staff.login_failed` and `staff.login.denied` — so `LIKE 'staff.login_failed'` also matches a hypothetical `staff.loginXfailed`. That is a subtle, silent widening of an egress filter (spec §4.1), and the test above pins it.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit tests/unit/egress-filter.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/egress/filter.ts tests/unit/egress-filter.test.ts
git commit -m "feat(egress): match action patterns without LIKE's underscore trap"
```

---

### Task 3: Secret derivation, the canary, and the signature header

**Files:**
- Create: `src/lib/server/egress/secret.ts`
- Test: `tests/unit/egress-secret.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `endpointSecret(rootKey: string, endpointId: string, version: number): Buffer`; `signBody(secret: Buffer, timestampSeconds: number, body: string): string` (lowercase hex); `signatureHeader(secrets: readonly Buffer[], timestampSeconds: number, body: string): string`; `canaryValue(rootKey: string): string`; `CANARY_SETTING_KEY = 'egress.signing_key_canary'`.

- [ ] **Step 1: Write the failing test**

`tests/unit/egress-secret.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	canaryValue,
	endpointSecret,
	signBody,
	signatureHeader
} from '../../src/lib/server/egress/secret';

const ROOT = 'x'.repeat(32);
const ID = '3f4a9c2e-0000-4000-8000-000000000001';

describe('endpointSecret', () => {
	it('is deterministic for a given id and version', () => {
		expect(endpointSecret(ROOT, ID, 1).toString('hex')).toBe(
			endpointSecret(ROOT, ID, 1).toString('hex')
		);
	});

	it('changes when the version is bumped', () => {
		expect(endpointSecret(ROOT, ID, 2).toString('hex')).not.toBe(
			endpointSecret(ROOT, ID, 1).toString('hex')
		);
	});

	it('changes with the endpoint id', () => {
		const other = '3f4a9c2e-0000-4000-8000-000000000002';
		expect(endpointSecret(ROOT, other, 1).toString('hex')).not.toBe(
			endpointSecret(ROOT, ID, 1).toString('hex')
		);
	});

	it('changes when the root key rotates', () => {
		expect(endpointSecret('y'.repeat(32), ID, 1).toString('hex')).not.toBe(
			endpointSecret(ROOT, ID, 1).toString('hex')
		);
	});
});

describe('signBody', () => {
	// The signed input is `${t}.${body}`, not the body alone: without the
	// timestamp in the signed material a captured body replays forever.
	it('covers the timestamp as well as the body', () => {
		const secret = endpointSecret(ROOT, ID, 1);
		expect(signBody(secret, 1756900000, '{"a":1}')).not.toBe(
			signBody(secret, 1756900001, '{"a":1}')
		);
	});

	it('is lowercase hex of a SHA-256 HMAC', () => {
		const signature = signBody(endpointSecret(ROOT, ID, 1), 1756900000, '{}');
		expect(signature).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('signatureHeader', () => {
	it('emits one v1 signature for a single secret', () => {
		const secret = endpointSecret(ROOT, ID, 1);
		expect(signatureHeader([secret], 1756900000, '{}')).toBe(
			`t=1756900000,v1=${signBody(secret, 1756900000, '{}')}`
		);
	});

	/**
	 * The rotation overlap. Without it a rotation makes every consumer return
	 * 401, which §5.3 makes terminal on the first attempt — so a routine key
	 * bump would fail every queued delivery (spec §7.2).
	 */
	it('emits both signatures during a rotation overlap', () => {
		const current = endpointSecret(ROOT, ID, 2);
		const previous = endpointSecret(ROOT, ID, 1);
		const header = signatureHeader([current, previous], 1756900000, '{}');

		expect(header).toBe(
			`t=1756900000,v1=${signBody(current, 1756900000, '{}')},v1=${signBody(previous, 1756900000, '{}')}`
		);
	});
});

describe('canaryValue', () => {
	it('differs when the root key differs', () => {
		expect(canaryValue(ROOT)).not.toBe(canaryValue('y'.repeat(32)));
	});

	it('is stable for one root key', () => {
		expect(canaryValue(ROOT)).toBe(canaryValue(ROOT));
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:unit tests/unit/egress-secret.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/secret`.

- [ ] **Step 3: Write the implementation**

`src/lib/server/egress/secret.ts`:

```ts
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
 * Stored on first use and compared on every boot. Without it, restoring a
 * backup into an environment with a different or absent EVENT_SIGNING_KEY
 * silently re-keys every endpoint and nothing detects it — the one property a
 * stored secret gets for free and derivation otherwise loses. One row, and it
 * converts a silent failure into a loud one (spec §7.1).
 */
export function canaryValue(rootKey: string): string {
	return createHmac('sha256', rootKey).update('canary').digest('hex');
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit tests/unit/egress-secret.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/egress/secret.ts tests/unit/egress-secret.test.ts
git commit -m "feat(egress): derive per-endpoint signing secrets with a key canary"
```

---

### Task 4: The destination check — URL validation, address classification, the allowlist

**Files:**
- Create: `src/lib/server/egress/destination.ts`
- Test: `tests/unit/egress-destination.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class EgressDestinationRejected extends Error` with `reason: 'url' | 'destination_denied'`; `parseAllowList(raw: string | undefined): AllowEntry[]`; `classifyAddress(address: string): 'denied' | 'private' | 'public'`; `validateEndpointUrl(raw: string): URL`; `resolveDestination(url: URL, allow: readonly AllowEntry[], lookup?: LookupAll): Promise<PinnedAddress>` where `PinnedAddress = { address: string; family: 4 | 6; port: number }` and `LookupAll = (host: string) => Promise<{ address: string; family: number }[]>`.

**Threat model, stated because the design depends on which one it is:** this control exists against *a malicious or compromised admin account*, not only against operator accident. That is why the resolved address is pinned rather than re-resolved — against an accident a documented rebinding window is fine; against an actor who chooses the hostname it is the whole attack (spec §6).

- [ ] **Step 1: Write the failing test**

`tests/unit/egress-destination.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	classifyAddress,
	EgressDestinationRejected,
	parseAllowList,
	resolveDestination,
	validateEndpointUrl
} from '../../src/lib/server/egress/destination';

/** A stub resolver, so this whole table stays in the unit suite. */
function resolver(...addresses: string[]) {
	return async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
}

describe('classifyAddress', () => {
	it('denies loopback, link-local, unspecified and multicast', () => {
		for (const address of [
			'127.0.0.1',
			'127.1.2.3',
			'::1',
			'169.254.169.254',
			'169.254.0.1',
			'fe80::1',
			'0.0.0.0',
			'::',
			'224.0.0.1',
			'ff02::1'
		]) {
			expect(classifyAddress(address), address).toBe('denied');
		}
	});

	/**
	 * A classifier that is correct only for canonical input is not a
	 * classifier. `::ffff:169.254.169.254` is the cloud metadata endpoint
	 * wearing an IPv6 hat.
	 */
	it('normalises IPv4-mapped IPv6 before classifying', () => {
		expect(classifyAddress('::ffff:169.254.169.254')).toBe('denied');
		expect(classifyAddress('::ffff:127.0.0.1')).toBe('denied');
		expect(classifyAddress('::ffff:10.0.0.1')).toBe('private');
		expect(classifyAddress('::ffff:93.184.216.34')).toBe('public');
	});

	it('classifies RFC1918, CGNAT and ULA as private', () => {
		for (const address of [
			'10.0.0.1',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			// CGNAT, which is in scope precisely because Alibaba Cloud's metadata
			// service lives at 100.100.100.200 (spec §6.3).
			'100.64.0.1',
			'100.100.100.200',
			'fc00::1',
			'fd12:3456::1'
		]) {
			expect(classifyAddress(address), address).toBe('private');
		}
	});

	it('leaves ordinary public addresses public', () => {
		expect(classifyAddress('93.184.216.34')).toBe('public');
		expect(classifyAddress('172.32.0.1')).toBe('public');
		expect(classifyAddress('2606:2800:220:1::')).toBe('public');
	});
});

describe('validateEndpointUrl', () => {
	it('accepts an https URL on the default port', () => {
		expect(validateEndpointUrl('https://hooks.example.test/abc').hostname).toBe(
			'hooks.example.test'
		);
	});

	it('accepts an explicit port 80 or 443', () => {
		expect(validateEndpointUrl('https://hooks.example.test:443/a').port).toBe('443');
		expect(validateEndpointUrl('http://n8n:80/webhook/x').port).toBe('80');
	});

	/**
	 * A credential in a field §9 deliberately keeps out of the audit log, and a
	 * contradiction of "no credential is ever attached" (spec §6.2).
	 */
	it('rejects userinfo', () => {
		expect(() => validateEndpointUrl('https://user:pass@hooks.example.test/a')).toThrow(
			EgressDestinationRejected
		);
		expect(() => validateEndpointUrl('https://user@hooks.example.test/a')).toThrow();
	});

	it('rejects a non-http(s) scheme', () => {
		for (const raw of ['file:///etc/passwd', 'gopher://x/1', 'ftp://x/a', 'ws://x/a']) {
			expect(() => validateEndpointUrl(raw), raw).toThrow(EgressDestinationRejected);
		}
	});

	it('rejects a port outside 80 and 443 unless the allowlist names it', () => {
		expect(() => validateEndpointUrl('https://hooks.example.test:10250/a')).toThrow(
			EgressDestinationRejected
		);
		// Named in the allowlist, so the URL itself is acceptable; whether the
		// address is reachable is resolveDestination's question.
		expect(
			validateEndpointUrl('http://n8n:5678/webhook/x', parseAllowList('n8n:5678')).port
		).toBe('5678');
	});

	/**
	 * Decimal and octal IPv4 literals, which are the classic way to smuggle a
	 * denied address past a textual check.
	 */
	it('rejects a non-canonical numeric host', () => {
		for (const raw of [
			'https://2130706433/a',
			'https://0177.0.0.1/a',
			'https://0x7f.1/a',
			'https://[::ffff:7f00:1]/a'
		]) {
			expect(() => validateEndpointUrl(raw), raw).toThrow(EgressDestinationRejected);
		}
	});

	it('strips a trailing dot from the hostname', () => {
		expect(validateEndpointUrl('https://hooks.example.test./a').hostname).toBe(
			'hooks.example.test'
		);
	});
});

describe('resolveDestination', () => {
	const url = validateEndpointUrl('https://hooks.example.test/a');

	it('pins the first public address', async () => {
		const pinned = await resolveDestination(url, [], resolver('93.184.216.34'));
		expect(pinned).toEqual({ address: '93.184.216.34', family: 4, port: 443 });
	});

	/**
	 * Every returned address is classified, not just the one that would be
	 * used: a name that resolves to one public and one denied address is a
	 * rebinding attempt, and picking the good one leaves the attack live.
	 */
	it('refuses when any returned address is denied', async () => {
		await expect(
			resolveDestination(url, [], resolver('93.184.216.34', '169.254.169.254'))
		).rejects.toThrow(EgressDestinationRejected);
	});

	it('refuses a private address with an empty allowlist', async () => {
		await expect(resolveDestination(url, [], resolver('10.1.2.3'))).rejects.toThrow(
			EgressDestinationRejected
		);
	});

	it('permits a private address named by host and port in the allowlist', async () => {
		const target = validateEndpointUrl('http://n8n:5678/webhook/x', parseAllowList('n8n:5678'));
		const pinned = await resolveDestination(
			target,
			parseAllowList('n8n:5678'),
			resolver('10.1.2.3')
		);
		expect(pinned).toEqual({ address: '10.1.2.3', family: 4, port: 5678 });
	});

	it('permits a private address inside an allowlisted CIDR', async () => {
		const pinned = await resolveDestination(url, parseAllowList('10.1.0.0/16'), resolver('10.1.2.3'));
		expect(pinned.address).toBe('10.1.2.3');
	});

	it('does not permit an address outside the allowlisted CIDR', async () => {
		await expect(
			resolveDestination(url, parseAllowList('10.1.0.0/16'), resolver('10.2.2.3'))
		).rejects.toThrow(EgressDestinationRejected);
	});

	/**
	 * The allowlist names destinations that may resolve into otherwise-denied
	 * space. It does not — and must not — reach the unconditional denials:
	 * no legitimate webhook lives at a metadata endpoint, and no configuration
	 * makes reaching one the operator's intent (spec §6.3).
	 */
	it('never permits an unconditionally denied address, allowlist or not', async () => {
		for (const allow of ['0.0.0.0/0', '169.254.0.0/16', 'hooks.example.test']) {
			await expect(
				resolveDestination(url, parseAllowList(allow), resolver('169.254.169.254')),
				allow
			).rejects.toThrow(EgressDestinationRejected);
		}
	});

	it('refuses plain http to a public address', async () => {
		const target = validateEndpointUrl('http://hooks.example.test:80/a');
		await expect(resolveDestination(target, [], resolver('93.184.216.34'))).rejects.toThrow(
			EgressDestinationRejected
		);
	});

	it('refuses when the name resolves to nothing', async () => {
		await expect(resolveDestination(url, [], resolver())).rejects.toThrow(
			EgressDestinationRejected
		);
	});
});

describe('parseAllowList', () => {
	it('is empty for an unset or blank value', () => {
		expect(parseAllowList(undefined)).toEqual([]);
		expect(parseAllowList('')).toEqual([]);
	});

	it('parses hosts, host:port and CIDRs', () => {
		expect(parseAllowList('n8n:5678, 10.1.0.0/16 ,hooks.internal')).toEqual([
			{ kind: 'host', host: 'n8n', port: 5678 },
			{ kind: 'cidr', cidr: '10.1.0.0/16' },
			{ kind: 'host', host: 'hooks.internal', port: undefined }
		]);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:unit tests/unit/egress-destination.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/destination`.

- [ ] **Step 3: Write the implementation**

`src/lib/server/egress/destination.ts`:

```ts
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, isIPv4 } from 'node:net';

export type AllowEntry =
	| { kind: 'host'; host: string; port: number | undefined }
	| { kind: 'cidr'; cidr: string };

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

/** `n8n:5678, 10.1.0.0/16, hooks.internal` — hosts, host:port, or CIDRs. */
export function parseAllowList(raw: string | undefined): AllowEntry[] {
	if (!raw) return [];

	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry): AllowEntry => {
			if (entry.includes('/')) return { kind: 'cidr', cidr: entry };

			const colon = entry.lastIndexOf(':');
			// A bare IPv6 literal has colons too, so only a trailing all-digit
			// segment counts as a port.
			if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1)) && !isIP(entry)) {
				return { kind: 'host', host: entry.slice(0, colon).toLowerCase(), port: Number(entry.slice(colon + 1)) };
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

	return groups.reduce((accumulator, group) => (accumulator << 16n) + BigInt(parseInt(group || '0', 16)), 0n);
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
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

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
		throw new EgressDestinationRejected(`${url.hostname} resolved to nothing`, 'destination_denied');
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
	if (!base || !bitsRaw) return false;

	const normalised = unmap(address);
	const bits = BigInt(bitsRaw);

	if (isIPv4(normalised) && isIPv4(base)) {
		const mask = (1n << 32n) - (1n << (32n - bits));
		return (ipv4ToInt(normalised) & mask) === (ipv4ToInt(base) & mask);
	}
	if (!isIPv4(normalised) && !isIPv4(base)) {
		const mask = (1n << 128n) - (1n << (128n - bits));
		return (ipv6ToInt(normalised) & mask) === (ipv6ToInt(base) & mask);
	}

	return false;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit tests/unit/egress-destination.test.ts`
Expected: PASS, 17 tests. If the `0.0.0.0/0` allowlist case fails, the unconditional denial is being consulted after the allowlist rather than before — fix the order, do not weaken the test.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/egress/destination.ts tests/unit/egress-destination.test.ts
git commit -m "feat(egress): validate destinations and pin the checked address"
```

---

### Task 5: The egress client and retry classification

**Files:**
- Create: `src/lib/server/egress/client.ts`
- Create: `tests/helpers/webhook-server.ts`
- Test: `tests/unit/egress-retry.test.ts`, `tests/unit/egress-client.test.ts`

**Interfaces:**
- Consumes: `EgressDestinationRejected`, `PinnedAddress`, `resolveDestination`, `validateEndpointUrl`, `parseAllowList` (Task 4); `DeliveryErrorReason` (Task 1).
- Produces: `postEvent(input: PostInput): Promise<PostOutcome>` where
  `PostInput = { url: URL; allow: readonly AllowEntry[]; body: string; contentType: string; headers: Record<string, string> }`
  and `PostOutcome = { kind: 'delivered'; statusCode: number } | { kind: 'failed'; statusCode: number | null; reason: DeliveryErrorReason; retryable: boolean; retryAfterSeconds: number | null }`;
  `classifyResponse(statusCode: number, retryAfter: string | null): { retryable: boolean; retryAfterSeconds: number | null }`;
  `EGRESS_TIMEOUT_MS = 10_000`; `MAX_RESPONSE_BYTES = 8192`.
  From the fixture: `startWebhookServer(handler): Promise<{ url: string; requests: RecordedRequest[]; close(): Promise<void> }>` with `RecordedRequest = { method: string; headers: Record<string, string>; body: string }`.

- [ ] **Step 1: Write the failing retry-classification test**

`tests/unit/egress-retry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { backoffMinutes, classifyResponse, MAX_ATTEMPTS } from '../../src/lib/server/egress/client';

describe('classifyResponse', () => {
	it('retries a 5xx, a 408 and a 429', () => {
		for (const status of [408, 429, 500, 502, 503, 504]) {
			expect(classifyResponse(status, null).retryable, String(status)).toBe(true);
		}
	});

	/**
	 * Retrying a 404 or a 401 five times over fifteen minutes buys nothing and
	 * delays the operator seeing a misconfiguration by a quarter of an hour
	 * (spec §5.3).
	 */
	it('is terminal on any other 4xx', () => {
		for (const status of [400, 401, 403, 404, 410, 422]) {
			expect(classifyResponse(status, null).retryable, String(status)).toBe(false);
		}
	});

	// A redirect is the cheapest way to launder a denied destination into an
	// allowed one, and no legitimate webhook receiver needs one (spec §6.1).
	it('is terminal on any 3xx', () => {
		for (const status of [301, 302, 307, 308]) {
			expect(classifyResponse(status, null).retryable, String(status)).toBe(false);
		}
	});

	it('honours Retry-After on a 429, capped at fifteen minutes', () => {
		expect(classifyResponse(429, '30').retryAfterSeconds).toBe(30);
		expect(classifyResponse(429, '99999').retryAfterSeconds).toBe(900);
		expect(classifyResponse(429, 'not-a-number').retryAfterSeconds).toBeNull();
	});

	/**
	 * Only on 429, where it is a rate-limit signal. On a 5xx it is a server
	 * guessing about its own recovery, and our backoff is already the right
	 * answer (spec §15).
	 */
	it('ignores Retry-After on a 5xx', () => {
		expect(classifyResponse(503, '600').retryAfterSeconds).toBeNull();
	});
});

describe('backoffMinutes', () => {
	// outbound_email's numbers verbatim, so the deployment has one retry story
	// rather than two that differ for no reason (spec §5.3).
	it('is 1, 2, 4, 8 minutes and then gives up', () => {
		expect([1, 2, 3, 4].map(backoffMinutes)).toEqual([1, 2, 4, 8]);
		expect(MAX_ATTEMPTS).toBe(5);
	});
});
```

- [ ] **Step 2: Write the failing client test**

`tests/unit/egress-client.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { postEvent } from '../../src/lib/server/egress/client';
import { parseAllowList, validateEndpointUrl } from '../../src/lib/server/egress/destination';
import { startWebhookServer } from '../helpers/webhook-server';

let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	stop = undefined;
});

/**
 * The fixture listens on 127.0.0.1, which `classifyAddress` denies
 * unconditionally — so these tests allowlist nothing and instead point the
 * client at the loopback address through the one seam that exists for it: the
 * allowlist cannot admit loopback, so `postEvent` takes an explicit
 * `pinnedAddress` override that only tests pass. Every other property under
 * test (headers, redirect refusal, the discarded body, the timeout) is
 * unaffected by which address it is.
 */
async function serve(handler: Parameters<typeof startWebhookServer>[0]) {
	const server = await startWebhookServer(handler);
	stop = server.close;
	return server;
}

describe('postEvent', () => {
	it('POSTs the body with the given headers and reports the status', async () => {
		const server = await serve((_request, response) => {
			response.writeHead(200).end('ok');
		});

		const outcome = await postEvent({
			url: validateEndpointUrl(server.url),
			allow: parseAllowList(''),
			pinnedAddress: { address: '127.0.0.1', family: 4, port: server.port },
			body: '{"event":"access_request.pending"}',
			contentType: 'application/json',
			headers: { 'X-Trust-Center-Event': 'access_request.pending' }
		});

		expect(outcome).toEqual({ kind: 'delivered', statusCode: 200 });
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.method).toBe('POST');
		expect(server.requests[0]?.body).toBe('{"event":"access_request.pending"}');
		expect(server.requests[0]?.headers['x-trust-center-event']).toBe('access_request.pending');
		expect(server.requests[0]?.headers['content-type']).toBe('application/json');
		// No cookie jar, and no operator-supplied header (spec §6.2).
		expect(server.requests[0]?.headers.cookie).toBeUndefined();
	});

	it('refuses a redirect rather than following it', async () => {
		const server = await serve((_request, response) => {
			response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
		});

		const outcome = await postEvent({
			url: validateEndpointUrl(server.url),
			allow: [],
			pinnedAddress: { address: '127.0.0.1', family: 4, port: server.port },
			body: '{}',
			contentType: 'application/json',
			headers: {}
		});

		expect(outcome).toMatchObject({
			kind: 'failed',
			statusCode: 302,
			reason: 'redirect_refused',
			retryable: false
		});
		expect(server.requests).toHaveLength(1);
	});

	/**
	 * Three reasons, any one sufficient (spec §6.4): a receiver that echoes its
	 * input would put requester personal data into a column purgeRequester
	 * cannot reach; a slowloris or a multi-gigabyte response defeats an
	 * `await res.text()`-then-slice bound because that buffers first; and with
	 * §11's inline test send a stored body turns an admin-triggered request
	 * into an SSRF read primitive.
	 */
	it('never returns the response body', async () => {
		const server = await serve((_request, response) => {
			response.writeHead(200).end('x'.repeat(64 * 1024));
		});

		const outcome = await postEvent({
			url: validateEndpointUrl(server.url),
			allow: [],
			pinnedAddress: { address: '127.0.0.1', family: 4, port: server.port },
			body: '{}',
			contentType: 'application/json',
			headers: {}
		});

		expect(outcome).toEqual({ kind: 'delivered', statusCode: 200 });
		expect(JSON.stringify(outcome)).not.toContain('xxxx');
	});

	it('reports a refused destination without making a request', async () => {
		const outcome = await postEvent({
			url: validateEndpointUrl('https://hooks.example.test/a'),
			allow: [],
			body: '{}',
			contentType: 'application/json',
			headers: {},
			// Resolution is stubbed to a denied address, so the guard runs where a
			// real delivery would run it: at delivery time, not only at save.
			lookup: async () => [{ address: '169.254.169.254', family: 4 }]
		});

		expect(outcome).toMatchObject({
			kind: 'failed',
			statusCode: null,
			reason: 'destination_denied',
			retryable: false
		});
	});
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm test:unit tests/unit/egress-retry.test.ts tests/unit/egress-client.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/client` or `tests/helpers/webhook-server`.

- [ ] **Step 4: Write the fixture**

`tests/helpers/webhook-server.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export interface RecordedRequest {
	method: string;
	headers: Record<string, string>;
	body: string;
}

/**
 * A one-off HTTP receiver on loopback. Exists so delivery, retry and header
 * assertions run against a real socket rather than a mocked `request` — the
 * properties under test here (a refused redirect, a discarded body, a timeout)
 * are all properties of the transport, and a mock would assert the mock.
 */
export async function startWebhookServer(
	handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<{
	url: string;
	port: number;
	requests: RecordedRequest[];
	close: () => Promise<void>;
}> {
	const requests: RecordedRequest[] = [];

	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			requests.push({
				method: request.method ?? '',
				headers: request.headers as Record<string, string>,
				body: Buffer.concat(chunks).toString('utf8')
			});
			handler(request, response);
		});
	});

	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no port assigned');

	return {
		url: `http://127.0.0.1:${address.port}/webhook`,
		port: address.port,
		requests,
		close: async () => {
			server.closeAllConnections();
			server.close();
			await once(server, 'close');
		}
	};
}
```

- [ ] **Step 5: Write the client**

`src/lib/server/egress/client.ts`:

```ts
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
	EgressDestinationRejected,
	resolveDestination,
	type AllowEntry,
	type LookupAll,
	type PinnedAddress
} from './destination';
import type { DeliveryErrorReason } from '../db/schema';

export const EGRESS_TIMEOUT_MS = 10_000;
/** Read to a bound and discarded. Never stored, never returned. */
export const MAX_RESPONSE_BYTES = 8192;
/** outbound_email's numbers verbatim (spec §5.3). */
export const MAX_ATTEMPTS = 5;
const RETRY_AFTER_CAP_SECONDS = 900;

export function backoffMinutes(attempt: number): number {
	return 2 ** (attempt - 1);
}

export function classifyResponse(
	statusCode: number,
	retryAfter: string | null
): { retryable: boolean; retryAfterSeconds: number | null } {
	if (statusCode === 429) {
		const parsed = Number(retryAfter);
		const seconds =
			retryAfter !== null && Number.isFinite(parsed) && parsed >= 0
				? Math.min(parsed, RETRY_AFTER_CAP_SECONDS)
				: null;
		return { retryable: true, retryAfterSeconds: seconds };
	}

	if (statusCode === 408 || statusCode >= 500) return { retryable: true, retryAfterSeconds: null };

	// Any other 4xx, and any 3xx, are terminal on the first attempt.
	return { retryable: false, retryAfterSeconds: null };
}

export type PostOutcome =
	| { kind: 'delivered'; statusCode: number }
	| {
			kind: 'failed';
			statusCode: number | null;
			reason: DeliveryErrorReason;
			retryable: boolean;
			retryAfterSeconds: number | null;
	  };

export interface PostInput {
	url: URL;
	allow: readonly AllowEntry[];
	body: string;
	contentType: string;
	headers: Record<string, string>;
	/** Test seam: skips resolution when the address is already known. */
	pinnedAddress?: PinnedAddress;
	/** Test seam: the resolver `resolveDestination` uses. */
	lookup?: LookupAll;
}

/**
 * The one way out. Not a general HTTP client and not reusable as one (spec §6):
 * POST only, no redirects, no cookie jar, no operator-supplied header, a fixed
 * timeout, and the *validated* address handed to the socket through the
 * `lookup` option so the connection cannot go somewhere a second resolution
 * would return.
 */
export async function postEvent(input: PostInput): Promise<PostOutcome> {
	let pinned: PinnedAddress;
	try {
		pinned = input.pinnedAddress ?? (await resolveDestination(input.url, input.allow, input.lookup));
	} catch (cause) {
		if (cause instanceof EgressDestinationRejected) {
			return {
				kind: 'failed',
				statusCode: null,
				reason: 'destination_denied',
				retryable: false,
				retryAfterSeconds: null
			};
		}
		throw cause;
	}

	const send = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
	const payload = Buffer.from(input.body, 'utf8');

	return new Promise<PostOutcome>((resolve) => {
		const clientRequest = send({
			protocol: input.url.protocol,
			hostname: input.url.hostname,
			port: pinned.port,
			path: `${input.url.pathname}${input.url.search}`,
			method: 'POST',
			headers: {
				...input.headers,
				'content-type': input.contentType,
				'content-length': payload.byteLength
			},
			timeout: EGRESS_TIMEOUT_MS,
			// The whole point: the socket connects to the address that was
			// classified, not to whatever DNS returns a second time.
			lookup: (_hostname, options, callback) => {
				if (options && (options as { all?: boolean }).all) {
					(callback as unknown as (error: null, addresses: unknown[]) => void)(null, [
						{ address: pinned.address, family: pinned.family }
					]);
					return;
				}
				(callback as (error: null, address: string, family: number) => void)(
					null,
					pinned.address,
					pinned.family
				);
			}
		});

		let settled = false;
		const settle = (outcome: PostOutcome) => {
			if (settled) return;
			settled = true;
			clientRequest.destroy();
			resolve(outcome);
		};

		clientRequest.on('response', (response) => {
			const statusCode = response.statusCode ?? 0;

			if (statusCode >= 300 && statusCode < 400) {
				settle({
					kind: 'failed',
					statusCode,
					reason: 'redirect_refused',
					retryable: false,
					retryAfterSeconds: null
				});
				return;
			}

			// Counted and dropped as it arrives. `await res.text()` then slice
			// buffers first, which is what a multi-gigabyte response exploits.
			let seen = 0;
			response.on('data', (chunk: Buffer) => {
				seen += chunk.byteLength;
				if (seen > MAX_RESPONSE_BYTES) response.destroy();
			});

			const finish = () => {
				if (statusCode >= 200 && statusCode < 300) {
					settle({ kind: 'delivered', statusCode });
					return;
				}

				const classification = classifyResponse(
					statusCode,
					response.headers['retry-after'] as string | null | undefined ?? null
				);
				settle({
					kind: 'failed',
					statusCode,
					reason: 'http_status',
					retryable: classification.retryable,
					retryAfterSeconds: classification.retryAfterSeconds
				});
			};

			response.on('end', finish);
			// destroy() after the bound is hit ends the stream without 'end'.
			response.on('close', finish);
		});

		clientRequest.on('timeout', () => {
			settle({
				kind: 'failed',
				statusCode: null,
				reason: 'timeout',
				retryable: true,
				retryAfterSeconds: null
			});
		});

		clientRequest.on('error', () => {
			settle({
				kind: 'failed',
				statusCode: null,
				reason: 'network',
				retryable: true,
				retryAfterSeconds: null
			});
		});

		clientRequest.end(payload);
	});
}
```

Add `pinnedAddress` and `lookup` to `PostInput` only as the two test seams they are — the comment above each says so, so a later reader does not wire them into the delivery path.

- [ ] **Step 6: Run the tests**

Run: `pnpm test:unit tests/unit/egress-retry.test.ts tests/unit/egress-client.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/lib/server/egress/client.ts tests/helpers/webhook-server.ts tests/unit/egress-retry.test.ts tests/unit/egress-client.test.ts
git commit -m "feat(egress): add the hardened POST client and retry classification"
```

---

### Task 6: `EventModel` and enrichment

**Files:**
- Create: `src/lib/server/egress/model.ts`, `src/lib/server/egress/enrich.ts`
- Test: `tests/integration/egress-enrich.test.ts`

**Interfaces:**
- Consumes: `AuditEventRow` (`src/lib/server/audit`), the domain schema tables.
- Produces: `interface EventModel` (exact shape below); `interface EnrichContext { deliveryId: string; baseUrl: string; locale: string }`; `type EnrichOutcome = { kind: 'model'; model: EventModel } | { kind: 'skip'; reason: 'subject_purged' | 'subject_missing' }`; `enrichEvent(db: Db, row: AuditEventRow, context: EnrichContext): Promise<EnrichOutcome>`; `ENRICHED_ACTIONS: readonly string[]`.

**The governing rule, cited by the code:** *the payload carries what a consumer needs to act on, never what only the audit log needs to prove.* `ip` and `ua` are forensic columns — no card renders them, no automation branches on them, and shipping them would put an address in an n8n execution history for *every* event rather than the ones an operator chose. Enriched payloads carry name, company and email precisely because those *are* what the consumer acts on.

- [ ] **Step 1: Write `model.ts`**

```ts
/**
 * The stable seam. Everything above it is domain code that reads the database;
 * everything below it is presentation. This is the thing this subsystem
 * promises not to break, and every wire shape is derived from it (spec §3.1).
 */
export interface EventModel {
	/** The audit action, verbatim. */
	action: string;
	at: Date;
	/** audit_event.id */
	eventId: string;
	/** audit_event.seq, as a string: a bigint does not survive JSON.stringify. */
	seq: string;
	deliveryId: string;
	subject: { type: string; id: string } | null;
	actor: { type: string; id: string | null };
	/**
	 * True when the payload's subject data was identity-verified. False on the
	 * fallback path and on `access_request.submitted`, whose data is free text
	 * from a public form (spec §4.3) — stated on the wire so a consumer
	 * branching on it does not have to know which of our action names implies
	 * verification.
	 */
	verified: boolean;
	/** Enriched from live domain state, or the audit row's meta as a fallback. */
	data: Record<string, unknown>;
	/** Human-readable one-liner. Formatters that render prose use this. */
	summary: string;
	/** Absolute URL into the admin area, where one exists for the subject. */
	link: string | null;
}
```

- [ ] **Step 2: Write the failing test**

`tests/integration/egress-enrich.test.ts`. Build fixtures with direct inserts; the suite migrates a fresh database, so nothing pre-exists.

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { recordEvent } from '../../src/lib/server/audit';
import {
	accessGrant,
	accessRequest,
	auditEvent,
	document,
	documentFile,
	documentTranslation,
	requester
} from '../../src/lib/server/db/schema';
import { enrichEvent } from '../../src/lib/server/egress/enrich';

let db: Db;
let close: () => Promise<void>;

const CONTEXT = {
	deliveryId: 'd1e5f2a0-0000-4000-8000-00000000000a',
	baseUrl: 'https://trust.example.com',
	locale: 'en'
};

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

async function newestEvent(action: string) {
	const [row] = await db
		.select()
		.from(auditEvent)
		.where(eq(auditEvent.action, action))
		.orderBy(sql`seq desc`)
		.limit(1);
	if (!row) throw new Error(`no ${action} event`);
	return row;
}

async function insertRequester(overrides: Record<string, unknown> = {}): Promise<string> {
	const [row] = await db
		.insert(requester)
		.values({
			email: `person-${crypto.randomUUID()}@acme.example`,
			name: 'Dana Vogel',
			company: 'Acme GmbH',
			companyDomain: 'acme.example',
			locale: 'en',
			...overrides
		})
		.returning({ id: requester.id });
	return row!.id;
}

describe('enrichEvent', () => {
	it('enriches access_request.pending from live domain state', async () => {
		const requesterId = await insertRequester();
		const [request] = await db
			.insert(accessRequest)
			.values({ requesterId, status: 'pending' })
			.returning({ id: accessRequest.id });

		await recordEvent(db, {
			action: 'access_request.pending',
			actor: { type: 'requester', id: requesterId },
			subjectType: 'access_request',
			subjectId: request!.id,
			ip: '198.51.100.7',
			ua: 'Mozilla/5.0',
			meta: { ruleId: null, domain: 'acme.example' }
		});

		const outcome = await enrichEvent(db, await newestEvent('access_request.pending'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.verified).toBe(true);
		expect(outcome.model.data).toMatchObject({
			name: 'Dana Vogel',
			company: 'Acme GmbH',
			companyDomain: 'acme.example'
		});
		expect(outcome.model.data.email).toContain('@acme.example');
		expect(outcome.model.summary).toContain('Acme GmbH');
		expect(outcome.model.link).toBe(`https://trust.example.com/en/admin/requests/${request!.id}`);
		expect(outcome.model.seq).toBe(String(outcome.model.seq));
		// Forensic columns never travel.
		expect(JSON.stringify(outcome.model)).not.toContain('198.51.100.7');
		expect(JSON.stringify(outcome.model)).not.toContain('Mozilla');
	});

	/**
	 * A privacy feature must not cause a data-integrity failure. A consumer
	 * receiving `name: ""`, `email: ""` cannot distinguish it from a person
	 * with no name: n8n → HubSpot will create a junk contact, or error, or —
	 * worst — upsert by an empty email and overwrite an unrelated record.
	 * Blanks are the one shape a consumer cannot branch on (spec §4.5).
	 */
	it('skips an event whose requester has been purged', async () => {
		const requesterId = await insertRequester();
		const [request] = await db
			.insert(accessRequest)
			.values({ requesterId, status: 'approved' })
			.returning({ id: accessRequest.id });
		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'requester', id: requesterId },
			subjectType: 'access_request',
			subjectId: request!.id
		});

		// Exactly what purgeRequester writes — NOT blank columns. An
		// implementation testing for an empty email gets the one field a CRM
		// upserts on wrong.
		await db
			.update(requester)
			.set({
				email: `purged-${requesterId}@invalid`,
				name: '',
				company: '',
				companyDomain: '',
				purgedAt: new Date()
			})
			.where(eq(requester.id, requesterId));

		const outcome = await enrichEvent(db, await newestEvent('access_request.approved'), CONTEXT);
		expect(outcome).toEqual({ kind: 'skip', reason: 'subject_purged' });
	});

	it('skips an event whose subject row is gone', async () => {
		const requesterId = await insertRequester();
		const [request] = await db
			.insert(accessRequest)
			.values({ requesterId, status: 'pending' })
			.returning({ id: accessRequest.id });
		await recordEvent(db, {
			action: 'access_request.pending',
			actor: { type: 'requester', id: requesterId },
			subjectType: 'access_request',
			subjectId: request!.id
		});
		await db.delete(accessRequest).where(eq(accessRequest.id, request!.id));

		const outcome = await enrichEvent(db, await newestEvent('access_request.pending'), CONTEXT);
		expect(outcome).toEqual({ kind: 'skip', reason: 'subject_missing' });
	});

	/**
	 * §6.6 guarantees `meta` holds no requester personal data, so the fallback
	 * is safe by construction rather than by filtering — which is worth
	 * preserving, because a filter is a thing somebody later forgets to extend.
	 */
	it('falls back to the audit row for an unregistered action', async () => {
		await recordEvent(db, {
			action: 'certification.created',
			actor: { type: 'staff', id: crypto.randomUUID() },
			subjectType: 'certification',
			subjectId: crypto.randomUUID(),
			ip: '198.51.100.9',
			ua: 'curl/8',
			meta: { slug: 'iso-27001' }
		});

		const outcome = await enrichEvent(db, await newestEvent('certification.created'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.verified).toBe(false);
		expect(outcome.model.data).toEqual({ slug: 'iso-27001' });
		expect(outcome.model.link).toBeNull();
		expect(JSON.stringify(outcome.model)).not.toContain('198.51.100.9');
		expect(JSON.stringify(outcome.model)).not.toContain('curl/8');
	});

	/**
	 * `access_request.submitted` takes the fallback path deliberately: at the
	 * moment it is written there is no requester row, and the name and address
	 * are free text from a public, unauthenticated form. Enriching it would
	 * make that form a delivery mechanism aimed at the operator's own staff
	 * channel and CRM (spec §4.3).
	 */
	it('does not enrich access_request.submitted', async () => {
		await recordEvent(db, {
			action: 'access_request.submitted',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID(),
			meta: { documentCount: 2, tiers: ['request'] }
		});

		const outcome = await enrichEvent(db, await newestEvent('access_request.submitted'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.verified).toBe(false);
		expect(outcome.model.data).toEqual({ documentCount: 2, tiers: ['request'] });
	});

	/**
	 * Plan C5. `/api/documents/{fileId}` is the cookie-free public path, so
	 * this event is routinely written with a null actor id and no requester
	 * row. Treating that as a missing subject would silently drop every public
	 * download notification an operator subscribed to.
	 */
	it('delivers a public document.downloaded with no requester', async () => {
		const [doc] = await db
			.insert(document)
			.values({ slug: `policy-${crypto.randomUUID()}`, tier: 'public' })
			.returning({ id: document.id });
		await db
			.insert(documentTranslation)
			.values({ documentId: doc!.id, locale: 'en', title: 'Information Security Policy' });
		const [file] = await db
			.insert(documentFile)
			.values({
				documentId: doc!.id,
				locale: 'en',
				version: 1,
				storageKey: `k-${crypto.randomUUID()}`,
				contentType: 'application/pdf',
				sizeBytes: 1024,
				sha256: 'a'.repeat(64)
			})
			.returning({ id: documentFile.id });

		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'requester', id: null },
			subjectType: 'document_file',
			subjectId: file!.id,
			meta: { documentId: doc!.id, locale: 'en', version: 1, tier: 'public', watermarked: false }
		});

		const outcome = await enrichEvent(db, await newestEvent('document.downloaded'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.actor.id).toBeNull();
		expect(outcome.model.verified).toBe(false);
		expect(outcome.model.data).toMatchObject({ title: 'Information Security Policy', tier: 'public' });
		expect(outcome.model.data).not.toHaveProperty('email');
	});

	it('enriches a gated document.downloaded with the requester', async () => {
		const requesterId = await insertRequester({ name: 'Ines Roth', company: 'Beta AG' });
		const [doc] = await db
			.insert(document)
			.values({ slug: `soc2-${crypto.randomUUID()}`, tier: 'request' })
			.returning({ id: document.id });
		await db.insert(documentTranslation).values({ documentId: doc!.id, locale: 'en', title: 'SOC 2' });
		const [file] = await db
			.insert(documentFile)
			.values({
				documentId: doc!.id,
				locale: 'en',
				version: 1,
				storageKey: `k-${crypto.randomUUID()}`,
				contentType: 'application/pdf',
				sizeBytes: 2048,
				sha256: 'b'.repeat(64)
			})
			.returning({ id: documentFile.id });

		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'requester', id: requesterId },
			subjectType: 'document_file',
			subjectId: file!.id,
			meta: { documentId: doc!.id, locale: 'en', version: 1, tier: 'request', watermarked: true }
		});

		const outcome = await enrichEvent(db, await newestEvent('document.downloaded'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.verified).toBe(true);
		expect(outcome.model.data).toMatchObject({ name: 'Ines Roth', title: 'SOC 2', tier: 'request' });
	});

	it('skips a grant revocation whose grant is gone', async () => {
		await recordEvent(db, {
			action: 'access_grant.revoked',
			actor: { type: 'staff', id: crypto.randomUUID() },
			subjectType: 'access_grant',
			subjectId: crypto.randomUUID()
		});

		const outcome = await enrichEvent(db, await newestEvent('access_grant.revoked'), CONTEXT);
		expect(outcome).toEqual({ kind: 'skip', reason: 'subject_missing' });
	});

	it('enriches a grant revocation', async () => {
		const requesterId = await insertRequester({ name: 'Lior Kaplan' });
		const [grant] = await db
			.insert(accessGrant)
			.values({
				requesterId,
				termDays: 90,
				expiresAt: new Date(Date.now() + 86_400_000)
			})
			.returning({ id: accessGrant.id });

		await recordEvent(db, {
			action: 'access_grant.revoked',
			actor: { type: 'staff', id: crypto.randomUUID() },
			subjectType: 'access_grant',
			subjectId: grant!.id
		});

		const outcome = await enrichEvent(db, await newestEvent('access_grant.revoked'), CONTEXT);

		expect(outcome.kind).toBe('model');
		if (outcome.kind !== 'model') return;
		expect(outcome.model.data).toMatchObject({ name: 'Lior Kaplan', grantId: grant!.id });
		expect(outcome.model.link).toBe('https://trust.example.com/en/admin/grants');
	});
});
```

Before writing the implementation, confirm the exact `document`, `documentTranslation` and `documentFile` column names against `src/lib/server/db/schema/documents.ts` and adjust the fixture inserts if any required column is missing from the values above — the test must compile against the real schema, not against this plan's recollection of it.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/egress-enrich.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/enrich`.

- [ ] **Step 4: Write the enricher**

`src/lib/server/egress/enrich.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import {
	accessGrant,
	accessRequest,
	document,
	documentFile,
	documentTranslation,
	ndaAcceptance,
	ndaTemplate,
	ndaTemplateVersion,
	requester
} from '../db/schema';
import type { AuditEventRow } from '../audit';
import type { Db } from '../db';
import type { EventModel } from './model';

export type EnrichOutcome =
	| { kind: 'model'; model: EventModel }
	| { kind: 'skip'; reason: 'subject_purged' | 'subject_missing' };

export interface EnrichContext {
	deliveryId: string;
	baseUrl: string;
	/**
	 * `config.defaultLocale`, passed in by the job. Used only to build the
	 * admin link, which is locale-prefixed like every page URL in this
	 * application — the payload's audience is the operator's own staff, not the
	 * requester (spec §3.2).
	 */
	locale: string;
}

/** What an enricher returns; the shared fields are filled in around it. */
interface Enriched {
	data: Record<string, unknown>;
	summary: string;
	link: string | null;
	/**
	 * Overrides the enriched path's default of `true`. Set only by the
	 * anonymous branch of `document.downloaded`, where there is no verified
	 * identity to speak of (plan C5).
	 */
	verified?: boolean;
}

type Enricher = (
	db: Db,
	row: AuditEventRow,
	context: EnrichContext
) => Promise<Enriched | { skip: 'purged' | 'missing' }>;

/**
 * Personal data a consumer acts on. `purged_at` is the signal, NOT blank
 * columns: purgeRequester writes `purged-<id>@invalid` into `email`, so a
 * blank-column test would pass a purged row through with the one field a CRM
 * upserts on (spec §4.5, plan §Smaller corrections).
 */
function identity(row: typeof requester.$inferSelect | undefined) {
	if (!row) return { skip: 'missing' as const };
	if (row.purgedAt !== null) return { skip: 'purged' as const };

	return {
		person: {
			name: row.name,
			email: row.email,
			company: row.company,
			companyDomain: row.companyDomain
		}
	};
}

async function loadRequester(db: Db, id: string | null) {
	if (id === null) return undefined;
	const [row] = await db.select().from(requester).where(eq(requester.id, id)).limit(1);
	return row;
}

/**
 * The four access-request events share a loader: they differ only in which
 * decision columns are worth carrying, and one query is what a consumer
 * branching on `event` actually needs.
 */
const enrichAccessRequest: Enricher = async (db, row, context) => {
	if (row.subjectId === null) return { skip: 'missing' };

	const [request] = await db
		.select()
		.from(accessRequest)
		.where(eq(accessRequest.id, row.subjectId))
		.limit(1);
	if (!request) return { skip: 'missing' };

	const person = identity(await loadRequester(db, request.requesterId));
	if ('skip' in person) return person;

	const [grant] = await db
		.select({
			id: accessGrant.id,
			termDays: accessGrant.termDays,
			expiresAt: accessGrant.expiresAt,
			acceptanceDueAt: accessGrant.acceptanceDueAt
		})
		.from(accessGrant)
		.where(eq(accessGrant.requestId, request.id))
		.limit(1);

	return {
		data: {
			...person.person,
			requestId: request.id,
			status: request.status,
			justification: request.justification,
			...(row.meta as Record<string, unknown> | null),
			...(grant
				? {
						grantId: grant.id,
						termDays: grant.termDays,
						expiresAt: grant.expiresAt?.toISOString() ?? null,
						acceptanceDueAt: grant.acceptanceDueAt?.toISOString() ?? null
					}
				: {}),
			...(request.reason !== null ? { reason: request.reason } : {})
		},
		summary: summaryFor(row.action, person.person.company),
		// Every page URL in this application is locale-prefixed, and the link is
		// built by string interpolation rather than by `localizePath()` because
		// this is a server-side absolute URL for an external consumer, not a
		// navigation target.
		link: `${context.baseUrl}/${context.locale}/admin/requests/${request.id}`
	};
};
```

The remaining enrichers, written the same way:

```ts
const enrichGrantRevoked: Enricher = async (db, row, context) => {
	if (row.subjectId === null) return { skip: 'missing' };

	const [grant] = await db
		.select()
		.from(accessGrant)
		.where(eq(accessGrant.id, row.subjectId))
		.limit(1);
	if (!grant) return { skip: 'missing' };

	const person = identity(await loadRequester(db, grant.requesterId));
	if ('skip' in person) return person;

	return {
		data: {
			...person.person,
			grantId: grant.id,
			termDays: grant.termDays,
			expiresAt: grant.expiresAt?.toISOString() ?? null,
			revokedAt: grant.revokedAt?.toISOString() ?? null
		},
		summary: `Access for ${person.person.company} was revoked`,
		link: `${context.baseUrl}/${context.locale}/admin/grants`
	};
};

/** `nda_acceptance.recorded` and `nda_record.downloaded` share a subject. */
const enrichNdaAcceptance =
	(verb: 'accepted' | 'downloaded'): Enricher =>
	async (db, row, context) => {
		if (row.subjectId === null) return { skip: 'missing' };

		const [acceptance] = await db
			.select({
				id: ndaAcceptance.id,
				requesterId: ndaAcceptance.requesterId,
				acceptedAt: ndaAcceptance.acceptedAt,
				slug: ndaTemplate.slug,
				version: ndaTemplateVersion.version
			})
			.from(ndaAcceptance)
			.innerJoin(ndaTemplateVersion, eq(ndaTemplateVersion.id, ndaAcceptance.versionId))
			.innerJoin(ndaTemplate, eq(ndaTemplate.id, ndaTemplateVersion.templateId))
			.where(eq(ndaAcceptance.id, row.subjectId))
			.limit(1);
		if (!acceptance) return { skip: 'missing' };

		const person = identity(await loadRequester(db, acceptance.requesterId));
		if ('skip' in person) return person;

		return {
			data: {
				...person.person,
				acceptanceId: acceptance.id,
				template: acceptance.slug,
				version: acceptance.version,
				acceptedAt: acceptance.acceptedAt.toISOString()
			},
			summary:
				verb === 'accepted'
					? `${person.person.company} accepted ${acceptance.slug} v${acceptance.version}`
					: `${person.person.company} downloaded their ${acceptance.slug} record`,
			link: `${context.baseUrl}/${context.locale}/admin/requesters/${acceptance.requesterId}`
		};
	};

/**
 * The subject is a `document_file`, not a document (delivery/serve.ts), so the
 * title comes from file → document → translation. The actor id is null for
 * every public-tier download, which is a deliverable event and not a missing
 * subject (plan C5).
 */
const enrichDocumentDownloaded: Enricher = async (db, row, context) => {
	if (row.subjectId === null) return { skip: 'missing' };

	const [file] = await db
		.select({
			id: documentFile.id,
			locale: documentFile.locale,
			version: documentFile.version,
			documentId: document.id,
			slug: document.slug,
			tier: document.tier,
			title: documentTranslation.title
		})
		.from(documentFile)
		.innerJoin(document, eq(document.id, documentFile.documentId))
		.leftJoin(
			documentTranslation,
			and(
				eq(documentTranslation.documentId, document.id),
				eq(documentTranslation.locale, documentFile.locale)
			)
		)
		.where(eq(documentFile.id, row.subjectId))
		.limit(1);
	if (!file) return { skip: 'missing' };

	const document_ = {
		documentId: file.documentId,
		slug: file.slug,
		title: file.title ?? file.slug,
		tier: file.tier,
		locale: file.locale,
		version: file.version
	};

	// A public download has no requester at all — no session is created on that
	// path — so there is nobody to enrich and nobody to have been purged.
	if (row.actorId === null) {
		return {
			data: document_,
			summary: `${document_.title} was downloaded`,
			link: `${context.baseUrl}/${context.locale}/admin/documents/${file.documentId}`,
			// Nobody was identified, so nothing here is verified.
			verified: false
		};
	}

	const person = identity(await loadRequester(db, row.actorId));
	if ('skip' in person) return person;

	return {
		data: { ...person.person, ...document_ },
		summary: `${person.person.company} downloaded ${document_.title}`,
		link: `${context.baseUrl}/${context.locale}/admin/documents/${file.documentId}`
	};
};

/**
 * Walked against `grep -rhoE "action: '[a-z0-9._-]+'" src/` plus the two
 * template-literal sites (`access/verify.ts` and
 * `admin/requests/[id]/+page.server.ts`, both `access_request.${status}`) —
 * not against memory. `access_request.submitted` is deliberately absent: its
 * data is unverified public-form input (spec §4.3).
 */
const ENRICHERS: Record<string, Enricher> = {
	'access_request.pending': enrichAccessRequest,
	'access_request.approved': enrichAccessRequest,
	'access_request.denied': enrichAccessRequest,
	'access_request.info_requested': enrichAccessRequest,
	'access_grant.revoked': enrichGrantRevoked,
	'nda_acceptance.recorded': enrichNdaAcceptance('accepted'),
	'nda_record.downloaded': enrichNdaAcceptance('downloaded'),
	'document.downloaded': enrichDocumentDownloaded
};

export const ENRICHED_ACTIONS: readonly string[] = Object.keys(ENRICHERS);

/** `access_request.pending` → "Access request pending". */
function summaryFor(action: string, company?: string): string {
	const words = action.replace(/[._]/g, ' ');
	const sentence = words.charAt(0).toUpperCase() + words.slice(1);
	return company ? `${sentence} — ${company}` : sentence;
}

export async function enrichEvent(
	db: Db,
	row: AuditEventRow,
	context: EnrichContext
): Promise<EnrichOutcome> {
	const shared = {
		action: row.action,
		at: row.at,
		eventId: row.id,
		// A bigint does not survive JSON.stringify, and `seq` is what makes a
		// gap detectable by a consumer (spec §4.4).
		seq: String(row.seq),
		deliveryId: context.deliveryId,
		subject:
			row.subjectType !== null && row.subjectId !== null
				? { type: row.subjectType, id: row.subjectId }
				: null,
		actor: { type: row.actorType, id: row.actorId }
	};

	const enricher = ENRICHERS[row.action];

	if (enricher) {
		const result = await enricher(db, row, context);
		if ('skip' in result) {
			return { kind: 'skip', reason: result.skip === 'purged' ? 'subject_purged' : 'subject_missing' };
		}

		// Every registered action is written after identity verification —
		// `access_request.pending` exists precisely because someone has by then
		// proven they control the address — so `true` is the default and an
		// enricher opts out of it explicitly.
		return {
			kind: 'model',
			model: { ...shared, ...result, verified: result.verified ?? true }
		};
	}

	// The fallback carries `meta` verbatim and neither `ip` nor `ua`. §6.6
	// already guarantees `meta` holds no requester personal data, so this is
	// safe by construction rather than by filtering — and a filter is a thing
	// somebody later forgets to extend (spec §4.2).
	return {
		kind: 'model',
		model: {
			...shared,
			verified: false,
			data: (row.meta as Record<string, unknown> | null) ?? {},
			summary: summaryFor(row.action),
			link: null
		}
	};
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:integration tests/integration/egress-enrich.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/egress/model.ts src/lib/server/egress/enrich.ts tests/integration/egress-enrich.test.ts
git commit -m "feat(egress): enrich events from live domain state, skipping purged subjects"
```

---

### Task 7: The formatter registry, `generic` and `teams`

**Files:**
- Create: `src/lib/server/egress/format/{index,escape,generic,teams}.ts`
- Test: `tests/unit/egress-format.test.ts`

**Interfaces:**
- Consumes: `EventModel` (Task 6), `EGRESS_FORMATS` (Task 1).
- Produces: `type Formatter = (model: EventModel) => { body: string; contentType: string }`; `FORMATTERS: Record<EgressFormat, Formatter>`; `formatEvent(format: EgressFormat, model: EventModel): { body: string; contentType: string }`; `escapeMarkdown(value: string): string`.

A formatter is a **pure function**: no database, no config, no `fetch`. That keeps these tests in the unit suite, which needs no Postgres, and it is what makes the next formatter cheap (spec §3.2). The model is already rendered in `config.defaultLocale` by the caller — the audience of an egress payload is the operator's own staff and automation, not the requester, and rendering a card in the *requester's* locale would put a German card in an English-speaking team's channel because of who happened to submit the form.

- [ ] **Step 1: Write the failing test**

`tests/unit/egress-format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeMarkdown, formatEvent } from '../../src/lib/server/egress/format';
import type { EventModel } from '../../src/lib/server/egress/model';

const MODEL: EventModel = {
	action: 'access_request.pending',
	at: new Date('2026-09-03T10:12:00.000Z'),
	eventId: '8c1e0000-0000-4000-8000-000000000001',
	seq: '48213',
	deliveryId: '0f3c0000-0000-4000-8000-000000000002',
	subject: { type: 'access_request', id: 'req-1' },
	actor: { type: 'requester', id: 'person-1' },
	verified: true,
	data: { name: 'Dana Vogel', company: 'Acme GmbH', email: 'dana@acme.example' },
	summary: 'Access request from Acme GmbH needs review',
	link: 'https://trust.example.com/en/admin/requests/req-1'
};

describe('generic', () => {
	it('renders the model with snake_case keys', () => {
		const { body, contentType } = formatEvent('generic', MODEL);
		expect(contentType).toBe('application/json');

		expect(JSON.parse(body)).toEqual({
			event: 'access_request.pending',
			at: '2026-09-03T10:12:00.000Z',
			event_id: '8c1e0000-0000-4000-8000-000000000001',
			seq: '48213',
			delivery_id: '0f3c0000-0000-4000-8000-000000000002',
			verified: true,
			subject: { type: 'access_request', id: 'req-1' },
			actor: { type: 'requester', id: 'person-1' },
			summary: 'Access request from Acme GmbH needs review',
			link: 'https://trust.example.com/en/admin/requests/req-1',
			data: { name: 'Dana Vogel', company: 'Acme GmbH', email: 'dana@acme.example' }
		});
	});

	it('carries seq as a string so a consumer does not lose precision', () => {
		const body = JSON.parse(formatEvent('generic', { ...MODEL, seq: '9007199254740993' }).body);
		expect(body.seq).toBe('9007199254740993');
	});
});

describe('teams', () => {
	it('renders the Workflows envelope with an Adaptive Card', () => {
		const { body, contentType } = formatEvent('teams', MODEL);
		expect(contentType).toBe('application/json');

		const parsed = JSON.parse(body);
		expect(parsed.type).toBe('message');
		expect(parsed.attachments).toHaveLength(1);
		expect(parsed.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
		expect(parsed.attachments[0].contentUrl).toBeNull();
		expect(parsed.attachments[0].content.type).toBe('AdaptiveCard');
	});

	/**
	 * 1.4, not the newest available. Adaptive Card support differs by Teams
	 * surface and client, and a card that fails to render is indistinguishable
	 * to the operator from a delivery that never arrived — the worst possible
	 * failure for a notification channel (spec §3.3).
	 */
	it('declares card version 1.4', () => {
		const parsed = JSON.parse(formatEvent('teams', MODEL).body);
		expect(parsed.attachments[0].content.version).toBe('1.4');
	});

	// MessageCard is not the target and must not be written: Microsoft retired
	// Office 365 Connectors in Teams.
	it('is not a MessageCard', () => {
		expect(formatEvent('teams', MODEL).body).not.toContain('MessageCard');
	});

	it('carries an OpenUrl action to the link', () => {
		const card = JSON.parse(formatEvent('teams', MODEL).body).attachments[0].content;
		expect(card.actions).toEqual([
			{ type: 'Action.OpenUrl', title: 'Open in trust center', url: MODEL.link }
		]);
	});

	it('omits the actions array when there is no link', () => {
		const card = JSON.parse(formatEvent('teams', { ...MODEL, link: null }).body).attachments[0]
			.content;
		expect(card.actions).toBeUndefined();
	});

	// Nothing in a Teams channel should fetch from us.
	it('carries no images and no external references', () => {
		const body = formatEvent('teams', MODEL).body;
		expect(body).not.toContain('"Image"');
		expect(body).not.toContain('backgroundImage');
		expect(body).not.toContain('iconUrl');
	});

	/**
	 * Adaptive Card TextBlock renders markdown, and §4.3's data is in part
	 * supplied by whoever filled in a public form — so a company name of
	 * `[Password reset required](https://evil.example)` would otherwise become
	 * a clickable link in the security team's own channel, delivered by the
	 * trust center. Escaping is a property of the formatter, tested per
	 * formatter, and not of the enricher (spec §3.3).
	 */
	it('escapes markdown in every rendered string', () => {
		const hostile = '[Password reset required](https://evil.example)';
		const { body } = formatEvent('teams', {
			...MODEL,
			summary: hostile,
			data: { company: hostile, note: `**bold** _under_ \`code\`` }
		});

		expect(body).not.toContain('](https://evil.example)');
		const rendered = JSON.parse(body).attachments[0].content;
		expect(JSON.stringify(rendered)).toContain('\\\\[Password reset required\\\\]');
	});

	it('renders a fact set from data', () => {
		const card = JSON.parse(formatEvent('teams', MODEL).body).attachments[0].content;
		const factSet = card.body.find((block: { type: string }) => block.type === 'FactSet');
		expect(factSet.facts).toEqual(
			expect.arrayContaining([{ title: 'company', value: 'Acme GmbH' }])
		);
	});

	it('renders a nested value without crashing', () => {
		const { body } = formatEvent('teams', { ...MODEL, data: { tiers: ['request', 'nda'] } });
		const card = JSON.parse(body).attachments[0].content;
		const factSet = card.body.find((block: { type: string }) => block.type === 'FactSet');
		expect(factSet.facts).toEqual([{ title: 'tiers', value: 'request, nda' }]);
	});
});

describe('escapeMarkdown', () => {
	it('escapes every character Adaptive Card treats as markup', () => {
		expect(escapeMarkdown('[a](b)')).toBe('\\[a\\]\\(b\\)');
		expect(escapeMarkdown('**a** _b_ `c`')).toBe('\\*\\*a\\*\\* \\_b\\_ \\`c\\`');
		expect(escapeMarkdown('a\\b')).toBe('a\\\\b');
	});

	it('leaves ordinary text alone', () => {
		expect(escapeMarkdown('Acme GmbH')).toBe('Acme GmbH');
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:unit tests/unit/egress-format.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/format`.

- [ ] **Step 3: Write the escaper**

`src/lib/server/egress/format/escape.ts`:

```ts
/**
 * Adaptive Card `TextBlock` renders markdown. Part of the data reaching a
 * formatter is supplied by whoever filled in a public form, so a company name
 * of `[Password reset required](https://evil.example)` would become a
 * clickable link in the security team's own channel, delivered by the trust
 * center (spec §3.3).
 *
 * The backslash is escaped first — otherwise escaping `[` into `\[` and then
 * escaping backslashes would double the escape and render the marker.
 */
export function escapeMarkdown(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/[[\]()*_`~#>|-]/g, (match) => `\\${match}`);
}
```

- [ ] **Step 4: Write both formatters and the registry**

`src/lib/server/egress/format/generic.ts`:

```ts
import type { EventModel } from '../model';

/**
 * The model rendered directly, in snake_case because that is what a JSON
 * consumer expects and this is the shape n8n reads. `seq` stays a string: it
 * is a bigint, and a consumer parsing it as a JSON number silently loses
 * precision above 2^53 — which matters because `seq` is what makes a gap
 * detectable (spec §4.4).
 */
export function formatGeneric(model: EventModel): { body: string; contentType: string } {
	return {
		contentType: 'application/json',
		body: JSON.stringify({
			event: model.action,
			at: model.at.toISOString(),
			event_id: model.eventId,
			seq: model.seq,
			delivery_id: model.deliveryId,
			verified: model.verified,
			subject: model.subject,
			actor: model.actor,
			summary: model.summary,
			link: model.link,
			data: model.data
		})
	};
}
```

`src/lib/server/egress/format/teams.ts`:

```ts
import { escapeMarkdown } from './escape';
import type { EventModel } from '../model';

/** Flattens one `data` value into a single card line. */
function factValue(value: unknown): string {
	if (value === null || value === undefined) return '—';
	if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

/**
 * An Adaptive Card in the envelope the Workflows (Power Automate) trigger
 * expects. Microsoft retired Office 365 Connectors in Teams, so `MessageCard`
 * is not the target and must not be written.
 *
 * The declared version is 1.4 rather than the newest available: Adaptive Card
 * support differs by Teams surface and client, and a card that fails to render
 * is indistinguishable to the operator from a delivery that never arrived —
 * the worst possible failure for a notification channel. 1.4 renders
 * everywhere Workflows posts (spec §3.3).
 *
 * No images and no external references: nothing in a Teams channel should
 * fetch from us.
 */
export function formatTeams(model: EventModel): { body: string; contentType: string } {
	const facts = Object.entries(model.data).map(([title, value]) => ({
		title: escapeMarkdown(title),
		value: escapeMarkdown(factValue(value))
	}));

	const card: Record<string, unknown> = {
		type: 'AdaptiveCard',
		$schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
		version: '1.4',
		body: [
			{ type: 'TextBlock', text: escapeMarkdown(model.summary), wrap: true, weight: 'Bolder' },
			{ type: 'TextBlock', text: escapeMarkdown(model.action), wrap: true, isSubtle: true, spacing: 'None' },
			{ type: 'FactSet', facts }
		]
	};

	if (model.link !== null) {
		// A URL, not a rendered string, so it is NOT markdown-escaped — an
		// escaped URL is a broken button. It is our own absolute admin link,
		// built by the enricher from baseUrl, never operator or requester input.
		card.actions = [{ type: 'Action.OpenUrl', title: 'Open in trust center', url: model.link }];
	}

	return {
		contentType: 'application/json',
		body: JSON.stringify({
			type: 'message',
			attachments: [
				{
					contentType: 'application/vnd.microsoft.card.adaptive',
					contentUrl: null,
					content: card
				}
			]
		})
	};
}
```

`src/lib/server/egress/format/index.ts`:

```ts
import { formatGeneric } from './generic';
import { formatTeams } from './teams';
import type { EgressFormat } from '../../db/schema';
import type { EventModel } from '../model';

export { escapeMarkdown } from './escape';

export type Formatter = (model: EventModel) => { body: string; contentType: string };

/**
 * Adding Slack later is: one file, one entry here, one value in
 * `event_endpoint_format_check`, and unit tests. That is the point of the
 * registry and the reason `format` is a column rather than two branches
 * (spec §3.3).
 */
export const FORMATTERS: Record<EgressFormat, Formatter> = {
	generic: formatGeneric,
	teams: formatTeams
};

export function formatEvent(
	format: EgressFormat,
	model: EventModel
): { body: string; contentType: string } {
	return FORMATTERS[format](model);
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test:unit tests/unit/egress-format.test.ts`
Expected: PASS, 13 tests. The markdown-escaping assertion is the one that must be watched failing before it is claimed to defend anything — comment out `escapeMarkdown` in `teams.ts`, confirm the test fails, restore it.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/egress/format tests/unit/egress-format.test.ts
git commit -m "feat(egress): add the generic and Teams formatters with per-target escaping"
```

---

### Task 8: Configuration

**Files:**
- Modify: `src/lib/server/config/parse.ts`
- Modify: `.env.example`
- Test: `tests/unit/config.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `parseAllowList` is *not* used here — `parse.ts` must not import from `egress/`, because that would make the config module depend on a module that imports the schema. The raw string is carried through and parsed by the caller.
- Produces: `AppConfig.egress: { enabled: boolean; signingKey: string | undefined; allow: string | undefined }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/config.test.ts` (match the file's existing helper for building a valid environment — read it first and reuse it rather than writing a second one):

```ts
describe('egress configuration', () => {
	it('is off by default', () => {
		const config = parseConfig(validEnv(), ['en']);
		expect(config.egress).toEqual({ enabled: false, signingKey: undefined, allow: undefined });
	});

	it('reads the three variables', () => {
		const config = parseConfig(
			{
				...validEnv(),
				EVENT_EGRESS_ENABLED: 'true',
				EVENT_SIGNING_KEY: 'k'.repeat(32),
				EVENT_EGRESS_ALLOW: 'n8n:5678,10.1.0.0/16'
			},
			['en']
		);

		expect(config.egress.enabled).toBe(true);
		expect(config.egress.signingKey).toBe('k'.repeat(32));
		expect(config.egress.allow).toBe('n8n:5678,10.1.0.0/16');
	});

	// A blank value is how a .env spells "unset" (blankAsUndefined's reason).
	it('treats a blank switch as off rather than refusing to boot', () => {
		expect(parseConfig({ ...validEnv(), EVENT_EGRESS_ENABLED: '' }, ['en']).egress.enabled).toBe(
			false
		);
	});

	/**
	 * A typo in the one switch that answers "does this deployment call out at
	 * all" must refuse to boot rather than silently reading as off — the same
	 * discipline the OTEL variables get, and for the same reason.
	 */
	it('refuses a switch that is neither true nor false', () => {
		expect(() => parseConfig({ ...validEnv(), EVENT_EGRESS_ENABLED: '1' }, ['en'])).toThrow(
			/EVENT_EGRESS_ENABLED/
		);
	});

	it('refuses a signing key shorter than 32 characters', () => {
		expect(() => parseConfig({ ...validEnv(), EVENT_SIGNING_KEY: 'short' }, ['en'])).toThrow(
			/EVENT_SIGNING_KEY/
		);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:unit tests/unit/config.test.ts`
Expected: FAIL — `config.egress` is undefined.

- [ ] **Step 3: Implement**

In `parse.ts`, next to `blankAsUndefined`:

```ts
/**
 * The schema's first boolean. `z.enum` rather than a truthiness check, so
 * `EVENT_EGRESS_ENABLED=1` refuses to boot instead of silently reading as
 * off — the same discipline the OTEL variables get, and this is the switch
 * that answers "does this deployment call out at all".
 *
 * RUN_JOBS and RUN_MIGRATIONS deliberately stay outside this schema: they are
 * read in hooks.server.ts's `init` to decide whether to *start* the subsystems
 * that own config, so they are consulted before this parse runs.
 */
const booleanFlag = z.preprocess(
	(value) => (value === '' || value === undefined ? 'false' : value),
	z.enum(['true', 'false']).transform((value) => value === 'true')
);
```

Add to the schema object:

```ts
			// Deploy-time switch. Endpoints live in the database so they can be
			// reconfigured by someone without shell access, and this is what keeps
			// "does this deployment call out, and to where?" answerable from
			// `docker inspect`: the environment answers whether, the database
			// answers where (spec §1.1). Also the kill switch that is not
			// RUN_JOBS=false, which would also stop mail.
			EVENT_EGRESS_ENABLED: booleanFlag,
			// Not blankAsUndefined + min(1): a signing key shorter than 32
			// characters is a weak HMAC key, and the failure is silent.
			EVENT_SIGNING_KEY: blankAsUndefined(z.string().min(32)),
			// Carried through as the raw string and parsed by egress/destination.ts.
			// parse.ts must not import from egress/, or the config module would
			// depend on one that imports the schema.
			EVENT_EGRESS_ALLOW: blankAsUndefined(z.string().min(1)),
```

Add to `AppConfig`:

```ts
	egress: {
		enabled: boolean;
		signingKey: string | undefined;
		/** Raw `EVENT_EGRESS_ALLOW`; parsed by `parseAllowList`. */
		allow: string | undefined;
	};
```

And to the returned object:

```ts
		egress: {
			enabled: parsed.EVENT_EGRESS_ENABLED,
			signingKey: parsed.EVENT_SIGNING_KEY,
			allow: parsed.EVENT_EGRESS_ALLOW
		},
```

In `.env.example`, after the OTel block:

```sh
# Event egress (integrations). Off unless this is `true`: with it off, no
# endpoint delivers anything, whatever the database says.
EVENT_EGRESS_ENABLED=false
# At least 32 characters. Required for any endpoint using the `generic` format;
# a Teams-only deployment needs no key, because Teams verifies nothing.
EVENT_SIGNING_KEY=
# Hosts, host:port or CIDRs permitted to resolve into otherwise-denied address
# space — an in-cluster n8n, for example. Loopback, link-local and metadata
# addresses are denied whatever is listed here.
EVENT_EGRESS_ALLOW=
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:unit tests/unit/config.test.ts`
Expected: PASS.

Then confirm the build still needs no environment: `env -i PATH=$PATH pnpm build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/config/parse.ts .env.example tests/unit/config.test.ts
git commit -m "feat(egress): add the three egress environment variables"
```

---

### Task 9: Fan-out and the visibility watermark

**This task carries the load-bearing claim of the whole subsystem.** Its two concurrency tests are written as guards that are deleted so the test can be watched failing before it is claimed to defend anything.

**Files:**
- Create: `src/lib/server/egress/fanout.ts`
- Test: `tests/integration/egress-fanout.test.ts`

**Interfaces:**
- Consumes: `matchesPattern` (Task 2), the three tables (Task 1).
- Produces: `fanOut(tx: Db): Promise<{ enqueued: number; paused: string[] }>`; `currentHorizon(tx: Db): Promise<bigint>`; `FANOUT_LIMIT = 500`; `BACKPRESSURE_THRESHOLD = 1000`.

- [ ] **Step 1: Write the two adversarial concurrency tests first**

`tests/integration/egress-fanout.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { recordEvent } from '../../src/lib/server/audit';
import { auditEvent, eventDelivery, eventEndpoint, eventEndpointFilter } from '../../src/lib/server/db/schema';
import { currentHorizon, fanOut } from '../../src/lib/server/egress/fanout';

let db: Db;
let close: () => Promise<void>;
let url: string;

beforeAll(() => {
	url = process.env.TEST_DATABASE_URL ?? '';
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	// Endpoints and deliveries only. audit_event is append-only and its rows are
	// harmless here — every endpoint starts at the current horizon anyway.
	await db.delete(eventEndpoint);
});

/** An endpoint whose cursor starts where a real one does: the live horizon. */
async function createEndpoint(patterns: string[], overrides: Record<string, unknown> = {}) {
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

async function deliveredSeqs(endpointId: string): Promise<string[]> {
	const rows = await db
		.select({ auditSeq: eventDelivery.auditSeq })
		.from(eventDelivery)
		.where(eq(eventDelivery.endpointId, endpointId))
		.orderBy(eventDelivery.auditSeq);
	return rows.map((row) => String(row.auditSeq));
}

async function seqOf(action: string, subjectId: string): Promise<string> {
	const [row] = await db
		.select({ seq: auditEvent.seq })
		.from(auditEvent)
		.where(eq(auditEvent.subjectId, subjectId))
		.limit(1);
	if (!row) throw new Error(`no ${action} event for ${subjectId}`);
	return String(row.seq);
}

describe('the visibility watermark', () => {
	/**
	 * GUARD 1 — the failure a naive `WHERE seq > cursor` scan has.
	 *
	 * `audit_event.seq` is a bigserial: `nextval()` is consumed at INSERT but a
	 * row becomes *visible* at COMMIT, and those two orders are not the same.
	 * recordEvent is routinely called inside a transaction that does other work
	 * first, so a concurrent autocommit insert can take a HIGHER seq and commit
	 * FIRST. A naive scan landing in that window sees the higher seq, misses
	 * the lower one, and moves the cursor past it — a silently dropped
	 * approval notification, indistinguishable from Teams having eaten it
	 * (spec §5.2).
	 *
	 * To watch this fail: replace the predicate in fanout.ts with a plain
	 * `seq > cursor_seq` scan advancing to `max(seq)`. This test must then fail
	 * on the second assertion.
	 */
	it('does not consume an event whose transaction is still open, and delivers it after the commit', async () => {
		const endpointId = await createEndpoint(['access_request.*']);
		const slowSubject = crypto.randomUUID();
		const fastSubject = crypto.randomUUID();

		const slow = createDb(url);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));

		// A transaction that takes a LOW seq and stays open.
		const held = slow.db.transaction(async (tx) => {
			await recordEvent(tx, {
				action: 'access_request.approved',
				actor: { type: 'system', id: null },
				subjectType: 'access_request',
				subjectId: slowSubject
			});
			await gate;
		});

		// Give the held transaction time to reach the gate, then take a HIGHER
		// seq and commit first.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await recordEvent(db, {
			action: 'access_request.pending',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: fastSubject
		});

		const fastSeq = await seqOf('access_request.pending', fastSubject);

		// The tick that lands in the window consumes NOTHING: the committed row's
		// inserting transaction started after the still-open one, so it is above
		// the horizon.
		await db.transaction((tx) => fanOut(tx));
		expect(await deliveredSeqs(endpointId)).toEqual([]);

		release();
		await held;
		await slow.close();

		const slowSeq = await seqOf('access_request.approved', slowSubject);
		// The trace only means something if the seqs really are out of order.
		expect(BigInt(slowSeq)).toBeLessThan(BigInt(fastSeq));

		await db.transaction((tx) => fanOut(tx));
		expect(await deliveredSeqs(endpointId)).toEqual([slowSeq, fastSeq]);
	});

	/**
	 * GUARD 2 — the failure the *spec's own* xmin-horizon fix still has, and
	 * the reason the cursor is a keyset on `(xmin, seq)` rather than a `seq`
	 * high-watermark (plan C1).
	 *
	 * `xmin < horizon` excludes rows from still-running transactions. It does
	 * NOT exclude rows from transactions that started later, committed
	 * already, and are excluded by that same predicate — and those can hold a
	 * lower seq, because a transaction's xid is assigned at its first write
	 * while its seq is assigned when recordEvent runs last.
	 *
	 * To watch this fail: advance the cursor to `max(seq)` of the scanned
	 * window instead of to the last row's `(xmin, seq)`. This test must then
	 * fail on the final assertion, with `fastSeq` missing.
	 */
	it('delivers a committed event whose xid is above the horizon but whose seq is below a scanned row', async () => {
		const endpointId = await createEndpoint(['access_request.*']);
		const earlySubject = crypto.randomUUID();
		const fastSubject = crypto.randomUUID();

		// T_early: an xid assigned before T_slow's, committing after T_fast.
		const early = createDb(url);
		let releaseEarly: () => void = () => {};
		const earlyGate = new Promise<void>((resolve) => (releaseEarly = resolve));

		// T_slow: holds the horizon down for the whole tick and writes nothing.
		const slow = createDb(url);
		let releaseSlow: () => void = () => {};
		const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));

		const heldEarly = early.db.transaction(async (tx) => {
			// Forces xid assignment without writing an audit row, so this
			// transaction's xid is low while its seq will be high.
			await tx.execute(sql`SELECT txid_current()`);
			await earlyGate;
			await recordEvent(tx, {
				action: 'access_request.approved',
				actor: { type: 'system', id: null },
				subjectType: 'access_request',
				subjectId: earlySubject
			});
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		const heldSlow = slow.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT txid_current()`);
			await slowGate;
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		// T_fast: a later xid, a LOWER seq than T_early's will be, commits now.
		await recordEvent(db, {
			action: 'access_request.pending',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: fastSubject
		});

		// T_early now takes its (higher) seq and commits.
		releaseEarly();
		await heldEarly;
		await early.close();

		const fastSeq = await seqOf('access_request.pending', fastSubject);
		const earlySeq = await seqOf('access_request.approved', earlySubject);
		// The interleaving must really have happened, or this test proves nothing.
		expect(BigInt(fastSeq)).toBeLessThan(BigInt(earlySeq));

		// The tick: T_slow still holds the horizon, so T_early's row is scanned
		// (its xid is below the horizon) while T_fast's is not (its xid is above).
		await db.transaction((tx) => fanOut(tx));
		expect(await deliveredSeqs(endpointId)).toEqual([earlySeq]);

		releaseSlow();
		await heldSlow;
		await slow.close();

		// The one that matters: the lower seq is NOT stranded below the cursor.
		await db.transaction((tx) => fanOut(tx));
		expect(await deliveredSeqs(endpointId)).toEqual([fastSeq, earlySeq]);
	});
});

describe('fanOut', () => {
	it('inserts one delivery per matching event and respects the filter', async () => {
		const endpointId = await createEndpoint(['access_request.approved']);
		const wanted = crypto.randomUUID();

		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: wanted
		});
		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'system', id: null },
			subjectType: 'document_file',
			subjectId: crypto.randomUUID()
		});

		await db.transaction((tx) => fanOut(tx));

		expect(await deliveredSeqs(endpointId)).toEqual([
			await seqOf('access_request.approved', wanted)
		]);
	});

	it('advances the cursor past events it scanned but did not match', async () => {
		const endpointId = await createEndpoint(['access_request.approved']);

		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'system', id: null },
			subjectType: 'document_file',
			subjectId: crypto.randomUUID()
		});
		await db.transaction((tx) => fanOut(tx));

		const [before] = await db
			.select({ xmin: eventEndpoint.cursorXmin, seq: eventEndpoint.cursorSeq })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));
		// Advancing only past matches would re-scan every unmatched event
		// forever (spec §5.2).
		expect(before?.seq).toBeGreaterThan(0n);
	});

	it('receives nothing when the endpoint has no filter rows', async () => {
		const endpointId = await createEndpoint([]);
		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});

		await db.transaction((tx) => fanOut(tx));

		// Silence is the safe reading of an empty set (spec §2.2).
		expect(await deliveredSeqs(endpointId)).toEqual([]);
	});

	it("starts a new endpoint at the current horizon so its first tick delivers no history", async () => {
		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});
		// The row above must be below the horizon before the endpoint is made,
		// which is what makes this a test of the cursor rather than of timing.
		await db.execute(sql`SELECT txid_current()`);

		const endpointId = await createEndpoint(['access_request.*']);
		await db.transaction((tx) => fanOut(tx));

		expect(await deliveredSeqs(endpointId)).toEqual([]);
	});

	it('neither fans out nor advances the cursor for a disabled endpoint', async () => {
		const endpointId = await createEndpoint(['access_request.*'], {
			enabled: false,
			disabledAt: new Date(),
			disabledReason: 'no success in 24 h'
		});
		const [before] = await db
			.select({ seq: eventEndpoint.cursorSeq })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));

		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});
		await db.transaction((tx) => fanOut(tx));

		const [after] = await db
			.select({ seq: eventEndpoint.cursorSeq })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));

		// The cursor stalls, so re-enabling is an explicit choice with the
		// backlog count in front of the operator (spec §5.5).
		expect(await deliveredSeqs(endpointId)).toEqual([]);
		expect(after?.seq).toBe(before?.seq);
	});

	it('is a no-op when replayed, so a crash between fan-out and the cursor update is safe', async () => {
		const endpointId = await createEndpoint(['access_request.*']);
		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});

		await db.transaction(async (tx) => {
			await fanOut(tx);
			// Rewind the cursor, exactly as a crash before the commit would.
			await tx.update(eventEndpoint).set({ cursorSeq: 0n, cursorXmin: 1n });
		});
		await db.transaction((tx) => fanOut(tx));

		expect(await deliveredSeqs(endpointId)).toHaveLength(1);
	});

	it('pauses fan-out for an endpoint whose pending depth is above the threshold', async () => {
		const endpointId = await createEndpoint(['access_request.*']);

		// 1001 pending rows, inserted directly: what is under test is the pause,
		// not how the backlog got there.
		await db.execute(sql`
			INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id)
			SELECT ${endpointId}::uuid, -n, gen_random_uuid() FROM generate_series(1, 1001) AS s(n)
		`);

		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});
		const result = await db.transaction((tx) => fanOut(tx));

		expect(result.paused).toEqual([endpointId]);
		expect(result.enqueued).toBe(0);

		// Draining below the threshold resumes it. The cursor is the backlog's
		// durable record, so pausing loses nothing (spec §5.2).
		await db.execute(sql`DELETE FROM event_delivery WHERE audit_seq < 0`);
		const resumed = await db.transaction((tx) => fanOut(tx));
		expect(resumed.enqueued).toBe(1);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/egress-fanout.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/fanout`.

- [ ] **Step 3: Write the implementation**

`src/lib/server/egress/fanout.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { auditEvent, eventDelivery, eventEndpoint, eventEndpointFilter } from '../db/schema';
import { matchesPattern } from './filter';
import type { Db } from '../db';

/** How much of the log one tick reads per endpoint. */
export const FANOUT_LIMIT = 500;
/**
 * Above this pending depth an endpoint stops being fanned out. Without it the
 * two limits fight: 500 fanned out per tick against 25 delivered per tick
 * means a catch-up grows event_delivery twenty times faster than it drains it
 * (spec §5.2).
 */
export const BACKPRESSURE_THRESHOLD = 1000;

/**
 * The oldest transaction id still running. Everything inserted by a
 * transaction below it has completed.
 *
 * The 64-bit `xid8` forms, not the 32-bit `xid` ones, which wrap around.
 */
export async function currentHorizon(db: Db): Promise<bigint> {
	const rows = (await db.execute(
		sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text::bigint AS horizon`
	)) as unknown as { horizon: string }[];

	return BigInt(rows[0]!.horizon);
}

interface Endpoint {
	id: string;
	cursorXmin: bigint;
	cursorSeq: bigint;
	patterns: string[];
}

/**
 * Fans out newly-final audit events into per-endpoint deliveries, and advances
 * each endpoint's cursor.
 *
 * **The cursor is a keyset on `(xmin, seq)`, not a `seq` high-watermark.** A
 * seq watermark cannot be made correct here: `nextval()` is consumed at INSERT
 * and a row becomes visible at COMMIT, and because recordEvent is called last
 * in a transaction, xid order and seq order diverge. Two distinct events are
 * dropped by two distinct seq-based schemes —
 *
 * - a plain `seq > cursor` scan misses a row whose transaction is still open
 *   and then moves past it;
 * - a `seq > cursor` scan filtered by `xmin < horizon` misses a *committed*
 *   row whose transaction started after the oldest running one, because that
 *   row is excluded by the horizon while a lower-xid transaction's higher seq
 *   is scanned — and the cursor moves past it.
 *
 * The keyset closes both, and the invariant is worth stating exactly: the
 * cursor is only ever set to a row whose `xmin` was strictly below the horizon
 * observed in that same tick. Every unconsumed row — invisible (its
 * transaction is running, so its xid is at or above that horizon) or
 * visible-but-excluded (same) — therefore has a key strictly greater than the
 * cursor. Each row is consumed exactly once, in the tick where the horizon
 * crosses its xmin. Both failure modes are asserted in
 * tests/integration/egress-fanout.test.ts.
 *
 * The failure mode this trades into is **delay, not loss**: a long-running
 * transaction holds the horizon back and events wait for it. That is the right
 * direction, and it is bounded by the longest transaction in the system rather
 * than unbounded.
 *
 * Ordering is by `(xmin, seq)` — roughly commit order rather than seq order.
 * §15 promises no delivery ordering, and `seq` in the payload still makes a
 * gap detectable; a consumer must not assume monotonicity.
 *
 * The window scan is sequential: `xmin::text::bigint` is not indexable (a
 * system column, and not an immutable expression). At this system's scale —
 * a trust center writes thousands of audit events a month — that is a
 * sub-millisecond scan every fifteen seconds. If `audit_event` ever passes
 * roughly a million rows, add a `seq > cursor_seq - N` bound and record the
 * resulting bounded gap; do not add it speculatively.
 */
export async function fanOut(tx: Db): Promise<{ enqueued: number; paused: string[] }> {
	const horizon = await currentHorizon(tx);

	const endpoints = await tx
		.select({
			id: eventEndpoint.id,
			cursorXmin: eventEndpoint.cursorXmin,
			cursorSeq: eventEndpoint.cursorSeq
		})
		.from(eventEndpoint)
		.where(eq(eventEndpoint.enabled, true));

	let enqueued = 0;
	const paused: string[] = [];

	for (const endpoint of endpoints) {
		const depth = (await tx.execute(
			sql`SELECT count(*)::int AS depth FROM event_delivery
			    WHERE endpoint_id = ${endpoint.id}::uuid AND status = 'pending'`
		)) as unknown as { depth: number }[];

		if ((depth[0]?.depth ?? 0) > BACKPRESSURE_THRESHOLD) {
			paused.push(endpoint.id);
			continue;
		}

		const patterns = (
			await tx
				.select({ pattern: eventEndpointFilter.pattern })
				.from(eventEndpointFilter)
				.where(eq(eventEndpointFilter.endpointId, endpoint.id))
		).map((row) => row.pattern);

		// The window is read WITHOUT the filter applied, so the cursor advances
		// past events that were scanned but did not match — advancing only past
		// matches would re-scan every unmatched event forever. Matching then runs
		// in process against `matchesPattern`, which keeps one implementation of
		// the pattern rule rather than a SQL one that has to agree with it.
		const window = (await tx.execute(sql`
			SELECT id, seq, action, xmin::text::bigint AS xmin
			FROM audit_event
			WHERE xmin::text::bigint < ${horizon}
			  AND (xmin::text::bigint, seq) > (${endpoint.cursorXmin}, ${endpoint.cursorSeq})
			ORDER BY xmin::text::bigint, seq
			LIMIT ${FANOUT_LIMIT}
		`)) as unknown as { id: string; seq: string; action: string; xmin: string }[];

		if (window.length === 0) continue;

		const matching = patterns.length === 0
			? []
			: window.filter((row) => patterns.some((pattern) => matchesPattern(pattern, row.action)));

		if (matching.length > 0) {
			await tx
				.insert(eventDelivery)
				.values(
					matching.map((row) => ({
						endpointId: endpoint.id,
						auditSeq: BigInt(row.seq),
						auditId: row.id
					}))
				)
				// What makes a replayed fan-out a no-op, so a crash between this
				// insert and the cursor update below is safe — and what absorbs the
				// re-scan purgeRequester's UPDATE of audit_event causes, since that
				// bumps a row's xmin above the cursor again.
				.onConflictDoNothing({
					target: [eventDelivery.endpointId, eventDelivery.auditSeq]
				});
			enqueued += matching.length;
		}

		const last = window[window.length - 1]!;
		await tx
			.update(eventEndpoint)
			.set({ cursorXmin: BigInt(last.xmin), cursorSeq: BigInt(last.seq) })
			.where(eq(eventEndpoint.id, endpoint.id));
	}

	return { enqueued, paused };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test:integration tests/integration/egress-fanout.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Watch both guards fail**

This step is not optional — a concurrency test that has never been seen failing defends nothing.

1. In `fanout.ts`, replace the window predicate with `WHERE seq > ${endpoint.cursorSeq} ORDER BY seq` and the cursor update with `cursorSeq: BigInt(last.seq)` only.
   Run: `pnpm test:integration tests/integration/egress-fanout.test.ts -t 'still open'`
   Expected: **FAIL** — the event committed after the tick is stranded below the cursor.
2. Restore the horizon predicate but advance the cursor with `max(seq)` semantics: `ORDER BY seq` and `cursorSeq: BigInt(window[window.length - 1].seq)` while keeping `cursorXmin` unchanged.
   Run: `pnpm test:integration tests/integration/egress-fanout.test.ts -t 'above the horizon'`
   Expected: **FAIL** — `fastSeq` never arrives.
3. Restore the implementation. Run the whole file. Expected: PASS.

Record in the commit message that both guards were watched failing.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/egress/fanout.ts tests/integration/egress-fanout.test.ts
git commit -m "feat(egress): fan out under an (xmin, seq) keyset watermark

Both concurrency guards were watched failing before the implementation
landed: a plain seq scan strands an event committed out of order, and a
seq high-watermark filtered by the xmin horizon strands one whose xid is
above the horizon. See plan C1."
```

---

### Task 10: Claiming and delivering

**Files:**
- Create: `src/lib/server/egress/deliver.ts`
- Test: `tests/integration/egress-deliver.test.ts`

**Interfaces:**
- Consumes: `postEvent`, `backoffMinutes`, `MAX_ATTEMPTS` (Task 5); `enrichEvent` (Task 6); `formatEvent` (Task 7); `endpointSecret`, `signatureHeader` (Task 3); `validateEndpointUrl`, `parseAllowList` (Task 4).
- Produces:
  `claimDeliveries(tx: Db, options?: { limit?: number; perEndpoint?: number }): Promise<ClaimedDelivery[]>`;
  `deliverClaimed(db: Db, claimed: readonly ClaimedDelivery[], options: DeliverOptions): Promise<{ delivered: number; failed: number; skipped: number }>`;
  `CLAIM_LIMIT = 25`; `PER_ENDPOINT_LIMIT = 5`.
  `ClaimedDelivery = { id: string; endpointId: string; auditSeq: bigint; auditId: string; attempts: number; endpoint: { url: string; format: EgressFormat; secretVersion: number } }`
  `DeliverOptions = { baseUrl: string; locale: string; signingKey: string | undefined; allow: readonly AllowEntry[] }`

**The two phases, and why they are two.** `runJob` wraps `fn()` in `db.transaction` while `startJobRunner` passes `() => job.run(getDb())` — so the job body runs on a *different* pooled connection and the lock connection sits `idle in transaction` for the whole tick. With a 25-row batch and a 10 s timeout that is up to 250 seconds, repeatedly, which pins the xmin horizon on a system with high-churn tables (`ratelimit`, `outbound_email`, `event_delivery`) so autovacuum reclaims nothing, is killed outright by `idle_in_transaction_session_timeout` (standard hardening, and the default on several managed offerings), and occupies two of the pool's ten connections behind which request-path queries queue. Mail gets away with the same shape because it talks to one configured relay on a short timeout; this talks to arbitrary operator-supplied hosts, and that difference is the whole point (spec §5.1).

- [ ] **Step 1: Write the failing test**

`tests/integration/egress-deliver.test.ts`. Reuse the endpoint/filter helpers from the fan-out test by copying them into this file — Playwright's restriction does not apply here, but these two files diverge in what they need and a shared helper would grow options for both.

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { recordEvent } from '../../src/lib/server/audit';
import { eventDelivery, eventEndpoint, eventEndpointFilter, requester } from '../../src/lib/server/db/schema';
import { claimDeliveries, deliverClaimed } from '../../src/lib/server/egress/deliver';
import { parseAllowList } from '../../src/lib/server/egress/destination';
import { currentHorizon, fanOut } from '../../src/lib/server/egress/fanout';
import { startWebhookServer } from '../helpers/webhook-server';

let db: Db;
let close: () => Promise<void>;
let stop: (() => Promise<void>) | undefined;

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
	await stop?.();
	stop = undefined;
});

async function serve(handler: Parameters<typeof startWebhookServer>[0]) {
	const server = await startWebhookServer(handler);
	stop = server.close;
	return server;
}

async function createEndpoint(url: string, patterns: string[], overrides = {}) {
	const horizon = await currentHorizon(db);
	const [row] = await db
		.insert(eventEndpoint)
		.values({
			name: 'n8n',
			url,
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

async function tick() {
	const claimed = await db.transaction(async (tx) => {
		await fanOut(tx);
		return claimDeliveries(tx);
	});
	return deliverClaimed(db, claimed, OPTIONS);
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
		const server = await serve((_request, response) => response.writeHead(204).end());
		const endpointId = await createEndpoint(server.url, ['certification.*']);
		await emitFallbackEvent();

		const result = await tick();

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
		const server = await serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(server.url, ['certification.*']);
		await emitFallbackEvent();
		await tick();

		const [row] = await db
			.select({ lastSuccessAt: eventEndpoint.lastSuccessAt })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));
		expect(row?.lastSuccessAt).toBeInstanceOf(Date);
	});

	it('retries a 503 on the 1/2/4/8 schedule and fails after five attempts', async () => {
		const server = await serve((_request, response) => response.writeHead(503).end());
		const endpointId = await createEndpoint(server.url, ['certification.*']);
		await emitFallbackEvent();

		for (let attempt = 1; attempt <= 5; attempt++) {
			// Each pass claims the row again: the claim pushes next_attempt_at
			// forward, so it is pulled back here rather than waiting minutes.
			await db.update(eventDelivery).set({ nextAttemptAt: new Date(Date.now() - 1000) });
			const result = await tick();
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
		const server = await serve((_request, response) => response.writeHead(404).end());
		const endpointId = await createEndpoint(server.url, ['certification.*']);
		await emitFallbackEvent();

		await tick();

		const row = await deliveryRow(endpointId);
		expect(row?.status).toBe('failed');
		expect(row?.attempts).toBe(1);
		expect(server.requests).toHaveLength(1);
	});

	it('never stores a response body', async () => {
		const server = await serve((_request, response) =>
			// The shape that matters: a receiver echoing its input.
			response.writeHead(500).end('requester dana@acme.example could not be created')
		);
		const endpointId = await createEndpoint(server.url, ['certification.*']);
		await emitFallbackEvent();
		await tick();

		const row = await deliveryRow(endpointId);
		expect(row?.lastError).toBe('http_status');
		expect(JSON.stringify(row)).not.toContain('acme.example');
	});

	/**
	 * GUARD — a purged subject is `skipped`, not blanked, and no request is
	 * made. A consumer receiving `name: ""`, `email: ""` cannot distinguish it
	 * from a person with no name, and n8n → HubSpot will create a junk contact,
	 * error, or upsert by an empty email and overwrite an unrelated record
	 * (spec §4.5).
	 *
	 * To watch this fail: make enrich.ts return the blank row instead of
	 * `{ kind: 'skip' }`.
	 */
	it('skips a delivery whose subject was purged, without making a request', async () => {
		const server = await serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(server.url, ['access_grant.*']);

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
		await recordEvent(db, {
			action: 'access_grant.revoked',
			actor: { type: 'staff', id: crypto.randomUUID() },
			subjectType: 'access_grant',
			subjectId: crypto.randomUUID()
		});
		await db.update(requester).set({ purgedAt: new Date() }).where(eq(requester.id, person!.id));

		const result = await tick();

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
		const blackhole = await serve(() => {
			/* never responds */
		});
		const healthy = await startWebhookServer((_request, response) => response.writeHead(200).end());

		try {
			await createEndpoint(blackhole.url, ['certification.*']);
			const healthyId = await createEndpoint(healthy.url, ['certification.*']);
			await emitFallbackEvent();

			const claimed = await db.transaction(async (tx) => {
				await fanOut(tx);
				return claimDeliveries(tx);
			});

			// Both endpoints are represented in one claim.
			expect(new Set(claimed.map((row) => row.endpointId)).size).toBe(2);

			await deliverClaimed(db, claimed, OPTIONS);
			expect(healthy.requests).toHaveLength(1);

			const row = await deliveryRow(healthyId);
			expect(row?.status).toBe('delivered');
		} finally {
			await healthy.close();
		}
	}, 30_000);

	it('claims at most five rows per endpoint and twenty-five overall', async () => {
		const server = await serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(server.url, ['certification.*']);
		for (let index = 0; index < 8; index++) await emitFallbackEvent();

		const claimed = await db.transaction(async (tx) => {
			await fanOut(tx);
			return claimDeliveries(tx);
		});

		expect(claimed).toHaveLength(5);
		expect(claimed.every((row) => row.endpointId === endpointId)).toBe(true);
	});

	it('does not claim a row a concurrent tick already claimed', async () => {
		const server = await serve((_request, response) => response.writeHead(200).end());
		await createEndpoint(server.url, ['certification.*']);
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

	it('records signing_key_missing without making a request when a generic endpoint has no key', async () => {
		const server = await serve((_request, response) => response.writeHead(200).end());
		const endpointId = await createEndpoint(server.url, ['certification.*']);
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
		const endpointId = await createEndpoint('https://metadata.example.test/a', ['certification.*']);
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
```

`DeliverOptions` therefore also carries the optional `lookup` test seam; declare it as such with the same comment `PostInput` uses.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/egress-deliver.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/deliver`.

- [ ] **Step 3: Write the implementation**

`src/lib/server/egress/deliver.ts`:

```ts
import { SpanKind } from '@opentelemetry/api';
import { eq, sql } from 'drizzle-orm';
import { eventDelivery, eventEndpoint, type EgressFormat } from '../db/schema';
import { withSpan } from '../telemetry';
import { backoffMinutes, MAX_ATTEMPTS, postEvent } from './client';
import { parseAllowList, validateEndpointUrl, type AllowEntry, type LookupAll } from './destination';
import { enrichEvent } from './enrich';
import { formatEvent } from './format';
import { endpointSecret, signatureHeader } from './secret';
import type { AuditEventRow } from '../audit';
import type { Db } from '../db';

/** Global per tick, subdivided by the per-endpoint cap below. */
export const CLAIM_LIMIT = 25;
/**
 * Deliveries are round-robin across endpoints rather than draining one
 * endpoint at a time: without this a single black-holing endpoint delays every
 * other endpoint's deliveries by the full tick, and the 15 s interval exists
 * because a late notice is a defect (spec §5.1). Stating which limit is which
 * matters — per-endpoint alone multiplies tick time by the endpoint count,
 * global alone starves by claim order.
 */
export const PER_ENDPOINT_LIMIT = 5;

export interface ClaimedDelivery {
	id: string;
	endpointId: string;
	auditSeq: bigint;
	auditId: string;
	attempts: number;
	endpoint: { url: string; format: EgressFormat; secretVersion: number };
}

export interface DeliverOptions {
	baseUrl: string;
	locale: string;
	signingKey: string | undefined;
	allow: readonly AllowEntry[];
	/** Test seam, as on `PostInput`. Never set on the delivery path. */
	lookup?: LookupAll;
}

/**
 * Phase one, under the advisory lock and inside one transaction: claim due
 * rows and push their next attempt forward, exactly as `drainOutbox` does. The
 * pushed-forward claim is what makes phase two safe with no lock held.
 */
export async function claimDeliveries(
	tx: Db,
	options: { limit?: number; perEndpoint?: number } = {}
): Promise<ClaimedDelivery[]> {
	const limit = options.limit ?? CLAIM_LIMIT;
	const perEndpoint = options.perEndpoint ?? PER_ENDPOINT_LIMIT;

	// The window function is what makes the global limit fair: rows are ranked
	// within their endpoint, so the cap applies per endpoint and the outer
	// LIMIT then bounds total tick work.
	const rows = (await tx.execute(sql`
		WITH due AS (
			SELECT d.id,
			       row_number() OVER (PARTITION BY d.endpoint_id ORDER BY d.next_attempt_at, d.audit_seq) AS rank
			FROM event_delivery d
			JOIN event_endpoint e ON e.id = d.endpoint_id
			WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.enabled = true
			ORDER BY d.next_attempt_at
			FOR UPDATE OF d SKIP LOCKED
		)
		SELECT d.id, d.endpoint_id, d.audit_seq, d.audit_id, d.attempts,
		       e.url, e.format, e.secret_version
		FROM due
		JOIN event_delivery d ON d.id = due.id
		JOIN event_endpoint e ON e.id = d.endpoint_id
		WHERE due.rank <= ${perEndpoint}
		ORDER BY d.next_attempt_at
		LIMIT ${limit}
	`)) as unknown as {
		id: string;
		endpoint_id: string;
		audit_seq: string;
		audit_id: string;
		attempts: number;
		url: string;
		format: EgressFormat;
		secret_version: number;
	}[];

	if (rows.length === 0) return [];

	// A crash mid-delivery retries later rather than being retried by the very
	// next tick.
	await tx.execute(sql`
		UPDATE event_delivery SET next_attempt_at = now() + interval '5 minutes'
		WHERE id = ANY(${sql.raw(`ARRAY['${rows.map((row) => row.id).join("','")}']::uuid[]`)})
	`);

	return rows.map((row) => ({
		id: row.id,
		endpointId: row.endpoint_id,
		auditSeq: BigInt(row.audit_seq),
		auditId: row.audit_id,
		attempts: Number(row.attempts),
		endpoint: { url: row.url, format: row.format, secretVersion: row.secret_version }
	}));
}

/**
 * Phase two, outside any transaction: render, POST, and record each outcome in
 * its own short write. Nothing here holds a lock, which is the point — see the
 * task note on why this cannot live inside `runJob`'s transaction.
 */
export async function deliverClaimed(
	db: Db,
	claimed: readonly ClaimedDelivery[],
	options: DeliverOptions
): Promise<{ delivered: number; failed: number; skipped: number }> {
	let delivered = 0;
	let failed = 0;
	let skipped = 0;

	for (const row of claimed) {
		const [audit] = (await db.execute(sql`
			SELECT id, seq, at, actor_type, actor_id, action, subject_type, subject_id, meta
			FROM audit_event WHERE seq = ${row.auditSeq}
		`)) as unknown as AuditEventRow[];

		// The audit log is append-only, so the row cannot have been deleted — but
		// a delivery whose audit row is somehow absent has nothing to render.
		if (!audit) {
			await terminate(db, row, 'skipped', null, null);
			skipped++;
			continue;
		}

		const enriched = await enrichEvent(db, audit, {
			deliveryId: row.id,
			baseUrl: options.baseUrl,
			locale: options.locale
		});

		if (enriched.kind === 'skip') {
			// Nothing is sent. Blanks are the one shape a consumer cannot branch
			// on (spec §4.5).
			await terminate(db, row, 'skipped', null, null);
			skipped++;
			continue;
		}

		const { body, contentType } = formatEvent(row.endpoint.format, enriched.model);

		// Required for `generic` because that payload is what a consumer
		// authenticates. Teams verifies nothing, so a Teams-only operator should
		// not have to manage a key they cannot use (spec §7.1).
		if (row.endpoint.format === 'generic' && options.signingKey === undefined) {
			await recordFailure(db, row, null, 'signing_key_missing', false, null);
			failed++;
			continue;
		}

		const headers: Record<string, string> = {
			'x-trust-center-event': enriched.model.action,
			'x-trust-center-delivery': row.id
		};

		if (options.signingKey !== undefined) {
			const timestamp = Math.floor(Date.now() / 1000);
			const secrets = [
				endpointSecret(options.signingKey, row.endpointId, row.endpoint.secretVersion)
			];
			// The rotation overlap: the previous version travels alongside the
			// current one, without which a rotation makes every consumer return
			// 401 — which §5.3 makes terminal on the first attempt (spec §7.2).
			if (row.endpoint.secretVersion > 1) {
				secrets.push(
					endpointSecret(options.signingKey, row.endpointId, row.endpoint.secretVersion - 1)
				);
			}
			headers['x-trust-center-signature'] = signatureHeader(secrets, timestamp, body);
		}

		const outcome = await withSpan(
			'event deliver',
			{
				'egress.endpoint_id': row.endpointId,
				'egress.action': enriched.model.action,
				'egress.format': row.endpoint.format,
				'egress.attempt': row.attempts + 1
			},
			async (span) => {
				const result = await postEvent({
					// Re-validated here, not only on save: an endpoint row can be
					// changed by anyone with admin access between the two.
					url: validateEndpointUrl(row.endpoint.url, options.allow as AllowEntry[]),
					allow: options.allow,
					body,
					contentType,
					headers,
					lookup: options.lookup
				});

				if (result.kind === 'delivered' || result.statusCode !== null) {
					span.setAttribute('http.response.status_code', result.kind === 'delivered' ? result.statusCode : result.statusCode!);
				}
				return result;
			},
			// CLIENT, for the reason `mail send` is: Tempo, Jaeger, Grafana,
			// Datadog and the collector's spanmetrics connector all key service
			// maps and RED aggregation on the span kind.
			SpanKind.CLIENT
		);

		if (outcome.kind === 'delivered') {
			await db.transaction(async (tx) => {
				await tx
					.update(eventDelivery)
					.set({
						status: 'delivered',
						attempts: row.attempts + 1,
						lastStatusCode: outcome.statusCode,
						lastError: null,
						deliveredAt: new Date()
					})
					.where(eq(eventDelivery.id, row.id));
				// Drives auto-disable (spec §5.4). No audit event: the job mutates
				// the endpoint row routinely, and an event here would match the
				// endpoint's own filter and recur (spec §9).
				await tx
					.update(eventEndpoint)
					.set({ lastSuccessAt: new Date() })
					.where(eq(eventEndpoint.id, row.endpointId));
			});
			delivered++;
			continue;
		}

		await recordFailure(
			db,
			row,
			outcome.statusCode,
			outcome.reason,
			outcome.retryable,
			outcome.retryAfterSeconds
		);
		failed++;
	}

	return { delivered, failed, skipped };
}

async function terminate(
	db: Db,
	row: ClaimedDelivery,
	status: 'skipped',
	statusCode: number | null,
	reason: string | null
): Promise<void> {
	await db
		.update(eventDelivery)
		.set({ status, lastStatusCode: statusCode, lastError: reason })
		.where(eq(eventDelivery.id, row.id));
}

async function recordFailure(
	db: Db,
	row: ClaimedDelivery,
	statusCode: number | null,
	reason: string,
	retryable: boolean,
	retryAfterSeconds: number | null
): Promise<void> {
	const attempts = row.attempts + 1;
	const giveUp = !retryable || attempts >= MAX_ATTEMPTS;
	// outbound_email's schedule verbatim, so the deployment has one retry story
	// rather than two that differ for no reason (spec §5.3).
	const delayMinutes = backoffMinutes(attempts);

	await db.execute(sql`
		UPDATE event_delivery
		SET status = ${giveUp ? 'failed' : 'pending'},
		    attempts = ${attempts},
		    last_status_code = ${statusCode},
		    last_error = ${reason},
		    next_attempt_at = ${
					retryAfterSeconds !== null
						? sql`now() + make_interval(secs => ${retryAfterSeconds})`
						: sql`now() + make_interval(mins => ${delayMinutes})`
				}
		WHERE id = ${row.id}::uuid
	`);
}
```

Note the `parseAllowList` import is unused in the final shape — remove it if the implementation does not need it, rather than leaving an orphan.

- [ ] **Step 4: Run the tests**

Run: `pnpm test:integration tests/integration/egress-deliver.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Watch the purge guard fail**

In `enrich.ts`, make `identity()` return the blank row instead of `{ skip: 'purged' }`.
Run: `pnpm test:integration tests/integration/egress-deliver.test.ts -t 'purged'`
Expected: **FAIL** — a request is made and the delivery is `delivered`.
Restore, re-run, expect PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/egress/deliver.ts tests/integration/egress-deliver.test.ts
git commit -m "feat(egress): claim under the lock, deliver outside it"
```

---

### Task 11: Auto-disable, the loop-prevention rule, and the key canary

**Files:**
- Modify: `src/lib/server/egress/deliver.ts` (add `disableStaleEndpoints`)
- Create: `src/lib/server/egress/canary.ts`
- Test: `tests/integration/egress-audit.test.ts`

**Interfaces:**
- Consumes: `recordEvent` (`src/lib/server/audit`), `canaryValue`, `CANARY_SETTING_KEY` (Task 3), `setting` table.
- Produces: `disableStaleEndpoints(db: Db): Promise<{ disabled: string[] }>`; `DISABLE_AFTER_HOURS = 24`; `checkSigningKeyCanary(db: Db, signingKey: string | undefined): Promise<'ok' | 'mismatch' | 'absent'>`.

**Auto-disable is time-based, not a failure count.** A consecutive-failure counter is wrong in both directions: a low-volume deployment sending three events a day takes four days to reach ten failures, so a permanently dead endpoint stays "enabled" and silent for four days — and a high-volume one reaches ten inside a single 25-row batch, so a routine `secret_version` rotation, which makes the consumer return 401, which §5.3 makes terminal on the first attempt, would auto-disable the endpoint within one 15-second tick. §7.2's overlap window closes that particular hole, but the counter would still be measuring the wrong thing (spec §5.4).

**`coalesce(last_success_at, created_at)`, and this is plan-not-spec.** `last_success_at` is NULL for an endpoint that has never succeeded, so `now() - last_success_at > interval '24 hours'` is NULL and never fires — which is exactly the permanently-dead endpoint this rule exists for.

- [ ] **Step 1: Write the failing test**

`tests/integration/egress-audit.test.ts`:

```ts
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent, eventDelivery, eventEndpoint, setting } from '../../src/lib/server/db/schema';
import { checkSigningKeyCanary } from '../../src/lib/server/egress/canary';
import { disableStaleEndpoints } from '../../src/lib/server/egress/deliver';
import { currentHorizon } from '../../src/lib/server/egress/fanout';

let db: Db;
let close: () => Promise<void>;

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
	await db.delete(setting).where(eq(setting.key, 'egress.signing_key_canary'));
});

async function createEndpoint(overrides: Record<string, unknown> = {}) {
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
	return row!.id;
}

/** One failed attempt in the window, which is the second half of the rule. */
async function addFailedAttempt(endpointId: string, hoursAgo: number) {
	await db.execute(sql`
		INSERT INTO event_delivery
			(endpoint_id, audit_seq, audit_id, status, attempts, last_error, created_at, next_attempt_at)
		VALUES (${endpointId}::uuid, ${Math.floor(Math.random() * 1e9)}, gen_random_uuid(),
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

describe('disableStaleEndpoints', () => {
	it('disables an endpoint with no success in 24 hours and an attempt in that window', async () => {
		const endpointId = await createEndpoint({
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
		const endpointId = await createEndpoint({ createdAt: sql`now() - interval '30 hours'` });
		await addFailedAttempt(endpointId, 1);

		expect((await disableStaleEndpoints(db)).disabled).toEqual([endpointId]);
	});

	it('leaves an endpoint alone while it is still succeeding', async () => {
		const endpointId = await createEndpoint({ lastSuccessAt: sql`now() - interval '1 hour'` });
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
		const endpointId = await createEndpoint({
			createdAt: sql`now() - interval '40 hours'`,
			lastSuccessAt: sql`now() - interval '30 hours'`
		});

		expect((await disableStaleEndpoints(db)).disabled).toEqual([]);
	});

	it('is idempotent — a disabled endpoint is not disabled twice', async () => {
		const endpointId = await createEndpoint({ lastSuccessAt: sql`now() - interval '30 hours'` });
		await addFailedAttempt(endpointId, 2);

		await disableStaleEndpoints(db);
		const after = await auditCount('event_endpoint.disabled');
		await disableStaleEndpoints(db);

		expect(await auditCount('event_endpoint.disabled')).toBe(after);
	});

	/**
	 * GUARD — the counting version, which is what catches a reintroduced loop.
	 *
	 * An audit event written on delivery success or failure would match its own
	 * endpoint's filter, fan out into a new event_delivery, deliver or fail,
	 * write another audit event, and recur — an unbounded loop whose first
	 * symptom is an operator's Teams channel filling at 15-second intervals
	 * (spec §9). The count, not the absence, is the assertion: a later
	 * contributor adding a generic "endpoint changed → record
	 * event_endpoint.updated" helper or a trigger reintroduces the loop without
	 * touching the delivery path.
	 */
	it('writes exactly one audit event for a day of failures, not one per failure', async () => {
		const endpointId = await createEndpoint({ lastSuccessAt: sql`now() - interval '30 hours'` });
		for (let hour = 0; hour < 20; hour++) await addFailedAttempt(endpointId, hour);

		const before = await auditCount('event_endpoint.disabled');
		// Several ticks, as a real day would produce.
		await disableStaleEndpoints(db);
		await disableStaleEndpoints(db);
		await disableStaleEndpoints(db);

		expect(await auditCount('event_endpoint.disabled')).toBe(before + 1);

		// And nothing else was written about this endpoint at all.
		const [row] = await db
			.select({ n: count() })
			.from(auditEvent)
			.where(eq(auditEvent.subjectId, endpointId));
		expect(Number(row?.n)).toBe(1);
	});

	it('names the endpoint as the subject and keeps the URL out of meta', async () => {
		const endpointId = await createEndpoint({
			url: 'https://hooks.example.test/a?secret=abc123',
			lastSuccessAt: sql`now() - interval '30 hours'`
		});
		await addFailedAttempt(endpointId, 1);
		await disableStaleEndpoints(db);

		const [event] = await db
			.select()
			.from(auditEvent)
			.where(eq(auditEvent.subjectId, endpointId));

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
		const rows = await db.select().from(setting).where(eq(setting.key, 'egress.signing_key_canary'));
		expect(rows).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/egress-audit.test.ts`
Expected: FAIL — cannot resolve `disableStaleEndpoints` or `src/lib/server/egress/canary`.

- [ ] **Step 3: Write the canary**

`src/lib/server/egress/canary.ts`:

```ts
import { eq } from 'drizzle-orm';
import { setting } from '../db/schema';
import { canaryValue, CANARY_SETTING_KEY } from './secret';
import type { Db } from '../db';

/**
 * Compared on every boot and before every tick. `event_endpoint` holds no
 * secret, so nothing else would notice that EVENT_SIGNING_KEY changed —
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

	return row.value === expected ? 'ok' : 'mismatch';
}
```

- [ ] **Step 4: Write auto-disable**

Append to `src/lib/server/egress/deliver.ts`:

```ts
/** The window with no success after which an endpoint disables itself. */
export const DISABLE_AFTER_HOURS = 24;

/**
 * Time-based rather than a consecutive-failure count, which is wrong in both
 * directions: a low-volume deployment takes four days to reach ten failures,
 * so a dead endpoint stays "enabled" and silent for four days, while a
 * high-volume one reaches ten inside a single 25-row batch — so a routine
 * secret_version rotation would auto-disable the endpoint within one tick
 * (spec §5.4).
 *
 * `coalesce(last_success_at, created_at)` because `last_success_at` is NULL
 * for an endpoint that has never succeeded once, which is precisely the
 * permanently-dead case this exists for.
 *
 * The "and at least one attempt in the window" half is what keeps a *quiet*
 * endpoint enabled: an operator whose channel simply had no matching events
 * for a day must not find it disabled.
 */
export async function disableStaleEndpoints(db: Db): Promise<{ disabled: string[] }> {
	const stale = (await db.execute(sql`
		SELECT e.id, e.name, e.format,
		       (SELECT d.last_status_code FROM event_delivery d
		         WHERE d.endpoint_id = e.id AND d.status IN ('failed', 'pending')
		         ORDER BY d.created_at DESC LIMIT 1) AS last_status_code
		FROM event_endpoint e
		WHERE e.enabled = true
		  AND coalesce(e.last_success_at, e.created_at) < now() - make_interval(hours => ${DISABLE_AFTER_HOURS})
		  AND EXISTS (
		    SELECT 1 FROM event_delivery d
		    WHERE d.endpoint_id = e.id
		      AND d.attempts > 0
		      AND d.created_at > now() - make_interval(hours => ${DISABLE_AFTER_HOURS})
		  )
	`)) as unknown as { id: string; name: string; format: string; last_status_code: number | null }[];

	const disabled: string[] = [];

	for (const endpoint of stale) {
		const reason = `no delivery succeeded in ${DISABLE_AFTER_HOURS} hours`;

		await db.transaction(async (tx) => {
			await tx
				.update(eventEndpoint)
				.set({ enabled: false, disabledAt: new Date(), disabledReason: reason })
				.where(eq(eventEndpoint.id, endpoint.id));

			// The single exception to "egress writes no audit events" (spec §9).
			// Safe because by the time this is written the endpoint is disabled
			// and cannot deliver it, and another endpoint delivering it is
			// desirable. `meta` carries the name and format but NOT the URL: a
			// Teams Workflows URL carries its shared secret in the query string,
			// and this table cannot be deleted from.
			await recordEvent(tx, {
				action: 'event_endpoint.disabled',
				actor: { type: 'system', id: null },
				subjectType: 'event_endpoint',
				subjectId: endpoint.id,
				meta: {
					name: endpoint.name,
					format: endpoint.format,
					reason,
					lastStatusCode: endpoint.last_status_code
				}
			});
		});

		disabled.push(endpoint.id);
	}

	return { disabled };
}
```

Add `import { recordEvent } from '../audit';` to `deliver.ts`.

- [ ] **Step 5: Run the tests**

Run: `pnpm test:integration tests/integration/egress-audit.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Watch the loop guard fail**

In `deliverClaimed`'s success branch, add a `recordEvent(tx, { action: 'event_endpoint.updated', … })` next to the `last_success_at` update — the exact change a later contributor would make.
Run: `pnpm test:integration tests/integration/egress-audit.test.ts -t 'exactly one audit event'`
Expected: **FAIL** on the "nothing else was written about this endpoint" assertion.
Remove it, re-run, expect PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/lib/server/egress/deliver.ts src/lib/server/egress/canary.ts tests/integration/egress-audit.test.ts
git commit -m "feat(egress): disable an endpoint after 24h without a success

Auto-disable writes the single audit event egress is allowed to write.
The counting guard was watched failing with a delivery-path recordEvent
added, which is the shape that reintroduces the loop."
```

---

### Task 12: Job wiring, retention, and telemetry

**Files:**
- Modify: `src/lib/server/jobs/index.ts` (the `Job` shape, the new job, the retention fold-in), `src/lib/server/jobs/runner.ts` (no change expected — confirm), `src/lib/server/telemetry/metrics.ts`, `src/lib/server/telemetry/index.ts`, `src/hooks.server.ts`
- Create: `src/lib/server/egress/index.ts` (the job body, so `jobs/index.ts` stays a registry)
- Test: `tests/unit/jobs.test.ts` (extend), `tests/integration/egress-retention.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `runEgressFanoutAndClaim(db: Db): Promise<ClaimedDelivery[]>` and `runEgressDeliveries(db: Db, claimed: readonly ClaimedDelivery[]): Promise<void>` from `egress/index.ts`; `sweepEventDeliveries(db, { retentionDays })` from `src/lib/server/retention.ts`; `recordEgressDelivery`, `registerEgressQueueDepthGauge` from `telemetry/metrics.ts`; `Job.afterLock?: (db: Db) => Promise<void>`.

- [ ] **Step 1: Extend the `Job` shape**

In `src/lib/server/jobs/index.ts`:

```ts
interface Job {
	name: string;
	everyMs: number;
	/** Runs under the advisory lock, inside one transaction. */
	run: (db: Db) => Promise<void>;
	/**
	 * Runs after the lock's transaction has committed, on a pooled connection
	 * and outside any transaction. For work that talks to the network.
	 *
	 * `runJob` wraps `run` in `db.transaction`, so without this phase the lock
	 * connection sits `idle in transaction` for the whole tick — up to 250
	 * seconds for a 25-row egress batch on a 10 s timeout. That pins the xmin
	 * horizon so autovacuum reclaims nothing on `ratelimit` and
	 * `outbound_email`, is killed outright by
	 * `idle_in_transaction_session_timeout`, and holds two of the pool's ten
	 * connections behind which request-path queries queue. `mail:drain` gets
	 * away with the single-phase shape because it talks to one configured relay
	 * on a short timeout; egress talks to arbitrary operator-supplied hosts
	 * (spec §5.1).
	 *
	 * Only runs when `run` actually held the lock: if another replica had it,
	 * this replica claimed nothing and has nothing to deliver.
	 */
	afterLock?: (db: Db) => Promise<void>;
}
```

And in `startJobRunner`:

```ts
		const timer = setInterval(() => {
			void runJob(getDb(), job.name, () => job.run(getDb()))
				.then((result) => (result.ran && job.afterLock ? job.afterLock(getDb()) : undefined))
				.catch((cause) => {
					console.error(
						JSON.stringify({
							level: 'error',
							job: job.name,
							message: cause instanceof Error ? cause.message : String(cause)
						})
					);
				});
		}, job.everyMs);
```

`runJob` itself is unchanged. Note the consequence rather than discovering it later: `trustcenter.job.tick.duration` covers phase one only. The `event deliver` spans and `trustcenter.egress.delivery.duration` cover phase two, which is where the time goes.

Phase two's claimed rows have to reach it. Hold them in a module-scoped variable inside `egress/index.ts` rather than widening the `Job` interface with a generic payload type — one job needs this, and a generic channel is speculative:

`src/lib/server/egress/index.ts`:

```ts
import { getConfig } from '../config';
import { checkSigningKeyCanary } from './canary';
import { claimDeliveries, deliverClaimed, disableStaleEndpoints, type ClaimedDelivery } from './deliver';
import { parseAllowList } from './destination';
import { fanOut } from './fanout';
import { recordEgressFanout } from '../telemetry';
import { withSpan } from '../telemetry';
import type { Db } from '../db';

/**
 * Phase one's output, handed to phase two of the same tick. Module-scoped
 * rather than threaded through the Job interface: one job needs it, and a
 * generic payload channel on every job is surface with nothing to buy. Safe
 * because the two phases of one tick never overlap — `runJob`'s advisory lock
 * makes a second tick skip rather than queue.
 */
let claimed: ClaimedDelivery[] = [];

/** Phase one: under the lock, in one transaction. */
export async function runEgressClaim(db: Db): Promise<void> {
	claimed = [];
	const config = getConfig();
	if (!config.egress.enabled) return;

	// A changed root key means every signature is wrong; delivering anyway
	// would burn all five attempts on every queued event and then auto-disable
	// every endpoint (spec §7.1).
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

	await withSpan('event fanout', {}, async (span) => {
		const result = await fanOut(db);
		span.setAttribute('egress.enqueued', result.enqueued);
		recordEgressFanout(result.enqueued);
	});

	claimed = await claimDeliveries(db);
}

/** Phase two: outside the lock and outside any transaction. */
export async function runEgressDeliveries(db: Db): Promise<void> {
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
			allow: parseAllowList(config.egress.allow)
		});
	}

	// Evaluated per tick, after the batch, so an endpoint that just succeeded is
	// not disabled by a stale reading.
	if (config.egress.enabled) await disableStaleEndpoints(db);
}
```

Register it in `JOBS`, after `mail:drain`:

```ts
	// Fifteen seconds, matching mail:drain and on the same reasoning: a magic
	// link a minute late is a person waiting, and a Teams notice fifteen
	// minutes late is a defect.
	{
		name: 'egress:deliver',
		everyMs: 15_000,
		run: runEgressClaim,
		afterLock: runEgressDeliveries
	},
```

Fold the delivery sweep into the existing `retention:sweep` entry, after `sweepUnconfirmedSubscriptions(db)`:

```ts
			// Terminal deliveries older than 30 days. Folded in here rather than
			// becoming an eighth timer, for the reason the subscription sweep was:
			// the interval is right and a tick that finds nothing costs one
			// indexed query (spec §5.6).
			await sweepEventDeliveries(db, { retentionDays: 30 });
```

- [ ] **Step 2: Write the retention sweep and its test**

In `src/lib/server/retention.ts`:

```ts
/**
 * Terminal deliveries are a log of what went where, and thirty days is long
 * enough to answer "did that approval reach n8n?". Pending rows are never
 * swept: one is still owed a delivery.
 *
 * Nothing here is personal data — `audit_seq` and `audit_id` are references,
 * `last_error` is a fixed reason phrase (spec §2.3) — so this is a table-size
 * measure rather than an erasure one.
 */
export async function sweepEventDeliveries(
	db: Db,
	options: { retentionDays: number }
): Promise<{ deleted: number }> {
	const deleted = await db
		.delete(eventDelivery)
		.where(
			and(
				inArray(eventDelivery.status, ['delivered', 'failed', 'skipped']),
				lt(eventDelivery.createdAt, sql`now() - make_interval(days => ${options.retentionDays})`)
			)
		)
		.returning({ id: eventDelivery.id });

	return { deleted: deleted.length };
}
```

`tests/integration/egress-retention.test.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { eventDelivery, eventEndpoint } from '../../src/lib/server/db/schema';
import { currentHorizon } from '../../src/lib/server/egress/fanout';
import { sweepEventDeliveries } from '../../src/lib/server/retention';

let db: Db;
let close: () => Promise<void>;

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

describe('sweepEventDeliveries', () => {
	it('deletes terminal rows past the window and keeps pending ones', async () => {
		const horizon = await currentHorizon(db);
		const [endpoint] = await db
			.insert(eventEndpoint)
			.values({
				name: 'n8n',
				url: 'https://hooks.example.test/a',
				format: 'generic',
				cursorXmin: horizon,
				cursorSeq: 0n
			})
			.returning({ id: eventEndpoint.id });

		await db.execute(sql`
			INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id, status, created_at) VALUES
				(${endpoint!.id}::uuid, 1, gen_random_uuid(), 'delivered', now() - interval '40 days'),
				(${endpoint!.id}::uuid, 2, gen_random_uuid(), 'failed',    now() - interval '40 days'),
				(${endpoint!.id}::uuid, 3, gen_random_uuid(), 'skipped',   now() - interval '40 days'),
				(${endpoint!.id}::uuid, 4, gen_random_uuid(), 'delivered', now() - interval '10 days'),
				-- A pending row is still owed a delivery, however old it is.
				(${endpoint!.id}::uuid, 5, gen_random_uuid(), 'pending',   now() - interval '40 days')
		`);

		const result = await sweepEventDeliveries(db, { retentionDays: 30 });

		expect(result.deleted).toBe(3);
		const remaining = await db
			.select({ auditSeq: eventDelivery.auditSeq })
			.from(eventDelivery)
			.where(eq(eventDelivery.endpointId, endpoint!.id))
			.orderBy(eventDelivery.auditSeq);
		expect(remaining.map((row) => String(row.auditSeq))).toEqual(['4', '5']);
	});
});
```

- [ ] **Step 3: Add the telemetry instruments**

In `src/lib/server/telemetry/metrics.ts`, inside `build()`:

```ts
		egressDelivery: meter.createCounter('trustcenter.egress.delivery', {
			description: 'Event deliveries by outcome'
		}),
		egressDeliveryDuration: meter.createHistogram('trustcenter.egress.delivery.duration', {
			description: 'Duration of one event delivery attempt',
			unit: 's',
			// The request set, not the job set: a delivery is one HTTP call on a
			// 10 s timeout, so the same boundaries answer the same question.
			advice: { explicitBucketBoundaries: REQUEST_DURATION_BUCKETS }
		}),
		egressFanout: meter.createCounter('trustcenter.egress.fanout', {
			description: 'Deliveries enqueued by fan-out'
		}),
```

And the recorders, next to `recordJobTick`:

```ts
/**
 * The endpoint's UUID, never its `name`, URL or host. A host can be a literal
 * IP address and §8 bans IP addresses from telemetry outright — an attribute
 * whose value is *sometimes* an IP cannot be sanitised into compliance, which
 * is C's carry-over §1.1 reasoning for dropping `server.address`. `name` is
 * unvalidated operator free text, and an operator who names an endpoint after
 * its URL or a contact address puts exactly that into a metric label. The UUID
 * costs one lookup and is not a judgement call (spec §10).
 */
export function recordEgressDelivery(input: {
	endpointId: string;
	outcome: 'delivered' | 'failed' | 'skipped';
	seconds: number;
}): void {
	const attributes: Attributes = {
		'egress.endpoint_id': input.endpointId,
		outcome: input.outcome
	};
	get().egressDelivery.add(1, attributes);
	get().egressDeliveryDuration.record(input.seconds, attributes);
}

export function recordEgressFanout(enqueued: number): void {
	if (enqueued > 0) get().egressFanout.add(enqueued);
}
```

Mirror `registerQueueDepthGauge` for the queue depth:

```ts
/** Mirrors trustcenter.mail.queue.depth, and tells the same two cases apart. */
export function registerEgressQueueDepthGauge(read: () => Promise<number>): void {
	const gauge = metrics
		.getMeter(METER_NAME)
		.createObservableGauge('trustcenter.egress.queue.depth', {
			description: 'Event deliveries queued and not yet delivered'
		});

	gauge.addCallback(async (result) => {
		result.observe(await read());
	});
}
```

Export both from `src/lib/server/telemetry/index.ts`, and call `registerEgressQueueDepthGauge` wherever `registerQueueDepthGauge` is called today — read that call site first and follow it exactly, including whether it is guarded by "telemetry is on".

Then call `recordEgressDelivery` from `deliverClaimed`'s three outcome branches, timing each attempt with `performance.now()` as `runJob` does.

- [ ] **Step 4: Extend the jobs unit test**

Add to `tests/unit/jobs.test.ts` (read the existing file first and match its style):

```ts
	it('registers egress:deliver with a phase that runs outside the lock', () => {
		const job = JOBS.find((entry) => entry.name === 'egress:deliver');
		expect(job).toBeDefined();
		expect(job?.everyMs).toBe(15_000);
		// The property that matters: the HTTP phase is not inside runJob's
		// transaction (spec §5.1, plan C3).
		expect(job?.afterLock).toBeTypeOf('function');
	});
```

- [ ] **Step 5: Run everything**

Run: `pnpm test:unit && pnpm test:integration && pnpm check`
Expected: PASS throughout.

Also verify the telemetry rule holds, using the shared assertion rather than a hand-rolled one — add to whichever telemetry test file covers spans (`tests/unit/telemetry-span.test.ts` names the pattern):

```ts
	it('carries no sensitive attributes on an egress span', () => {
		// expectNoSensitiveAttributes states the §8 rule once; these tests use
		// it rather than hand-rolling the assertion.
		expectNoSensitiveAttributes(exported);
	});
```

Any assertion of the form `.some(…) === false` must pin the collection's size first — an empty array satisfies such an assertion, a trap the OTel branch shipped three times before it was caught.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/jobs src/lib/server/egress/index.ts src/lib/server/retention.ts src/lib/server/telemetry tests/unit/jobs.test.ts tests/integration/egress-retention.test.ts
git commit -m "feat(egress): wire the two-phase job, retention sweep and telemetry"
```

---

### Task 13: Endpoint management and the admin surface

**Files:**
- Create: `src/lib/server/egress/endpoints.ts`
- Create: `src/routes/(admin)/admin/settings/integrations/{+page.server.ts,+page.svelte}`
- Create: `src/routes/(admin)/admin/settings/integrations/[id]/{+page.server.ts,+page.svelte}`
- Modify: `src/lib/admin/sections.ts`, `messages/en.json`, `messages/de.json`
- Test: `tests/integration/egress-endpoints.test.ts`, `tests/e2e/admin-integrations.spec.ts`

**Interfaces:**
- Consumes: `isValidPattern` (Task 2), `validateEndpointUrl`/`parseAllowList` (Task 4), `currentHorizon` (Task 9), `endpointSecret` (Task 3), `postEvent` (Task 5), `formatEvent` (Task 7), `recordEvent`.
- Produces from `endpoints.ts`:
  `listEndpoints(db): Promise<EndpointSummary[]>` with `EndpointSummary = { id, name, format, host, enabled, disabledReason, lastSuccessAt, lastOutcome, pendingDepth, patterns }`;
  `getEndpoint(db, id): Promise<EndpointDetail | undefined>`;
  `createEndpoint(db, input: EndpointInput, actor, options?: EndpointOptions): Promise<string>` where `EndpointInput = { name: string; url: string; format: EgressFormat; patterns: string[] }` and `EndpointOptions = { signingKey: string | null; allow?: readonly AllowEntry[] }` — the whole object is defaulted from `getConfig()` when omitted, and `signingKey: null` means "no key is configured" (distinct from an omitted option, which would fall back to config); the tests pass it explicitly so validation is exercisable without an environment;
  `updateEndpoint(db, id, input: EndpointInput, actor, options?: EndpointOptions): Promise<void>`;
  `deleteEndpoint(db, id, actor): Promise<void>`;
  `setEndpointEnabled(db, id, input: { enabled: boolean; skipBacklog?: boolean; reason?: string }, actor): Promise<void>`;
  `bumpSecretVersion(db, id, actor): Promise<number>`;
  `sendTestEvent(db, id, options): Promise<{ statusCode: number | null; reason: string | null }>`.
  `actor` is `{ staffUserId: string; ip: string | null }`.

**The role gate is not a deviation** (plan C2): `/admin/audit` already refuses a non-admin in its `load`, and `ADMIN_SECTIONS` already carries `role` so the nav hides what the route would refuse. Both halves are required here, for the reason the audit page gives: an endpoint URL is where a prospect's name and address get sent, and §6's threat model is explicitly the compromised admin.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/egress-endpoints.test.ts`:

```ts
import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent, eventDelivery, eventEndpoint, eventEndpointFilter, staffUser } from '../../src/lib/server/db/schema';
import { recordEvent } from '../../src/lib/server/audit';
import {
	bumpSecretVersion,
	createEndpoint,
	deleteEndpoint,
	getEndpoint,
	listEndpoints,
	setEndpointEnabled,
	updateEndpoint
} from '../../src/lib/server/egress/endpoints';
import { currentHorizon } from '../../src/lib/server/egress/fanout';

let db: Db;
let close: () => Promise<void>;
let actor: { staffUserId: string; ip: string | null };

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	// Match the columns staff_user actually requires — read the schema file.
	const [staff] = await db
		.insert(staffUser)
		.values({ subject: `admin-${crypto.randomUUID()}`, email: 'admin@example.test', role: 'admin' })
		.returning({ id: staffUser.id });
	actor = { staffUserId: staff!.id, ip: '198.51.100.1' };
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	await db.delete(eventEndpoint);
});

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
		await expect(createEndpoint(db, { ...VALID, url: 'https://u:p@x.test/a' }, actor)).rejects.toThrow();
		await expect(createEndpoint(db, { ...VALID, url: 'file:///etc/passwd' }, actor)).rejects.toThrow();
		await expect(createEndpoint(db, { ...VALID, patterns: ['*.approved'] }, actor)).rejects.toThrow();
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
			createEndpoint(db, { ...VALID, format: 'generic' }, actor, { signingKey: null })
		).rejects.toThrow(/EVENT_SIGNING_KEY/);

		// Teams verifies nothing, so a Teams-only operator needs no key.
		await expect(
			createEndpoint(db, { ...VALID, format: 'teams' }, actor, { signingKey: null })
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
			.where(eq(auditEvent.action, 'event_endpoint.updated'));
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
		await db.execute(
			// Three queued deliveries, as a day of downtime would leave.
			eventDeliveryFixture(id)
		);
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
			.where(eq(auditEvent.action, 'event_endpoint.deleted'));
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
```

Write `eventDeliveryFixture(id)` at the top of the file as a small `sql` helper inserting three pending rows with distinct `audit_seq` values — do not leave it undefined.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration tests/integration/egress-endpoints.test.ts`
Expected: FAIL — cannot resolve `src/lib/server/egress/endpoints`.

- [ ] **Step 3: Write `endpoints.ts`**

Implement the eight functions above. The rules each one must encode, so nothing is left to taste:

- **Validation before any write.** `validateEndpointUrl(url, parseAllowList(config.egress.allow))`, `EGRESS_FORMATS.includes(format)`, every pattern through `isValidPattern`, at least one pattern. Throw a named error (`EndpointInvalid` with a `field`) so the route can `fail(400, { field })` the way `settings/access` does.
- **`createEndpoint`** sets `cursorXmin` from `currentHorizon(db)` and `cursorSeq` to `0n`, inserts the filters, and records `event_endpoint.created` — all in one transaction, so a half-created endpoint cannot exist.
- **`updateEndpoint`** replaces the filter set wholesale (delete then insert, in the transaction) and records `event_endpoint.updated`. It does **not** touch the cursor: an operator narrowing a filter is not asking to re-send anything.
- **`setEndpointEnabled`** keeps `enabled` and `disabledAt` in agreement — the check constraint will reject anything else — and on `skipBacklog` sets the cursor to the current horizon *and* updates the endpoint's `pending` deliveries to `skipped` in the same transaction. Records `event_endpoint.updated`, not a new action: the four names are fixed.
- **`bumpSecretVersion`** increments and records `event_endpoint.updated` with `{ secretVersion }` in meta. Returns the new version.
- **`deleteEndpoint`** deletes the row (filters and deliveries cascade) and records `event_endpoint.deleted` with the name and format in meta. Record the event *before* the delete inside the transaction if a foreign key would otherwise complain — `audit_event` has no FK to `event_endpoint`, deliberately, so either order works; pick delete-then-record and say why in a comment.
- **`listEndpoints`** derives `host` with `new URL(row.url).hostname` and never returns `url`. `lastOutcome` is the newest delivery's `status` and `lastStatusCode`. `pendingDepth` is one grouped count over the partial index.
- **`sendTestEvent`** builds a synthetic `EventModel` with `action: 'egress.test'`, formats it with the endpoint's formatter, signs it, and calls `postEvent` inline. It bypasses **exactly three** things — the cursor, the filter and the queue — and nothing else: the destination check, the scheme and port restrictions, the redirect refusal and the discard-the-body rule all apply unchanged, because an inline admin-triggered request that skipped them would be a hand-built SSRF probe with a UI (spec §11). It writes no `event_delivery` row and no audit event; `egress.test` is deliberately not an audit action, so nothing writes it to `audit_event` and no filter can match it.

- [ ] **Step 4: Write the two routes**

`integrations/+page.server.ts`:

```ts
import { error } from '@sveltejs/kit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { listEndpoints } from '$lib/server/egress/endpoints';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Admin only, not approver: an endpoint URL is where a prospect's name and
	// address get sent, and §6's threat model is the compromised admin. Same
	// gate, same shape as /admin/audit.
	if (locals.staff?.role !== 'admin') {
		error(403, 'Integrations are restricted to administrators.');
	}

	return {
		endpoints: await listEndpoints(getDb()),
		// So the page can say why nothing is being delivered.
		egressEnabled: getConfig().egress.enabled
	};
};
```

The `[id]` route repeats the gate (a page's own `load` is the only thing that can refuse it) and exposes named form actions: `save`, `enable`, `disable`, `rotate`, `test`, `delete`. Each parses with zod and returns `fail(400, { field })` on invalid input, matching `settings/access`.

The list page shows name, format, **host only**, enabled/disabled with its reason, last delivery outcome, and pending depth — plus a banner when `EVENT_EGRESS_ENABLED` is off, because otherwise a configured endpoint that delivers nothing looks like a bug.

Two things the edit page must carry that are easy to skip:

- **The high-frequency warning.** When a filter selects an action whose 7-day rate exceeds a threshold, warn. `document.downloaded` is registered and deliberately not throttled — one grant holder working through forty documents produces forty cards. Throttling it here would be this subsystem deciding what an operator's channel should contain, which is note §2's line; the operator chooses, and is told what they are choosing (spec §9.1).
- **Skip-first re-enabling.** The enable control offers "enable, skipping the backlog" *first*, with the pending count next to it, and "enable and catch up" second.

- [ ] **Step 5: Nav entry and messages**

In `src/lib/admin/sections.ts`, after the access-settings entry:

```ts
	{ path: '/admin/settings/integrations', label: () => m.admin_integrations(), role: 'admin' },
```

Add every new key to **both** `messages/en.json` and `messages/de.json` — `pnpm check` compiles the catalogs and a key missing from one is a build error. Keys needed: `admin_integrations`, plus labels for the fields, the two enable options, the test-send result, and the high-frequency warning.

- [ ] **Step 6: Write the e2e spec**

`tests/e2e/admin-integrations.spec.ts`, following `tests/e2e/admin-audit.spec.ts` for the sign-in pattern (`signInAs(page, slotAccount('admin'))`):

```ts
// Admin CRUD for an endpoint, plus the role gate.
test('an admin creates, edits and deletes an endpoint', async ({ page }) => { … });
test('an approver is refused and never offered the link', async ({ page }) => {
	// Both halves: the route 403s, and the nav does not show it — the existing
	// comment in sections.ts says an approver must never be offered a link
	// that 403s.
});
```

`tests/e2e/security.spec.ts` is **unchanged and must stay so**: its claim is that the *portal* makes no browser-side third-party requests, which server-side egress does not touch. Do not add egress assertions to it.

- [ ] **Step 7: Run everything**

Run: `pnpm check && pnpm test:unit && pnpm test:integration`
Expected: PASS.

Run: `pnpm test:e2e tests/e2e/admin-integrations.spec.ts --project=app`
Expected: PASS. This needs `pnpm dev:up` running.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add src/lib/server/egress/endpoints.ts 'src/routes/(admin)/admin/settings/integrations' src/lib/admin/sections.ts messages tests/integration/egress-endpoints.test.ts tests/e2e/admin-integrations.spec.ts
git commit -m "feat(egress): add endpoint management and the admin surface"
```

---

### Task 14: Documentation

**Files:**
- Modify: `docs/self-hosting.md`
- Modify: `docs/superpowers/specs/2026-08-31-integrations-decomposition.md`
- Modify: `docs/superpowers/specs/2026-09-03-event-egress-design.md`

- [ ] **Step 1: New `docs/self-hosting.md` section**

Write **Event egress (integrations)** covering, in this order: what an endpoint is; the three environment variables with their defaults; the two payload shapes with a real example of each; a **signature-verification recipe a consumer can paste** (the signed input is `${t}.${body}`, the header may carry two `v1=` values during a rotation and a consumer must accept either, and a timestamp tolerance of a few minutes is expected); the delivery id as the idempotency key, stated explicitly rather than left for a consumer to discover — because retries re-render from live state, a consumer *cannot* deduplicate on a body hash; the high-frequency actions by name (§9.1); the `skipped`-on-purge contract; that delivery order is roughly commit order and a consumer must not assume `seq` arrives monotonically (plan C1); and the §8 boundary statement verbatim:

> An event that leaves this application has left the reach of its erasure mechanism. `purgeRequester` clears personal data from this database and from mail queued but not yet sent; it cannot reach an n8n execution history, a Teams channel, or a CRM record that an earlier delivery caused to be written. Those are your systems, on your subprocessor list, and your Art. 17 obligation reaches them exactly as it reaches the HubSpot record your automation wrote.

- [ ] **Step 2: Amend `docs/self-hosting.md` §9**

§9 ("What this deployment does not send anywhere") stops being unqualifiedly true the moment an endpoint exists. The amendment must say, **in the same paragraph**, that egress is off unless `EVENT_EGRESS_ENABLED` is set, and that the browser-side claim is unchanged and still enforced by `tests/e2e/security.spec.ts` — otherwise a reader takes the amendment for a retreat from the whole section rather than an addition to it.

- [ ] **Step 3: Point the decomposition note at this document**

In `2026-08-31-integrations-decomposition.md`, add a line to §5 and to §9 A naming `2026-09-03-event-egress-design.md` as governing for subsystem A, and mark §5 **corrected** — "A consumer is a cursor holding one bigint. No deduplication, no ordering problem" is false, and B would otherwise inherit the defect. §5 must point at the *plan's* C1 as well as the spec's §5.2, since the spec's own fix was also insufficient.

- [ ] **Step 4: Write the corrections back into the spec**

Add **§18 Revision history — 2026-09-03, after implementation review** to `2026-09-03-event-egress-design.md`, in the same table form §17 uses, covering C1–C5 and the smaller corrections. Then fix the sections themselves, or the document contradicts its own revision table:

- §2.1 — `cursor_seq` becomes `cursor_xmin` + `cursor_seq` as one keyset; state the invariant.
- §5.2 — replace the horizon paragraph with the keyset rule and both counterexamples.
- §1.2 — B inherits the keyset, not the horizon scan.
- §4.2/§4.5 — add the anonymous case for a public `document.downloaded`, and name `document_file` as its subject.
- §5.4 — `coalesce(last_success_at, created_at)`.
- §7.1 — boot behaviour is a delivery halt, not an exit; say why.
- §11 — the role gate follows `/admin/audit`; add the `ADMIN_SECTIONS` half.
- §12 — `EVENT_EGRESS_ENABLED` is the config schema's first boolean; `RUN_JOBS` is not the precedent.
- §16 — add the three new residuals: the frozen-`xmin` case, the endpoint-creation and skip-backlog cursor jumps, and the sequential window scan with the row-count threshold at which to bound it.

- [ ] **Step 5: Verify the docs build and commit**

Run: `pnpm lint`
Expected: PASS (prettier formats markdown in this repo).

```bash
pnpm format
git add docs
git commit -m "docs(egress): document event egress and correct the design's watermark"
```

---

### Task 15: Full verification

- [ ] **Step 1: Run the whole suite from a clean state**

```bash
pnpm dev:up
pnpm lint && pnpm check && pnpm build
pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: PASS throughout. Paste the actual output into the completion note — evidence before assertions.

- [ ] **Step 2: Prove the build needs no environment**

Run: `env -i PATH=$PATH pnpm check && env -i PATH=$PATH pnpm build`
Expected: PASS. This is what proves no module in `egress/` opened a connection or required configuration at import time.

- [ ] **Step 3: Prove egress is off by default**

Run the app with no egress variables set, create an endpoint through the admin UI, emit a matching event, and confirm nothing is delivered and no request leaves the container. `EVENT_EGRESS_ENABLED` defaulting to `false` is the claim a procurement reviewer actually checks, and it should be checked once by hand.

- [ ] **Step 4: Re-read the migration**

Run: `git show --stat HEAD~N -- drizzle` and read `drizzle/0026_*.sql` once more against `src/lib/server/db/schema/egress.ts`. Confirm both partial indexes carry their `WHERE`, both check constraints exist with the same text as the schema file, and `drizzle/meta/` is consistent.

- [ ] **Step 5: Confirm the four guards were watched failing**

Each of these must have been seen red before it was trusted (Task 9 Step 5, Task 10 Step 5, Task 11 Step 6, Task 7 Step 5):

1. The visibility watermark, both counterexamples.
2. A purged subject is `skipped`, not blanked, and no request is made.
3. A day of failures writes exactly one audit event.
4. A markdown payload is escaped by the Teams formatter.

Plus the one that is asserted rather than watched: a hostname resolving to `169.254.169.254` is refused at delivery time, not only on save, and the connection is made to the validated address.

- [ ] **Step 6: Check for the empty-array trap**

Run: `grep -rn 'some(' tests/unit/egress-*.test.ts tests/integration/egress-*.test.ts`

Every assertion of the form `.some(…) === false` (or `expect(x.some(…)).toBe(false)`) must pin the collection's size first — an empty array satisfies such an assertion. This is a trap the OTel branch shipped three times before it was caught.

---

## Self-review

**Spec coverage.** §1 Task 8/12 (the switch) · §2 Task 1 · §3 Tasks 6, 7 · §4.1 Task 2 · §4.2–4.5 Task 6 · §5.1 Tasks 10, 12 · §5.2 Task 9 · §5.3 Tasks 5, 10 · §5.4 Task 11 · §5.5 Tasks 9, 13 · §5.6 Task 12 · §6 Tasks 4, 5 · §7 Tasks 3, 10, 11 · §8 Tasks 6, 14 · §9 Tasks 11, 13 · §9.1 Task 13 · §10 Task 12 · §11 Task 13 · §12 Task 8 · §13 every task · §14 Task 14 · §15 (absences — nothing to build; the "no inbound anything" and "no templating" boundaries are respected by construction, and no task adds either) · §16 Task 14 Step 4.

**Known gaps, stated rather than hidden.**

- §13's spec test list includes "each retry transition" as separate integration cases; Task 10 covers the transitions in one loop plus the terminal-4xx case. That is the same coverage in fewer tests, and the loop asserts every attempt's `status` and `attempts`.
- The spec's §13 asks for a test that a disabled endpoint "neither fans out nor delivers". Fan-out is covered in Task 9; the delivery half is covered by `claimDeliveries`' join on `e.enabled = true` and is asserted only indirectly. **Add an explicit case in Task 10** if the reviewer wants it named: create a disabled endpoint with a pending delivery and assert `claimDeliveries` returns nothing.
- `sendTestEvent` (Task 13) has no automated test beyond the e2e path. Its risky property — that it does not bypass §6.3 — is worth a unit test with a stubbed `lookup`; add one in Task 13 rather than deferring it.

**Type consistency.** `ClaimedDelivery`, `DeliverOptions`, `EnrichOutcome`, `PostOutcome`, `AllowEntry`, `PinnedAddress` and `EventModel` are each defined once, in the task that produces them, and referenced by those exact names afterwards. `matchesPattern(pattern, action)` keeps that argument order at every call site. `currentHorizon(db)` returns `bigint` and every cursor column is `bigint` — `BigInt(...)` conversions happen at the SQL boundary only, because `postgres-js` returns `bigint` columns as strings.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-03-event-egress.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.
