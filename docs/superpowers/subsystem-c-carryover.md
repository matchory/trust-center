# Integrations subsystem C — OTel egress — Carry-over

**Date:** 2026-09-03
**Branch:** `feat/otel-egress`, 23 commits from `84b71e0`
**Spec:** `docs/superpowers/specs/2026-09-02-otel-egress-design.md`
**Plan:** `docs/superpowers/plans/2026-09-02-otel-egress.md`

Records what this subsystem deliberately did not do, what it measured, and the defects it left
standing — in the shape the five phase carry-overs use, so the next reader can read it the same way.
Subsystem C is the first of the five integration subsystems (`2026-08-31-integrations-decomposition.md`
sequences them C → A → B → D → E), so this is also the first carry-over that is not a phase.

---

## 1. Two undocumented spec deviations

Both were decided during implementation and neither was written down until now, which is the reason
this section exists first.

### 1.1 §7.1 lists four request-span attributes; three are implemented

`server.address` was dropped. It is the `Host` header — attacker-controlled, unbounded in
cardinality, and on a request that reaches the container directly it is frequently a literal IP
address. §8 bans IP addresses from telemetry outright, so an attribute whose value is *sometimes* an
IP is not a thing that can be sanitised into compliance; and a metric or span attribute an attacker
can set to any value they like is a cardinality bomb in the operator's own backend.

The three that ship — `http.request.method`, `http.route`, `http.response.status_code` — are the
three the spec's own questions need. This is a correction to §7.1, not a shortfall against it: the
attribute should not have been listed.

### 1.2 §7.2's `delivery/serve.ts` span was dropped

§7.2 asks for a span around the one mediated path out of storage *and* the watermarking inside it,
singling out delivery because it "buffers." Only the watermark span shipped.

`serveDocumentFile` takes a SvelteKit `RequestEvent`, and no integration test in this repository
constructs one — the unit fakes in `tests/unit/telemetry-request.test.ts` and
`tests/unit/hooks-locale.test.ts` cover only what `handle` reads, which is a much smaller surface
than `serveDocumentFile` touches. A span added there would therefore ship untested, and this
subsystem's whole argument for manual instrumentation (§4) is that a missing span is a missing line
of code rather than a silent breakage — an untested span is neither.

**What the watermark span does and does not cover.** It covers the CPU cost of stamping, which is
real. It does *not* cover the storage read that precedes it: `serveDocumentFile` buffers the whole
object out of storage and only then calls `stampPdf`, so the buffering — the thing §7.2 actually
singled out — is outside the span. On a large document over a slow storage adapter, the span will
report a fast watermark inside a slow request and the gap will be unexplained.

**What would unblock it.** Either of:

- a `RequestEvent` fixture the integration suite can build, which would also serve the several other
  server modules that take one and are tested only through e2e today; or
- moving the span up to wrap the storage-read-plus-stamp block inside `serveDocumentFile`, which
  needs no new attributes — `document.pages` stays where it is — and measures what §7.2 named.

Raised by the final review of this branch and deliberately not taken there: reopening the
untestable-`RequestEvent` problem in a fix wave is the wrong moment for it.

---

## 2. Deferred minors, with the reasoning

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

### 2.3 The `audit-trace` no-active-span case does not exercise the branch its comment implies

`activeTraceId()` has two guards: `!span`, and an all-zero (invalid) trace id from the API's no-op
tracer. `tests/integration/audit-trace.test.ts`'s "writes null when there is no active span" case
reaches the first one only — it calls `recordEvent` outside any span at all.

The second guard is the interesting one, because it is what stops the column filling with a constant
that looks like a correlation id on every deployment with telemetry off. Reaching it needs a test
that runs `withSpan` under the *no-op* tracer, which means a file that deliberately registers no
provider — the opposite precondition to every other telemetry test file, all of which register one.
Worth doing, not worth doing inside this branch's last commits.

### 2.4 e2e teardown noise, pre-existing

`tests/setup/e2e-db-teardown.ts` drops the e2e database while the 15-second `mail:drain` tick is
still live, so a run
can end with a connection error from a job querying a table that has just gone. It predates this
branch — the timers are Phase 1 — and is adjacent to §3.4 of the spec's note that `stopJobRunner` is
exported and called from nowhere. Fixing it means giving the preview server a shutdown path the e2e
harness actually invokes, which is a change to the harness rather than to C.

---

## 3. What the branch measured

| | Before | After |
| --- | --- | --- |
| Unit tests | 199 | 227 |
| Integration tests | 281 | 287 |
| E2e tests | 103 | 103 |
| Migrations | 26 | 26 |
| Tables | — | unchanged; C has no state beyond a process-lifetime SDK |
| Span names | — | +4, permanent |
| Metric names | — | +4, permanent |

`pnpm check` at 0 errors and 0 warnings throughout, and
`env -i PATH="$PATH" HOME="$HOME" pnpm build` succeeds at every gate — which is the property C7 and
C2 exist to protect, since the SDK packages are behind a dynamic import that only runs when an
endpoint is configured.

**The unit suite regressed to 9.9s and was brought back to ~1.5s.** The cause was
`tests/unit/telemetry-provider.test.ts`: it built a real `OTLPTraceExporter` against a dead port and
then ended a span, so the batch processor had something to flush and the exporter spent the
difference in its own retry/backoff. Fixed by never ending the probe span — an unended span is never
enqueued, so shutdown's flush has nothing to send and the dead port is never actually dialled. The
suite is back at 1.5s and the test is stronger than it was, because it now asserts on
`startTelemetry`'s return value rather than on side effects a stacked second provider would leave
looking identical.

---

## 4. One process note worth keeping

**Three separate vacuous assertions were caught in this branch.** Two by review, and one by a
reviewer who deleted the guard under test and confirmed every assertion still passed.

The sharpest was the branch's own permanent security regression test: the request-path leak case in
`tests/unit/telemetry-request.test.ts` asserted four `.some(...) === false` predicates over the
collected span attributes — every one of which an **empty array** satisfies. A `withSpan` that
emitted no span at all would have passed the file unchanged, which is to say the test defending "no
span carries a credential" could be satisfied by having no spans. It now pins the span count first.

The same shape appeared in the histogram tests: the existing metric cases asserted only on attribute
keys, and passed identically whether or not the histograms declared bucket boundaries — which is
exactly how two histograms shipped with millisecond-shaped default buckets recording seconds. The
test that would have caught it reads `dataPoints[0].value.buckets.boundaries`, and now does.

Deleting the guard and watching the test fail is the only thing that distinguishes a test which
defends a rule from one that merely mentions it. Every fix in the final wave was checked that way.
It is the same discipline `phase-4-carryover.md` §5 records, arrived at independently, which is
probably the strongest argument for keeping it.
