# Integrations subsystem B1 — audit log sink — Carry-over

**Date:** 2026-09-04
**Branch:** `feat/audit-sink`, 24 commits from `a9c56a3`
**Spec:** `docs/superpowers/specs/2026-09-04-audit-sink-design.md`
**Plan:** `docs/superpowers/plans/2026-09-04-audit-sink-b1.md`
**Spike:** `docs/superpowers/specs/2026-09-04-audit-sink-spike.md`

Records what this subsystem deliberately did not do, what it measured, and the defects it left
standing — in the shape the phase carry-overs and `subsystem-c-carryover.md` use. B1 is the second
integration subsystem to land (`2026-08-31-integrations-decomposition.md` sequences them C → A → B →
D → E; D landed before B). B2 — the syslog adapter — is not in this branch and is not started.

---

## 1. What the spike settled, and the one premise still open

The plan's Task 1 existed because the design carried two unverified infrastructure premises under a
document marked "Approved design". Both were checked on 2026-09-04 against MinIO. Raw output is in
the spike findings; the verdicts:

- **A PUT to an existing key under object lock adds a version rather than being refused.** Holds.
  This is what makes §5.2's deterministic key safe on retry.
- **Governance mode refuses a delete without `s3:BypassGovernanceRetention` and permits it with.**
  Holds. This is what §6.1's erasure argument rests on, and it is why governance is the documented
  default rather than compliance.

A third question was answered while the bucket was up, because Task 7 needed it: **the bucket's
default retention applies to a plain PUT**, so the adapter sends no object-lock headers. That keeps
retention the operator's decision and keeps `s3:PutObjectRetention` out of the write-only policy.

**Still open: neither premise was checked against a real Amazon S3 bucket.** No AWS credentials were
available. Both behaviours are what the Object Lock documentation specifies and MinIO agrees, but
"documented, and MinIO agrees" is weaker than "we ran it". If Amazon refuses a re-PUT to a locked
key, §5.2's retry path fails in production against Amazon while every test passes against MinIO.
Closing it costs one PUT, one re-PUT and one versioned listing against a real locked bucket. Recorded
as a residual in the design's §16, and stated plainly in `docs/self-hosting.md` §13 rather than
glossed.

**A note on ordering.** The plan put the spike first and said to stop before Task 2 if a premise
failed. In practice Tasks 2–6, 8 and 9 were implemented first and the spike ran before Task 7, which
is what correction C3 says the dependency actually is — the findings gate the adapter, not the
schema. The order was right; the plan's checkboxes were never ticked, so the plan file reads as
untouched. The record of what shipped is the design's §19, not the plan.

---

## 2. Deviations from the plan, and why

### 2.1 The kill-switch test is a unit test, not an integration test

Task 10 Step 1 sketched "does nothing at all while the sink is disabled" as an integration test
calling `setConfig({ auditSink: { enabled: false } })`. **No such seam exists in this codebase** and
inventing one would have added a production-code affordance for a test.

`tests/unit/auditsink-switch.test.ts` mirrors `tests/unit/egress-switch.test.ts` instead, which is
the established shape for exactly this property: the assertion is which calls are *not* made, and a
test that proves absence has to control every collaborator. It also proves more than the sketch did —
that phase two ships nothing phase one did not claim, that a due attestation is written in phase two
and stamped only after, and that a stamp still advances when a sink rejected it.

Mutation-checked: removing `if (!auditSink.enabled) return;` fails exactly one test, and restoring it
returns the file to green.

### 2.2 Two things the plan did not name, implemented anyway

**`ship()` returns the object key it wrote.** The plan's own self-review flagged this as "one
deliberate asymmetry to watch in review": Task 6 wrote `object_key` as the batch id, Task 7's adapter
computes a full path, and the reviewer was asked to reconcile them. An earlier commit on this branch
had already refused to write a fabricated key and left the column `null` with a comment deferring it
to "once the port can report a real key". The port now reports one — or `null` from a transport that
addresses no object, which is what syslog will return. Without this the column was permanently null
in a table that forbids DELETE.

**The object-lock probe.** §5.2 requires the adapter to read the bucket's lock configuration and
surface it in §10's panel, and no task owned it — Task 7 did not list it and Task 11 only listed the
strings for its four values. It is an optional port method, because a syslog receiver's retention is
not something we can ask it, implemented by the S3 adapter and memoised per bucket origin.

### 2.3 The nav badge came from the spec, not the plan

§10's last line — "an oldest-pending age beyond a threshold is surfaced as a badge in the admin
navigation" — has no task in the plan. It was implemented, because §9 is explicit about why it
matters: on a default deployment `startTelemetry` returns early and there is **no gauge at all**, so
the panel alone leaves a stuck sink visible only to someone who opens one particular page.

Threshold: **six hours**, chosen against §3.1's "minutes to hours" latency budget and deliberately
far above the 15-minute default batch age, so the ordinary rhythm never raises it. It is a named
constant (`BACKLOG_THRESHOLD_MS`), not a literal.

---

## 3. Measurements

- **Spike**: `quay.io/minio/minio:latest`, bucket created with `mc mb --with-lock`, governance
  default. Two versions retained under one key after a re-PUT; delete refused as `WORM protected`
  without the bypass, both versions removed with it.
- **IAM policy**: the snippet in `docs/self-hosting.md` §13 was applied to a MinIO bucket through
  `mc admin policy create` and exercised by a constrained user — PUT succeeded, DELETE was refused
  with `Insufficient permissions to access this path`, `ListBucket` was refused as `Access Denied`,
  and the optional lock-configuration statement made the retention readable. It is not written from
  memory.
- **Dependency**: `aws4fetch@1.0.20`, pinned, MIT, **zero dependencies** — confirmed from the
  installed `package.json`, which is the reason the spec chose it.
- **Suites at the close of the branch**: 369 unit, 415 integration (41 files), 106 e2e, `pnpm check`
  0 errors / 0 warnings over 2714 files, `npx drizzle-kit check` clean, and `pnpm check` and
  `pnpm build` both green under `env -i` — the CI property that the build needs neither secrets nor a
  database.
- **CI cost**: one new container. The integration suite now starts MinIO alongside Postgres in
  `tests/setup/minio.ts`, for every integration run rather than only the two files that need it.
  Called out in the spec as the one real infrastructure cost here, and it is.

---

## 4. Defects and costs left standing

### 4.1 The coverage panel runs `count(*)` on `audit_event`

`auditSinkStatus` reads `count(*)` and `max(seq)` from `audit_event` on every render of
`/admin/settings/integrations`. In Postgres that is a sequential scan; A §16 already names ~1M rows
as the point where such scans need bounding, and an audit log is the table most likely to get there.

Kept because §10 asks for coverage as an **exact** comparison and says why: the alternative it
rejects — "rows not yet batched" from the keyset — reads zero in exactly the two cases that matter.
An estimate from `reltuples` would make the comparison approximate, and an approximate coverage
figure is worse than a slow exact one on a page an auditor is being shown.

Not measured against a large table. If it becomes a problem the fix is a cached count with an
explicit as-of timestamp, so the page keeps saying what it knows and when it knew it, rather than
silently reporting an estimate. The same `count(*)` runs in `buildAttestation`, once per
`AUDIT_SINK_ATTEST_INTERVAL` (24 hours by default), where the cost is irrelevant.

### 4.2 The nav badge is a query on every admin page render

`auditSinkBacklog` runs on the admin layout load, so it is one query on every admin page, not only
the integrations page. It returns before touching the database while the sink is off — which is the
default — and it is deliberately not the full status: no object-lock probe, no per-sink facts, one
indexed query against `audit_batch`.

Recorded because it is a cost the layout did not previously carry: `+layout.server.ts` was
synchronous before this branch and is now async.

### 4.3 The object-lock probe caches failure for the life of the process

A bucket whose lock configuration we may not read reports `unknown`, and that answer is memoised
alongside a successful one. An operator who fixes the IAM policy sees `unknown` until the container
restarts.

Deliberate: the alternative is an S3 round trip on every admin page render for the failing case,
which is the case a misconfigured deployment is in permanently. A restart is the deployment's own
answer to a changed policy, and `resetObjectLockProbes()` exists for tests rather than as an
operator affordance.

### 4.4 "The last error a sink is still carrying" is approximate

The panel picks it with `DISTINCT ON (sink) … ORDER BY sink, next_attempt_at DESC` over unshipped
rows. `next_attempt_at` is pushed forward on both a claim and a failure, so the row with the latest
one is the most recently *touched* row rather than provably the most recently failed. With a
single-digit backlog they are the same row; with a large one the panel may name a different batch's
error than the newest failure.

The reason it does not matter much: `last_error` is a closed-set value, and a sink failing at all
usually fails the same way for every batch. If it ever needs to be exact, the shipment table would
need a `last_attempt_at` distinct from `next_attempt_at`, which is a migration.

### 4.5 The German is the implementer's

26 new `admin_auditsink_*` keys in both locales. The German is not a translator's — the same standing
caveat subsystem A carries, stated in the commit and repeated here so it is not rediscovered.

### 4.6 `SINK_NAMES` is duplicated in three places by hand

The TypeScript constant, the `audit_batch_shipment_sink_check` CHECK constraint in `drizzle/0028`,
and the schema comment that says they are kept in sync by hand. That is the discipline
`audit_event_actor_type_check` already uses, so it is consistent rather than novel — but adding
`'syslog'`'s successor means editing two files, and only the CHECK constraint will complain.

---

## 5. What B2 inherits, and what it does not have to do

`SINK_NAMES` and the CHECK constraint already carry `'syslog'`. The panel already renders it as not
configured. The queue-depth gauge is already registered for it, and reports the true pending count
rather than going silent. `pendingShipments`, `claimShipments` and `shipClaimed` are all keyed by
sink and take a list of adapters, so B2 adds an adapter rather than reworking the spine.

What B2 owns: the adapter itself (§5.3), its TLS configuration including private-CA and mutual TLS,
its message-size cap, its docs, and its tests against an in-process TLS server. Its `ship()` should
return `null` — a syslog receiver has no object to point an auditor at, and that is exactly the case
the port's return type was widened for.

Two things B2 must not assume it inherits:

- **`AUDIT_SINK_SYSLOG_*` is not parsed today.** §11 lists the variables; `config/parse.ts` does not
  read them. Setting them currently does nothing, and `docs/self-hosting.md` §13 says so under "Not
  yet shipped". B2 adds them to the schema, to §3's table and to `.env.example`.
- **The partial-configuration boot failure is S3-shaped.** `parse.ts` refuses `AUDIT_SINK_ENABLED`
  with no sink and refuses a partially set S3 block. B2 has to extend the first rule rather than
  replace it, or enabling the sink with syslog alone will refuse to boot.

---

## 6. Cleanup findings not taken

- **`adapterFor()` in `status.ts` builds an adapter to answer "is this configured?"** It constructs
  an `AwsClient` to return a boolean for the syslog row's benefit. Cheap — no network, no
  credentials validated — and the alternative is a second function that reads the same config and can
  drift from the first about what "configured" means.
- **`coverage()` and `buildAttestation()` ask `audit_event` the same two questions.** The shapes
  differ (`::text` for the attestation because those values are bigints an auditor may parse with any
  tool; `::int` for the panel because it renders them), and merging them would mean one of the two
  callers converting back. Left as two queries with the same predicate.
- **`transportReason()` maps every non-abort throw to `network`.** A DNS failure, a refused socket
  and a TLS handshake failure are one value. `SHIPMENT_ERROR_REASONS` has `tls` for the last of
  these, and B2's syslog adapter has a producible rule for it; over `fetch` the cause is not reliably
  distinguishable without parsing an error message, which is what §5.4 exists to avoid.
