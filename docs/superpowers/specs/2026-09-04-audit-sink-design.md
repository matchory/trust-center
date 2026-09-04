# Integrations subsystem B — Audit sink — Design

**Date:** 2026-09-04
**Status:** Approved design, revised 2026-09-04 after adversarial review (§18 records what changed).
Governs subsystem B where it and `2026-08-31-integrations-decomposition.md` differ.
**Author:** Moritz Friedrich (CISO, Matchory), with Claude
**Scoping note:** `docs/superpowers/specs/2026-08-31-integrations-decomposition.md`, §9 B
**Governing design:** `docs/superpowers/specs/2026-08-28-trust-center-design.md`
**Sibling subsystem:** `docs/superpowers/specs/2026-09-03-event-egress-design.md` (A)

Section references of the form "§6.6" are to the governing design unless a document is named.
References of the form "note §6" are to the decomposition note, and "A §5.2" to subsystem A's design.

**This document does not reverse note §6 in its default configuration.** The first draft did, and
§18 records why that was wrong: the reversal bought a defence against an actor the threat model never
named. Under the documented default — **governance-mode** object lock — note §6's reasoning transfers
intact. §6 below states the narrow case in which an operator opts into the reversal.

**This document corrects A §16.** Its frozen-`xmin` residual states that a vacuum-frozen row's `xmin`
"becomes `2`". That is pre-9.4 behaviour. Verified on PostgreSQL 18.6, the version this project
ships: `VACUUM FREEZE` leaves the reported `xmin` unchanged, because freezing sets the
`HEAP_XMIN_FROZEN` infomask bit rather than rewriting `t_xmin`. The residual is unreachable on any
supported version, in A and in B. §16 records the correction; A's own document should be amended on a
separate commit.

---

## 1. What this subsystem is

The compliance record leaves the application in batches, to storage the operator controls and the
application cannot rewrite. Note §9 B states the evidential claim it exists to support: *an auditor
asking whether someone with database access could have removed a row gets a materially better answer
when events are shipped continuously to object-locked storage the application holds no credentials to
rewrite.*

`audit_event` is already append-only, enforced by triggers rather than by convention (`drizzle/0003`,
`drizzle/0004`). That defends against the application. It does not defend against **the threat actor
this subsystem exists for: someone holding `psql` and the `postgres` role**, who can drop a trigger.
Shipping off-box closes that gap, and only to the extent the destination is outside that actor's
reach.

Naming the actor precisely matters, because §5.2 and §6 both follow from it and the first draft got
both wrong by leaving it implicit. That actor holds no object-storage credentials. Even holding the
container's, the write-only policy in §5.2 cannot delete. **Governance-mode object lock therefore
defeats them completely**, and the far more expensive compliance mode defends only against the
operator's own storage root principal — an actor this product trusts everywhere else.

Two adapters ship, S3 with object lock and syslog over TLS, so the port is proven by two
implementations rather than shaped around one. §19 sequences them.

### 1.1 What B inherits from A, and what it must not

A §1.2 is explicit and this document obeys it: **B takes A §5.2's composite `(xmin, seq)` keyset and
nothing else.** Per-endpoint filtering, enrichment, formatters, retry classification and auto-disable
are A-only. B is not built by widening A's document, and B's code does not import from
`src/lib/server/egress/`.

One shared function is real rather than notional: `currentHorizon` — `pg_snapshot_xmin` of the
current snapshot, widened to `bigint` — is identical for both subsystems and today lives in
`src/lib/server/egress/fanout.ts`. It moves to a shared module both subsystems import.

**What B must inherit and the first draft did not: A's per-row replay guard.** A's fan-out is
idempotent because `event_delivery` carries a unique `(endpoint_id, audit_seq)` and the insert is
`ON CONFLICT DO NOTHING` (`src/lib/server/egress/fanout.ts`). The first draft of B dropped the
per-row table for a batch table and replaced that guard with nothing. **The keyset alone was never
the safe half of A's design.** §2.4 restores an equivalent.

The keyset's consequence for B's output is stated once here and repeated in the operator docs: the
window is ordered by `(xmin, seq)`, which is commit-ish order and not `seq` order. **A reader of the
sink's output must not take `seq` to arrive monotonically**, within a batch or across batches, and
gap detection is therefore over the union of all batches rather than within any one of them.

### 1.2 The claim, stated precisely

What the sink lets an operator say to an auditor:

- Every `audit_event` row is shipped at least once, in batches, subject to §16's residuals.
- The **bucket's contents under object lock are the evidence.** Each batch arrives with a manifest
  naming its row count, `(xmin, seq)` range and a SHA-256 digest over the exact bytes of the batch,
  and a periodic **attestation object** (§3.4) records `count(*)` and `max(seq)` of `audit_event`
  against the reader's cursor — so coverage is checkable **from the bucket alone**.
- Under object lock, no shipped object can be altered or deleted before its retention date.

**The digests recorded in `audit_batch` are an operational aid, not independent evidence.** The first
draft claimed they were "recorded independently in the application's own database", which is
circular: §1's actor holds `psql`, and can rewrite a digest column in the same session as the row it
describes. §2.1's append-only triggers raise that cost but do not close it, because the same actor
can drop those triggers too. What is genuinely outside their reach is the bucket, which is why §3.4's
attestation — verifiable without consulting our database at all — is not optional decoration.

What it does not let them say, and §16 records rather than hides: that the sink holds exactly one
copy of each row (it is at-least-once); that batches are `seq`-contiguous (they are not); that a row
in the database is already in the sink (there is lag by design); or that the record is complete
across a period when the sink was switched off — for which §3.4 is the only detection.

---

## 2. Data model

Two tables, plus §3.4's attestation, which holds no state of its own.

### 2.1 `audit_batch` — the batch table *is* the cursor

| Column | |
| --- | --- |
| `id` | uuid, primary key, `gen_random_uuid()` |
| `created_at` | timestamptz not null, `now()` |
| `cursor_xmin`, `cursor_seq` | bigint not null — the keyset position of the batch's **last** row |
| `prev_cursor_xmin`, `prev_cursor_seq` | bigint not null — the position this batch starts *after* |
| `row_count` | integer not null |
| `min_seq`, `max_seq` | bigint not null, informational only (see §1.1: not a contiguous range) |
| `byte_count` | integer not null |
| `digest` | text not null — SHA-256 hex over the canonical body as built |

Unique on `(cursor_xmin, cursor_seq)`. Indexed on `created_at`.

The reader's position is `SELECT cursor_xmin, cursor_seq FROM audit_batch ORDER BY cursor_xmin DESC,
cursor_seq DESC LIMIT 1`, defaulting to `(0, 0)`. That is a correct total order **given** that batch
cursors strictly advance, and the unique index serves the descending scan directly.

`prev_cursor_*` is stored rather than derived, because §4.3's rebuild needs the batch's exact range
and deriving it from "the previous row by cursor order" would silently produce a different range
after any anomaly.

**Crash safety, narrowly.** `run` is one transaction under the advisory lock, so the batch row and
the cursor advance are the same fact: there is no state in which the cursor has advanced past rows no
batch describes. That claim survives review and is worth keeping.

**Where the first draft was wrong: making the batch table the cursor conflates the evidence with the
control surface**, and control is what §1's actor wants. One forged `INSERT INTO audit_batch` with a
high cursor permanently and silently skips a window. Three defences, none of which is sufficient
alone:

- **Append-only triggers on `audit_batch` and `audit_batch_shipment`**, modelled on `drizzle/0003`
  and `drizzle/0004`: no DELETE, no TRUNCATE. `audit_batch` permits no UPDATE at all;
  `audit_batch_shipment` permits UPDATE only of the shipment-progress columns.
- **A monotonicity check on insert**: a new batch's `(cursor_xmin, cursor_seq)` must strictly exceed
  the current maximum, and its `prev_cursor_*` must equal that maximum. This turns §16's anomalies —
  a restore, a wraparound, a forged row — into loud failures instead of silent skips.
- **§3.4's attestation**, which is the only one of the three that survives an actor who can drop
  triggers.

### 2.2 `audit_batch_shipment` — there is no terminal failure

| Column | |
| --- | --- |
| `batch_id` | uuid not null, references `audit_batch(id)` |
| `sink` | text not null, check in `('s3', 'syslog')` |
| `attempts` | integer not null, default 0 |
| `next_attempt_at` | timestamptz not null, default `now()` |
| `last_error` | text, from the closed set in §5.4 |
| `last_status_code` | integer — the HTTP status when `last_error` is `http_status`, null otherwise |
| `shipped_at` | timestamptz — null until shipped |
| `object_key` | text — the S3 key written, null for other sinks |
| `digest` | text — SHA-256 over the bytes actually sent, null until shipped |

Primary key `(batch_id, sink)`.

**The absence of a `status` column is the point.** A shipment is pending until `shipped_at` is set,
and there is no state meaning "gave up". A §5.4's auto-disable is precisely what B may not have: A is
allowed to drop an event after five attempts and say so, B is not (A §1.2). Encoding that in the
schema rather than a comment means a future contributor cannot add a give-up path without first
adding a column, which is a conversation rather than a patch. This survives review unchanged.

**Rows are created in `run`, under the advisory lock** — one `INSERT … SELECT … ON CONFLICT DO
NOTHING` covering every configured sink and every unshipped batch up to the claim limit — and then
claimed in the same transaction. The first draft created them lazily in the shipper, which left the
*first* attempt at every batch unprotected by the claim stamp: two replicas with overlapping ticks
would both find the batch unshipped and both ship it. The lazy-creation property that mattered is
retained by the `INSERT … SELECT`: a sink configured later still receives the full history, with no
backfill path to write.

`last_error` holds a value from a closed set and never a provider message — the discipline
`event_delivery` follows (A §6.4), and the one the mail queue does not (issue #11).

### 2.3 What is deliberately not stored

**The serialized batch body is not persisted.** Storing it would put `ip`, `ua` and `actor_id` at
rest in a second place inside our own database that `purgeRequester` does not clear — the second
erasure path note §6 warned against, and of which issue #11 is a live instance.

**It is, however, held in memory for the tick that built it.** "Not persisted" and "not held across
two phases of one job" are different constraints, and the first draft conflated them. A already hands
phase-one output to phase two through a module-scoped variable (`src/lib/server/egress/index.ts`),
with a note explaining why it is safe: the two phases of one tick never overlap, because `runJob`'s
advisory lock makes a second tick skip rather than queue. B does the same. §4.3 works through why
that matters more than it looks.

### 2.4 The replay guard, restored

A batch is idempotent at the object level — §5.2's keys are deterministic from the batch id — but
that protects only re-shipping *the same batch*. It does not protect against the reader producing a
**new** batch over rows already shipped, which is what §16's restore case does.

The guard is the monotonicity check in §2.1 plus one operator procedure in §14: **after any logical
restore, re-seed the cursor.** A `pg_restore`, a `\copy` migration to a new host, or a
logical-replication major-version upgrade rewrites every row's `xmin` to the restoring transaction's
xid, while `audit_batch` returns with a cursor naming xids from the old cluster. Both directions are
broken and §16 records both. The monotonicity check makes the reader **fail loudly** rather than
either re-ship the entire history or silently skip it, which converts an undetectable data problem
into a startup error with a documented fix.

---

## 3. The reader

### 3.1 One job, two phases

A new `JOBS` entry, `audit-sink:batch`, every 60 seconds, using the two-phase shape A introduced as
correction C3 and for the same reason — `runJob` wraps `run` in the advisory lock's transaction, and
the lock must not be held across the network:

- **`run` (inside the lock, one transaction):** read the horizon; read the window; if it qualifies
  under §3.2, build the body, compute the digest and insert `audit_batch`; insert shipment rows for
  every configured sink over unshipped batches up to `SHIPMENT_CLAIM_LIMIT`; claim them by stamping
  `next_attempt_at` forward. Hand the in-memory body for any batch built this tick to phase two.
- **`afterLock` (outside the lock):** ship the claimed shipments.

`SHIPMENT_CLAIM_LIMIT` bounds per-tick work, as A's `CLAIM_LIMIT = 25` does
(`src/lib/server/egress/deliver.ts`). Without it, a sink recovering from a week down would claim
thousands of batches in one tick and attempt thousands of PUTs while the 60-second timer keeps
firing — and any run outstripping the claim stamp would be re-claimed and double-ship.

The claim stamp is what makes phase two safe across replicas, exactly as `claimDeliveries` does for A
and `drainOutbox` does for mail. Issue #8 records that the mail queue's stamp has no test; **B's must
be covered**, and §13 says how.

Sixty seconds rather than A's fifteen: A §1.2 puts B's latency budget at minutes to hours.

### 3.2 When a batch is built

The window is A §5.2's keyset query with the per-endpoint filter and pattern match removed, and all
of §4.1's declared columns selected:

```sql
SELECT <declared columns>
FROM audit_event
WHERE xmin::text::bigint < $horizon
  AND (xmin::text::bigint, seq) > ($cursor_xmin, $cursor_seq)
ORDER BY xmin::text::bigint, seq
LIMIT $batch_rows
```

A §5.2's invariant carries over unchanged: the cursor is only ever set to a row whose `xmin` was
strictly below the horizon observed in the same tick, so every unconsumed row has a key strictly
greater than the cursor and is consumed exactly once, in the tick where the horizon crosses its
`xmin`. The failure mode traded into is delay, not loss.

**A batch is built when the window is full, or when its oldest row is older than
`AUDIT_SINK_BATCH_MAX_AGE` (default 15 minutes), or when the serialized body would exceed
`AUDIT_SINK_BATCH_MAX_BYTES` (default 8 MiB, which caps rows below the row limit).** An empty window
produces nothing.

The first draft had only the row limit and the empty-window rule, and argued elsewhere from a
batch-to-event ratio of 1:500 and 1:1000. **Both were wrong by two to three orders of magnitude.**
`AUDIT_SINK_BATCH_ROWS` is a maximum; at A §5.2's stated volume — thousands of audit events a month,
so roughly 100 a day — a 60-second tick produces about **one row per batch**, not a thousand. That is
~70,000 objects a year in a bucket where nothing can be deleted, each holding one event, and any
later lifecycle transition to a cheaper class pays the 128 KiB minimum billable size for each. The
minimum-fill rule is cheap now and impossible to retrofit, because objects already written cannot be
consolidated.

`AUDIT_SINK_BATCH_MAX_BYTES` also bounds an otherwise unbounded in-memory buffer and an unbounded
PUT: `meta` is unbounded `jsonb`.

The default cursor is `(0, 0)`, so enabling a sink ships **the entire history** — the deliberate
opposite of A §5.5's "enable, skipping the backlog", because a partial record is worth much less than
a complete one and there is no channel to flood.

### 3.3 The reader never stalls on a sink

Batching continues while a sink is unreachable. The batch table is the cursor, so stalling the reader
would relocate the backlog rather than bound it, while conflating reading with shipping. The pending
shipment count is what grows, and §9's gauge and §10's panel are what report it.

A pauses fan-out under backpressure (`BACKPRESSURE_THRESHOLD`) because its queue drains twenty times
slower than it fills. B's batch table grows at most one row per tick and `audit_event` is never
swept, so there is nothing to protect. (The first draft justified this from the same false ratio as
§3.2; the conclusion holds on the corrected numbers, the arithmetic did not.)

### 3.4 The attestation object

Every `AUDIT_SINK_ATTEST_INTERVAL` (default 24 hours), and independently of whether any batch was
built, the reader writes one small object to each sink containing: `now()`, `count(*)` and `max(seq)`
from `audit_event`, the current batch cursor, the id of the most recent batch, and the count of
batches written since the previous attestation.

It exists because of a hole the first draft's §15 explicitly dismissed — *"the auditor's question is
about removal, not about whether the shipper was running last Tuesday"* — which is backwards. **"Was
the shipper running last Tuesday" is exactly how rows are removed without detection under this
design:** set `AUDIT_SINK_ENABLED=false` (or stop the container — §11 means the job then does not
run), drop the triggers, delete rows, re-enable. Nothing in the bucket records the gap; §8 means
nothing in the audit log does either; and configuration is environment, so there is no admin action
to audit.

A regular series closes it. A missing attestation is a visible gap in an otherwise unbroken sequence;
a cursor that moved without matching batches is visible in the next attestation; and `count(*)` and
`max(seq)` give an auditor a **coverage check computable from the bucket alone**, which is most of
what §17's rejected hash chain was for, at a fraction of the cost and without serializing shipping.

It is not a heartbeat batch (§15): it carries no audit rows, has its own key prefix, and is never
confused with the record itself.

---

## 4. Serialization and the digest

### 4.1 Canonical NDJSON

One JSON object per `audit_event` row, LF-terminated, UTF-8, no insignificant whitespace.

- Keys come from an **explicit declared column list in a fixed order** — not reflection over the row
  object. The list is every column of `audit_event`: `id`, `seq`, `at`, `actor_type`, `actor_id`,
  `action`, `subject_type`, `subject_id`, `ip`, `ua`, `request_id`, `meta`. (The first draft called
  this "schema order", which is ambiguous and, read as Postgres attribute order, wrong — `seq` was
  added by `drizzle/0003` and is physically last. The explicit list is the definition; the phrase is
  gone.) Adding a column becomes a deliberate format-version bump under §4.2, enforced by the drift
  test in §13.
- **Values are read as text from Postgres, not round-tripped through the driver's types**, wherever
  fidelity is at stake: `at::text` (or `to_char`), `meta::text`, and `seq::text`. The reasons are
  concrete and each would otherwise corrupt the record silently — `timestamptz` is microsecond
  precision and a JS `Date` is millisecond; `jsonb` numbers are arbitrary-precision `numeric` and the
  driver parses them to IEEE doubles, so `{"n": 12345678901234567890}` ships as
  `12345678901234567000`; and `seq` already comes back as a string from `db.execute`, while
  `JSON.stringify` throws on a `BigInt`. §4.1 refuses to depend on normalization rules belonging to
  components we do not control, and the driver is one of them.
- `meta`'s keys are sorted recursively before serialization.
- Timestamps are RFC 3339 in UTC. `seq` is emitted as a JSON number; the 2^53 bound is unreachable at
  any plausible volume, and emitting a string would break the ordinary tools an auditor reaches for.

The digest is SHA-256 over exactly the bytes shipped, so verifying an S3 object is `sha256sum` and
nothing else. §5.3 records why that promise is weaker for syslog.

### 4.2 The manifest

A JSON document accompanying each batch: batch id, `created_at`, both cursor positions, `row_count`,
`min_seq`, `max_seq`, `byte_count`, the digest and its algorithm, and a format version — a small
integer, so §4.1's column list can change once without making historical objects ambiguous.

### 4.3 The rebuild, and two digests

Because the body is not persisted (§2.3), a retry in a later tick must rebuild it. **The rebuild
query is the half-open keyset range `(prev_cursor_xmin, prev_cursor_seq) < key <= (cursor_xmin,
cursor_seq)`**, which is why §2.1 stores `prev_cursor_*`. Stating this explicitly matters, because
its interaction with a purge is not what the first draft assumed:

`purgeRequester` UPDATEs the row (`src/lib/server/purge.ts`), so its `xmin` becomes the purge
transaction's xid — **above every existing batch cursor**. The row therefore leaves the range
entirely. On rebuild the batch has **N−1 rows, not N rows one of which is nulled.** The consequences,
all of which the first draft missed:

- `row_count`, `min_seq`/`max_seq` and `byte_count` in `audit_batch` no longer describe what shipped.
  The manifest, built from the bytes actually sent, disagrees with the batch table on row count and
  not only on digest — and the manifest is the authority for what the object contains.
- §6.1's "the sink ships those columns verbatim, before any purge can reach them" is **false for any
  batch still pending when the purge lands.** Those rows reach the sink only in post-purge form,
  which is a better privacy outcome than §6 argues for.
- If every row in a pending batch is purged, an empty body ships against a non-zero `row_count`.
- Two sinks shipping either side of a purge hold different **row sets**, not merely different digests.

**This is why §2.3 holds the body for the tick.** Doing so makes the same-tick digests identical by
construction and confines rebuild — and therefore mismatch — to the genuinely unavoidable case: a
retry in a later tick, or after a restart. Without it, §9's `digest_mismatch` counter would tick for
the ordinary path as well as the interesting one and would mean nothing.

So there are two recorded digests: `audit_batch.digest`, what the batch was when built, and
`audit_batch_shipment.digest`, what was actually sent per sink. When they differ, a purge intervened
between the build and a later retry. That is a **detected erasure**, surfaced by §9's counter and
§10's panel — and, per the above, a differing `row_count` in the manifest is the stronger signal of
the same event.

---

## 5. The port and the adapters

### 5.1 The port

```ts
interface AuditSinkAdapter {
	readonly name: 's3' | 'syslog';
	ship(batch: SinkBatch): Promise<void>; // throws to fail the shipment
	attest(attestation: Attestation): Promise<void>; // §3.4
}

interface SinkBatch {
	id: string;
	body: Uint8Array; // canonical NDJSON, the exact bytes
	digest: string; // SHA-256 hex over body
	manifest: BatchManifest;
}
```

The batch is built once per tick and handed to every configured sink. An adapter receives bytes and a
manifest; it does not receive rows, a database handle, or another sink's configuration.

**One body for all sinks is a deliberate simplification with a consequence recorded in §6.1**: it
forecloses per-sink payloads, and therefore forecloses redacting for the object-locked sink while
shipping verbatim to the SIEM. That trade is named where it is paid rather than left implicit.

### 5.2 S3, and which object-lock mode

`aws4fetch` (MIT, zero dependencies, ~65 KB, by the author of `aws4`) signs one `PutObject` per
object, two objects per batch plus one per attestation:

```
<prefix>/audit/<YYYY>/<MM>/<DD>/<batch-id>.ndjson
<prefix>/audit/<YYYY>/<MM>/<DD>/<batch-id>.manifest.json
<prefix>/attest/<YYYY>/<MM>/<DD>/<timestamp>.json
```

Chosen over hand-rolled SigV4 (no dependency, but the canonical-URI and payload-hash rules are a
debugging tar pit) and over `@aws-sdk/client-s3` (by far the largest dependency in the tree for one
signed PUT per batch). Trade accepted with open eyes: `aws4fetch` was last published 2024-08-28, so
we own any future breakage. Tolerable for a signer whose specification does not move, and the escape
hatch is that the same adapter could hand-roll the signature later with nothing else changing.

**Governance mode is the documented default.** §1 names the threat as the holder of `psql` and the
`postgres` role; governance mode blocks deletion for every principal without
`s3:BypassGovernanceRetention`, which neither the application's write-only credentials nor that actor
possess. Compliance mode additionally binds the operator's own storage root — and that is the entire
difference, purchased at the price of §6's reversal. Compliance mode remains available and documented
**with its consequence attached**, for operators whose own regulator requires it.

We configure nothing about the bucket. Versioning, lock mode and retention period are the operator's,
documented in §14 with a **write-only IAM policy** — `s3:PutObject`, no `s3:DeleteObject`, no
`s3:BypassGovernanceRetention` — which turns note §9's "storage the application holds no credentials
to rewrite" into something checkable.

Keys are deterministic from the batch id, so a retry re-PUTs. **Whether a PUT to an existing key
under object lock adds a version rather than being refused is a load-bearing premise that must be
verified against a real bucket and against MinIO before implementation** (§19).

The adapter reads the bucket's object-lock configuration once per process and **surfaces the result
in §10's panel as a status row**, not only in a log line. It degrades to "unknown" when the
permission is absent. We cannot prove the bucket is locked; we can be loud about what we could see.
The read happens on first use rather than at import (the lazy-singleton rule: `vite build` runs with
no environment) or at `init` (a boot that reaches a third party makes startup depend on its
availability). §16 records that on a quiet deployment this may be late, and that each replica reports
separately.

Endpoint override is first-class: MinIO, Garage, Hetzner and Scaleway are the deployments this
product's sovereignty argument attracts. **Object-lock support across those stores is uneven and
§14 must state it per store, verified rather than assumed** — an S3 copy with no lock is
indistinguishable from the real thing and would be sold on §1.2's claim.

### 5.3 Syslog, over TLS

RFC 5424 messages over TLS (`node:tls`) with RFC 6587 octet-counting framing — the only unambiguous
framing over a stream. One message per row carrying the canonical JSON line, then a trailing message
carrying the manifest.

**TLS trust is configured, not assumed.** `AUDIT_SINK_SYSLOG_CA`, `AUDIT_SINK_SYSLOG_CLIENT_CERT` and
`AUDIT_SINK_SYSLOG_CLIENT_KEY` exist because syslog-to-SIEM is overwhelmingly against a private CA
and frequently mutual-TLS. **`rejectUnauthorized` is never disabled**, and there is no environment
variable to disable it. The first draft specified `tls` as an error reason while saying nothing about
how TLS was established, on the channel carrying the entire compliance record.

Also specified: one connection per batch, closed after the manifest message; a write timeout;
`AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES` (default 8 KiB, matching rsyslog's default) with a row
exceeding it failing the batch rather than being truncated, because a truncated row can never
reproduce its digest.

**UDP is not supported** — silent loss disqualifies a compliance record. Plain TCP is accepted and
documented as discouraged.

**Two honesty notes for §14.** RFC 6587 has no acknowledgement, so "shipped" here means "written to a
socket", materially weaker than a PUT returning 200; a receiver whose queue overflows loses silently.
And there is no object at the far end, so §4.1's "verify with `sha256sum`" does not apply — an
auditor cannot reproduce the digest from what a SIEM stored without reconstructing the NDJSON exactly,
and cannot at all after SIEM-side normalization. `byte_count` and the shipment digest for this sink
describe what we sent, not what was stored.

CEF is deferred (§15).

### 5.4 Ordering, retry, and the reason set as a decision procedure

Per sink, batches are shipped in cursor order **within a tick**, and the first failure stops that
sink's tick rather than burning through the backlog. Across overlapping ticks or replicas, ordering
is not guaranteed and the claim stamp cannot make it so; the first draft overstated this as a global
property.

Backoff is exponential from one minute to a one-hour cap, forever. There is no attempt ceiling (§2.2).

`last_error` is assigned by the **first matching rule**, in this order, because a menu of overlapping
labels is not a lookup key:

1. `config` — the sink's configuration is unusable (missing bucket, unparseable URL).
2. `tls` — TLS handshake or verification failed. For `fetch`, this means walking `cause.code`; stated
   explicitly so this value is actually producible rather than joining A §16's `body_too_large` as a
   declared reason nothing writes.
3. `timeout` — no response, or no socket progress, within the adapter's timeout.
4. `network` — connection refused, DNS failure, socket error, or a syslog write failing mid-batch.
5. `auth` — HTTP 401, or 403 whose error code names a signature or credential problem.
6. `permission` — any other HTTP 403.
7. `not_found` — HTTP 404.
8. `http_status` — any other non-success status; the code goes in `last_status_code`.

Rules 5 and 6 exist because S3 returns 403 for both a bad signature and a denied action, and §14
promises this set "by name, as the operator's lookup key" — a key that means two things is not one.

---

## 6. Erasure

### 6.1 Under the default, note §6 holds

`purgeRequester` clears `ip`, `ua` and `actor_id` on `audit_event` — the one UPDATE the append-only
trigger permits (`drizzle/0004`) — and the sink ships those columns verbatim in any batch that
shipped before the purge (§4.3 corrects the "always verbatim" claim).

**Under governance-mode object lock, note §6's reasoning transfers intact.** The bucket is the
operator's system; their Art. 17 obligation reaches it as it reaches the HubSpot record their n8n
wrote; and they retain a mechanism — a principal with `s3:BypassGovernanceRetention` — to discharge
it. Our claim, being about what we hold and control, remains true.

**The reversal applies only under compliance mode**, which an operator must deliberately choose.
There, the immutability that makes the artifact worth having is the same property that makes the data
in it unerasable, no formulation holds both guarantees completely, and the operator has chosen
immutability. §14 states that in those terms, next to the mode setting.

The first draft made the reversal unconditional, on the assumption that compliance mode was required.
§18 records why that was wrong. Alternatives weighed and recorded in §17: redaction, crypto-shredding,
and explicit erasure notices. Two refinements the first draft missed and which remain open to an
operator-facing option later:

- **The three columns are not equivalent.** `ip` is the genuinely identifying one and evidentially
  the weakest; `ua` is fingerprinting-grade and near-worthless as evidence; `actor_id` for a requester
  is the requester UUID, which `subject_id` already carries unredacted on the same events and which
  CLAUDE.md's invariant treats as pseudonymous. Redacting `ip` and `ua` alone would remove most of
  the problem at almost no evidential cost.
- **Redaction need not be global.** The unerasability problem belongs to the object-locked sink; a
  SIEM is the operator's own system with its own deletion. What forecloses "verbatim to syslog,
  redacted to S3" is §5.1's single body, a simplicity choice — named there so it is not mistaken for
  a legal conclusion.

### 6.2 Erasure also arrives at the sink, structurally

A purge's `UPDATE audit_event` bumps the row's `xmin` above the reader's cursor, so the row is
**re-batched into a later batch with the three columns nulled** — an erasure record with no
erasure-notice mechanism to maintain. (Per §4.3 it simultaneously drops out of any pending batch, so
for rows purged before their first shipment the nulled copy may be the *only* copy that ever ships.)

The cost is at-least-once, and §14 must state the dedupe rule with three qualifications the first
draft lacked:

- **Dedupe on `audit_event.id`**, and order by the **manifest's cursor**, not by `seq` — §1.1 forbids
  reading `seq` as monotonic, and object keys are dated, not ordered.
- **Nulls alone are not the signal.** Most audit events have `ip = null` already (system actors and
  background jobs write none). Only a *differing pair* under one `id` indicates an erasure.
- **Duplicates have other causes** — a crash re-PUT, a restore (§16), a double-claim. A duplicate is
  not evidence of erasure.

This is A §16's re-enqueue residual arriving from the same mechanism. Inert there. Useful here.

### 6.3 What must be written down, and where

Three sites, not one. The first draft named only the README and got the least important of them:

- **`docs/self-hosting.md` §10, "Erasure requests"** — currently *"Purging is immediate and **cannot
  be undone**; nothing keeps a copy of what it cleared."* With a sink enabled this is **false**, and
  §10 is the section someone reads *while handling an erasure request*. It must carry the
  qualification, not only the new §13 next to the S3 setup — nobody handling a DSAR reads the setup
  section.
- **`src/lib/server/purge.ts`** — the docstring *"Irreversible by construction: nothing here keeps a
  copy of what it cleared"* is the code-level statement of the same invariant and is equally false.
- **`docs/self-hosting.md` §13** — the full boundary statement beside the lock-mode setting.

The README is **unchanged**. Read strictly, its claim is about the database and stays true; the sink
is opt-in and off by default; and under the governance-mode default there is no reversal to qualify.

---

## 7. This is not an SSRF surface

Note §7 says its rule — no redirects, a destination denylist — applies to any URL-valued setting B
accepts. It does not apply here, and the reason is stated so nobody adds the machinery later out of
symmetry with A.

A's URLs come from an admin session: a staff user types a URL into a form and the application
connects to it, which is server-side request forgery by construction. B's destinations come from the
process environment. An operator who can set environment variables can already reach anything the
container can, by simpler means. `EVENT_EGRESS_ALLOW`'s machinery would be ceremony against a threat
model that does not exist here, and dead security code is worse than none because it implies a check
that is not happening.

What does carry over: the S3 adapter follows no redirects.

---

## 8. The sink writes no audit events

Recording a shipment as an audit event would create an event that needs shipping, which would create
an event — a non-terminating loop, not merely noise.

Configuration lives in the environment, so there is no admin action to record either. Same reasoning
that made `egress.test` deliberately not an audit action (A §9), reached from a different direction.

**This is also what makes §3.4 necessary**: because the sink is silent in the audit log, the audit log
cannot testify that the sink was running.

---

## 9. Telemetry

Reusing subsystem C, with no new exporter configuration:

| Instrument | |
| --- | --- |
| `trustcenter.auditsink.batch` | Counter, attributes `sink` and `outcome`. |
| `trustcenter.auditsink.s3.queue.depth`, `…syslog.queue.depth` | Observable gauges, unshipped batches per sink. |
| `trustcenter.auditsink.digest_mismatch` | Counter. §4.3's detected erasures. |

Two corrections to the first draft. `registerQueueDepthGauge` takes a name, a description and a read
returning one number, with **no attributes** (`src/lib/server/telemetry/metrics.ts`) — "a gauge per
sink through the existing helper" does not typecheck, and registering one name twice yields an OTel
duplicate-instrument warning. Hence two named instruments, matching how the mail and egress depth
gauges are already registered.

And the alerting story must be stated honestly: **on a default deployment there is no gauge at all.**
`startTelemetry` returns early unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set
(`src/lib/server/telemetry/provider.ts`), and subsystem C is off by default. So the decision recorded
in §17 — retry forever, no notification email, no auto-disable — rests on §10's panel alone for most
deployments. §10 therefore surfaces the oldest-pending age in the admin navigation, not only inside
the panel, so a subsystem whose failure mode is "the compliance record silently stopped leaving the
box" is not invisible to an operator who never opens one page.

---

## 10. Admin surface

A **read-only** panel appended to `/admin/settings/integrations` — the page is 118 lines, `[id]` under
it is the event-endpoint detail page, and a status panel with no write path does not warrant its own
route.

Per sink: configured or not; **object-lock status for S3 (`compliance` / `governance` / `none` /
`unknown`)**; pending batch count; age of the oldest pending batch; last batch shipped and when; last
error reason and status code; digest-mismatch count.

Above them, three facts about the reader: total batches, the most recent attestation, and **coverage**
— `max(seq)` and `count(*)` of `audit_event` against what the last batch and last attestation
recorded.

Coverage is deliberately **not** "rows not yet batched" evaluated from the keyset. That figure would
be an unindexable sequential scan on every page render (`xmin` is a system column and not indexable —
A §16 already names ~1M rows as where such scans need bounding), and it would read **zero** in exactly
the two cases that matter: a forged cursor (§2.1) and a period when the sink was off (§3.4). A
coverage comparison detects both.

An oldest-pending age beyond a threshold is surfaced as a badge in the admin navigation (§9).

Gated with the existing `requireAdmin`. New strings in both locales; **the German will be the
implementer's and not a translator's**, the same standing caveat A carries.

---

## 11. Configuration

All environment, validated in the config schema at parse time.

| Variable | |
| --- | --- |
| `AUDIT_SINK_ENABLED` | Boolean, default `false`. Mirrors `EVENT_EGRESS_ENABLED`. |
| `AUDIT_SINK_BATCH_ROWS` | Integer, default 1000. A maximum (§3.2). |
| `AUDIT_SINK_BATCH_MAX_AGE` | Duration, default 15 minutes. The minimum-fill escape (§3.2). |
| `AUDIT_SINK_BATCH_MAX_BYTES` | Integer, default 8 MiB. |
| `AUDIT_SINK_ATTEST_INTERVAL` | Duration, default 24 hours (§3.4). |
| `AUDIT_SINK_S3_BUCKET`, `_REGION`, `_ENDPOINT`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_PREFIX` | `_ENDPOINT` and `_PREFIX` optional. |
| `AUDIT_SINK_SYSLOG_URL` | `tls://host:6514` or `tcp://host:514`. |
| `AUDIT_SINK_SYSLOG_CA`, `_CLIENT_CERT`, `_CLIENT_KEY` | PEM, for private-CA and mutual TLS (§5.3). |
| `AUDIT_SINK_SYSLOG_FACILITY` | Default `local0`. |
| `AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES` | Default 8 KiB (§5.3). |

A sink is active iff all its required variables are present. **Partial configuration is a boot
failure, not a silently disabled sink** — commit b67569e's lesson from A, where a malformed
`EVENT_EGRESS_ALLOW` booted clean and then threw inside every tick and 500'd the admin page an
operator would have used to fix it. `AUDIT_SINK_ENABLED=true` with no sink configured is likewise a
boot failure: it would otherwise accumulate batches nothing ships and mean the operator believes
something is running that is not.

A's correction C4 — "a boot exit lets one row brick the container that serves the only UI for fixing
it" — **does not apply**, and the difference is worth naming for a reader who knows C4: A's precondition
was a database row, reachable only through the UI the exit would have removed. B's is an environment
variable, and restarting with it corrected is the fix.

**When the sink is off, the job does not run — neither phase**, matching A, whose delivery path claims
nothing while `EVENT_EGRESS_ENABLED` is off. Nothing is lost: `audit_event` is never swept and §3.2's
`(0, 0)` default ships everything that accumulated. What *is* lost is the attestation series, which is
precisely why a gap in it is the signal §3.4 describes.

---

## 12. Retention, and the cursor's un-resettability

`audit_batch` and `audit_batch_shipment` are kept indefinitely and **deliberately excluded** from the
retention sweep. They are metadata about a permanent log — `audit_event` is never swept, and nothing
in `retention.ts` touches it — and §3.2's minimum-fill rule bounds the row count at roughly one per
tick worst case, one per `AUDIT_SINK_BATCH_MAX_AGE` at rest.

This differs from `event_delivery`, swept at 30 days (A §5.6), because A's rows log notifications
sent while B's are the local half of §1.2 — and a digest an auditor may check must outlive a window.

**A consequence the first draft did not record: the cursor cannot be reset.** In A an operator can
UPDATE `event_endpoint.cursor_*`. In B the cursor is derived from a table §2.1 makes append-only and
§12 keeps forever, so correcting it means deleting evidence. §2.4's re-seeding procedure is therefore
an *insert* of a synthetic batch row carrying the intended cursor and a zero row count, documented in
§14, never a delete. The monotonicity check permits it precisely because it only ever moves forward.

---

## 13. Testing

**Unit.** Canonical serialization determinism, including recursive `meta` key ordering and a
same-content-different-insertion-order case; digest stability across a rebuild; **serialization
fidelity** — a microsecond-precision `at`, and a `meta` number exceeding 2^53, both asserted to ship
byte-identical to what Postgres holds; manifest shape and format version; RFC 5424 construction and
RFC 6587 framing; the message-size cap failing rather than truncating; S3 key layout; and §5.4's
reason set asserted as a **deterministic decision procedure**, not merely exhaustive — a 403 must
resolve to one value.

**Integration, against Postgres (Testcontainers).** A §5.2's two keyset failure modes re-asserted for
B's window, because B's query is a separate implementation of the same invariant. Then: batch-table-
as-cursor crash safety; the monotonicity check rejecting a lower or equal cursor; append-only triggers
refusing DELETE and UPDATE on both tables; shipment rows created under the lock and a second
overlapping tick claiming nothing; the claim limit bounding a large backlog; a sink configured after
batches exist receiving the full history; per-tick ordering, and one sink's failure leaving the
other's shipments intact; **the claim stamp**, which issue #8 shows is easy to leave uncovered, tested
against a shipper abandoned mid-flight; the attestation series written on schedule and when no batch
was built; and the two purge behaviours — the dropped row and differing `row_count` on rebuild
(§4.3), and the later re-batched row with nulled columns (§6.2).

**Column-list drift.** An integration test reading `information_schema.columns` for `audit_event` and
asserting set-equality against §4.1's declared list, failing with a message naming §4.2's format
version. Without it, a migration plus a schema edit silently drops a column from the compliance
record and no test fails.

**S3 adapter, against MinIO in Testcontainers** — a second CI container, the one real infrastructure
cost here, called out so it is a decision rather than a surprise in a PR. Includes the re-PUT-under-
lock behaviour §5.2 depends on.

**Syslog adapter**, against an in-process TLS server, including private-CA verification and a
mid-batch write failure.

**e2e.** The panel renders with no sink configured and with one. The existing security spec's
assertions must continue to pass untouched; B adds no client-side anything.

---

## 14. Documentation

`docs/self-hosting.md` gains §13:

- What the sink is for, in §1.2's terms — **including what it does not let an operator claim.**
- **Object-lock mode**, governance as the recommended default with the reasoning, compliance with its
  erasure consequence stated in §6.1's terms.
- A **bounded, recommended retention period** with its reasoning. An unbounded or century-long lock on
  personal data is the version that is genuinely indefensible under storage-limitation principles, and
  nothing else in the design steers an operator away from it. The operator must also reflect this
  retention in their own privacy notice and processing records — one sentence, pointing at their
  counsel rather than substituting for it.
- Bucket setup: versioning, lock mode, retention, and the write-only IAM policy as a pasteable
  snippet, **verified against a real bucket** rather than shipped on inspection.
- **Per-store object-lock support**, verified per named S3-compatible store (§5.2).
- Syslog transport, private-CA and mutual TLS, why UDP is not offered, and the two honesty notes of
  §5.3 — no acknowledgement, and no reproducible digest at a SIEM.
- The at-least-once rule with §6.2's three dedupe qualifications, and erasure-by-re-shipping.
- That `seq` does not arrive monotonically, and that gap detection is over the union of batches.
- **The attestation object**: what it contains, and how an auditor uses it for coverage.
- **The post-restore re-seeding procedure** (§2.4, §12), and that the reader fails loudly until it runs.
- The closed `last_error` set by name, as the operator's lookup key.
- How to verify: `sha256sum` against the manifest for S3, and why that does not apply to syslog.

`docs/self-hosting.md` §10 and `src/lib/server/purge.ts`'s docstring are corrected per §6.3.

---

## 15. What this subsystem does not do

- **No heartbeat batches.** An empty window produces no *batch*. §3.4's attestation is a separate
  object carrying no audit rows, and is not this.
- **No CEF** (§5.3). **No UDP syslog** (§5.3).
- **No admin CRUD.** Environment-only (§11), which also keeps S3 credentials out of a database an
  admin session can read.
- **No backfill command.** §2.2's `INSERT … SELECT` makes it unnecessary.
- **No verification CLI.** The verification is `sha256sum`.
- **No filtering.** The record is the whole log or it is not the record (note §4).
- **No auto-disable, no notification email** (§9, §17).
- **No hash chain** (§17).

---

## 16. Known residuals

- **A logical restore breaks the cursor in both directions.** `pg_restore`, a `\copy` migration or a
  logical-replication upgrade rewrites every row's `xmin` while `audit_batch` returns naming the old
  cluster's xids. If the new xids are higher, the reader re-batches the entire history into storage
  nothing can delete; if lower — which a restore into a fresh cluster makes likely, since xids restart
  low — the rows sort **below** the cursor and are silently never shipped. §2.1's monotonicity check
  converts both into a loud failure, and §2.4's re-seeding is the fix. Recorded because the check
  detects rather than prevents.
- **The `xid` epoch limitation, inherited from A §5.2.** `xmin::text::bigint` is a bare 32-bit `xid`
  widened without its epoch. Valid within one epoch; past a wraparound it breaks two ways. Centuries
  away at this write rate.
- **A §16's frozen-`xmin` residual does not apply, in A or in B.** Verified on PostgreSQL 18.6:
  `VACUUM FREEZE` leaves the reported `xmin` unchanged, because freezing sets an infomask bit rather
  than rewriting `t_xmin`. The concern would otherwise have been sharper for B than for A, since §11
  stops the job entirely when the sink is off; it is recorded as closed rather than omitted, so it is
  not rediscovered.
- **Batches are not `seq`-contiguous** (§1.1). `min_seq`/`max_seq` are informational.
- **A digest mismatch, and a manifest `row_count` below the batch's, are expected after a purge**
  (§4.3), not alarming. §9's counter will be non-zero on any deployment that has honoured an erasure
  request.
- **The object-lock check is advisory and possibly late.** It runs on first use, so a quiet deployment
  may not report for some time, and each replica reports separately. A bucket with no lock and no
  `s3:GetBucketObjectLockConfiguration` permission reads `unknown`, not `none`. We cannot close this
  from inside the application; §10 makes it visible rather than silent.
- **Syslog "shipped" means "written to a socket"** (§5.3). Weaker than the S3 adapter's guarantee, and
  §1.2's at-least-once claim is correspondingly weaker for that sink.

---

## 17. Decisions taken during design

| Decision | Alternatives rejected |
| --- | --- |
| **Governance-mode object lock as the documented default** (§5.2, §6) | Compliance mode as default — the first draft's position, which reversed note §6 to defend against the operator's own storage root, an actor §1 never names. Compliance remains available with its consequence stated. |
| **Ship `ip`/`ua`/`actor_id` verbatim** (§6) | Redact at ship — now understood as separable per column and per sink (§6.1), and reconsiderable without redesign; crypto-shred under a per-requester key — the textbook answer, but it buys a key table, an auditor-resolution path and a restore-from-backup story; verbatim plus erasure notices — discharges nothing, and §6.2 supplies the same signal free. |
| **A port plus two adapters** (§5) | One adapter first. Two proves the boundary rather than shaping it around one implementation. OTLP-logs rejected outright: a lossy, sampled-by-convention pipeline invites the wrong assumptions about a compliance record. §19 sequences them so this does not become one unreviewable change. |
| **Environment for secrets, admin for state** (§10, §11) | Environment-only, which gives no health view; full admin CRUD like A, which would put S3 credentials in a table an admin session can read. |
| **Retry forever, gauge and panel only** (§9) | A threshold email; disabling like A; failing the health check. The last two convert an outage into a stop. Qualified by §9: the gauge does not exist on a default deployment, so the panel and its nav badge carry it. |
| **Batch manifest with a digest, plus a periodic attestation** (§3.4, §4) | A hash chain across batches — stronger and offline-verifiable, but it serializes shipping and needs a defined meaning for a chain break after a restore. The attestation recovers most of its value at a fraction of the cost. Relying on object lock alone was rejected: it makes the whole claim a property of a bucket configuration we cannot verify. |
| **Batches are durable rows, shipment is per-sink** (§2) | An independent cursor per sink, giving the same rows two digests under two boundaries; one shared cursor advancing only when all sinks succeed, coupling exactly what the port isolates. |
| **One body for all sinks** (§5.1) | Per-sink payloads, which would permit redacting for S3 while shipping verbatim to a SIEM. Rejected on port simplicity, and named in §6.1 because it is what forecloses that option. |
| **`aws4fetch`** (§5.2) | Hand-rolled SigV4; `@aws-sdk/client-s3`. |

---

## 18. Revision history — 2026-09-04, after adversarial review

§17 records what was decided while designing. This section records what an adversarial review of the
document changed, because several items reverse positions the first draft argued at length.

| Changed | Was | Now |
| --- | --- | --- |
| §5.2, §6, §1 | Compliance-mode object lock assumed; note §6 reversed unconditionally, with three paragraphs on which guarantee to sacrifice | **Governance mode is the default and note §6 holds.** The reversal bought a defence only against the operator's own storage root — an actor §1 never names and the product trusts everywhere else. §1 now names the threat actor explicitly, because §5.2 and §6 both follow from it. |
| §1.2 | Digests "recorded independently in the application's own database" | Circular: §1's actor holds `psql` and can rewrite the digest beside the row. The **bucket** is the evidence; the digest columns are an operational aid. §3.4 supplies what is genuinely independent. |
| §15, §3.4 | "No heartbeat batches… the auditor's question is about removal, not whether the shipper was running" | Backwards. Switching the sink off, deleting rows and switching it back on leaves **no trace anywhere** — §8 guarantees the audit log cannot testify either. A periodic **attestation object** closes it, and gives a bucket-only coverage check. |
| §2.1 | The batch table is the cursor, presented purely as an elegance | Still the cursor, but it **conflates evidence with control surface**: one forged INSERT skips a window silently. Append-only triggers, a monotonicity check, and §3.4. The narrow crash-safety claim survives unchanged. |
| §4.3, §2.3 | Two digests "forced" by not persisting the body; a purge "changes the bytes" | The rebuild query is now **stated** — and under it a purged row leaves the range entirely, so the batch has N−1 rows, not N with one nulled. `row_count` and the manifest diverge too. And the body is **held in memory for the tick** (as A already does), so mismatch means a genuine retry rather than the ordinary path. |
| §1.1, §2.4 | B inherits A's keyset | B inherited the keyset but **not A's per-row replay guard** (`ON CONFLICT DO NOTHING` on `(endpoint_id, audit_seq)`), and nothing replaced it. §16's restore case is what that omission costs. |
| §3.2, §3.3, §12 | Ratio arguments from 1:500 and 1:1000 batches to events | **Wrong by two to three orders of magnitude.** `AUDIT_SINK_BATCH_ROWS` is a maximum; at this system's volume a 60-second tick yields ~1 row per batch — ~70,000 undeletable objects a year. A minimum-fill / max-age rule, and a byte cap. |
| §3.1, §2.2 | Shipment rows created lazily by the shipper; claim stamp in `run` | Contradictory — the stamp presupposed rows that did not exist, leaving every **first** attempt unprotected across replicas. Rows are created under the lock. A `SHIPMENT_CLAIM_LIMIT` is added; A has `CLAIM_LIMIT = 25` and B had none. |
| §5.4 | "Batches ship strictly in cursor order" | A per-tick property only; the claim stamp cannot make it global. The useful half — first failure stops the tick — is kept. |
| §5.3, §11 | `node:tls`, and `tls` as an error reason | **No TLS trust configuration at all** on the channel carrying the whole compliance record. CA, client cert and key added; `rejectUnauthorized` never disabled; message-size cap; and the no-acknowledgement and no-reproducible-digest caveats stated. |
| §5.4 | A list of eight reason values | A list is a menu, not a key: S3 returns 403 for both a bad signature and a denied action. Now a **first-match decision procedure**, with `tls` given a producible rule so it does not become A §16's `body_too_large`. |
| §6.3 | The README checked; qualification placed in a new §13 | The README was the least important site. **`docs/self-hosting.md` §10 and `purge.ts`'s docstring both assert "nothing keeps a copy of what it cleared"**, which a sink makes false — and §10 is what someone reads while handling an erasure request. |
| §9 | "Observable gauge per sink, through the existing `registerQueueDepthGauge`" | Does not typecheck — that helper takes one name and one read, with no attributes. Two named instruments. And **on a default deployment there is no gauge at all**, since `startTelemetry` returns early without an OTLP endpoint; the panel and a nav badge carry the story. |
| §10 | Panel shows "rows not yet batched" | An unindexable sequential scan per render, and it reads **zero** in exactly the forged-cursor and sink-was-off cases. Replaced by a coverage comparison, plus an object-lock status row. |
| §4.1 | "Every column, in schema order"; driver types trusted | "Schema order" is ambiguous and wrong read as attribute order (`seq` is physically last). Values are now read as **text** from Postgres: `Date` loses microseconds, `jsonb` numbers lose precision past 2^53, and `JSON.stringify` throws on the `BigInt` `seq` already returns. A column-drift test is added. |
| §16 | A §16's frozen-`xmin` residual inherited implicitly | **Verified on PostgreSQL 18.6 and does not apply**: `VACUUM FREEZE` leaves the reported `xmin` unchanged. A's own document should be corrected on a separate commit. |
| §12 | Retention stated | Added: **the cursor cannot be reset**, because the table is append-only and kept forever. Re-seeding is an insert, never a delete. |

Two things the review attacked and **did not move**: §7's refusal to add SSRF machinery, and §2.2's
no-terminal-failure schema. Both are recorded here as load-bearing and deliberately unchanged.

---

## 19. Sequencing

This is **not** "nearly free once A's spine exists", and note §9 B's estimate should be read as
superseded. It predates A's spine turning out to be a keyset with residuals rather than a bigint. What
B actually is: two tables with triggers, a two-phase job, a canonical serialization format with a
digest and a version, an attestation series, a SigV4 signer with a new dependency, an RFC 5424/6587
TLS client, a second CI container, an admin panel in two locales, a new `docs/self-hosting.md`
section, and corrections to two erasure statements elsewhere in the tree.

**Before any plan is written**, one spike: verify against a real bucket and against MinIO that a PUT
to an existing key under object lock adds a version rather than being refused (§5.2), and that
governance mode behaves as §6.1 assumes. Two unverified infrastructure premises currently sit under
this document; a day of spike is cheap and week three is not.

**Then two plans**, because the adapters stress the port in opposite directions — one is a
request/response PUT with a status code, the other a stream of framed messages with no acknowledgement
— and one review cannot hold both well. The first draft's syslog adapter received a fraction of the
design attention the S3 one did, and §5.3's absent TLS story was the symptom.

- **B1** — the shared `currentHorizon` module, both tables and their triggers, the reader, canonical
  serialization and the digest, the attestation, the S3 adapter, the panel, `docs/self-hosting.md` §13
  and the §6.3 corrections.
- **B2** — the syslog adapter, its TLS configuration, its docs and its tests.

Each carries one reviewable theme in the sense §11 of the governing design uses.

---

## Sources

- RFC 5424 (Syslog Protocol), RFC 6587 (Transmission of Syslog Messages over TCP) — §5.3.
- `aws4fetch` package metadata, checked 2026-09-04: 1.0.20, MIT, zero dependencies, 65,541 bytes
  unpacked across 9 files, last published 2024-08-28, `github.com/mhart/aws4fetch`.
- PostgreSQL freeze behaviour, measured 2026-09-04 on `postgres:18-alpine` (18.6): a row's reported
  `xmin` is unchanged by `VACUUM FREEZE` — §16.
- Amazon S3 Object Lock, for governance vs compliance retention and versioning. **The premises in
  §5.2 and §6.1 must be verified against a real bucket and MinIO before implementation** (§19).
