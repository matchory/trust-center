# Phase 4 — Notifications and Subscriptions — Carry-over

**Date:** 2026-09-02
**Branch:** `feat/phase-4-notifications`, 32 commits from `1f35319`
**Spec:** `docs/superpowers/specs/2026-09-02-phase-4-notifications-design.md`, as amended by its §15
**Plan:** `docs/superpowers/plans/2026-09-02-phase-4-notifications.md`

Records what the phase deliberately did not do, what it measured, and the defects it left standing —
in the shape the previous five carry-overs use, so the next phase can read it the same way.

---

## 1. Two design errors this phase found in its own spec

Both were found after the spec was approved, and both are worth remembering because of *how* they
were found rather than what they were.

**The addition-coverage anchor did not do what it claimed.** §15's amendment #2 changed the
subprocessor addition condition from "no live covering post at all" to "none on or after
`started_at`", to stop a post announcing a *removal* from clearing the *addition* warning. It does
not: a removal post published later satisfies that lower bound trivially, so anchored and unanchored
behave identically in exactly the scenario the anchor was introduced for. Closed in amendment #15 by
bounding the condition above by `ended_at` as well.

It surfaced from a **duplicated test case**. Two cases in the plan passed byte-identical arguments,
and one of them was named for the removal scenario. The name described a behaviour the predicate did
not have. "These two tests are identical" turned out to be a statement about the spec.

**Hashed storage for the management token was incompatible with mailing the link.** §4.2 stored both
tokens hashed while three other sections mailed the manage link. A one-way hash can produce its
plaintext exactly once, at confirmation, so every notice mail would have carried a link the job could
not build. Found while writing the implementation plan, by trying to write that code. The
confirmation token stays hashed; the management token is stored recoverably, with the argument for
why the asymmetry is right rather than merely convenient in §4.2.

---

## 2. Deferred, with the reasoning

### 2.1 A read-then-write race in the notification tick

`notifySubscribers` runs its select outside the transaction that writes. A `saveSubscription`
committing in that window is rolled backwards by the tick's `UPDATE`, losing the cursor push that
P4.18 exists to perform — so the subscriber receives the back catalogue that save was meant to
suppress.

The window is one tick's in-memory processing. The effect is over-notification rather than a lost
notice, which is the right direction to fail in, and matches the at-least-once posture the single
transaction was chosen for.

**The fix is one line, and smaller than this phase first recorded.** The initial note claimed a guard
needs per-row reconciliation with the already-built insert. That is true of the
`AND subscription.last_notified_at = v.previous` form, but not of the monotonic form: appending

```sql
AND subscription.last_notified_at < v.cursor
```

to the existing `UPDATE … FROM (VALUES …)` needs no extra column and no reconciliation. A row whose
cursor was pushed to `now()` by a save simply does not match, and since `now() > v.cursor` the next
tick finds nothing older than the save, so the queued mail is not duplicated. Correcting this here
so the next reader does not re-derive the harder fix.

### 2.2 The migration validates a constraint under an exclusive lock

`drizzle/0025_plain_surge.sql` drops and re-adds `audit_event_actor_type_check` to admit the
`subscriber` actor. `ADD CONSTRAINT … CHECK` takes `ACCESS EXCLUSIVE` and validates every existing
row, and `audit_event` is append-only by design, so the scan grows with the deployment's age.

Not changed, twice, for two different reasons. The first was that Drizzle's snapshot cannot represent
`NOT VALID`, so hand-writing it risks the next `db:generate` re-emitting the constraint. The
whole-branch review refined that: `ADD CONSTRAINT … NOT VALID` followed by `VALIDATE CONSTRAINT`
leaves `convalidated` true, so the snapshot concern dissolves. By then the migration had been applied
in development and the phase was closing, and changing the only migration of a phase at that point is
a worse risk than the scan it saves.

The new value set is a strict superset of the old, so validation cannot fail; migrations run at boot
before traffic in the shipped single-container deployment. This is a slow start, not an outage.

### 2.3 Whether the subscribe form should be indexable

`/subscribe` is now a `PORTAL_SECTIONS` entry, so every indexed portal page links to it — and it
carries `noindex, nofollow`, which also suppresses its canonical and hreflang alternates. It is
absent from the sitemap, deliberately.

The precedent it inherited from is `/request`, which is also `noindex` but is **not** in the nav. So
the one new public, cacheable, discoverable page in the phase is invisible to search. The spec asks
for `noindex` only on the two token-bearing pages (§10.3, P4.21) and says nothing about the form.

Left as-is because it is a decision about what search engines see, which belongs to the repository
owner rather than to an implementation phase. If the form is meant to be found, drop the `noindex`.

### 2.4 Two intermittent tests, neither in code this phase touched

- `tests/integration/setting.test.ts`
- `tests/e2e/auth.spec.ts:92` — "signing out revokes the session immediately, at the server"

Both pass in isolation and fail occasionally under full-suite load. Neither is in code this phase
modified, and `git diff` over `tests/e2e/` and `playwright.config.ts` across the whole branch is
empty.

The suspicion is shared-resource contention: integration files serialize over one Testcontainers
Postgres (`fileParallelism: false`), and the e2e suite mints a database inside the dev Postgres.
**That is a hypothesis, not a diagnosis.** This phase also adds a sixth timer and two integration
suites to the same environment, so the load they fail under is now higher than when they were first
seen. Worth a tracked item rather than a note — and worth checking neither is being silently retried.

Phase 3c opened with a task devoted to exactly this class of problem; the same discipline applies.

### 2.5 An environment defect found while verifying

`matchory-trust-center-postgres-1` publishes **no host port**. A leftover
`phase-3a-scope-is-a-set-postgres-1` container from a finished phase answers on `127.0.0.1:5433`,
which is where `.env`'s `DATABASE_URL` points. So the dev server and every hand-verification in this
phase reached the phase-3a container rather than this project's own.

Nothing in the phase is invalidated by it — integration tests use their own Testcontainers instance,
the e2e suite mints a throwaway database, and all 26 of this branch's migrations were confirmed
applied in the container actually being reached. The risk is future: `docker rm` of a long-finished
phase's container is reasonable housekeeping and would silently break the dev environment, with a
symptom that points at nothing obvious.

Not fixed, because stopping or recreating containers is an environment change outside this plan.

---

## 3. Accepted minors

Triaged by the whole-branch review as shipping rather than blocking. Recorded so nobody re-discovers
them as findings.

| What | Why it stands |
| --- | --- |
| Three of four paired check constraints tested in one polarity | Two "accepts a well-formed row" tests cover both states positively |
| `hashToken`/`newToken` are a third copy, beside `identity/magic-link.ts` and `identity/requester.ts` | Extraction across three identity modules is its own change; CLAUDE.md forbids refactoring adjacent working code |
| Confirm and manage tokens are minted before the branch that needs them | `randomBytes(32)` is cheap and the discarded value is never stored |
| `subscriptionByManageToken` does two round trips rather than a join | Two indexed lookups on a per-request page |
| An invalid (not absent) topic value renders "choose at least one topic" | Both Zod issues report `path[0] = 'topics'`; only reachable by a crafted body |
| A 404 thrown from a manage action carries no `no-store` | POST responses are not shared-cached, and the token is in the request line either way |
| The coverage badge uses `text-xs` where other admin badges use `text-sm` | The amber-vs-neutral colouring is an intentional departure: this signals a warning, not a status |
| `tests/e2e/subscribe.spec.ts`'s malformed-topics case leaves its row | The e2e database is per-run |

One was struck from this list on inspection: the migration's missing trailing newline is **house
convention**, not an omission — all 23 prior migration files lack one.

---

## 4. What the phase measured

| | Before | After |
| --- | --- | --- |
| Unit tests | 177 | 198 |
| Integration tests | 242 | 280 |
| E2e tests | 99 | 103 |
| Migrations | 24 | 25 |
| Background jobs | 5 | 6 |
| Mail templates | 9 | 12 |
| Audit action names | — | +4, permanent |

`pnpm check` at 0 errors and 0 warnings throughout; `vite build` succeeds with `DATABASE_URL`,
`OIDC_CLIENT_SECRET` and `SMTP_URL` unset at every gate.

---

## 5. One process note worth keeping

Three defects in this phase were caught by **mutation testing done by hand** — applying the inverse
of a rule and checking whether any test fails:

- The cursor advancing past a *skipped* post was unpinned; a mutant moving that line passed all seven
  tests, because the only skipped-post case used a single-post subscription whose cursor was already
  seeded to that post's date.
- The notification tick's bound was unpinned; the test used one post and two subscribers, so the
  subscriber count and the joined-row count were the same number and a mis-scoped `LIMIT` produced
  identical output.
- The coverage predicate's branch order was unpinned; branch order is only observable when both
  conditions are true at once, and no case reached that state.

All three were correct in implementation and undefended in test. None would have been found by
reading the tests, and all three are rules a later reader would reasonably delete as dead weight.
When a rule matters, applying its inverse and watching a test fail is cheap and is the only evidence
that the test defends it.

---

## 6. Amendment — 2026-09-02, after the phase closed

Closing §2.1 and answering §2.4, which was recorded as a hypothesis rather than a diagnosis.

### 6.1 The notification race is closed

`AND subscription.last_notified_at < v.cursor`, exactly the monotonic form §2.1 corrected itself to.
It is pinned by an integration case that interposes a `saveSubscription` in the real window — a proxy
around `Db` that runs the save when `notifySubscribers` opens its write transaction, which is after
the select has already read the stale cursor. Without the guard the cursor is rolled back to the
post's date and the next tick delivers the back catalogue; with it the save stands.

### 6.2 §2.4's shared-resource-contention hypothesis was wrong

Neither test fails for the reason recorded, and load is not the variable in either case.

**`setting.test.ts` is shared state plus file ordering.** Half its cases assert on the *absence* of a
key, and `setting` is one global table with no per-test axis. `nda-grants.test.ts` leaves
`nda.default_template_id` behind. Vitest's sequencer does not order files alphabetically, so whether
that row is present is a property of ordering, not of load — and `nda-delivery.test.ts` clears the
table in its own `beforeAll`, so the flake also depends on whether that file happens to land between
them. Reproduced deterministically:

```sh
pnpm test:integration tests/integration/nda-grants.test.ts tests/integration/setting.test.ts
```

Fixed in the test, not in the fixture that dirtied the table: a `beforeEach` clean slate, the same
one `subscription-notify.test.ts` already takes for the same reason.

**`auth.spec.ts:92` did not reproduce.** Three consecutive full-suite runs passed 103/103. The only
reproduction achieved was an artifact of the reproduction method: `--repeat-each` with parallel
workers puts several workers on the plain `admin` fixture account at once, and signing in revokes
that staff member's other sessions — the deliberate property `tools/dev-idp/server.js` and
`tests/helpers/admin.ts` both already document. Single-worker repeats pass 20/20. The suite itself
never does this, because the file's cases run serially in one worker and nothing else claims `admin`.
So this remains open and undiagnosed, but it is *not* contention, and the next attempt should capture
the received URL from a real full-suite failure before changing anything.

**Nothing is silently retried.** `playwright.config.ts` sets no `retries`, so the default of 0
applies. That question from §2.4 is answered.

**`--repeat-each` is not a valid stressor for this suite.** Beyond the account collision, spec files
build fixtures with fixed slugs in `beforeAll` and delete them in `afterAll`, so parallel copies of
one file collide on unique constraints and tear each other's fixtures down. Stress the real
configuration by repeating whole runs.

### 6.3 A third intermittent test, found and fixed on the way

`access-portal.spec.ts:149`, "the gated portal is never cached", failed a full-suite run with
`public, max-age=0, s-maxage=60, must-revalidate`. Its local `signIn` returned without waiting for
the verification POST's navigation. Every other caller follows with a retrying assertion and tolerates
that; this one follows with `page.goto`, which cancels the pending POST and requests the gated subtree
with no session cookie — landing on the public request form, whose headers are exactly the ones
asserted against. A security assertion failing for a reason unrelated to the security property is the
worst shape a flake can take, since the obvious reading of the failure is that the portal really is
cacheable. Fixed by making the helper wait for its own navigation.

### 6.4 §2.5's environment defect is still present

Confirmed today: `matchory-trust-center-postgres-1` publishes no host port, and
`phase-3a-scope-is-a-set-postgres-1` still answers on `127.0.0.1:5433`, where `.env` points.
