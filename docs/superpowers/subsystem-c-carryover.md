# Integrations subsystem C — OTel egress — Carry-over

**Date:** 2026-09-03
**Branch:** `feat/otel-egress`, 26 commits from `84b71e0`
**Spec:** `docs/superpowers/specs/2026-09-02-otel-egress-design.md`
**Plan:** `docs/superpowers/plans/2026-09-02-otel-egress.md`

Records what this subsystem deliberately did not do, what it measured, and the defects it left
standing — in the shape the five phase carry-overs use, so the next reader can read it the same way.
Subsystem C is the first of the five integration subsystems (`2026-08-31-integrations-decomposition.md`
sequences them C → A → B → D → E), so this is also the first carry-over that is not a phase.

---

## 1. Spec deviations, both now folded back into the spec

Both were decided during implementation and neither was written down at the time, which is the reason
this section exists first. Both have since been reconciled: §7.1 and §7.2 of the design now say what
the code does, so a reader of the spec alone is no longer misled.

### 1.1 §7.1 listed four request-span attributes; three are implemented — spec corrected

`server.address` was dropped. It is the `Host` header — attacker-controlled, unbounded in
cardinality, and on a request that reaches the container directly it is frequently a literal IP
address. §8 bans IP addresses from telemetry outright, so an attribute whose value is *sometimes* an
IP is not a thing that can be sanitised into compliance; and a metric or span attribute an attacker
can set to any value they like is a cardinality bomb in the operator's own backend.

The three that ship — `http.request.method`, `http.route`, `http.response.status_code` — are the
three the spec's own questions need. This is a correction to §7.1, not a shortfall against it: the
attribute should not have been listed.

### 1.2 §7.2's `delivery/serve.ts` span — closed

Originally dropped: §7.2 asks for a span around the one mediated path out of storage *and* the
watermarking inside it, singling out delivery because it "buffers," and only the watermark span
shipped. That left the storage read — the thing §7.2 actually named — outside every span, so a large
document over a slow adapter reported a fast watermark inside a slow request with the gap
unexplained.

**Now implemented.** `serveDocumentFile` opens a `document deliver` span around the storage read and
the stamping, with `stampPdf`'s own span nested inside it; the difference between the two is exactly
the buffering. Attributes are `document.tier`, `document.watermarked` and `document.size_bytes`, and
the recipient appears on neither span (§8).

**What unblocked it.** The stated blocker was that `serveDocumentFile` takes a SvelteKit
`RequestEvent` no integration test could construct. That turned out to be the wrong diagnosis: the
module reads five fields off the event (`params`, `request.headers`, `locals.requester`,
`locals.locale`, `getClientAddress()`), and `tests/helpers/request-event.ts` supplies exactly those.
The real obstacle was the three lazy singletons it reaches for rather than takes — `getDb()`,
`getConfig()`, `getStorage()` — which a test can satisfy by owning `process.env` before the first
call, as `tests/integration/delivery-serve.test.ts` now does. Integration files run in isolated
forks, so that affects no other file.

That fixture is reusable, and it is the thing that was actually missing: several other server
modules take a `RequestEvent` and are covered only through e2e today. `tests/integration/download.test.ts`
carries a comment saying the authorization matrix is asserted at the module boundary "because the
endpoint needs a full SvelteKit event" — that constraint is now lifted for whoever wants to take it
up.

---

## 2. The minors: what closed, and what is deliberately still open

### 2.1 `(performance.now() - started) / 1000` is written twice in `runner.ts`

Both the success and the error path compute the elapsed seconds the same way. Extracting it is a
three-line helper for a two-line duplication, and the two call sites are eight lines apart in one
function. Left as is; it would be worth extracting the moment a third exit path appears.

### 2.2 The errored job span carries `job.name` but never `job.lock_acquired`

Honest rather than incomplete: on the error path the lock state is genuinely unknown, because the
throw can come from the `pg_try_advisory_xact_lock` query itself. Any value written there would be a
guess recorded as a fact, and a query that says "this tick did not hold the lock" is worse than one
that says nothing when the truth is "we do not know."

A one-line comment now says so in `runner.ts`, which is the actual gap — the behaviour was right and
undocumented, so the next reader would reasonably have "fixed" it.

### 2.3 The second `activeTraceId` guard — closed

`activeTraceId()` has two guards: `!span`, and an all-zero (invalid) trace id from the API's no-op
tracer. `tests/integration/audit-trace.test.ts`'s "writes null when there is no active span" case
reaches the first one only, and the second is the interesting one — it is what stops
`audit_event.request_id` filling with a 32-zero constant that looks like a correlation id on every
deployment with telemetry off.

`tests/unit/telemetry-noop.test.ts` now covers it. Reaching that guard needs a precondition no other
telemetry test file has: **no tracer provider, but a context manager installed anyway.** Without the
context manager the span is never active and the first guard catches everything; with it, the no-op
tracer hands back a live `NonRecordingSpan` carrying `INVALID_SPAN_CONTEXT`. The test asserts the raw
trace id really is the 32-zero string before asserting that `activeTraceId()` reports `undefined`, so
it cannot pass by the span being absent.

Checked the way §5 describes: with the `isSpanContextValid` guard removed, the test fails with
`expected '00000000000000000000000000000000' to be undefined`.

### 2.4 Four cleanup findings left standing

A final `/simplify` pass over the branch fixed reuse, indentation and closure-retention problems (see
§4). Four of its findings were skipped on judgement, and are recorded here so they are decisions
rather than oversights:

- **A `withRequestSpan(event, fn)` seam owned by `telemetry/`.** Would pull `isHttpError` and
  SvelteKit into a directory that is otherwise framework-free. Extracting `handleRequest` in
  `hooks.server.ts` got the blame-and-indentation benefit without that coupling.
- **`withSpan` owning duration and outcome.** It has the try/catch where both are known, so both
  metric call sites reopen a second `performance.now()` around it. But the two differ genuinely — a
  status code versus a three-valued outcome including `locked` — so the shared version would need a
  per-site callback anyway.
- **A shared structured `logError()`.** `console.error(JSON.stringify({ level: 'error', … }))` is now
  hand-written four times, and `provider.ts`'s comment justifies itself by matching the other copies.
  Two of the four predate this branch, so fixing it properly is a change outside C.
- **A `jobAttributes()` beside `requestAttributes()`.** One repeated attribute key across three
  literals; an abstraction would cost more than the drift it prevents.

### 2.5 e2e teardown noise — mechanism removed, symptom never reproduced

`tests/setup/e2e-db-teardown.ts` drops the e2e database `WITH (FORCE)` while the 15-second
`mail:drain` tick is still live, so a run can end with a connection error from a job querying a
table that has just gone.

**What was fixed.** `stopJobRunner` had been exported and called from nowhere since Phase 1 (spec
§3.4). This subsystem added a `sveltekit:shutdown` handler for the telemetry flush, which is the seam
it was waiting for, so the job timers are now cleared on shutdown. The timers were already
`unref()`ed and so never held the process open — the gap was an interval firing *during* teardown,
against a pool that is closing.

**What was not demonstrated.** The e2e symptom did not reproduce, in a run with the fix or in a
baseline run without it (103 passed, no job or connection line in either). So this is recorded as a
mechanism closed on the application side, not as a fix to an observed failure. What remains is
genuinely the harness's ordering — Playwright's `globalTeardown` drops the database before it reaps
the web server, so a server it does not own, or does not reap promptly, can still outlive its
database. That is a change to the harness rather than to C, and it stays open.
