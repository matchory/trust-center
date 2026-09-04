# Audit sink B1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `audit_event` compliance log off-box in batches to S3 with object lock, with a digest per batch and a periodic attestation that makes coverage checkable from the bucket alone.

**Architecture:** A 60-second two-phase job. Phase one, inside the existing advisory lock, reads a window of `audit_event` on the `(xmin, seq)` keyset subsystem A established, builds a canonical NDJSON body, records an `audit_batch` row (which *is* the cursor), then creates and claims shipment rows. Phase two, outside the lock, ships claimed batches through an adapter port. The batch body is never persisted — it is held in memory for the tick and rebuilt from live rows on any later retry.

**Tech Stack:** SvelteKit (Svelte 5 runes) + Drizzle + postgres-js, `aws4fetch` for SigV4, `node:crypto` for SHA-256, Vitest + Testcontainers (Postgres and MinIO).

**Spec:** `docs/superpowers/specs/2026-09-04-audit-sink-design.md` — binding. Read it before Task 1. Where this plan and the spec differ, the "Corrections" section below governs until Task 12 writes them back.

**Scope:** B1 only, per spec §19. The syslog adapter, its TLS configuration, its docs and its tests are **B2** and are out of scope here. The port is still defined with two implementations in mind, and `SINK_NAMES` includes `'syslog'` so B2 adds an adapter rather than a migration.

## Global Constraints

- **Tabs, single quotes, no trailing commas, 100-column print width** (`.prettierrc`). Run `pnpm format` before every commit.
- **Comments explain *why*, naming the failure mode prevented or a spec section** (`spec §4.3`). Match the surrounding density; do not restate code.
- **`getConfig()`, `getDb()`, `getStorage()` are lazy singletons.** Importing any module in this plan must never open a connection or require a configured environment — `pnpm build` runs with an empty environment and CI proves it.
- **Never edit `src/lib/paraglide/`** (generated, gitignored). UI strings go in `messages/de.json` and `messages/en.json`.
- **`audit_event` is append-only.** Nothing in this plan writes, updates or deletes a row in it.
- **The sink writes no audit events** (spec §8) — recording a shipment would create an event needing shipping. No `recordEvent` call appears anywhere in this subsystem.
- **`last_error` holds a value from the closed set only** — never a provider message, never a response body (spec §5.4).
- Defaults, verbatim from spec §11: `AUDIT_SINK_BATCH_ROWS` **1000**, `AUDIT_SINK_BATCH_MAX_AGE` **15 minutes**, `AUDIT_SINK_BATCH_MAX_BYTES` **8 MiB**, `AUDIT_SINK_ATTEST_INTERVAL` **24 hours**, `AUDIT_SINK_ENABLED` **false**.
- `SHIPMENT_CLAIM_LIMIT` = **25**, matching A's `CLAIM_LIMIT` (`src/lib/server/egress/deliver.ts`).
- Tick interval **60_000 ms** (spec §3.1).
- Backoff: exponential from **1 minute**, capped at **1 hour**, with **no attempt ceiling** (spec §5.4).

## Corrections to the spec this plan encodes

Write these back to the spec in Task 12.

- **C1 — `meta` is embedded as `meta::text` verbatim, not re-serialized in JS.** Spec §4.1 asks for recursive key sorting *and* for text-reading to preserve `jsonb` numeric precision. These conflict: `JSON.parse` → sort → `JSON.stringify` converts arbitrary-precision `numeric` to IEEE doubles, which is the exact corruption §4.1 exists to prevent. Postgres `jsonb` already normalizes object key order (by key length, then bytewise) and `meta::text` renders that normalization deterministically, so embedding the text verbatim satisfies both goals. The spec's "belt and braces" re-sort is withdrawn as actively harmful.
- **C2 — `currentHorizon` moves to `src/lib/server/audit/index.ts`**, not a new shared module. That directory already exists and already owns facts about the audit log; a third location would be one more place to look.
- **C3 — the object-lock spike is Task 1 of this plan**, not a prerequisite completed before planning. Its findings gate Task 7 only; Tasks 2–6 do not depend on them.
- **C4 — the attestation is written by phase two, not phase one.** Spec §3.4 says "the reader writes" it, but writing it is network I/O and phase one runs inside the advisory lock, which spec §3.1 forbids holding across the network. Phase one decides whether one is *due* and records the intent; phase two writes it.

---

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `src/lib/server/db/schema/auditsink.ts` | `audit_batch`, `audit_batch_shipment`, `SINK_NAMES`, `SHIPMENT_ERROR_REASONS` |
| `drizzle/0028_audit_sink.sql` | The two tables, their append-only triggers, the monotonicity trigger |
| `src/lib/server/auditsink/serialize.ts` | `AUDIT_COLUMNS`, canonical NDJSON, digest, manifest. Pure. |
| `src/lib/server/auditsink/reader.ts` | The keyset window and the batch-build rules |
| `src/lib/server/auditsink/ship.ts` | Shipment-row creation, claiming, and the ship loop |
| `src/lib/server/auditsink/port.ts` | `AuditSinkAdapter`, `SinkBatch`, `Attestation`, `SinkError` |
| `src/lib/server/auditsink/s3.ts` | The S3 adapter over `aws4fetch` |
| `src/lib/server/auditsink/attest.ts` | Attestation payload construction and due-check |
| `src/lib/server/auditsink/index.ts` | `runAuditSinkBatch` / `runAuditSinkShip`, the two job phases |
| `tests/unit/auditsink-serialize.test.ts` | Serialization, digest, manifest |
| `tests/unit/auditsink-reason.test.ts` | §5.4's decision procedure |
| `tests/unit/auditsink-s3.test.ts` | Key layout and request shape, against a `fetch` double |
| `tests/integration/auditsink-reader.test.ts` | Keyset, batch-build rules, cursor, triggers |
| `tests/integration/auditsink-ship.test.ts` | Claiming, ordering, isolation, purge behaviours |
| `tests/integration/auditsink-s3.test.ts` | The adapter against MinIO |
| `tests/helpers/auditsink.ts` | Fixtures |

**Modified:** `src/lib/server/audit/index.ts` (C2), `src/lib/server/egress/fanout.ts` (import moves), `src/lib/server/db/schema/index.ts`, `src/lib/server/config/parse.ts`, `src/lib/server/jobs/index.ts`, `src/lib/server/telemetry/metrics.ts`, `src/lib/server/telemetry/provider.ts`, `src/lib/server/telemetry/index.ts`, `src/routes/(admin)/admin/settings/integrations/+page.server.ts` and `+page.svelte`, `messages/{de,en}.json`, `docs/self-hosting.md`, `src/lib/server/purge.ts`, `vitest.integration.config.ts` (MinIO container).

---

## Task 1: The object-lock spike

**Files:**
- Create: `docs/superpowers/specs/2026-09-04-audit-sink-spike.md`
- Modify: `docs/superpowers/specs/2026-09-04-audit-sink-design.md` (Sources, and §16 if a premise fails)

**Interfaces:**
- Consumes: nothing.
- Produces: a findings document. Task 7 reads it before implementing the adapter.

This task writes **no production code**. Spec §19 records two unverified premises under a document marked "Approved design", and both are cheap to check now and expensive in week three.

- [ ] **Step 1: Start MinIO with object lock enabled**

Object lock can only be enabled at bucket creation, and MinIO requires versioning with it.

```bash
docker run -d --name sink-spike -p 9000:9000 \
  -e MINIO_ROOT_USER=spike -e MINIO_ROOT_PASSWORD=spikespike \
  quay.io/minio/minio:latest server /data
sleep 3
docker run --rm --network host --entrypoint sh quay.io/minio/mc:latest -c "
  mc alias set s http://127.0.0.1:9000 spike spikespike &&
  mc mb --with-lock s/audit &&
  mc retention set --default governance 1d s/audit &&
  mc retention info --default s/audit"
```

Expected: the retention info reports `governance` with a 1-day default.

- [ ] **Step 2: Answer premise one — does a PUT to an existing key add a version, or is it refused?**

Spec §5.2 depends on a retry re-PUTting a deterministic key. If that is refused under lock, every retry after a crash fails permanently and the adapter needs a different key strategy.

```bash
docker run --rm --network host --entrypoint sh quay.io/minio/mc:latest -c "
  mc alias set s http://127.0.0.1:9000 spike spikespike &&
  echo 'first'  | mc pipe s/audit/batch-1.ndjson &&
  echo 'second' | mc pipe s/audit/batch-1.ndjson &&
  mc ls --versions s/audit/batch-1.ndjson &&
  mc cat s/audit/batch-1.ndjson"
```

Record: whether the second PUT succeeded, how many versions exist, and which content the unversioned read returns.

- [ ] **Step 3: Answer premise two — can a governance-mode object be deleted without the bypass permission, and with it?**

Spec §6.1 rests on the operator retaining a discharge mechanism under governance mode. If governance behaves like compliance here, §6's default is wrong.

```bash
docker run --rm --network host --entrypoint sh quay.io/minio/mc:latest -c "
  mc alias set s http://127.0.0.1:9000 spike spikespike &&
  mc rm --versions s/audit/batch-1.ndjson 2>&1 | head -3;
  echo '--- with bypass ---';
  mc rm --versions --bypass s/audit/batch-1.ndjson 2>&1 | head -3"
```

Record both outcomes verbatim.

- [ ] **Step 4: Write the findings document**

Create `docs/superpowers/specs/2026-09-04-audit-sink-spike.md` with, for each premise: the command run, the raw output, and a one-line verdict — **holds** / **fails** / **differs on MinIO**. Where a premise fails, state what the adapter must do instead. Do not soften a failure into a caveat.

- [ ] **Step 5: Amend the design document**

Replace the Sources bullet reading "must be verified against a real bucket and MinIO before implementation" with the verdicts and a link to the findings. If either premise failed, add a §16 residual and adjust §5.2 — and stop, reporting to the human before Task 2.

- [ ] **Step 6: Tear down and commit**

```bash
docker rm -f sink-spike
pnpm format
git add docs/superpowers/specs/
git commit -m "docs(auditsink): verify the object-lock premises against MinIO"
```

---

## Task 2: Move `currentHorizon` into the audit module

**Files:**
- Modify: `src/lib/server/audit/index.ts`, `src/lib/server/egress/fanout.ts`
- Test: `tests/integration/egress-fanout.test.ts` (existing, must still pass)

**Interfaces:**
- Consumes: nothing.
- Produces: `currentHorizon(db: Db): Promise<bigint>`, exported from `src/lib/server/audit`. Tasks 5 and 8 import it from there. `src/lib/server/egress/fanout.ts` **no longer exports it**.

Spec §1.1: B must not import from `egress/`, and duplicating the horizon query would be two implementations of one invariant.

- [ ] **Step 1: Move the function and its docstring verbatim**

Cut `currentHorizon` from `src/lib/server/egress/fanout.ts` — the whole function *and* its docstring, which explains the `xid8`/`xid` epoch limitation and must not be summarised — and paste it into `src/lib/server/audit/index.ts`. Add above it:

```ts
// Lives here rather than in egress/ because subsystems A and B both consume
// the audit log and both need the same answer to "which rows are final".
// A second copy would be two implementations of one invariant (audit sink
// spec §1.1).
```

In `fanout.ts`, import it: `import { currentHorizon } from '../audit';` and delete the now-unused `sql` import only if nothing else in the file uses it.

- [ ] **Step 2: Verify nothing else imported it from the old path**

Run: `grep -rn "currentHorizon" src tests`
Expected: definition in `audit/index.ts`, import in `fanout.ts`, and any test import updated to `../../src/lib/server/audit`.

- [ ] **Step 3: Run the affected suites**

Run: `pnpm check && pnpm test:integration tests/integration/egress-fanout.test.ts`
Expected: check 0 errors; fanout tests all pass. This is a pure move — a failure means something was changed, not moved.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add src/lib/server/audit/index.ts src/lib/server/egress/fanout.ts tests
git commit -m "refactor(audit): move currentHorizon out of egress, for B to share"
```

---

## Task 3: Schema and migration

**Files:**
- Create: `src/lib/server/db/schema/auditsink.ts`, `drizzle/0028_audit_sink.sql`
- Modify: `src/lib/server/db/schema/index.ts`
- Test: `tests/integration/auditsink-reader.test.ts` (trigger cases only in this task)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `auditBatch`, `auditBatchShipment` (Drizzle tables)
  - `SINK_NAMES: readonly ['s3', 'syslog']`, `type SinkName`
  - `SHIPMENT_ERROR_REASONS: readonly [...]`, `type ShipmentErrorReason`

- [ ] **Step 1: Write the schema module**

Create `src/lib/server/db/schema/auditsink.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
	bigint,
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
 * Both sinks are declared here although B1 implements only S3: adding the
 * syslog adapter in B2 must be an adapter, not a migration (spec §19).
 */
export const SINK_NAMES = ['s3', 'syslog'] as const;
export type SinkName = (typeof SINK_NAMES)[number];

/**
 * The closed set `last_error` may hold, assigned by the first matching rule in
 * spec §5.4. Never a provider message: the mail queue stores raw SMTP text and
 * it survives both a purge and the retention window (issue #11), which is the
 * failure this set exists to avoid.
 */
export const SHIPMENT_ERROR_REASONS = [
	'config',
	'tls',
	'timeout',
	'network',
	'auth',
	'permission',
	'not_found',
	'http_status'
] as const;
export type ShipmentErrorReason = (typeof SHIPMENT_ERROR_REASONS)[number];

/**
 * A batch of audit events, and the reader's cursor: the position is the
 * greatest `(cursor_xmin, cursor_seq)` in this table, so a crash between
 * "batch written" and "batch shipped" cannot leave the cursor ahead of any
 * batch (spec §2.1).
 *
 * `prev_cursor_*` is stored rather than derived because the rebuild on retry
 * needs the batch's exact range, and deriving it from "the previous row by
 * cursor order" would silently produce a different range after any anomaly
 * (spec §4.3).
 *
 * No `body` column, deliberately: persisting it would put ip, ua and actor_id
 * at rest in a second place purgeRequester does not clear (spec §2.3).
 */
export const auditBatch = pgTable(
	'audit_batch',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		cursorXmin: bigint('cursor_xmin', { mode: 'bigint' }).notNull(),
		cursorSeq: bigint('cursor_seq', { mode: 'bigint' }).notNull(),
		prevCursorXmin: bigint('prev_cursor_xmin', { mode: 'bigint' }).notNull(),
		prevCursorSeq: bigint('prev_cursor_seq', { mode: 'bigint' }).notNull(),
		rowCount: integer('row_count').notNull(),
		minSeq: bigint('min_seq', { mode: 'bigint' }).notNull(),
		maxSeq: bigint('max_seq', { mode: 'bigint' }).notNull(),
		byteCount: integer('byte_count').notNull(),
		digest: text('digest').notNull()
	},
	(table) => [
		unique('audit_batch_cursor_key').on(table.cursorXmin, table.cursorSeq),
		index('audit_batch_created_idx').on(table.createdAt)
	]
);

/** One row per (batch, sink). Pending until `shipped_at` is set — there is no
 * terminal failure state, because B may not give up (spec §2.2). */
export const auditBatchShipment = pgTable(
	'audit_batch_shipment',
	{
		batchId: uuid('batch_id')
			.notNull()
			.references(() => auditBatch.id),
		sink: text('sink').notNull(),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
		lastError: text('last_error'),
		lastStatusCode: integer('last_status_code'),
		shippedAt: timestamp('shipped_at', { withTimezone: true }),
		objectKey: text('object_key'),
		digest: text('digest')
	},
	(table) => [
		primaryKey({ columns: [table.batchId, table.sink] }),
		// The claim predicate, partial for the reason outbound_email_claim_idx is:
		// the index stays small as shipped rows accumulate forever (spec §12).
		index('audit_batch_shipment_claim_idx')
			.on(table.sink, table.nextAttemptAt)
			.where(sql`${table.shippedAt} IS NULL`)
	]
);
```

- [ ] **Step 2: Export from the barrel**

Append `export * from './auditsink';` to `src/lib/server/db/schema/index.ts`.

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`
Expected: `drizzle/0028_*.sql` created. **Read it before continuing** — CLAUDE.md requires this, and Task 1 of the egress plan hit a drizzle-kit BigInt serialization bug in exactly this position. Rename the file to `drizzle/0028_audit_sink.sql` only if drizzle-kit did not already name it usefully; if you rename it, update `drizzle/meta/_journal.json` to match.

- [ ] **Step 4: Hand-extend the migration with the triggers**

Append to the generated SQL. These cannot be expressed in Drizzle, exactly as `drizzle/0003` and `0004` could not:

```sql
--> statement-breakpoint
-- Spec §2.1: the batch table is the cursor, which makes it a control surface
-- as well as evidence. One forged INSERT with a high cursor would silently
-- skip a window of the audit log. These triggers raise the cost; the
-- attestation object (§3.4) is what survives an actor who can drop them.
CREATE FUNCTION "audit_batch_forbid_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_batch is append-only';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_forbid_change"
	BEFORE UPDATE OR DELETE ON "audit_batch"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_batch_forbid_change"();--> statement-breakpoint

CREATE FUNCTION "audit_batch_forbid_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_batch is append-only: the table cannot be truncated';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_forbid_truncate"
	BEFORE TRUNCATE ON "audit_batch"
	FOR EACH STATEMENT
	EXECUTE FUNCTION "audit_batch_forbid_truncate"();--> statement-breakpoint

-- Spec §2.1, §2.4: a new batch must continue the chain. This is what turns a
-- restore, an xid wraparound or a forged row into a loud failure instead of a
-- silently skipped window — and it is why re-seeding after a restore is an
-- INSERT that moves forward, never a DELETE (spec §12).
CREATE FUNCTION "audit_batch_require_monotonic"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	max_xmin bigint;
	max_seq bigint;
BEGIN
	SELECT b."cursor_xmin", b."cursor_seq" INTO max_xmin, max_seq
	FROM "audit_batch" b
	ORDER BY b."cursor_xmin" DESC, b."cursor_seq" DESC
	LIMIT 1;

	IF max_xmin IS NULL THEN
		max_xmin := 0;
		max_seq := 0;
	END IF;

	IF (NEW."prev_cursor_xmin", NEW."prev_cursor_seq") IS DISTINCT FROM (max_xmin, max_seq) THEN
		RAISE EXCEPTION 'audit_batch cursor chain broken: prev (%,%) does not match current head (%,%)',
			NEW."prev_cursor_xmin", NEW."prev_cursor_seq", max_xmin, max_seq;
	END IF;

	IF (NEW."cursor_xmin", NEW."cursor_seq") <= (max_xmin, max_seq) THEN
		RAISE EXCEPTION 'audit_batch cursor must advance: (%,%) is not above (%,%)',
			NEW."cursor_xmin", NEW."cursor_seq", max_xmin, max_seq;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_require_monotonic"
	BEFORE INSERT ON "audit_batch"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_batch_require_monotonic"();--> statement-breakpoint

-- Shipments record progress, so UPDATE is permitted — but only of the progress
-- columns, and the row may never be removed.
CREATE FUNCTION "audit_batch_shipment_forbid_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'audit_batch_shipment is append-only';
	END IF;

	IF NEW."batch_id" IS DISTINCT FROM OLD."batch_id"
		OR NEW."sink" IS DISTINCT FROM OLD."sink"
	THEN
		RAISE EXCEPTION 'audit_batch_shipment identity may not change';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_shipment_forbid_rewrite"
	BEFORE UPDATE OR DELETE ON "audit_batch_shipment"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_batch_shipment_forbid_rewrite"();
```

- [ ] **Step 5: Write the trigger tests**

Create `tests/integration/auditsink-reader.test.ts` with the header block copied from `tests/integration/egress-fanout.test.ts` (the `beforeAll`/`afterAll` `createDb` dance), then:

```ts
describe('audit_batch is append-only and monotonic', () => {
	it('rejects a batch whose prev cursor does not match the head', async () => {
		await db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }));

		await expect(
			db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [20n, 1n] }))
		).rejects.toThrow(/cursor chain broken/);
	});

	it('rejects a batch whose cursor does not advance', async () => {
		await db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }));

		await expect(
			db.insert(auditBatch).values(batchRow({ prev: [10n, 5n], cursor: [10n, 5n] }))
		).rejects.toThrow(/cursor must advance/);
	});

	it('accepts a forward re-seed after a restore', async () => {
		await db.insert(auditBatch).values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }));

		await db
			.insert(auditBatch)
			.values(batchRow({ prev: [10n, 5n], cursor: [99_999n, 0n], rowCount: 0 }));

		const [head] = await db
			.select({ xmin: auditBatch.cursorXmin })
			.from(auditBatch)
			.orderBy(desc(auditBatch.cursorXmin), desc(auditBatch.cursorSeq))
			.limit(1);
		expect(head!.xmin).toBe(99_999n);
	});

	it('refuses UPDATE and DELETE', async () => {
		const [row] = await db
			.insert(auditBatch)
			.values(batchRow({ prev: [0n, 0n], cursor: [10n, 5n] }))
			.returning({ id: auditBatch.id });

		await expect(
			db.update(auditBatch).set({ rowCount: 99 }).where(eq(auditBatch.id, row!.id))
		).rejects.toThrow(/append-only/);
		await expect(db.delete(auditBatch).where(eq(auditBatch.id, row!.id))).rejects.toThrow(
			/append-only/
		);
	});
});
```

Add `batchRow` to `tests/helpers/auditsink.ts`:

```ts
import type { InferInsertModel } from 'drizzle-orm';
import { auditBatch } from '../../src/lib/server/db/schema';

export function batchRow(input: {
	prev: [bigint, bigint];
	cursor: [bigint, bigint];
	rowCount?: number;
}): InferInsertModel<typeof auditBatch> {
	return {
		prevCursorXmin: input.prev[0],
		prevCursorSeq: input.prev[1],
		cursorXmin: input.cursor[0],
		cursorSeq: input.cursor[1],
		rowCount: input.rowCount ?? 1,
		minSeq: 1n,
		maxSeq: 1n,
		byteCount: 10,
		digest: 'x'.repeat(64)
	};
}
```

Each test must start from an empty `audit_batch`. Because the table refuses DELETE, `beforeEach` cannot clean it — use `TRUNCATE`… which the trigger also refuses. **Use a savepoint-free per-test transaction rollback instead**: wrap each test body in `await db.transaction(async (tx) => { … throw new Rollback(); })`, or drop and recreate the two tables in `beforeEach` via raw SQL. Prefer the latter for clarity; the triggers are recreated by re-running the migration statements, so keep them in a helper the test imports.

- [ ] **Step 6: Run the tests**

Run: `pnpm test:integration tests/integration/auditsink-reader.test.ts`
Expected: PASS. If the monotonic trigger's tuple comparison misbehaves, check that both sides are `bigint` — a `text` comparison would order `(9, …)` above `(10, …)`.

- [ ] **Step 7: Verify the migration runs from empty**

Run: `pnpm db:generate` again.
Expected: "No schema changes" — if it wants to generate another migration, the snapshot in `drizzle/meta/` disagrees with the hand-edits and must be reconciled before committing.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add src/lib/server/db/schema drizzle tests
git commit -m "feat(auditsink): the batch and shipment tables, append-only and monotonic"
```

---

## Task 4: Canonical serialization, digest and manifest

**Files:**
- Create: `src/lib/server/auditsink/serialize.ts`, `tests/unit/auditsink-serialize.test.ts`

**Interfaces:**
- Consumes: nothing (pure module; no database, no config).
- Produces:
  - `AUDIT_COLUMNS: readonly string[]` — the twelve column names in declared order
  - `AUDIT_SELECT: string` — the SQL select list reading every column as text
  - `interface AuditRowText` — twelve `string | null` fields, snake_case, as returned by `AUDIT_SELECT`
  - `serializeBatch(rows: readonly AuditRowText[]): { body: Uint8Array; digest: string }`
  - `interface BatchManifest` and `buildManifest(input: ManifestInput): BatchManifest`
  - `SERIALIZATION_VERSION = 1`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import {
	AUDIT_COLUMNS,
	SERIALIZATION_VERSION,
	buildManifest,
	serializeBatch
} from '../../src/lib/server/auditsink/serialize';
import type { AuditRowText } from '../../src/lib/server/auditsink/serialize';

function row(overrides: Partial<AuditRowText> = {}): AuditRowText {
	return {
		id: '00000000-0000-4000-8000-000000000001',
		seq: '42',
		at: '2026-09-04T12:00:00.123456Z',
		actor_type: 'staff',
		actor_id: 'staff-1',
		action: 'document.published',
		subject_type: 'document',
		subject_id: 'doc-1',
		ip: null,
		ua: null,
		request_id: 'req-1',
		meta: '{"a": 1}',
		...overrides
	};
}

describe('serializeBatch', () => {
	it('emits one LF-terminated JSON object per row, keys in declared order', () => {
		const { body } = serializeBatch([row()]);
		const text = new TextDecoder().decode(body);

		expect(text.endsWith('\n')).toBe(true);
		expect(text.trimEnd().split('\n')).toHaveLength(1);
		expect(Object.keys(JSON.parse(text))).toEqual([...AUDIT_COLUMNS]);
	});

	it('embeds meta verbatim, preserving a numeric that exceeds 2^53', () => {
		// Plan correction C1: JSON.parse -> stringify would render this
		// 12345678901234567000. jsonb already normalizes key order, so the text
		// is both deterministic and exact.
		const big = '{"n": 12345678901234567890}';
		const { body } = serializeBatch([row({ meta: big })]);

		expect(new TextDecoder().decode(body)).toContain('12345678901234567890');
	});

	it('preserves microsecond precision in `at`', () => {
		const { body } = serializeBatch([row({ at: '2026-09-04T12:00:00.123456Z' })]);
		expect(new TextDecoder().decode(body)).toContain('12:00:00.123456Z');
	});

	it('emits seq as a JSON number, not a string', () => {
		const { body } = serializeBatch([row({ seq: '42' })]);
		expect(new TextDecoder().decode(body)).toContain('"seq":42');
	});

	it('emits a null column as JSON null', () => {
		const { body } = serializeBatch([row({ ip: null, meta: null })]);
		const parsed = JSON.parse(new TextDecoder().decode(body));
		expect(parsed.ip).toBeNull();
		expect(parsed.meta).toBeNull();
	});

	it('is byte-identical for the same rows and differs when one byte changes', () => {
		const a = serializeBatch([row(), row({ seq: '43' })]);
		const b = serializeBatch([row(), row({ seq: '43' })]);
		const c = serializeBatch([row(), row({ seq: '44' })]);

		expect(a.digest).toBe(b.digest);
		expect(a.digest).not.toBe(c.digest);
		expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('digests exactly the bytes of the body, so sha256sum reproduces it', async () => {
		const { body, digest } = serializeBatch([row()]);
		const expected = Buffer.from(
			await crypto.subtle.digest('SHA-256', body as unknown as ArrayBuffer)
		).toString('hex');

		expect(digest).toBe(expected);
	});
});

describe('buildManifest', () => {
	it('carries both cursor positions, the counts and the digest', () => {
		const manifest = buildManifest({
			id: 'batch-1',
			createdAt: '2026-09-04T12:00:00.000000Z',
			prevCursor: { xmin: 10n, seq: 5n },
			cursor: { xmin: 20n, seq: 9n },
			rowCount: 2,
			minSeq: 5n,
			maxSeq: 9n,
			byteCount: 400,
			digest: 'a'.repeat(64)
		});

		expect(manifest.version).toBe(SERIALIZATION_VERSION);
		expect(manifest.cursor).toEqual({ xmin: '20', seq: '9' });
		expect(manifest.prev_cursor).toEqual({ xmin: '10', seq: '5' });
		expect(manifest.digest_algorithm).toBe('sha256');
		expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit tests/unit/auditsink-serialize.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/server/auditsink/serialize`.

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto';

/** Bumped when AUDIT_COLUMNS changes, so historical objects stay unambiguous. */
export const SERIALIZATION_VERSION = 1;

/**
 * Every column of audit_event, in the order the wire format emits them.
 *
 * An explicit list rather than reflection over the row: adding a column to
 * audit_event must be a deliberate format-version bump, not a silent change to
 * every future digest (spec §4.1). The drift test in
 * tests/integration/auditsink-reader.test.ts fails if this disagrees with the
 * table.
 */
export const AUDIT_COLUMNS = [
	'id',
	'seq',
	'at',
	'actor_type',
	'actor_id',
	'action',
	'subject_type',
	'subject_id',
	'ip',
	'ua',
	'request_id',
	'meta'
] as const;

/**
 * Every value read as text, never through the driver's types (spec §4.1):
 * postgres-js hands back a millisecond-precision Date for a microsecond
 * timestamptz, parses jsonb numerics into IEEE doubles, and returns seq as a
 * string that JSON.stringify would throw on if it were a BigInt.
 */
export const AUDIT_SELECT = `
	id::text AS id,
	seq::text AS seq,
	to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
	actor_type, actor_id, action, subject_type, subject_id, ip, ua, request_id,
	meta::text AS meta
`;

export interface AuditRowText {
	id: string;
	seq: string;
	at: string;
	actor_type: string;
	actor_id: string | null;
	action: string;
	subject_type: string | null;
	subject_id: string | null;
	ip: string | null;
	ua: string | null;
	request_id: string | null;
	meta: string | null;
}

/**
 * One line per row: keys in AUDIT_COLUMNS order, no insignificant whitespace,
 * LF-terminated, UTF-8.
 *
 * `meta` is spliced in as raw text rather than re-serialized (plan C1). Round
 * tripping it through JSON.parse would convert an arbitrary-precision jsonb
 * numeric to a double — the corruption §4.1 exists to prevent — and jsonb's own
 * key normalization already makes the text deterministic.
 */
export function serializeBatch(rows: readonly AuditRowText[]): {
	body: Uint8Array;
	digest: string;
} {
	const lines = rows.map((row) => {
		const fields = AUDIT_COLUMNS.map((column) => {
			if (column === 'meta') return `"meta":${row.meta ?? 'null'}`;
			if (column === 'seq') return `"seq":${Number(row.seq)}`;

			const value = row[column] as string | null;
			return `${JSON.stringify(column)}:${value === null ? 'null' : JSON.stringify(value)}`;
		});

		return `{${fields.join(',')}}`;
	});

	const body = new TextEncoder().encode(lines.length === 0 ? '' : `${lines.join('\n')}\n`);

	return { body, digest: createHash('sha256').update(body).digest('hex') };
}

export interface BatchManifest {
	version: number;
	batch_id: string;
	created_at: string;
	prev_cursor: { xmin: string; seq: string };
	cursor: { xmin: string; seq: string };
	row_count: number;
	min_seq: string;
	max_seq: string;
	byte_count: number;
	digest: string;
	digest_algorithm: 'sha256';
}

export interface ManifestInput {
	id: string;
	createdAt: string;
	prevCursor: { xmin: bigint; seq: bigint };
	cursor: { xmin: bigint; seq: bigint };
	rowCount: number;
	minSeq: bigint;
	maxSeq: bigint;
	byteCount: number;
	digest: string;
}

/** Cursors and seqs are strings: they are bigints, and a JSON number would be
 * a lie above 2^53 in a document an auditor may parse with any tool. */
export function buildManifest(input: ManifestInput): BatchManifest {
	return {
		version: SERIALIZATION_VERSION,
		batch_id: input.id,
		created_at: input.createdAt,
		prev_cursor: { xmin: String(input.prevCursor.xmin), seq: String(input.prevCursor.seq) },
		cursor: { xmin: String(input.cursor.xmin), seq: String(input.cursor.seq) },
		row_count: input.rowCount,
		min_seq: String(input.minSeq),
		max_seq: String(input.maxSeq),
		byte_count: input.byteCount,
		digest: input.digest,
		digest_algorithm: 'sha256'
	};
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:unit tests/unit/auditsink-serialize.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the fidelity tests can fail**

Change `"meta":${row.meta ?? 'null'}` to `"meta":${JSON.stringify(JSON.parse(row.meta ?? 'null'))}` and re-run. Expected: the 2^53 test FAILS. Restore, `git diff` to confirm the file is clean, and re-run. A fidelity test that cannot fail is decoration.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/auditsink/serialize.ts tests/unit/auditsink-serialize.test.ts
git commit -m "feat(auditsink): canonical NDJSON, digest and manifest"
```

---

## Task 5: The reader

**Files:**
- Create: `src/lib/server/auditsink/reader.ts`
- Modify: `tests/integration/auditsink-reader.test.ts`, `tests/helpers/auditsink.ts`

**Interfaces:**
- Consumes: `currentHorizon` (Task 2); `auditBatch` (Task 3); `AUDIT_SELECT`, `AuditRowText`, `serializeBatch`, `buildManifest` (Task 4).
- Produces:
  - `interface BuiltBatch { id: string; body: Uint8Array; digest: string; manifest: BatchManifest }`
  - `interface ReaderOptions { batchRows: number; maxAgeMs: number; maxBytes: number }`
  - `readCursor(tx: Db): Promise<{ xmin: bigint; seq: bigint }>`
  - `buildBatch(tx: Db, options: ReaderOptions): Promise<BuiltBatch | null>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/auditsink-reader.test.ts`:

```ts
describe('buildBatch', () => {
	const options = { batchRows: 1000, maxAgeMs: 15 * 60_000, maxBytes: 8 * 1024 * 1024 };

	it('returns null when the window is empty', async () => {
		await seedCursorAtHorizon(db);
		expect(await buildBatch(db, options)).toBeNull();
	});

	it('builds nothing until the window fills or ages', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system' }, action: 'test.one' });

		// Two rows, a limit of 1000, and nothing old enough yet.
		expect(await buildBatch(db, { ...options, maxAgeMs: 60 * 60_000 })).toBeNull();
	});

	it('builds when the row limit is reached', async () => {
		await seedCursorAtHorizon(db);
		for (let i = 0; i < 3; i++) {
			await recordEvent(db, { actor: { type: 'system' }, action: `test.${i}` });
		}

		const batch = await buildBatch(db, { ...options, batchRows: 3, maxAgeMs: 60 * 60_000 });
		expect(batch?.manifest.row_count).toBe(3);
	});

	it('builds when the oldest unbatched row is older than maxAge', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system' }, action: 'test.aged' });

		const batch = await buildBatch(db, { ...options, maxAgeMs: 0 });
		expect(batch?.manifest.row_count).toBe(1);
	});

	it('advances the cursor to the last row of the window, not max(seq)', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system' }, action: 'test.a' });
		const batch = await buildBatch(db, { ...options, maxAgeMs: 0 });

		const [head] = await db
			.select({ xmin: auditBatch.cursorXmin, seq: auditBatch.cursorSeq })
			.from(auditBatch)
			.orderBy(desc(auditBatch.cursorXmin), desc(auditBatch.cursorSeq))
			.limit(1);

		expect(String(head!.seq)).toBe(batch!.manifest.cursor.seq);
	});

	it('does not re-read a row the previous batch consumed', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system' }, action: 'test.first' });
		await buildBatch(db, { ...options, maxAgeMs: 0 });

		expect(await buildBatch(db, { ...options, maxAgeMs: 0 })).toBeNull();
	});

	it('caps the batch by bytes when rows are large', async () => {
		await seedCursorAtHorizon(db);
		for (let i = 0; i < 5; i++) {
			await recordEvent(db, {
				actor: { type: 'system' },
				action: `test.big.${i}`,
				meta: { pad: 'x'.repeat(2000) }
			});
		}

		const batch = await buildBatch(db, { ...options, maxAgeMs: 0, maxBytes: 4000 });
		expect(batch!.manifest.row_count).toBeLessThan(5);
		expect(batch!.manifest.byte_count).toBeLessThanOrEqual(4000);
	});

	it('declares every column of audit_event', async () => {
		const rows = (await db.execute(sql`
			SELECT column_name FROM information_schema.columns
			WHERE table_name = 'audit_event'
		`)) as unknown as { column_name: string }[];

		// Spec §4.1 / §13: a migration adding a column must fail here rather than
		// silently dropping it from every future object. If this fails, add the
		// column to AUDIT_COLUMNS and bump SERIALIZATION_VERSION.
		expect(new Set(rows.map((r) => r.column_name))).toEqual(new Set(AUDIT_COLUMNS));
	});
});
```

Add to `tests/helpers/auditsink.ts`:

```ts
import { sql } from 'drizzle-orm';
import { currentHorizon } from '../../src/lib/server/audit';
import { auditBatch } from '../../src/lib/server/db/schema';
import type { Db } from '../../src/lib/server/db';

/**
 * Puts the cursor at the current horizon so a test starts from "nothing
 * pending" without deleting audit_event rows, which is append-only.
 */
export async function seedCursorAtHorizon(db: Db): Promise<void> {
	const horizon = await currentHorizon(db);
	const [maxSeq] = (await db.execute(
		sql`SELECT coalesce(max(seq), 0)::text AS seq FROM audit_event`
	)) as unknown as { seq: string }[];

	await db.insert(auditBatch).values({
		prevCursorXmin: 0n,
		prevCursorSeq: 0n,
		cursorXmin: horizon,
		cursorSeq: BigInt(maxSeq!.seq),
		rowCount: 0,
		minSeq: 0n,
		maxSeq: 0n,
		byteCount: 0,
		digest: '0'.repeat(64)
	});
}
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:integration tests/integration/auditsink-reader.test.ts`
Expected: FAIL — `buildBatch` is not exported.

- [ ] **Step 3: Implement**

```ts
import { sql } from 'drizzle-orm';
import { currentHorizon } from '../audit';
import { auditBatch } from '../db/schema';
import { AUDIT_SELECT, buildManifest, serializeBatch } from './serialize';
import type { AuditRowText, BatchManifest } from './serialize';
import type { Db } from '../db';

export interface BuiltBatch {
	id: string;
	body: Uint8Array;
	digest: string;
	manifest: BatchManifest;
}

export interface ReaderOptions {
	batchRows: number;
	maxAgeMs: number;
	maxBytes: number;
}

/**
 * The cursor is the greatest (cursor_xmin, cursor_seq) in audit_batch — the
 * batch table IS the cursor (spec §2.1), so there is no state in which the
 * cursor has advanced past rows no batch describes.
 */
export async function readCursor(tx: Db): Promise<{ xmin: bigint; seq: bigint }> {
	const rows = (await tx.execute(sql`
		SELECT cursor_xmin::text AS xmin, cursor_seq::text AS seq
		FROM audit_batch
		ORDER BY cursor_xmin DESC, cursor_seq DESC
		LIMIT 1
	`)) as unknown as { xmin: string; seq: string }[];

	const head = rows[0];
	return head ? { xmin: BigInt(head.xmin), seq: BigInt(head.seq) } : { xmin: 0n, seq: 0n };
}

/**
 * Reads one window and, if it qualifies, records a batch.
 *
 * A batch is built when the window is full, when its oldest row is older than
 * maxAge, or when the body would exceed maxBytes. Without the age rule the row
 * limit is only a maximum: at this system's volume — thousands of audit events
 * a month against a 60-second tick — a batch would hold about one row, which
 * is ~70,000 undeletable objects a year (spec §3.2).
 *
 * The keyset invariant is subsystem A's (A §5.2) and is why this is correct:
 * the cursor is only ever set to a row whose xmin was strictly below the
 * horizon read in this same tick, so every unconsumed row has a key strictly
 * greater than the cursor.
 */
export async function buildBatch(tx: Db, options: ReaderOptions): Promise<BuiltBatch | null> {
	const horizon = await currentHorizon(tx);
	const cursor = await readCursor(tx);

	const window = (await tx.execute(sql`
		SELECT ${sql.raw(AUDIT_SELECT)},
		       xmin::text::bigint AS xmin,
		       (at < now() - make_interval(secs => ${options.maxAgeMs / 1000})) AS aged
		FROM audit_event
		WHERE xmin::text::bigint < ${horizon}
		  AND (xmin::text::bigint, seq) > (${cursor.xmin}, ${cursor.seq})
		ORDER BY xmin::text::bigint, seq
		LIMIT ${options.batchRows}
	`)) as unknown as (AuditRowText & { xmin: string; aged: boolean })[];

	if (window.length === 0) return null;

	// Trim to the byte cap before deciding whether the batch qualifies: meta is
	// unbounded jsonb, so without this the body and the PUT are both unbounded.
	let rows = window;
	let serialized = serializeBatch(rows);

	while (rows.length > 1 && serialized.body.byteLength > options.maxBytes) {
		rows = rows.slice(0, Math.max(1, Math.floor(rows.length / 2)));
		serialized = serializeBatch(rows);
	}

	const full = rows.length >= options.batchRows;
	const aged = rows[0]!.aged;
	const overflowed = rows.length < window.length;

	if (!full && !aged && !overflowed) return null;

	const last = rows[rows.length - 1]!;
	const seqs = rows.map((row) => BigInt(row.seq));

	const [inserted] = await tx
		.insert(auditBatch)
		.values({
			prevCursorXmin: cursor.xmin,
			prevCursorSeq: cursor.seq,
			cursorXmin: BigInt(last.xmin),
			cursorSeq: BigInt(last.seq),
			rowCount: rows.length,
			minSeq: seqs.reduce((a, b) => (b < a ? b : a)),
			maxSeq: seqs.reduce((a, b) => (b > a ? b : a)),
			byteCount: serialized.body.byteLength,
			digest: serialized.digest
		})
		.returning({ id: auditBatch.id, createdAt: auditBatch.createdAt });

	return {
		id: inserted!.id,
		body: serialized.body,
		digest: serialized.digest,
		manifest: buildManifest({
			id: inserted!.id,
			createdAt: inserted!.createdAt.toISOString(),
			prevCursor: cursor,
			cursor: { xmin: BigInt(last.xmin), seq: BigInt(last.seq) },
			rowCount: rows.length,
			minSeq: seqs.reduce((a, b) => (b < a ? b : a)),
			maxSeq: seqs.reduce((a, b) => (b > a ? b : a)),
			byteCount: serialized.body.byteLength,
			digest: serialized.digest
		})
	};
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:integration tests/integration/auditsink-reader.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the keyset test can fail**

Change the window's `WHERE` to `seq > ${cursor.seq}` (dropping the xmin half). Expected: the "does not re-read" test still passes but A's out-of-order-commit case would not — so **also** port A's two keyset failure-mode tests from `tests/integration/egress-fanout.test.ts` into this file, adapted to `buildBatch`, and confirm they fail under this mutation. Restore and `git diff` to verify clean.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/auditsink/reader.ts tests
git commit -m "feat(auditsink): the keyset reader and the batch-build rules"
```

---

## Task 6: The port, shipment rows, claiming and the ship loop

**Files:**
- Create: `src/lib/server/auditsink/port.ts`, `src/lib/server/auditsink/ship.ts`, `tests/integration/auditsink-ship.test.ts`, `tests/unit/auditsink-reason.test.ts`

**Interfaces:**
- Consumes: `auditBatch`, `auditBatchShipment`, `SinkName`, `ShipmentErrorReason` (Task 3); `AUDIT_SELECT`, `serializeBatch`, `buildManifest` (Task 4); `readCursor` (Task 5).
- Produces:
  - `interface SinkBatch { id: string; body: Uint8Array; digest: string; manifest: BatchManifest }`
  - `interface Attestation` and `interface AuditSinkAdapter { name: SinkName; ship(batch: SinkBatch): Promise<void>; attest(a: Attestation): Promise<void> }`
  - `class SinkError extends Error { reason: ShipmentErrorReason; statusCode?: number }`
  - `classifyError(cause: unknown): { reason: ShipmentErrorReason; statusCode?: number }`
  - `claimShipments(tx: Db, sinks: readonly SinkName[], limit: number): Promise<ClaimedShipment[]>`
  - `interface ClaimedShipment { batchId: string; sink: SinkName; attempts: number }`
  - `rebuildBatch(db: Db, batchId: string): Promise<SinkBatch>`
  - `shipClaimed(db, claimed, adapters, prebuilt): Promise<void>`

- [ ] **Step 1: Write `port.ts`**

```ts
import type { BatchManifest } from './serialize';
import type { ShipmentErrorReason, SinkName } from '../db/schema';

export interface SinkBatch {
	id: string;
	body: Uint8Array;
	digest: string;
	manifest: BatchManifest;
}

export interface Attestation {
	at: string;
	event_count: string;
	max_seq: string;
	cursor: { xmin: string; seq: string };
	last_batch_id: string | null;
	batches_since: number;
}

/**
 * An adapter receives bytes and a manifest. It never receives rows, a database
 * handle, or another sink's configuration — that isolation is the reason the
 * port exists, and it is what keeps one sink's failure off another (spec §5.1).
 */
export interface AuditSinkAdapter {
	readonly name: SinkName;
	ship(batch: SinkBatch): Promise<void>;
	attest(attestation: Attestation): Promise<void>;
}

/** Thrown by an adapter so the shipper records a closed-set reason rather than
 * a provider message (spec §5.4, issue #11). */
export class SinkError extends Error {
	constructor(
		readonly reason: ShipmentErrorReason,
		readonly statusCode?: number
	) {
		super(reason);
		this.name = 'SinkError';
	}
}
```

- [ ] **Step 2: Write the failing reason-classification test**

```ts
import { describe, expect, it } from 'vitest';
import { SinkError, classifyError } from '../../src/lib/server/auditsink/ship';

describe('classifyError', () => {
	it('passes a SinkError through unchanged', () => {
		expect(classifyError(new SinkError('auth'))).toEqual({ reason: 'auth', statusCode: undefined });
	});

	it('resolves a 403 to exactly one reason', () => {
		// Spec §5.4: S3 answers 403 for both a bad signature and a denied action.
		// A menu of overlapping labels is not a lookup key, so the rule is
		// first-match and the two cases are distinguished by the error code.
		expect(classifyError(new SinkError('auth', 403)).reason).toBe('auth');
		expect(classifyError(new SinkError('permission', 403)).reason).toBe('permission');
	});

	it('classifies a TLS failure from the cause chain, not the message', () => {
		const cause = Object.assign(new Error('fetch failed'), {
			cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
		});
		expect(classifyError(cause).reason).toBe('tls');
	});

	it('classifies an abort as a timeout', () => {
		expect(classifyError(new DOMException('aborted', 'AbortError')).reason).toBe('timeout');
	});

	it('falls back to network for an unrecognised failure', () => {
		expect(classifyError(new Error('socket hang up')).reason).toBe('network');
	});
});
```

Run: `pnpm test:unit tests/unit/auditsink-reason.test.ts` — expected FAIL, module not found.

- [ ] **Step 3: Write the failing shipment tests**

```ts
describe('claimShipments', () => {
	it('creates a row for every configured sink over every unshipped batch', async () => {
		await seedCursorAtHorizon(db);
		const batch = await insertBatch(db);

		const claimed = await claimShipments(db, ['s3'], 25);

		expect(claimed).toHaveLength(1);
		expect(claimed[0]!.batchId).toBe(batch.id);
	});

	it('gives a sink configured later the full history', async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);
		await insertBatch(db);
		await claimShipments(db, ['s3'], 25);

		// syslog has never run; it must see both batches, with no backfill path.
		const claimed = await claimShipments(db, ['syslog'], 25);
		expect(claimed).toHaveLength(2);
	});

	it('does not re-claim within the stamp window', async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);

		expect(await claimShipments(db, ['s3'], 25)).toHaveLength(1);
		expect(await claimShipments(db, ['s3'], 25)).toHaveLength(0);
	});

	it('bounds a large backlog by the claim limit', async () => {
		await seedCursorAtHorizon(db);
		for (let i = 0; i < 30; i++) await insertBatch(db);

		expect(await claimShipments(db, ['s3'], 25)).toHaveLength(25);
	});

	it('claims in cursor order', async () => {
		await seedCursorAtHorizon(db);
		const first = await insertBatch(db);
		const second = await insertBatch(db);

		const claimed = await claimShipments(db, ['s3'], 25);
		expect(claimed.map((c) => c.batchId)).toEqual([first.id, second.id]);
	});
});

describe('shipClaimed', () => {
	it('records the shipped digest and stops the sink at the first failure', async () => {
		await seedCursorAtHorizon(db);
		const first = await insertBatch(db);
		const second = await insertBatch(db);
		const claimed = await claimShipments(db, ['s3'], 25);

		const adapter = failingAfter(1); // ships the first, throws on the second
		await shipClaimed(db, claimed, [adapter], new Map());

		const rows = await db.select().from(auditBatchShipment);
		const one = rows.find((r) => r.batchId === first.id)!;
		const two = rows.find((r) => r.batchId === second.id)!;

		expect(one.shippedAt).not.toBeNull();
		expect(one.digest).toHaveLength(64);
		expect(two.shippedAt).toBeNull();
		expect(two.attempts).toBe(1);
		expect(two.lastError).toBe('network');
	});

	it("leaves one sink's shipments intact when another fails", async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);
		const claimed = await claimShipments(db, ['s3', 'syslog'], 25);

		await shipClaimed(db, claimed, [alwaysFails('s3'), alwaysSucceeds('syslog')], new Map());

		const rows = await db.select().from(auditBatchShipment);
		expect(rows.find((r) => r.sink === 's3')!.shippedAt).toBeNull();
		expect(rows.find((r) => r.sink === 'syslog')!.shippedAt).not.toBeNull();
	});

	it('backs off exponentially without ever giving up', async () => {
		await seedCursorAtHorizon(db);
		await insertBatch(db);

		for (let attempt = 1; attempt <= 3; attempt++) {
			const claimed = await claimShipments(db, ['s3'], 25);
			if (claimed.length > 0) await shipClaimed(db, claimed, [alwaysFails('s3')], new Map());
			await db
				.update(auditBatchShipment)
				.set({ nextAttemptAt: new Date(Date.now() - 1000) })
				.where(eq(auditBatchShipment.sink, 's3'));
		}

		const [row] = await db.select().from(auditBatchShipment);
		expect(row!.attempts).toBe(3);
		expect(row!.shippedAt).toBeNull(); // never terminal — spec §2.2
	});
});

describe('rebuildBatch', () => {
	it('drops a purged row from the range, so the manifest disagrees on row_count', async () => {
		// Spec §4.3: purgeRequester's UPDATE bumps the row's xmin above every
		// batch cursor, so it leaves the half-open range entirely. This is the
		// mechanism the first draft got wrong, and it is what a digest mismatch
		// actually means.
		await seedCursorAtHorizon(db);
		const { requesterId } = await seedRequesterWithAuditEvent(db);
		const batch = await buildBatch(db, { batchRows: 1000, maxAgeMs: 0, maxBytes: 8e6 });
		expect(batch!.manifest.row_count).toBe(1);

		await purgeRequester(db, { requesterId, storage: nullStorage, actor: { type: 'system' } });

		const rebuilt = await rebuildBatch(db, batch!.id);
		expect(rebuilt.manifest.row_count).toBe(0);
		expect(rebuilt.digest).not.toBe(batch!.digest);
	});
});
```

Add `insertBatch`, `failingAfter`, `alwaysFails`, `alwaysSucceeds`, `seedRequesterWithAuditEvent` and `nullStorage` to `tests/helpers/auditsink.ts`. `insertBatch` must respect the monotonicity trigger — read the current head with `readCursor` and chain from it.

- [ ] **Step 4: Run to verify failure**

Run: `pnpm test:integration tests/integration/auditsink-ship.test.ts`
Expected: FAIL — `claimShipments` not exported.

- [ ] **Step 5: Implement `ship.ts`**

```ts
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { auditBatch, auditBatchShipment } from '../db/schema';
import { AUDIT_SELECT, buildManifest, serializeBatch } from './serialize';
import { SinkError } from './port';
import type { AuditSinkAdapter, SinkBatch } from './port';
import type { AuditRowText } from './serialize';
import type { ShipmentErrorReason, SinkName } from '../db/schema';
import type { Db } from '../db';

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 60 * 60_000;

export interface ClaimedShipment {
	batchId: string;
	sink: SinkName;
	attempts: number;
}

/** Exponential from one minute, capped at an hour, forever — there is no
 * attempt ceiling, because B may not give up (spec §2.2, §5.4). */
export function backoffMs(attempts: number): number {
	return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

/**
 * First matching rule wins (spec §5.4). A list of overlapping labels would not
 * be the lookup key docs/self-hosting.md promises: S3 answers 403 for both a
 * bad signature and a denied action, so the adapter distinguishes them and
 * this function never guesses.
 */
export function classifyError(cause: unknown): {
	reason: ShipmentErrorReason;
	statusCode?: number;
} {
	if (cause instanceof SinkError) return { reason: cause.reason, statusCode: cause.statusCode };
	if (cause instanceof DOMException && cause.name === 'AbortError') return { reason: 'timeout' };

	// fetch reports a TLS failure as a generic TypeError with the real reason in
	// the cause chain. Walking it is what makes `tls` producible at all, rather
	// than a declared reason nothing writes (cf. A §16's body_too_large).
	const code = (cause as { cause?: { code?: string } })?.cause?.code;
	if (typeof code === 'string' && /CERT|SSL|TLS|VERIFY/i.test(code)) return { reason: 'tls' };

	return { reason: 'network' };
}

/**
 * Creates the shipment rows for every configured sink over every unshipped
 * batch, then claims them — both inside the caller's transaction, which runs
 * under the advisory lock.
 *
 * Creation happens HERE and not in the shipper. Creating rows lazily on first
 * attempt would leave the first attempt at every batch unprotected by the claim
 * stamp, so two replicas with overlapping ticks would both ship it. The
 * property that mattered — a sink configured later still gets the full history
 * with no backfill command — is preserved by the INSERT … SELECT.
 */
export async function claimShipments(
	tx: Db,
	sinks: readonly SinkName[],
	limit: number
): Promise<ClaimedShipment[]> {
	if (sinks.length === 0) return [];

	await tx.execute(sql`
		INSERT INTO audit_batch_shipment (batch_id, sink)
		SELECT b.id, s.sink
		FROM audit_batch b
		CROSS JOIN unnest(${sql.param(sinks as string[])}::text[]) AS s(sink)
		WHERE b.row_count > 0
		ON CONFLICT (batch_id, sink) DO NOTHING
	`);

	const claimed = (await tx.execute(sql`
		UPDATE audit_batch_shipment AS s
		SET next_attempt_at = now() + interval '5 minutes'
		FROM (
			SELECT sh.batch_id, sh.sink
			FROM audit_batch_shipment sh
			JOIN audit_batch b ON b.id = sh.batch_id
			WHERE sh.shipped_at IS NULL
			  AND sh.next_attempt_at <= now()
			  AND sh.sink = ANY(${sql.param(sinks as string[])}::text[])
			ORDER BY b.cursor_xmin, b.cursor_seq
			LIMIT ${limit}
			FOR UPDATE OF sh SKIP LOCKED
		) AS due
		WHERE s.batch_id = due.batch_id AND s.sink = due.sink
		RETURNING s.batch_id, s.sink, s.attempts
	`)) as unknown as { batch_id: string; sink: SinkName; attempts: number }[];

	return claimed.map((row) => ({
		batchId: row.batch_id,
		sink: row.sink,
		attempts: Number(row.attempts)
	}));
}

/**
 * Rebuilds a batch's body from live rows over its recorded half-open range.
 *
 * A purge landing between the build and this rebuild removes its row from the
 * range entirely — purgeRequester's UPDATE bumps the row's xmin above every
 * batch cursor — so the rebuilt batch has fewer rows, not the same rows with
 * nulls. That is why the manifest, built here from what is actually sent, is
 * the authority for an object's contents (spec §4.3).
 */
export async function rebuildBatch(db: Db, batchId: string): Promise<SinkBatch> {
	const [meta] = await db.select().from(auditBatch).where(eq(auditBatch.id, batchId)).limit(1);
	if (!meta) throw new SinkError('config');

	const rows = (await db.execute(sql`
		SELECT ${sql.raw(AUDIT_SELECT)}
		FROM audit_event
		WHERE (xmin::text::bigint, seq) > (${meta.prevCursorXmin}, ${meta.prevCursorSeq})
		  AND (xmin::text::bigint, seq) <= (${meta.cursorXmin}, ${meta.cursorSeq})
		ORDER BY xmin::text::bigint, seq
	`)) as unknown as AuditRowText[];

	const { body, digest } = serializeBatch(rows);
	const seqs = rows.map((row) => BigInt(row.seq));

	return {
		id: meta.id,
		body,
		digest,
		manifest: buildManifest({
			id: meta.id,
			createdAt: meta.createdAt.toISOString(),
			prevCursor: { xmin: meta.prevCursorXmin, seq: meta.prevCursorSeq },
			cursor: { xmin: meta.cursorXmin, seq: meta.cursorSeq },
			rowCount: rows.length,
			minSeq: seqs.length > 0 ? seqs.reduce((a, b) => (b < a ? b : a)) : 0n,
			maxSeq: seqs.length > 0 ? seqs.reduce((a, b) => (b > a ? b : a)) : 0n,
			byteCount: body.byteLength,
			digest
		})
	};
}

/**
 * Ships claimed batches, in cursor order within this tick, stopping a sink at
 * its first failure rather than burning the whole backlog against a dead
 * receiver. Across overlapping ticks or replicas ordering is not guaranteed and
 * the claim stamp cannot make it so (spec §5.4).
 *
 * `prebuilt` carries bodies built by phase one of this same tick, so the
 * ordinary path never rebuilds and its digest matches by construction — which
 * is what makes a recorded mismatch mean a genuine retry (spec §4.3).
 */
export async function shipClaimed(
	db: Db,
	claimed: readonly ClaimedShipment[],
	adapters: readonly AuditSinkAdapter[],
	prebuilt: ReadonlyMap<string, SinkBatch>
): Promise<void> {
	const bySink = new Map<SinkName, ClaimedShipment[]>();
	for (const shipment of claimed) {
		const list = bySink.get(shipment.sink) ?? [];
		list.push(shipment);
		bySink.set(shipment.sink, list);
	}

	await Promise.all(
		adapters.map(async (adapter) => {
			for (const shipment of bySink.get(adapter.name) ?? []) {
				const batch = prebuilt.get(shipment.batchId) ?? (await rebuildBatch(db, shipment.batchId));

				try {
					await adapter.ship(batch);

					await db
						.update(auditBatchShipment)
						.set({
							shippedAt: new Date(),
							digest: batch.digest,
							attempts: shipment.attempts + 1,
							lastError: null,
							lastStatusCode: null,
							objectKey: batch.id
						})
						.where(
							and(
								eq(auditBatchShipment.batchId, shipment.batchId),
								eq(auditBatchShipment.sink, adapter.name)
							)
						);
				} catch (cause) {
					const { reason, statusCode } = classifyError(cause);
					const attempts = shipment.attempts + 1;

					await db
						.update(auditBatchShipment)
						.set({
							attempts,
							lastError: reason,
							lastStatusCode: statusCode ?? null,
							nextAttemptAt: new Date(Date.now() + backoffMs(attempts))
						})
						.where(
							and(
								eq(auditBatchShipment.batchId, shipment.batchId),
								eq(auditBatchShipment.sink, adapter.name)
							)
						);

					// Stop this sink for the tick; the others keep going.
					return;
				}
			}
		})
	);
}
```

- [ ] **Step 6: Run both suites**

Run: `pnpm test:unit tests/unit/auditsink-reason.test.ts && pnpm test:integration tests/integration/auditsink-ship.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove the claim stamp is covered**

Issue #8 exists because the mail queue's identical stamp has no test. Delete `SET next_attempt_at = now() + interval '5 minutes'` from the claim statement and re-run. Expected: "does not re-claim within the stamp window" FAILS. Restore, `git diff` clean, re-run.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add src/lib/server/auditsink tests
git commit -m "feat(auditsink): the sink port, shipment claiming and the ship loop"
```

---

## Task 7: The S3 adapter

**Files:**
- Create: `src/lib/server/auditsink/s3.ts`, `tests/unit/auditsink-s3.test.ts`, `tests/integration/auditsink-s3.test.ts`
- Modify: `package.json`, `vitest.integration.config.ts` (or the global setup that starts containers)

**Interfaces:**
- Consumes: `AuditSinkAdapter`, `SinkBatch`, `Attestation`, `SinkError` (Task 6); Task 1's findings.
- Produces: `createS3Adapter(config: S3SinkConfig): AuditSinkAdapter`, `interface S3SinkConfig { bucket; region; endpoint?; accessKeyId; secretAccessKey; prefix? }`, `objectKeys(batchId: string, createdAt: Date, prefix?: string): { body: string; manifest: string }`.

- [ ] **Step 1: Read Task 1's findings first**

Open `docs/superpowers/specs/2026-09-04-audit-sink-spike.md`. If premise one failed — a PUT to an existing key under lock is refused rather than versioned — the deterministic key strategy below is wrong and you must stop and report before implementing.

- [ ] **Step 2: Add the dependency**

```bash
pnpm add aws4fetch@1.0.20
```

Pin the exact version. Verify `pnpm why aws4fetch` reports no transitive dependencies; if it does, stop — the spec chose this package on the strength of having none.

- [ ] **Step 3: Write the failing unit test**

```ts
import { describe, expect, it, vi } from 'vitest';
import { createS3Adapter, objectKeys } from '../../src/lib/server/auditsink/s3';
import { SinkError } from '../../src/lib/server/auditsink/port';

const config = {
	bucket: 'audit',
	region: 'eu-central-1',
	accessKeyId: 'k',
	secretAccessKey: 's',
	prefix: 'tc'
};

function batch() {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		body: new TextEncoder().encode('{"a":1}\n'),
		digest: 'a'.repeat(64),
		manifest: { version: 1, batch_id: '1111' } as never
	};
}

describe('objectKeys', () => {
	it('lays keys out by date under the prefix', () => {
		const keys = objectKeys('batch-1', new Date('2026-09-04T12:00:00Z'), 'tc');
		expect(keys.body).toBe('tc/audit/2026/09/04/batch-1.ndjson');
		expect(keys.manifest).toBe('tc/audit/2026/09/04/batch-1.manifest.json');
	});

	it('omits the prefix segment when none is configured', () => {
		expect(objectKeys('batch-1', new Date('2026-09-04T12:00:00Z')).body).toBe(
			'audit/2026/09/04/batch-1.ndjson'
		);
	});
});

describe('createS3Adapter', () => {
	it('PUTs the body and the manifest, and signs both', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		const adapter = createS3Adapter({ ...config, fetch: fetchMock });

		await adapter.ship(batch());

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [first] = fetchMock.mock.calls[0]!;
		expect((first as Request).method).toBe('PUT');
		expect((first as Request).headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
	});

	it('maps 403 with a signature error code to auth, and a plain 403 to permission', async () => {
		const signature = new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', {
			status: 403
		});
		const denied = new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });

		await expect(
			createS3Adapter({ ...config, fetch: async () => signature }).ship(batch())
		).rejects.toMatchObject({ reason: 'auth' });
		await expect(
			createS3Adapter({ ...config, fetch: async () => denied }).ship(batch())
		).rejects.toMatchObject({ reason: 'permission' });
	});

	it('maps other failures to http_status with the code', async () => {
		const adapter = createS3Adapter({
			...config,
			fetch: async () => new Response('boom', { status: 500 })
		});

		await expect(adapter.ship(batch())).rejects.toMatchObject({
			reason: 'http_status',
			statusCode: 500
		});
	});

	it('never stores a response body on the error', async () => {
		const adapter = createS3Adapter({
			...config,
			fetch: async () => new Response('alice@example.com', { status: 500 })
		});

		// Spec §5.4 / issue #11: a receiver echoing input must not put a
		// requester's address into a column no purge reaches.
		const error = await adapter.ship(batch()).catch((cause: SinkError) => cause);
		expect(JSON.stringify(error)).not.toContain('alice@example.com');
	});
});
```

Run: `pnpm test:unit tests/unit/auditsink-s3.test.ts` — expected FAIL.

- [ ] **Step 4: Implement**

```ts
import { AwsClient } from 'aws4fetch';
import { SinkError } from './port';
import type { AuditSinkAdapter, Attestation, SinkBatch } from './port';

const TIMEOUT_MS = 30_000;

export interface S3SinkConfig {
	bucket: string;
	region: string;
	endpoint?: string;
	accessKeyId: string;
	secretAccessKey: string;
	prefix?: string;
	/** Injected in tests only; production passes nothing and uses global fetch. */
	fetch?: typeof fetch;
}

/** Deterministic from the batch id, so a retry re-PUTs the same key. Under
 * object lock that adds a version rather than replacing one, which is both
 * legal and honest when a purge made the bytes differ (spec §5.2). */
export function objectKeys(
	batchId: string,
	createdAt: Date,
	prefix?: string
): { body: string; manifest: string } {
	const yyyy = createdAt.getUTCFullYear();
	const mm = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(createdAt.getUTCDate()).padStart(2, '0');
	const base = `${prefix ? `${prefix}/` : ''}audit/${yyyy}/${mm}/${dd}/${batchId}`;

	return { body: `${base}.ndjson`, manifest: `${base}.manifest.json` };
}

export function createS3Adapter(config: S3SinkConfig): AuditSinkAdapter {
	const client = new AwsClient({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		service: 's3',
		region: config.region
	});
	const doFetch = config.fetch ?? fetch;
	const origin = config.endpoint
		? `${config.endpoint.replace(/\/$/, '')}/${config.bucket}`
		: `https://${config.bucket}.s3.${config.region}.amazonaws.com`;

	async function put(key: string, body: Uint8Array, contentType: string): Promise<void> {
		const signed = await client.sign(`${origin}/${key}`, {
			method: 'PUT',
			body,
			headers: { 'content-type': contentType }
		});

		const response = await doFetch(signed, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (response.ok) return;

		// The body is read to classify and then discarded — never stored. A
		// receiver that echoes input would otherwise write a requester's details
		// into a column the erasure path does not know about (issue #11).
		const text = await response.text().catch(() => '');

		if (response.status === 401) throw new SinkError('auth', 401);
		if (response.status === 403) {
			throw /Signature|InvalidAccessKeyId|TokenRefreshRequired/.test(text)
				? new SinkError('auth', 403)
				: new SinkError('permission', 403);
		}
		if (response.status === 404) throw new SinkError('not_found', 404);
		throw new SinkError('http_status', response.status);
	}

	return {
		name: 's3',
		async ship(batch: SinkBatch): Promise<void> {
			const createdAt = new Date(batch.manifest.created_at);
			const keys = objectKeys(batch.id, createdAt, config.prefix);

			await put(keys.body, batch.body, 'application/x-ndjson');
			await put(
				keys.manifest,
				new TextEncoder().encode(JSON.stringify(batch.manifest, null, 2)),
				'application/json'
			);
		},
		async attest(attestation: Attestation): Promise<void> {
			const at = new Date(attestation.at);
			const stamp = at.toISOString().replace(/[:.]/g, '-');
			const yyyy = at.getUTCFullYear();
			const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
			const dd = String(at.getUTCDate()).padStart(2, '0');
			const key = `${config.prefix ? `${config.prefix}/` : ''}attest/${yyyy}/${mm}/${dd}/${stamp}.json`;

			await put(
				key,
				new TextEncoder().encode(JSON.stringify(attestation, null, 2)),
				'application/json'
			);
		}
	};
}
```

- [ ] **Step 5: Run the unit tests**

Run: `pnpm test:unit tests/unit/auditsink-s3.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Add MinIO to the integration setup and write the integration test**

Add a MinIO container alongside the Postgres one in the integration global setup, exporting `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY`, `TEST_S3_SECRET_KEY` and a bucket created **with object lock**, mirroring Task 1's `mc mb --with-lock`. Then:

```ts
it('writes both objects, and the digest reproduces from what was stored', async () => {
	const adapter = createS3Adapter(testConfig());
	const batch = { id: randomUUID(), ...serializeBatch([sampleRow()]), manifest: sampleManifest() };

	await adapter.ship(batch);

	const stored = new Uint8Array(await (await fetch(objectUrl(batch.id))).arrayBuffer());
	expect(createHash('sha256').update(stored).digest('hex')).toBe(batch.digest);
});

it('re-PUTs the same key on retry without error', async () => {
	// The premise Task 1 verified: under object lock this adds a version.
	const adapter = createS3Adapter(testConfig());
	const batch = { id: randomUUID(), ...serializeBatch([sampleRow()]), manifest: sampleManifest() };

	await adapter.ship(batch);
	await expect(adapter.ship(batch)).resolves.toBeUndefined();
});

it('reports permission rather than auth when the key cannot write', async () => {
	const adapter = createS3Adapter({ ...testConfig(), bucket: 'does-not-exist' });
	await expect(adapter.ship(sampleBatch())).rejects.toMatchObject({ reason: 'not_found' });
});
```

- [ ] **Step 7: Run the integration test**

Run: `pnpm test:integration tests/integration/auditsink-s3.test.ts`
Expected: PASS. First run pulls the MinIO image; allow time.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add package.json pnpm-lock.yaml src/lib/server/auditsink/s3.ts tests vitest.integration.config.ts
git commit -m "feat(auditsink): the S3 adapter, signed with aws4fetch"
```

---

## Task 8: The attestation

**Files:**
- Create: `src/lib/server/auditsink/attest.ts`
- Modify: `tests/integration/auditsink-ship.test.ts`

**Interfaces:**
- Consumes: `readCursor` (Task 5); `Attestation` (Task 6).
- Produces: `attestationDue(db: Db, intervalMs: number): Promise<boolean>`, `buildAttestation(db: Db): Promise<Attestation>`.

Per correction C4, phase one decides and phase two writes.

- [ ] **Step 1: Write the failing test**

```ts
describe('attestation', () => {
	it('reports the log height and the cursor together', async () => {
		await seedCursorAtHorizon(db);
		await recordEvent(db, { actor: { type: 'system' }, action: 'test.attest' });

		const attestation = await buildAttestation(db);

		const [row] = (await db.execute(
			sql`SELECT count(*)::text AS c, coalesce(max(seq), 0)::text AS m FROM audit_event`
		)) as unknown as { c: string; m: string }[];

		expect(attestation.event_count).toBe(row!.c);
		expect(attestation.max_seq).toBe(row!.m);
		expect(attestation.cursor.seq).toBeDefined();
	});

	it('is due when none has been written within the interval', async () => {
		expect(await attestationDue(db, 24 * 60 * 60_000)).toBe(true);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:integration tests/integration/auditsink-ship.test.ts -t attestation`
Expected: FAIL.

- [ ] **Step 3: Implement**

Track the last attestation time in the existing `setting` table (`src/lib/server/db/schema/setting.ts`) under key `auditsink.attested_at`, rather than adding a third table for one timestamp.

**`setting.value` is `jsonb`, not `text`** — verified against the schema. So the timestamp is stored as a JSON string (`"2026-09-04T…"`, quotes included) and read back with `#>> '{}'`, which extracts a jsonb scalar as text. Writing a bare string or reading with `value::timestamptz` fails.

```ts
import { sql } from 'drizzle-orm';
import { readCursor } from './reader';
import type { Attestation } from './port';
import type { Db } from '../db';

const SETTING_KEY = 'auditsink.attested_at';

/**
 * The attestation exists because the sink is silent in the audit log by
 * design (spec §8), so the log cannot testify that the sink was running.
 * Without a regular series, switching the sink off, deleting rows and
 * switching it back on leaves no trace anywhere (spec §3.4).
 */
export async function attestationDue(db: Db, intervalMs: number): Promise<boolean> {
	// `#>> '{}'` extracts a jsonb scalar as text: the column is jsonb, so the
	// value is a quoted JSON string and `value::timestamptz` would not parse.
	const rows = (await db.execute(sql`
		SELECT value #>> '{}' AS value FROM setting WHERE key = ${SETTING_KEY} LIMIT 1
	`)) as unknown as { value: string }[];

	const last = rows[0] ? Date.parse(rows[0].value) : 0;
	return Number.isNaN(last) || Date.now() - last >= intervalMs;
}

export async function markAttested(db: Db, at: Date): Promise<void> {
	await db.execute(sql`
		INSERT INTO setting (key, value)
		VALUES (${SETTING_KEY}, ${JSON.stringify(at.toISOString())}::jsonb)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
	`);
}

export async function buildAttestation(db: Db): Promise<Attestation> {
	const cursor = await readCursor(db);

	const [height] = (await db.execute(sql`
		SELECT count(*)::text AS event_count, coalesce(max(seq), 0)::text AS max_seq
		FROM audit_event
	`)) as unknown as { event_count: string; max_seq: string }[];

	const [batches] = (await db.execute(sql`
		SELECT count(*)::text AS since, max(id::text) AS last_id
		FROM audit_batch
		WHERE created_at > coalesce(
			(SELECT (value #>> '{}')::timestamptz FROM setting WHERE key = ${SETTING_KEY}),
			'-infinity'::timestamptz
		)
	`)) as unknown as { since: string; last_id: string | null }[];

	return {
		at: new Date().toISOString(),
		event_count: height!.event_count,
		max_seq: height!.max_seq,
		cursor: { xmin: String(cursor.xmin), seq: String(cursor.seq) },
		last_batch_id: batches!.last_id,
		batches_since: Number(batches!.since)
	};
}
```

The `setting` table is `{ key: text primary key, value: jsonb not null, updatedAt }` — verified, no adjustment needed.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:integration tests/integration/auditsink-ship.test.ts -t attestation`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/auditsink/attest.ts tests
git commit -m "feat(auditsink): the periodic attestation object"
```

---

## Task 9: Configuration

**Files:**
- Modify: `src/lib/server/config/parse.ts`
- Test: `tests/unit/config.test.ts` (existing file — read it and follow its `valid` const pattern)

**Interfaces:**
- Consumes: nothing.
- Produces: `AppConfig['auditSink']`:

```ts
auditSink: {
	enabled: boolean;
	batchRows: number;
	maxAgeMs: number;
	maxBytes: number;
	attestIntervalMs: number;
	s3: { bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; prefix?: string } | undefined;
};
```

- [ ] **Step 1: Write the failing tests**

```ts
it('defaults the audit sink to off', () => {
	expect(parseConfig(valid, COMPILED).auditSink.enabled).toBe(false);
});

it('refuses to boot when the sink is enabled with no destination', () => {
	// Spec §11: it would otherwise accumulate batches nothing ships, and mean
	// the operator believes something is running that is not.
	expect(() => parseConfig({ ...valid, AUDIT_SINK_ENABLED: 'true' }, COMPILED)).toThrow(
		/no sink is configured/i
	);
});

it('refuses partial S3 configuration', () => {
	// b67569e's lesson from A: a malformed setting must fail at boot, not inside
	// every tick.
	expect(() =>
		parseConfig(
			{ ...valid, AUDIT_SINK_ENABLED: 'true', AUDIT_SINK_S3_BUCKET: 'audit' },
			COMPILED
		)
	).toThrow(/AUDIT_SINK_S3/);
});

it('accepts a complete S3 configuration', () => {
	const config = parseConfig(
		{
			...valid,
			AUDIT_SINK_ENABLED: 'true',
			AUDIT_SINK_S3_BUCKET: 'audit',
			AUDIT_SINK_S3_REGION: 'eu-central-1',
			AUDIT_SINK_S3_ACCESS_KEY_ID: 'k',
			AUDIT_SINK_S3_SECRET_ACCESS_KEY: 's'
		},
		COMPILED
	);

	expect(config.auditSink.s3?.bucket).toBe('audit');
	expect(config.auditSink.batchRows).toBe(1000);
	expect(config.auditSink.maxAgeMs).toBe(15 * 60_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit tests/unit/config.test.ts`
Expected: FAIL — `auditSink` is not a property of the parsed config.

- [ ] **Step 3: Implement**

Add the fields to the zod object beside `EVENT_EGRESS_ENABLED`, reusing the existing `booleanFlag` and `blankAsUndefined` helpers. Add a `.superRefine` clause implementing the two boot failures, and map into `auditSink` in the return object. Durations are parsed as integer minutes/hours and converted to ms in the mapping, so the environment variable is human-readable.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:unit tests/unit/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the build still needs no environment**

Run: `env -i PATH="$PATH" HOME="$HOME" pnpm build`
Expected: succeeds. This is the property CI proves; a config change is exactly what breaks it.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/config/parse.ts tests/unit/config.test.ts
git commit -m "feat(auditsink): parse and validate the sink configuration at boot"
```

---

## Task 10: Wire the job and the telemetry

**Files:**
- Create: `src/lib/server/auditsink/index.ts`
- Modify: `src/lib/server/jobs/index.ts`, `src/lib/server/telemetry/metrics.ts`, `src/lib/server/telemetry/provider.ts`, `src/lib/server/telemetry/index.ts`
- Test: `tests/integration/auditsink-ship.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–9.
- Produces: `runAuditSinkBatch(db: Db): Promise<void>` (phase one), `runAuditSinkShip(db: Db): Promise<void>` (phase two), `recordAuditSinkBatch`, `recordAuditSinkDigestMismatch` from `../telemetry`.

- [ ] **Step 1: Write the failing test**

```ts
it('does nothing at all while the sink is disabled', async () => {
	// Spec §11: neither phase runs. Nothing is lost — audit_event is never
	// swept, and the (0,0) default ships everything once enabled.
	setConfig({ auditSink: { enabled: false } });
	const before = await db.select().from(auditBatch);

	await runAuditSinkBatch(db);
	await runAuditSinkShip(db);

	expect(await db.select().from(auditBatch)).toHaveLength(before.length);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:integration tests/integration/auditsink-ship.test.ts -t disabled`
Expected: FAIL.

- [ ] **Step 3: Implement the two phases**

```ts
import { getConfig } from '../config';
import { recordAuditSinkBatch, recordAuditSinkDigestMismatch, withSpan } from '../telemetry';
import { attestationDue, buildAttestation, markAttested } from './attest';
import { buildBatch } from './reader';
import { createS3Adapter } from './s3';
import { claimShipments, shipClaimed } from './ship';
import type { AuditSinkAdapter, Attestation, SinkBatch } from './port';
import type { ClaimedShipment } from './ship';
import type { SinkName } from '../db/schema';
import type { Db } from '../db';

/**
 * Phase one's output, handed to phase two of the same tick. Module-scoped for
 * the reason A's egress/index.ts gives: one job needs it, and a generic payload
 * channel on every Job is surface with nothing to buy. Safe because the two
 * phases of one tick never overlap — runJob's advisory lock makes a second tick
 * skip rather than queue.
 *
 * Carrying the body here is what keeps the ordinary path from rebuilding, so a
 * recorded digest mismatch means a genuine retry rather than every batch
 * (spec §4.3).
 */
let claimed: ClaimedShipment[] = [];
let prebuilt = new Map<string, SinkBatch>();
let pendingAttestation: Attestation | null = null;

function adapters(): AuditSinkAdapter[] {
	const { auditSink } = getConfig();
	return auditSink.s3 ? [createS3Adapter(auditSink.s3)] : [];
}

export async function runAuditSinkBatch(db: Db): Promise<void> {
	const { auditSink } = getConfig();
	claimed = [];
	prebuilt = new Map();
	pendingAttestation = null;

	if (!auditSink.enabled) return;

	const sinks = adapters().map((adapter) => adapter.name as SinkName);
	if (sinks.length === 0) return;

	const batch = await buildBatch(db, {
		batchRows: auditSink.batchRows,
		maxAgeMs: auditSink.maxAgeMs,
		maxBytes: auditSink.maxBytes
	});
	if (batch) prebuilt.set(batch.id, batch);

	claimed = await claimShipments(db, sinks, 25);

	// Built here, written by phase two: writing is network I/O and this runs
	// inside the advisory lock, which must not be held across the network
	// (spec §3.1, plan C4).
	if (await attestationDue(db, auditSink.attestIntervalMs)) {
		pendingAttestation = await buildAttestation(db);
	}
}

export async function runAuditSinkShip(db: Db): Promise<void> {
	const active = adapters();
	if (active.length === 0) return;

	if (claimed.length > 0) {
		await withSpan('audit sink ship', { 'auditsink.batches': claimed.length }, () =>
			shipClaimed(db, claimed, active, prebuilt)
		);
	}

	if (pendingAttestation) {
		const attestation = pendingAttestation;
		await Promise.all(
			active.map((adapter) => adapter.attest(attestation).catch(() => undefined))
		);
		await markAttested(db, new Date(attestation.at));
	}

	claimed = [];
	prebuilt = new Map();
	pendingAttestation = null;
}
```

- [ ] **Step 4: Register the job**

In `src/lib/server/jobs/index.ts`, import the two phases and add to `JOBS`:

```ts
	// Sixty seconds rather than mail's and egress's fifteen: A §1.2 puts B's
	// latency budget at minutes to hours, and a batch is worth more than a
	// prompt one (audit sink spec §3.1).
	{
		name: 'auditsink:batch',
		everyMs: 60_000,
		run: runAuditSinkBatch,
		afterLock: runAuditSinkShip
	},
```

- [ ] **Step 5: Add the instruments**

In `src/lib/server/telemetry/metrics.ts`, add a `trustcenter.auditsink.batch` counter (attributes `sink`, `outcome`) and a `trustcenter.auditsink.digest_mismatch` counter, following the shape of `egressDelivery`. In `provider.ts`, register **two separately named** depth gauges:

```ts
	// Two names rather than one instrument with a `sink` attribute:
	// registerQueueDepthGauge observes a single number and takes no attributes,
	// and registering one name twice raises an OTel duplicate-instrument warning
	// (spec §9).
	registerQueueDepthGauge(
		'trustcenter.auditsink.s3.queue.depth',
		'Audit batches not yet shipped to the S3 sink',
		() => readSinkQueueDepth('s3')
	);
```

Export the recorders from `src/lib/server/telemetry/index.ts`.

- [ ] **Step 6: Run the full suites**

Run: `pnpm check && pnpm test:unit && pnpm test:integration`
Expected: all pass. A failure in an unrelated job test means the new `JOBS` entry changed a count assertion — update it.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/lib/server/auditsink/index.ts src/lib/server/jobs src/lib/server/telemetry tests
git commit -m "feat(auditsink): run the two-phase job and report it"
```

---

## Task 11: The admin panel

**Files:**
- Create: `src/routes/(admin)/admin/settings/integrations/AuditSinkPanel.svelte`
- Modify: `src/routes/(admin)/admin/settings/integrations/+page.server.ts`, `+page.svelte`, `messages/de.json`, `messages/en.json`
- Create: `src/lib/server/auditsink/status.ts`
- Test: `tests/integration/auditsink-ship.test.ts` (the status query), `tests/e2e/admin.spec.ts` (rendering)

**Interfaces:**
- Consumes: `auditBatch`, `auditBatchShipment`; `getConfig().auditSink`.
- Produces: `auditSinkStatus(db: Db): Promise<AuditSinkStatus>` with per-sink rows and a coverage block.

- [ ] **Step 1: Write the failing status test**

```ts
it('reports coverage as a comparison, not a keyset re-scan', async () => {
	// Spec §10: "rows not yet batched" from the keyset would be an unindexable
	// sequential scan per render, and would read zero in exactly the two cases
	// that matter — a forged cursor, and a period when the sink was off.
	await seedCursorAtHorizon(db);
	await recordEvent(db, { actor: { type: 'system' }, action: 'test.coverage' });

	const status = await auditSinkStatus(db);

	expect(status.coverage.eventMaxSeq).toBeGreaterThan(status.coverage.batchedMaxSeq);
	expect(status.sinks.find((s) => s.name === 's3')?.pending).toBe(0);
});
```

- [ ] **Step 2: Run to verify failure, then implement `status.ts`**

The query reads `max(seq)` and `count(*)` from `audit_event`, `max(max_seq)` and `count(*)` from `audit_batch`, and per-sink pending counts and last outcome from `audit_batch_shipment`. Read them concurrently with `Promise.all`, as `listEndpoints` does.

- [ ] **Step 3: Add the strings**

Add to both `messages/en.json` and `messages/de.json`, keyed `admin_auditsink_*`: panel title, "not configured", the object-lock statuses (`compliance`/`governance`/`none`/`unknown`), pending, oldest pending, last shipped, last error, digest mismatches, coverage. **Note in the commit that the German is the implementer's and not a translator's** — the same standing caveat A carries.

- [ ] **Step 4: Render the panel**

A read-only `<section>` appended to the existing page, gated by the same `requireAdmin` the page already calls. No forms, no actions.

- [ ] **Step 5: Run check, lint and the e2e suite**

Run: `pnpm check && pnpm lint && pnpm test:e2e tests/e2e/admin.spec.ts --project=app`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src messages tests
git commit -m "feat(auditsink): a read-only status panel on the integrations page"
```

---

## Task 12: Documentation and the erasure corrections

**Files:**
- Modify: `docs/self-hosting.md`, `src/lib/server/purge.ts`, `docs/superpowers/specs/2026-09-04-audit-sink-design.md`

**Interfaces:**
- Consumes: everything.
- Produces: no code.

- [ ] **Step 1: Correct the two false statements**

Spec §6.3. In `docs/self-hosting.md` §10 ("Erasure requests"), the sentence *"Purging is immediate and **cannot be undone**; nothing keeps a copy of what it cleared"* is false once a sink is enabled, and §10 is what somebody reads while handling an erasure request. Qualify it there, with a pointer to §13. Do the same for the docstring on `purgeRequester` in `src/lib/server/purge.ts` — *"Irreversible by construction: nothing here keeps a copy of what it cleared."*

Both must name the condition (a configured audit sink), not merely hedge.

- [ ] **Step 2: Write `docs/self-hosting.md` §13**

Cover every bullet listed in spec §14. Hand-wrap at 80 columns — the file's convention, and prettier will not enforce it (`proseWrap: preserve`). Verify with:

```bash
awk 'length > 80 {print FILENAME":"NR": "length}' docs/self-hosting.md
```

Expected: no new lines reported beyond those already there.

The IAM policy snippet must be **verified against a real bucket**, not written from memory. Apply it to the MinIO bucket from Task 7 and confirm a PUT succeeds and a DELETE is refused.

- [ ] **Step 3: Write the plan's corrections back into the spec**

Apply C1–C4 from this plan's header to `docs/superpowers/specs/2026-09-04-audit-sink-design.md`, and add a row per correction to §18. C1 is the substantive one: §4.1's recursive `meta` key sort is withdrawn as actively harmful, because it would destroy the numeric precision the same section reads text to preserve.

- [ ] **Step 4: Record what B1 leaves for B2**

Add a short section to the spec's §19 stating what shipped in B1 and what B2 still owns, so a reader of the merged branch is not left guessing whether syslog was forgotten or deferred.

- [ ] **Step 5: Full gate**

Run:

```bash
pnpm lint && pnpm check && pnpm build && pnpm test:unit && pnpm test:integration && pnpm test:e2e
npx drizzle-kit check
env -i PATH="$PATH" HOME="$HOME" pnpm check && env -i PATH="$PATH" HOME="$HOME" pnpm build
```

Expected: all green. Record the counts.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add docs src/lib/server/purge.ts
git commit -m "docs(auditsink): operator guide, and correct two erasure statements the sink falsifies"
```

---

## Self-review

**Spec coverage.** §1.1 → Task 2. §1.2 → Tasks 5, 8 (attestation), 11 (coverage). §2.1/§2.2 → Task 3. §2.3 → Tasks 4, 6, 10 (body held, never persisted). §2.4 → Task 3's monotonic trigger, Task 12's docs. §3.1 → Task 10. §3.2 → Task 5. §3.3 → Task 5 (the reader does not consult shipment state). §3.4 → Task 8. §4.1/§4.2 → Task 4. §4.3 → Tasks 5, 6 (`rebuildBatch`). §5.1/§5.2 → Tasks 6, 7. §5.3 → **B2, out of scope**. §5.4 → Task 6. §6.1/§6.2 → Task 12. §6.3 → Task 12. §7 → nothing to build, by design. §8 → Global Constraints. §9 → Task 10. §10 → Task 11. §11 → Task 9. §12 → Task 3's schema comment and Task 12's docs. §13 → tests throughout, drift test in Task 5. §14 → Task 12. §16 → Task 12 step 3. §19 → Tasks 1, 12.

**Gaps found and closed while reviewing:** the column-drift test §13 requires had no home — it is now Task 5 step 1's last test, because that is where `information_schema` is already reachable. `markAttested` was implied by Task 8's due-check but not in its Interfaces block; added.

**Type consistency.** `SinkBatch` is defined once in `port.ts` and consumed by `ship.ts`, `s3.ts` and `index.ts` with the same four fields. `readCursor` returns `{ xmin, seq }` in Task 5 and is consumed with those names in Tasks 6 and 8. `ClaimedShipment` uses `batchId` (camel) everywhere in TypeScript and `batch_id` only inside raw SQL result types, which are mapped at the boundary in `claimShipments`. `SHIPMENT_ERROR_REASONS` in Task 3 matches the eight values `classifyError` and the S3 adapter can produce in Tasks 6 and 7.

**One deliberate asymmetry to watch in review:** `objectKey` is written as the batch id in Task 6's `shipClaimed` but the S3 adapter computes a full path in Task 7. Task 7's reviewer should change `shipClaimed` to record the real key, or Task 6's `objectKey` write should be dropped — flag it rather than leaving both.
