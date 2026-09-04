# Integrations subsystem B — Audit sink — Design

**Date:** 2026-09-04
**Status:** Approved design.
Governs subsystem B where it and `2026-08-31-integrations-decomposition.md` differ.
**Author:** Moritz Friedrich (CISO, Matchory), with Claude
**Scoping note:** `docs/superpowers/specs/2026-08-31-integrations-decomposition.md`, §9 B
**Governing design:** `docs/superpowers/specs/2026-08-28-trust-center-design.md`
**Sibling subsystem:** `docs/superpowers/specs/2026-09-03-event-egress-design.md` (A)

Section references of the form "§6.6" are to the governing design unless a document is named.
References of the form "note §6" are to the decomposition note, and "A §5.2" to subsystem A's design.

**This document reverses note §6 for B.** Note §6 settled that egress payloads carry no personal data
at rest and that the erasure claim therefore needs no qualification. That reasoning holds for A and
does not transfer here; §6 below states the reversal in the terms it deserves rather than as a
footnote.

---

## 1. What this subsystem is

The compliance record leaves the application in batches, to storage the operator controls and the
application cannot rewrite. Note §9 B states the evidential claim it exists to support: *an auditor
asking whether someone with database access could have removed a row gets a materially better answer
when events are shipped continuously to object-locked storage the application holds no credentials to
rewrite.*

`audit_event` is already append-only, enforced by triggers rather than by convention (`drizzle/0003`,
`drizzle/0004`). That defends against the application. It does not defend against someone with
`psql` and the `postgres` role, who can drop a trigger. Shipping off-box is what closes that gap, and
it closes it only to the extent that the destination is outside the reach of whoever holds that role.

Two adapters ship in the first version — S3 with object lock, and syslog over TLS — so the port is
proven by two implementations rather than shaped around one.

### 1.1 What B inherits from A, and what it must not

A §1.2 is explicit and this document obeys it: **B takes A §5.2's composite `(xmin, seq)` keyset and
nothing else.** Per-endpoint filtering, enrichment, formatters, retry classification and auto-disable
are A-only. B is not built by widening A's document, and B's code does not import from
`src/lib/server/egress/`.

One shared function is real rather than notional: `currentHorizon` — `pg_snapshot_xmin` of the
current snapshot, widened to `bigint` — is identical for both subsystems and today lives in
`src/lib/server/egress/fanout.ts`. It moves to a shared module both subsystems import. The
alternative, B importing from `egress/`, would create a dependency between two subsystems the
decomposition says share only a spine, and would be the first step toward exactly the widening A
§1.2 forbids.

The keyset's consequence for B's output is stated once here and repeated in the operator docs: the
window is ordered by `(xmin, seq)`, which is commit-ish order and not `seq` order. **A reader of the
sink's output must not take `seq` to arrive monotonically**, within a batch or across batches, and
gap detection is therefore over the union of all batches rather than within any one of them.

### 1.2 The claim, stated precisely

What the sink lets an operator say to an auditor:

- Every `audit_event` row is shipped to the sink, in batches, at least once.
- Each batch arrives with a manifest naming its row count, its `(xmin, seq)` range, and a SHA-256
  digest over the exact bytes of the batch — and the same digest is recorded independently in the
  application's own database, so an object can be checked against a value it does not itself carry.
- Under object lock, no shipped object can be altered or deleted before its retention date, by us or
  by the operator.

What it does not let them say, and §16 records rather than hides: that the sink holds exactly one
copy of each row (it is at-least-once), that batches are `seq`-contiguous (they are not), or that a
row present in the database is already in the sink (there is lag by design).

---

## 2. Data model

Two tables. There is no cursor table, and that is a design decision rather than an omission.

### 2.1 `audit_batch` — the batch table *is* the cursor

| Column | |
| --- | --- |
| `id` | uuid, primary key, `gen_random_uuid()` |
| `created_at` | timestamptz not null, `now()` |
| `cursor_xmin`, `cursor_seq` | bigint not null — the keyset position of the batch's **last** row |
| `row_count` | integer not null |
| `min_seq`, `max_seq` | bigint not null, informational only (see §1.1: not a contiguous range) |
| `byte_count` | integer not null |
| `digest` | text not null — SHA-256 hex over the canonical body as built |

Unique on `(cursor_xmin, cursor_seq)`. Indexed on `created_at`.

The reader's position is `SELECT cursor_xmin, cursor_seq FROM audit_batch ORDER BY cursor_xmin DESC,
cursor_seq DESC LIMIT 1`, defaulting to `(0, 0)`. Because each batch's cursor strictly advances, that
ordering is total and the read is a single index scan.

This buys more than one fewer table. A crash between "batch written" and "batch shipped" is safe by
construction: either the row exists, in which case the cursor moved and the shipment is pending, or
it does not, in which case the same window is read again. There is no state in which the cursor has
advanced past rows no batch describes — which is the failure a separate cursor column would make
possible and would then need a transaction to prevent.

### 2.2 `audit_batch_shipment` — there is no terminal failure

| Column | |
| --- | --- |
| `batch_id` | uuid not null, references `audit_batch(id)` |
| `sink` | text not null, check in `('s3', 'syslog')` |
| `attempts` | integer not null, default 0 |
| `next_attempt_at` | timestamptz not null, default `now()` |
| `last_error` | text, from a closed set (§5.4) |
| `last_status_code` | integer — the HTTP status when `last_error` is `http_status`, null otherwise |
| `shipped_at` | timestamptz — null until shipped |
| `object_key` | text — the S3 key written, null for other sinks |
| `digest` | text — SHA-256 over the bytes actually sent, null until shipped |

Primary key `(batch_id, sink)`.

**The absence of a `status` column is the point.** A shipment is pending until `shipped_at` is set,
and there is no state that means "gave up". A §5.4's auto-disable is precisely what B may not have:
A is allowed to drop an event after five attempts and say so, B is not (A §1.2). Encoding that in the
schema rather than in a comment means a future contributor cannot add a give-up path without first
adding a column, which is a conversation rather than a patch.

**Shipment rows are created lazily**, not when the batch is built. The shipper for a sink left-joins
batches against its own shipment rows and inserts on first attempt. A sink configured later therefore
ships the full history with no backfill command to write, and a sink removed from the configuration
leaves its rows as the record of what it received.

`last_error` holds a value from a closed set and never a provider message. This is the discipline
`event_delivery` already follows (A §6.4), and the one the mail queue does not — see issue #11, where
`outbound_email.last_error` stores raw SMTP messages that survive both a purge and the retention
window. A sink error is unlikely to carry personal data, but "unlikely" is how that column got its
contents too.

### 2.3 What is deliberately not stored

**The serialized batch body is not persisted.** Storing it would put `ip`, `ua` and `actor_id` at
rest in a second place inside our own database that `purgeRequester` does not clear — the second
erasure path note §6 warned against, and of which issue #11 is a live instance. The body is rebuilt
from live rows at ship time. §4.3 works through what that implies for the digest, which is the one
genuinely subtle consequence in this document.

---

## 3. The reader

### 3.1 One job, two phases

A new `JOBS` entry, `audit-sink:batch`, every 60 seconds. It uses the same two-phase shape A
introduced as correction C3 and for the same reason — `runJob` wraps `run` in the advisory lock's
transaction, and the lock must not be held across the network:

- **`run` (inside the lock):** read the horizon, read the window, build the batch, insert
  `audit_batch`, and *claim* due shipments by stamping `next_attempt_at` forward.
- **`afterLock` (outside the lock):** ship the claimed shipments.

The claim stamp is what makes phase two safe with multiple replicas, exactly as `claimDeliveries`
does for A and `drainOutbox` does for mail. Note that this construct is the subject of issue #8 — the
mail queue's stamp has no test — and B's must be covered rather than inheriting the gap.

Sixty seconds rather than A's fifteen: A §1.2 puts B's latency budget at minutes to hours, and a
batch is worth more than a prompt one.

### 3.2 The window, and starting from `(0, 0)`

The window is A §5.2's keyset query with the per-endpoint filter and the pattern match removed, and
all shipped columns selected:

```sql
SELECT <declared columns>
FROM audit_event
WHERE xmin::text::bigint < $horizon
  AND (xmin::text::bigint, seq) > ($cursor_xmin, $cursor_seq)
ORDER BY xmin::text::bigint, seq
LIMIT $batch_rows
```

The invariant is A §5.2's and is restated because B depends on it just as hard: the cursor is only
ever set to a row whose `xmin` was strictly below the horizon observed in the same tick, so every
unconsumed row has a key strictly greater than the cursor and is consumed exactly once, in the tick
where the horizon crosses its `xmin`. The failure mode traded into is delay, not loss.

An empty window produces **no batch**. Heartbeat batches proving liveness are a non-goal (§15): the
operator's liveness signal is the telemetry gauge and the admin panel, and the auditor's question is
about removal, not about whether the shipper was running last Tuesday.

The default cursor is `(0, 0)`, so enabling a sink ships **the entire history**. This is the
deliberate opposite of A §5.5's "enable, skipping the backlog", which A offers first because a
channel flooded with a day of stale notices is worse than a gap. Here a partial record is worth much
less than a complete one, and there is no channel to flood.

### 3.3 The reader never stalls on a sink

Batching continues while a sink is unreachable. Batches are cheap metadata — one row per
`AUDIT_SINK_BATCH_ROWS` events — and the batch table is the cursor, so stalling the reader would
relocate the backlog rather than bound it, while conflating reading with shipping. The pending
shipment count is what grows, and it is what the gauge in §9 reports.

This is the point at which B most visibly differs from A, which *does* pause fan-out under
backpressure (A's `BACKPRESSURE_THRESHOLD`). A pauses because its queue drains twenty times slower
than it fills and `event_delivery` would grow without bound. B's batch table grows at one
five-hundredth of `audit_event`'s rate and `audit_event` itself is never swept, so there is nothing
to protect.

---

## 4. Serialization and the digest

### 4.1 Canonical NDJSON

One JSON object per `audit_event` row, LF-terminated, UTF-8, no insignificant whitespace.

- Keys come from an **explicit declared column list in a fixed order** — not reflection over the row
  object. The list is every column of `audit_event`, in schema order: `id`, `seq`, `at`, `actor_type`,
  `actor_id`, `action`, `subject_type`, `subject_id`, `ip`, `ua`, `request_id`, `meta`. Adding a
  column to `audit_event` then becomes a deliberate change to the wire format — a format version bump
  under §4.2 — instead of a silent change to every future digest.
- `meta` is a `jsonb` value of arbitrary shape; its keys are sorted recursively before serialization.
  Postgres normalizes `jsonb` key order already, so this is belt and braces — but the digest must not
  depend on a normalization rule belonging to a component we do not control.
- Timestamps are RFC 3339 in UTC. `seq` is a JSON number; the 2^53 bound is unreachable at any
  plausible volume and emitting it as a string would break every ordinary tool an auditor reaches for.

The digest is SHA-256 over exactly the bytes shipped, so verifying an object is `sha256sum` and
nothing else. No canonical-JSON library, no re-parse, no second implementation to disagree with the
first.

### 4.2 The manifest

A JSON document accompanying each batch: batch id, `created_at`, the `(xmin, seq)` cursor position,
`row_count`, `min_seq`, `max_seq`, `byte_count`, the digest and its algorithm, and a format version.

The format version exists so §4.1's declared column list can change once without making every
historical object ambiguous. It is a small integer, not a semver string.

### 4.3 Two digests, and why a mismatch is a finding rather than a bug

Because the body is rebuilt at ship time (§2.3), a purge landing between batching and shipping
changes the bytes. Hence two recorded digests:

- `audit_batch.digest` — what the batch was when it was built.
- `audit_batch_shipment.digest` — what was actually sent, per sink.

Normally identical. When they differ, **that is a detected erasure**, and it is surfaced as such: a
counter in §9 and a column in §10's panel. The manifest inside the object is always built from the
bytes actually sent, so an object is always internally consistent, and an auditor checking an object
against the application's own record has a stated reason for the one case where the two differ.

Two sinks can also disagree with each other, if a purge lands between their shipments. Both digests
are recorded. This is documented rather than prevented; preventing it would mean holding the body,
which §2.3 refuses.

---

## 5. The port and the adapters

### 5.1 The port

```ts
interface AuditSinkAdapter {
	readonly name: 's3' | 'syslog';
	ship(batch: SinkBatch): Promise<void>; // throws to fail the shipment
}

interface SinkBatch {
	id: string;
	body: Uint8Array; // canonical NDJSON, the exact bytes
	digest: string; // SHA-256 hex over body
	manifest: BatchManifest;
}
```

The batch is built once per tick and handed to every configured sink. An adapter receives bytes and a
manifest; it does not receive rows, a database handle, or the configuration of any other sink.
Failure is an exception, which the shipper converts into a reason from §5.4's set.

### 5.2 S3, with object lock

`aws4fetch` (MIT, zero dependencies, ~65 KB, by the author of `aws4`) signs one `PutObject` per
object, two objects per batch:

```
<prefix>/audit/<YYYY>/<MM>/<DD>/<batch-id>.ndjson
<prefix>/audit/<YYYY>/<MM>/<DD>/<batch-id>.manifest.json
```

It was chosen over hand-rolled SigV4 (no dependency, but the canonical-URI and payload-hash rules are
a debugging tar pit) and over `@aws-sdk/client-s3` (by far the largest dependency in the tree, and a
substantial transitive graph, for one signed PUT per batch). The trade accepted with open eyes:
`aws4fetch` was last published 2024-08-28, so we own any future breakage. For a SigV4 signer that is
tolerable — the signing specification does not move — and the escape hatch is that the same adapter
could hand-roll the signature later without any other part of B changing.

Keys are deterministic from the batch id, so a retry after a crash re-PUTs. Under object lock a PUT
to an existing key adds a version rather than replacing one, which is legal and, in the §4.3 case
where the bytes now differ, evidentially honest: both versions are retained and the difference is
attributable to a purge the application also recorded.

**We configure nothing about the bucket.** Versioning and object lock are the operator's, documented
in §14 alongside a **write-only IAM policy** — `s3:PutObject` and no `s3:DeleteObject` — which is
what turns note §9's phrase "storage the application holds no credentials to rewrite" into something
an auditor can check rather than a sentence in a brochure.

Once per process, on the adapter's **first tick** rather than at import or at `init`, it *reads* the
bucket's object-lock configuration and logs a warning if object lock is absent, degrading silently
when the permission is not granted. Not at import, because `getConfig()`, `getDb()` and `getStorage()`
are lazy singletons and importing a module must never require a configured environment — `vite build`
runs with none. Not at `init`, because a boot that reaches out to a bucket makes the container's
startup depend on a third party's availability. We cannot prove the bucket is locked; we can decline
to be quiet about it when we can see that it is not.

Endpoint override is first-class rather than an afterthought. MinIO, Garage, Hetzner Object Storage
and Scaleway are the deployments this product's sovereignty argument actually attracts, and an S3
adapter that only works against AWS would be a strange thing to ship in a product whose §1.1 pitch is
that your data need not go to a US hyperscaler.

### 5.3 Syslog, over TLS

RFC 5424 messages over TLS (`node:tls`) with RFC 6587 octet-counting framing, which is the only
framing that is unambiguous over a stream. One message per row, carrying the same canonical JSON line
as its `MSG`; then a trailing message carrying the manifest, so a SIEM sees the batch boundary and
its digest rather than an undifferentiated stream.

**UDP is not supported.** Silent loss disqualifies a compliance record, and offering the transport
would invite exactly the misconfiguration this subsystem exists to prevent. Plain TCP is accepted and
documented as discouraged.

CEF is deferred (§15). It is a payload mapping on top of this adapter, it is straightforward to add
when an operator asks, and adding it now would be a second format with no consumer.

### 5.4 Ordering, retry, and the closed reason set

Per sink, batches ship **strictly in cursor order**. The first failure stops that sink's tick — it
does not skip ahead — and other sinks are untouched. That isolation is the reason the port exists at
all, and it is what §5.1's "no adapter sees another's configuration" is in service of.

Backoff is exponential from one minute to a one-hour cap, forever. There is no attempt ceiling
(§2.2).

`last_error` is one of: `network`, `timeout`, `auth`, `not_found`, `permission`, `http_status`
(with the code in the panel, as A does), `tls`, `config`. A provider message is written to the log
line and never to the column.

---

## 6. The erasure boundary, and the reversal

### 6.1 What the sink holds after a purge

`purgeRequester` clears `ip`, `ua` and `actor_id` on `audit_event` — the one UPDATE the append-only
trigger permits (`drizzle/0004`), and the whole of the requester-erasure path as it touches the audit
log. **The sink ships those columns verbatim, before any purge can reach them, into storage under
object lock.** Neither we nor the operator can go back and clear them.

Note §6 settled the analogous question for A by observing that the operator's n8n is the operator's
processor and their Art. 17 obligation reaches its execution history exactly as it reaches the
HubSpot record that execution wrote — so our claim, being about what we hold and control, remained
true unqualified. **That argument does not transfer, and it is important to say why rather than to
let the precedent carry.** Compliance-mode object lock means the operator cannot discharge the
obligation in their own bucket either. The immutability that makes the artifact worth having is the
same property that makes the data in it unerasable. There is no formulation of this in which both
guarantees hold completely; the design chooses immutability and says so.

Three alternatives were weighed and rejected: shipping those three columns redacted (keeps the
erasure claim whole, but forecloses the SIEM case and makes the off-box record unable to answer
"who"); crypto-shredding them under a per-requester key destroyed at purge (the textbook answer, but
it buys a key table, an auditor-resolution path, and a story about what restoring the key table from
backup means); and shipping verbatim plus explicit erasure notices (honest, but discharges nothing —
the data is still in the earlier object). §17 records the decision.

### 6.2 Erasure nonetheless arrives at the sink, structurally

A purge's `UPDATE audit_event` bumps that row's `xmin` above the reader's cursor, so the row is
**re-batched and re-shipped with the three columns nulled**. The sink therefore receives an erasure
record with no erasure-notice mechanism to build or maintain.

The cost is the sink's at-least-once property, and it must be documented rather than discovered: a
row may appear in more than one batch; an auditor deduplicates on `audit_event.id`; and a later copy
with nulled `ip`, `ua` and `actor_id` **is** the erasure. Under the same `id` and `seq`, so the two
copies are unambiguously the same event.

This is A's §16 residual — a swept delivery row re-enqueued by an `xmin` bump — arriving again from
the same mechanism. Inert there. Useful here.

### 6.3 What must be written down, and where

`docs/self-hosting.md` states plainly that enabling the sink moves personal data into storage no
purge reaches, in those words, next to the object-lock instructions rather than in a distant section.

The README is **unchanged**. The sink is opt-in and off by default, so its erasure bullet stays
accurate for a default deployment, and note §6's reasoning applies here undiminished: bolting an
asterisk onto a true statement to describe a feature the reader has not enabled makes it read as
weaker than it is. The qualification belongs with the feature.

---

## 7. This is not an SSRF surface, and the spec says why rather than adding a dead allowlist

Note §7 says its rule — no redirects, a destination denylist — applies to any URL-valued setting B
accepts. It does not apply here, and the reason is worth stating so nobody adds the machinery later
out of symmetry with A.

A's URLs come from an admin session: a staff user types a URL into a form and the application
connects to it, which is server-side request forgery by construction. B's destinations come from the
process environment. An operator who can set environment variables on the container can already reach
anything the container can reach, by simpler means than this feature. `EVENT_EGRESS_ALLOW`'s
machinery would be ceremony against a threat model that does not exist here, and dead security code
is worse than none because it implies a check that is not happening.

What does carry over: the S3 adapter follows no redirects, and neither does the syslog adapter have
any to follow.

---

## 8. The sink writes no audit events

Recording a shipment as an audit event would create an event that needs shipping, which would create
an event. That is an actual non-terminating loop, not merely noise.

Configuration lives in the environment, so there is no admin action to record either. This is the
same reasoning that made `egress.test` deliberately not an audit action (A §9), arrived at from a
different direction.

---

## 9. Telemetry

Reusing subsystem C, with no new exporter configuration:

| Instrument | |
| --- | --- |
| `trustcenter.auditsink.batch` | Counter, attributes `sink` and `outcome`. Counts shipments attempted and their result. |
| `trustcenter.auditsink.pending` | Observable gauge per sink, through the existing `registerQueueDepthGauge`. Unshipped batches. |
| `trustcenter.auditsink.digest_mismatch` | Counter. §4.3's detected erasures. |

Per §17's decision, this gauge and §10's panel are the **entire** alerting story. No notification
email, no auto-disable. A sink that has been down for a week shows as a growing gauge and a growing
panel number, and an operator who is not watching either finds out when they look. That is a
deliberate trade against the alternative — a threshold, a "notified at" column, a mail template in
two locales — which was considered and declined as machinery ahead of a request for it.

---

## 10. Admin surface

A **read-only** panel appended to `/admin/settings/integrations`, not a sibling route: the page is
118 lines, `[id]` under it is the event-endpoint detail page, and a status panel with no write path
does not warrant a route of its own.

Per sink: configured or not, pending batch count, age of the oldest pending batch, the last batch
shipped and when, the last error reason, and the digest-mismatch count. Above them, two facts about
the reader: total batches, and the number of `audit_event` rows not yet batched.

Gated with the existing `requireAdmin` from that route's `guard.ts`. Role `admin`, matching the
egress panel beside it.

New strings in both locales. **The German will be the implementer's and not a translator's**, which
is the same standing caveat A closed only partially; it is recorded here so it is a known state
rather than an assumption.

---

## 11. Configuration

All environment, validated in the config schema at parse time.

| Variable | |
| --- | --- |
| `AUDIT_SINK_ENABLED` | Boolean, default `false`. Mirrors `EVENT_EGRESS_ENABLED` so the sovereignty claim has one switch per egress subsystem, and so a sink can be stopped without deleting its configuration. |
| `AUDIT_SINK_BATCH_ROWS` | Integer, default 1000. |
| `AUDIT_SINK_S3_BUCKET` | |
| `AUDIT_SINK_S3_REGION` | |
| `AUDIT_SINK_S3_ENDPOINT` | Optional. Set for any S3-compatible store. |
| `AUDIT_SINK_S3_ACCESS_KEY_ID` | |
| `AUDIT_SINK_S3_SECRET_ACCESS_KEY` | |
| `AUDIT_SINK_S3_PREFIX` | Optional. |
| `AUDIT_SINK_SYSLOG_URL` | `tls://host:6514` or `tcp://host:514`. |
| `AUDIT_SINK_SYSLOG_FACILITY` | Optional, default `local0`. |

A sink is active if and only if all of its required variables are present. **Partial configuration is
a boot failure, not a silently disabled sink.** This is commit b67569e's lesson from A, where a
malformed `EVENT_EGRESS_ALLOW` booted clean and then threw inside every delivery tick and 500'd the
admin page an operator would have used to fix it. `AUDIT_SINK_ENABLED=true` with **no** sink
configured is a boot failure for the same reason: it would otherwise accumulate batch rows nothing
will ever ship, and mean the operator believes something is running that is not.

**When the sink is off, the job does not run — neither phase.** No batches are built and no cursor
advances, matching A, whose delivery path claims nothing while `EVENT_EGRESS_ENABLED` is off. Nothing
is lost by this: `audit_event` is never swept, and §3.2's default cursor of `(0, 0)` means enabling
the sink later ships everything that accumulated while it was off.

Parsing lives in `parse.ts` with the rest, and `getConfig()` stays lazy: importing the sink modules
must not require a configured environment, because `vite build` runs with none.

---

## 12. Retention

`audit_batch` and `audit_batch_shipment` rows are kept indefinitely and are **deliberately excluded**
from the retention sweep. They are metadata about a permanent log — `audit_event` itself is never
swept, and nothing in `retention.ts` touches it — and at one batch row per thousand events the volume
is negligible.

This differs from `event_delivery`, which is swept at 30 days (A §5.6), because A's delivery rows are
a log of notifications sent and B's batch rows are the local half of the evidential claim in §1.2. A
digest an auditor may want to check must outlive a retention window.

---

## 13. Testing

**Unit.** Canonical serialization determinism, including recursive `meta` key ordering and a
same-content-different-insertion-order case; digest stability across a rebuild; manifest shape and
format version; RFC 5424 message construction and RFC 6587 framing; S3 key layout; the closed reason
set's exhaustiveness against the adapters' throw sites.

**Integration, against Postgres (Testcontainers).** A §5.2's two keyset failure modes re-asserted for
B's window — the out-of-order commit and the horizon-excluded lower `seq` — because B's query is a
separate implementation of the same invariant and inheriting the tests is not the same as inheriting
the code. Then: batch-table-as-cursor crash safety (a batch row present without shipments resumes
correctly); lazy shipment-row creation, including a sink configured after batches exist receiving the
full history; strict per-sink ordering, and one sink's failure leaving the other's shipments intact;
the claim stamp, which issue #8 shows is easy to leave uncovered; and the two purge behaviours from
§4.3 and §6.2 — the digest mismatch, and the re-batched row arriving with nulled columns.

**S3 adapter, against MinIO in Testcontainers.** A second container in CI, which is the one real
infrastructure cost in this document and is called out here so it is a decision rather than a
surprise in a PR.

**Syslog adapter**, against an in-process TLS socket server. No container.

**e2e.** The admin panel renders with no sink configured and with one; the public portal is
unaffected. The existing security spec's assertions — no cookies on public routes, CSP with no
third-party origins — must continue to pass untouched, since B adds no client-side anything.

---

## 14. Documentation

`docs/self-hosting.md` gains §13, covering:

- What the sink is for, in the terms of §1.2 — including what it does not let an operator claim.
- **The erasure boundary**, per §6.3, next to the setup instructions rather than in a distant section.
- Bucket setup: versioning, object lock, retention mode, and the write-only IAM policy as a pasteable
  snippet, verified against a real bucket rather than shipped on inspection.
- S3-compatible stores, with the endpoint override.
- Syslog transport, and why UDP is not offered.
- The at-least-once rule, how to deduplicate, and erasure-by-re-shipping.
- That `seq` does not arrive monotonically, and that gap detection is over the union of batches.
- The closed `last_error` set, by name, as the operator's lookup key.
- How to verify an object: `sha256sum`, and where to find the digest we recorded.

---

## 15. What this subsystem does not do

- **No heartbeat batches.** An empty window produces nothing. Liveness is §9's gauge and §10's panel.
- **No CEF.** A payload mapping with no consumer yet (§5.3).
- **No UDP syslog** (§5.3).
- **No admin CRUD.** Configuration is environment-only (§11), which also keeps S3 credentials out of a
  database an admin session can read.
- **No backfill command.** Lazy shipment rows (§2.2) make it unnecessary.
- **No verification CLI.** The verification is `sha256sum`; shipping a tool to run it would imply the
  format needs one.
- **No filtering.** The record is the whole log or it is not the record (note §4).
- **No auto-disable, no notification email** (§9).

---

## 16. Known residuals

- **The `xid` epoch limitation, inherited from A §5.2.** `xmin::text::bigint` is a bare 32-bit `xid`
  widened without its epoch, because Postgres exposes no way to recover a tuple's epoch. The
  comparison is valid within one epoch and breaks two ways past a rollover. Centuries away at this
  system's write rate, and shared with A rather than introduced here.
- **A restore from backup re-batches already-shipped rows.** If `audit_batch` is restored behind the
  actual `audit_event` state, the reader produces new batch ids covering rows already in the sink.
  The sink is at-least-once and the duplicates are dedupable on `audit_event.id` (§6.2), so this is
  loss-free — but the batch ids differ, so the two copies are not identifiable as the same batch.
- **Batches are not `seq`-contiguous** (§1.1). `min_seq`/`max_seq` are informational, and a reader
  computing gaps from them alone will find gaps that are not gaps.
- **A digest mismatch is expected after a purge** (§4.3), not alarming. The counter in §9 will be
  non-zero on any deployment that has ever honoured an erasure request, and an operator who reads it
  as an integrity failure has read it wrong. The docs say so.
- **The object-lock warning is advisory.** §5.2's boot check degrades silently when the permission is
  absent, so a bucket without object lock and without `s3:GetBucketObjectLockConfiguration` looks the
  same as a correctly configured one. We cannot close this from inside the application.

---

## 17. Decisions taken during design

Recorded because several were close, and a later reader finding only the outcome would not know a
considered position was weighed.

| Decision | Alternatives rejected |
| --- | --- |
| **Ship `ip`/`ua`/`actor_id` verbatim**, with the boundary documented (§6) | Redact at ship; crypto-shred under a per-requester key; verbatim plus erasure notices. The first keeps the erasure claim whole but forecloses SIEM use; the second is the textbook answer but buys a key table and a restore-from-backup story; the third discharges nothing. |
| **A port plus two adapters** — S3 and syslog together (§5) | One adapter first. Two proves the boundary rather than shaping it around a single implementation, at roughly double the work. OTLP-logs was rejected outright: shipping a compliance record down a pipeline that is lossy and sampled by convention invites the wrong assumptions. |
| **Environment for secrets, admin for state** (§10, §11) | Environment-only, which gives the operator no health view; full admin CRUD like A, which would put S3 credentials in a table an admin session can read and add an SSRF story §7 shows we do not otherwise have. |
| **Retry forever, gauge only** (§9) | Adding a threshold email; disabling like A; failing the container health check. The last two convert an outage into a stop, and "we stopped shipping the audit record and waited to be asked" is a worse posture than a growing backlog. |
| **Batch manifest with a digest** (§4) | A hash chain across batches, which is stronger and verifiable offline but serializes shipping and needs a defined meaning for a chain break after a restore; or relying on object lock alone, which makes the entire evidential claim a property of a bucket configuration we cannot verify. |
| **Batches are durable rows, shipment is per-sink** (§2) | An independent cursor per sink, which is simpler but gives the same rows two different digests under two batch boundaries, undermining the artifact §1.2 asks an auditor to verify; or one shared cursor advancing only when all sinks succeed, which couples exactly what the port exists to isolate. |
| **`aws4fetch`** (§5.2) | Hand-rolled SigV4 — no dependency, but a fiddly one to get wrong; `@aws-sdk/client-s3` — the largest dependency in the tree for one signed PUT per batch. |

---

## Sources

- RFC 5424 (Syslog Protocol) and RFC 6587 (Transmission of Syslog Messages over TCP), for the message
  format and octet-counting framing in §5.3.
- `aws4fetch` package metadata, checked 2026-09-04: version 1.0.20, MIT, zero dependencies, 65,541
  bytes unpacked across 9 files, last published 2024-08-28, `github.com/mhart/aws4fetch`.
- Amazon S3 Object Lock, for the retention-mode and versioning behaviour §5.2 relies on. The
  interaction it depends on — that a PUT to an existing key under object lock adds a version rather
  than replacing one — **must be verified against a real bucket during implementation**, and against
  MinIO, before §14's operator instructions are written.
