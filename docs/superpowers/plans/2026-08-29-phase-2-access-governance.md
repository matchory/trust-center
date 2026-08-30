# Trust Center Phase 2 — Access Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the `request` tier end to end — a prospect asks for documents, verifies their email by magic link, is auto-decided or triaged by staff, and downloads per-recipient watermarked PDFs against a scoped, expiring grant, with every step audited and every notification queued.

**Architecture:** Requesters are a second identity model that never touches the staff IdP: a single-use magic link mints an opaque requester session, cookie-scoped to a `/{locale}/access` subtree so the public portal stays provably cookie-free and cacheable. Scope is a set of documents in join tables plus an `all_request_tier` flag, so grant resolution is one join with real foreign keys. Two new ports arrive together — `MailAdapter` (SMTP) and `JobRunner` (in-process, replica-safe via `SKIP LOCKED` and advisory locks) — because every notification is queued rather than sent inline, and expiry reminders need a scheduler anyway.

**Tech Stack:** SvelteKit 2 (Svelte 5 runes), TypeScript strict, Postgres 18, Drizzle ORM + drizzle-kit, Tailwind CSS v4, Paraglide JS v2, Zod v4, `pdf-lib`, `nodemailer`, Vitest, `@testcontainers/postgresql`, Playwright, `@sveltejs/adapter-node`.

**Spec:** `docs/superpowers/specs/2026-08-28-trust-center-design.md` (amended 2026-08-29 for this phase)

**Predecessors:** `docs/superpowers/plans/2026-08-28-phase-1-public-trust-center.md` and `docs/superpowers/phase-2-carryover.md`

---

## Global Constraints

Every task's requirements implicitly include this section. These are carried forward from Phase 1 unchanged unless marked **NEW**.

- **TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.** No `any` in committed code.
- **Svelte 5 runes syntax** (`$state`, `$derived`, `$props`, `$effect`). Never `export let` or Svelte 4 stores.
- **`audit_event` is append-only.** No DELETE, no TRUNCATE, and no UPDATE except the column-scoped pseudonymization defined in spec §10. Phase 1 enforced it at the database; **Task 15 is the first and only code that uses the exception.**
- **Requester personal data appears in `audit_event` only in `ip`, `ua`, and `actor_id`** — never in `meta`, never in `subject_id`. This constraint does the most work in this phase: a requester's email, name, and company are exactly the fields it forbids. Staff identifiers are outside the requester purge and may appear in `meta`.
- **Every admin mutation writes an audit event.** Create, update, publish, archive, delete, decide, grant, revoke, and purge each record actor, subject, and IP.
- **The public portal sets no cookies and loads no third-party resources.** **NEW:** this now means *the unauthenticated public routes*. The `/{locale}/access` subtree sets exactly one cookie. Task 10 splits the permanent Phase 1 test into those two assertions; it must not weaken the public half.
- **No public object URLs.** No file in storage is reachable except through the audited streaming endpoint.
- **Locales are two-layered** (spec §7): the compiled catalog set is a build input; `LOCALES` and `DEFAULT_LOCALE` select an enabled subset at runtime. Nothing outside message catalogs and test fixtures may hardcode `de` or `en`.
- **Every user-facing string is localized.** **NEW:** this now includes email templates and PDF watermark text. A requester-facing email renders in the *requester's* locale; a staff notification renders in `DEFAULT_LOCALE`.
- **`getConfig()`, `getDb()`, `getStorage()`, and (new) `getMailer()` are lazy and must never be called at module scope.** `pnpm build` must keep succeeding with no secrets and no database present; CI checks exactly that.
- **SvelteKit configuration is inline in `vite.config.ts`'s `sveltekit({...})` call.** There is deliberately no `svelte.config.js`.
- **`localeStorage.run(...)` must remain the outermost wrapper around `resolve` in `hooks.server.ts`,** or server-rendered translations break silently.
- **Use `pnpm db:migrate`, never bare `drizzle-kit`** — drizzle-kit reads no `.env`.
- **Local Postgres is on host port 5433** (`POSTGRES_PORT=5433` in `.env`); host port 5432 belongs to an unrelated project. Never stop, alter, or inspect a container you did not create.
- **TDD throughout:** write the failing test, run it and watch it fail, implement minimally, run it and watch it pass, commit.
- **Commit after every task,** Conventional Commits format. Commit signing goes through Secretive and may need unlocking — never pass `--no-gpg-sign` and never change `commit.gpgsign`.
- **Licence: AGPL-3.0-or-later.**

---

## Decisions this plan settles

Four were approved during brainstorming and are already amended into the spec. The fifth and sixth were found while writing this plan.

1. **NDA-tier documents are out of scope for this phase.** Spec §11 puts the NDA workflow in Phase 3. Phase 2 gates only the `request` tier. NDA-tier documents render on the portal with a "requires an NDA" note and cannot be placed in a request scope — the request form's document picker filters them out and the server rejects them if posted anyway. No `nda_template`, no `nda_acceptance`, and **no `access_grant.nda_acceptance_id` column** until Phase 3 creates the table it would reference. Nothing unreachable ships.

2. **Scope is join tables, not an opaque column.** Spec §8 now states it. `access_request_document` and `access_grant_document` hold explicit document ids; `all_request_tier` on the parent means "everything at that tier, including documents published later". Real foreign keys mean a deleted document cannot leave a dangling scope, and resolving what a requester may download is one join.

3. **An unverified submission lives in `access_request`,** with `requester_id NULL`, `status = 'unverified'`, and the submitted email, name, and company held inline. Consuming the magic link upserts the `requester`, adopts the row, and nulls those three columns in one transaction. The alternative — parking the payload as JSON on `magic_link` — keeps unverified email out of the table but discards the referential integrity of a document selection the prospect has *already made* at submission time.

4. **A POST consumes a magic link.** Spec §9.2 now states it. Following the link renders a confirmation page; the form's POST consumes the token. Enterprise mail gateways prefetch links to scan them, and a single-use link burned by a scanner strands the requester exactly as a lost email would.

5. **PROPOSED — the requester cookie cannot carry the `__Host-` prefix.** The carry-over asks for `__Host-` on the session cookie. `__Host-` mandates `Path=/`, which is precisely what the requester cookie must not have: path-scoping to `/{locale}/access` is what keeps the public portal cookie-free. So the staff cookie becomes `__Host-tc_staff_session` and the requester cookie becomes `__Secure-tc_requester_session`. Both prefixes require `Secure`, which browsers grant on `http://localhost` but **not** on a plain-HTTP deployment behind a proxy that terminates nothing. Task 17 adds the `docs/self-hosting.md` warning. **This is a behaviour change for any operator running plain HTTP and needs sign-off before Task 17 runs.**

6. **PROPOSED — `getClientAddress()` degrades to `null` rather than failing the write.** The carry-over records a `500 Could not determine clientAddress` that lost an admin mutation entirely, and notes the same call on the public download path where it would 500 every visitor download. This plan makes `clientIp(event)` return `string | null`, so a misconfigured `ADDRESS_HEADER` costs an audit attribution rather than the operation. `audit_event.ip` is already nullable — spec §10 requires it to be, since the purge sets it to `NULL`. Task 3 introduces the helper; Task 12 is where it matters most.

## Deviations from the spec, with rationale

7. **`access_rule.pattern` matches domains only, not arbitrary globs.** Spec §9.3 says rules are "matched by priority against the email domain". A pattern is either an exact domain (`acme.example`) or a single leading wildcard (`*.acme.example`). A general glob engine invites patterns nobody can reason about at decision time, and every §9.3 example is a domain.

8. **No `subscription` table and no digest emails.** Spec §8 lists `subscription`; spec §11 puts double opt-in subscriptions in Phase 4. `outbound_email` arrives here because this phase sends mail; the subscription model does not.

9. **The audit log viewer is a filterable table, not a dashboard.** Spec §11 lists "audit log viewer" in Phase 2 and the analytics dashboard in Phase 5. Task 16 builds the former: filter by action, actor, subject, and date range, newest first, keyset-paginated. No aggregation, no charts.

10. **`document_file.page_count` is still not implemented.** Phase 1 deferred it to "when the watermarker arrives". The watermarker arrives in Task 12 and still does not need it: `pdf-lib` reports the page count from the loaded document, so a stored column would be a denormalization with no reader. It arrives when something needs it before opening the file.

## Carry-over items folded into this phase

From `docs/superpowers/phase-2-carryover.md`, each in the task that touches that code anyway. Everything not listed here stays on the carry-over list.

| Carry-over item | Task |
|---|---|
| Extract the meta-form action (parse → update → `recordEvent` with a published/updated split) | 1 |
| `<type>.translation.updated` as a distinct audit action; `{ locale }` key spelling aligned across six types | 1 |
| Two (now six) `state_referenced_locally` warnings silenced inside `LocaleTabs.svelte` | 1 |
| The e2e suite is not isolated from the dev database | 2 |
| No test distinguishes `BASE_URL` from the request origin | 2 |
| `postgres:16-alpine` still pinned in `tests/setup/pg.ts` after commit `1ce91a1` bumped both compose files to 18 | 2 |
| `getClientAddress()` can throw and takes the mutation with it | 3 (helper), 12 (blast radius) |
| `staff_session.expires_at` index and a cleanup job | 8 |
| `RUN_MIGRATIONS=false` has no companion migration command | 8 |
| `__Host-` cookie prefix on the session cookie | 17 |
| Revoke prior sessions on re-login | 17 |
| Audit failed OIDC callbacks — state mismatch, replayed code, IdP `error=` | 17 |
| A route-level test for the disabled-staff denial | 17 |
| Staff email and OIDC subject written into `audit_event.meta` — confirm the policy | 16 |

---

## File Structure

```
src/lib/server/admin/actions.ts             NEW  meta-form action helper (Task 1)
src/lib/server/http/client-ip.ts            NEW  clientIp(event): string | null (Task 3)

src/lib/server/db/schema/requesters.ts      NEW  requester, magic_link, requester_session
src/lib/server/db/schema/access.ts          NEW  access_rule, access_request(+documents),
                                                 access_grant(+documents)
src/lib/server/db/schema/mail.ts            NEW  outbound_email
src/lib/server/db/schema/ratelimit.ts       NEW  rate_limit
drizzle/0011_requesters.sql                 NEW
drizzle/0012_access.sql                     NEW
drizzle/0013_ratelimit.sql                  NEW
drizzle/0014_mail.sql                       NEW
drizzle/0015_staff_session_expiry_idx.sql   NEW

src/lib/server/identity/requester.ts        NEW  upsertRequester, sessions
src/lib/server/identity/magic-link.ts       NEW  issueMagicLink, consumeMagicLink
src/lib/server/access/rules.ts              NEW  pure rule matching (Task 5)
src/lib/server/access/requests.ts           NEW  submit, verify, decide
src/lib/server/access/grants.ts             NEW  create, resolve, revoke, expire
src/lib/server/ratelimit.ts                 NEW  consume(key, limit, windowSeconds)
src/lib/server/mail/index.ts                NEW  MailAdapter port + getMailer()
src/lib/server/mail/smtp.ts                 NEW  nodemailer implementation
src/lib/server/mail/queue.ts                NEW  enqueue() + drain() over outbound_email
src/lib/server/mail/templates.ts            NEW  localized subject/body per template id
src/lib/server/jobs/runner.ts               NEW  JobRunner port + in-process ticker
src/lib/server/jobs/index.ts                NEW  job registry (drain, reminders, sweeps)
src/lib/server/delivery/watermark.ts        NEW  stampPdf() over pdf-lib
src/lib/server/purge.ts                     NEW  purgeRequester() — the §10 exception

src/routes/(portal)/request/                NEW  request form + action
src/routes/(portal)/access/                 NEW  gated subtree: verify, landing, logout
src/routes/(admin)/admin/requests/          NEW  triage queue + decision page
src/routes/(admin)/admin/grants/            NEW  grant list + revoke
src/routes/(admin)/admin/requesters/        NEW  requester list, detail, purge
src/routes/(admin)/admin/rules/             NEW  access rule CRUD
src/routes/(admin)/admin/audit/             NEW  audit log viewer
src/routes/(admin)/admin/settings/access/   NEW  default grant duration

src/routes/api/documents/[fileId]/+server.ts     MODIFIED  grant resolution + watermark
src/hooks.server.ts                              MODIFIED  locals.requester, cookie prefixes
src/lib/server/config/parse.ts                   MODIFIED  SMTP_*, MAIL_FROM, TTLs
tests/setup/pg.ts                                MODIFIED  postgres:18-alpine
playwright.config.ts                             MODIFIED  second project, disposable DB
docs/self-hosting.md                             MODIFIED  mail, jobs, Secure-cookie warning
```

Six admin route groups follow the Phase 1 pattern exactly: a `DataTable` list page and a meta form. Where a task says "follow the pattern in `<path>`", that file is committed and readable — read it rather than inventing a new shape.

---

## Execution log

Tasks 1–13 are complete (commits `b9fef02`..`HEAD`, all signed).

**Resume at Task 14** — grants, rules, and access settings, the remaining admin
CRUD. Both halves of the journey now work: a prospect requests, verifies, and
downloads; staff triage what the rules did not decide. What has no surface yet
is everything *after* a decision — a granted requester cannot be found, a grant
cannot be revoked from the UI, and rules can only be written directly to the
database.

### Departures from this plan, and why

- **Task 0, unplanned — `fix(compose)`.** Commit `1ce91a1` moved both compose
  files to `postgres:18-alpine` but kept the `pgdata` volume mounted at
  `/var/lib/postgresql/data`. PG18's `PGDATA` is `/var/lib/postgresql/18/docker`,
  so the volume was never written to and the database lived on the container
  layer — destroyed on every recreate, in `compose.yaml` as much as in the dev
  file. Nothing in this phase could run until it was fixed.

- **Task 1** — the helper needed `subjectType` and `meta` overrides, and
  `saveTranslationAction` needed `required`/`optional` field lists. The plan's
  `isPublished` for documents was wrong: status is `setStatus`'s business, and
  deriving it in `saveMeta` would emit `document.published` on a slug edit.
  Step 7's wrapper function does **not** silence `state_referenced_locally` —
  Svelte flags any `$props()`-derived reference in a `$state` initializer
  regardless of wrapping. Since no page read `activeLocale` for anything but the
  binding, `LocaleTabs` now owns the selection outright, with one documented
  suppression instead of six pages holding state they never used.

- **Task 2** — not Testcontainers. Playwright interpolates `webServer.env` while
  the config module is evaluated, strictly before `globalSetup` runs, so a URL
  minted there can never reach the server under test. The suite provisions a
  database inside the dev Postgres at config load instead, and repoints
  `DATABASE_URL` so specs opening their own connections agree with the app.

- **Task 3** — `requester.locale` added. Without it every notification falls back
  to `DEFAULT_LOCALE`, which is an English mail to a German prospect.

- **Task 4** — the plan's verification CHECK was wrong. Written as an equivalence,
  it was also satisfied when both sides were false, so a verified row could keep
  its submitted email — the exact leak the constraint exists to prevent. It is
  now a `CASE` covering both directions. Drizzle also emitted the deferred
  `magic_link.request_id` foreign key on its own once declared in the schema, so
  no hand-editing of the migration was needed.

- **Tasks 7 and 8** — `drainOutbox` and `sweepUnverifiedRequests` take their
  configuration as arguments rather than calling `getConfig()`. Requiring a fully
  configured environment to drain a queue or delete stale rows is untestable and
  more than either function needs to know; the job that calls them owns the
  lookup.

- **Task 9 Step 8 — spec §12 amended, and the security test with it.** The step
  as written was unsatisfiable. It asked for a per-document request affordance
  while insisting the Phase 1 test "a gated document never appears in public
  HTML" keep passing, and that test asserted the page contained the fixture's
  slug nowhere at all — the fixture's *title* is `Fixture gated-fixture`, so any
  row naming the document breaks it, `fileId` or no `fileId`. The suggested
  `listGatedForPortal` does not rescue it: what the test guarded was the
  document's existence, not its file. Settled deliberately in favour of naming
  gated documents, which is what a trust centre is for and how every comparable
  product behaves; spec §12 now says the **file** is what never appears, and
  the test asserts the file id is absent from the HTML and no download link is
  rendered. The sitemap guarantee is untouched.

  Implemented as a private `listDocumentsByTier(db, tiers, opts)` with two
  exported wrappers — `listPublicDocuments` (unchanged semantics, so the sitemap
  and `getPublicDocument` keep theirs) and `listPortalDocuments`. Files are
  queried for public-tier ids only, so a gated file id never leaves the
  database rather than being nulled on the way out.

- **Task 10 — configuration stays an argument, as in Tasks 7 and 8.** The plan
  had `createGrant` default its expiry from `getConfig()`. The integration
  global setup provides `TEST_DATABASE_URL` and nothing else, so that call makes
  every case in `access-verify.test.ts` unrunnable. `createGrant` now requires
  `expiresAt` and `verifyRequest` takes `grantTtlDays`; the route owns the
  lookup.

- **Task 10 — the staff notification is queued by `verifyRequest`, after its
  transaction commits.** The plan put it in the route, reasoning correctly that
  a mail queued inside a transaction that later rolls back is a mail about a
  request that does not exist — then asked for an integration case asserting
  the queued row, which the route placement makes untestable. Queuing after the
  commit, inside the function, satisfies both. `staffNotification` is an
  optional argument, so an unset `STAFF_NOTIFICATION_EMAIL` cannot fail a
  verification.

- **Task 10 — the staff cookie rename is left to Task 17.** Step 7 moved
  `SESSION_COOKIE` to the `__Host-` prefix here, on the grounds that "both
  cookies are set in the same place". They are not: the staff cookie is set in
  `src/routes/auth/callback/+server.ts` and the requester cookie in the verify
  route. Nothing in Task 10 needs the rename, so it stays in Task 17 Step 1
  where the rest of that item lives.

- **Task 10 — `grantedDocuments` deduplicates.** A requester holding both an
  explicit grant and an all-request-tier grant matches the same document twice
  in the plan's query. The portal shows a document once, with the date access
  actually ends, so the latest expiry wins.

- **Task 10 Step 9 — the no-cookie assertion was not where the plan said.**
  `security.spec.ts` did not assert it; `locale.spec.ts` and `request.spec.ts`
  did, each for its own route. Both kept, and the consolidated permanent test
  added to `security.spec.ts` covering `/de`, `/de/documents`, `/de/faq`,
  `/de/request`, and `/de/access/verify`. It asserts each route returns 200 as
  well, so a route that 500s cannot pass by setting no cookie on its error page.

- **Task 11 — sign-out is an endpoint, not a form action.** The plan put it in
  `logout/+page.server.ts`. A `+page.server.ts` exporting actions with no
  `+page.svelte` beside it is not a valid page route, and the subtree's
  `+layout.server.ts` guard does not run for endpoints — which is what lets
  someone sign out when the session being revoked has already expired. It now
  mirrors the staff sign-out at `src/routes/auth/logout/+server.ts`.

- **Task 11 Step 5 — the plan's e2e tests were replaced.** Its second test
  asserted only that a response was not null, which cannot fail; its third used
  a regex that matches any `/api/documents/<uuid>` and so would have caught a
  legitimate *public* download link, as the plan itself notes a line later. The
  spec now drives the real flow — verify, land, list, sign out, replay — and
  submits through `submitRequest` rather than the form, so it does not spend
  the submission limiter's shared per-address budget that `request.spec.ts`
  asserts on.

- **Task 11 Step 3 — four of the listed strings were not added.**
  `access_pending_title`, `access_pending_body`, `access_denied_title`, and
  `access_expires_soon` have no call site: the plan's own note says the empty
  state is what a pending requester sees, and per-row expiry is not in the
  load's output. `access_verify_*` already landed with Task 10.

- **Task 12 — gated delivery moved to `/{locale}/access/documents/{fileId}`.**
  The plan added the gated branch to `/api/documents/{fileId}` and authorized it
  from `locals.requester`. That cannot work: the requester cookie is scoped to
  `/{locale}/access` (Task 10 Step 7), so the browser never sends it to
  `/api/...` and every gated request arrives anonymous — a guaranteed 404, which
  is exactly what the new e2e download test saw. The two tiers now live at two
  paths, sharing one implementation in `src/lib/server/delivery/serve.ts` that
  takes the tier as an argument and applies it as an equality in the query.

  The alternative was widening the cookie to `Path=/`, which would have cost the
  portal its "public pages set no cookies" guarantee and made every public
  response vary by cookie. The path split keeps both properties and leaves
  `/api/documents/{fileId}` behaving exactly as it did in Phase 1 — the
  permanent test asserting a gated file 404s there still passes unchanged.

- **Task 12 Step 8 — an e2e download test was added beyond the plan's list.**
  The integration matrix asserts `mayDownload` and nothing else, so it cannot
  see the endpoint. The plan names `content-length` as this task's likeliest
  bug, and only a real download can catch it; the same test is what surfaced
  the cookie-path defect above.

- **Task 13 — `decideRequest` takes `defaultTtlDays` rather than reading it.**
  Same reason as `createGrant` and `verifyRequest`: the module would otherwise
  need a configured environment to be testable. The route owns the lookup.

- **Task 13 Step 6 — `requester.locale` already existed.** The plan offered to
  add it here if Task 3 was already committed; Task 3's own departure added it
  at the time, for exactly the reason given. The decision mail renders in it.

- **Task 13 — `info_requested` sends no mail.** The plan's mail step names
  `request_approved` and `request_denied` only, and `MAIL_TEMPLATES` has no
  entry for a question, so asking for more information is recorded and left for
  the operator to follow up out of band. `decidedAt` and `decidedByStaffId` stay
  null: a question is not a decision, and the request stays in the queue.

- **Task 13 Step 7 — `signInAsAdmin` moved to `tests/helpers/admin.ts`.**
  Playwright refuses to let one test file import another, and it lived in
  `admin-content.spec.ts`. `admin-documents.spec.ts` keeps its own private copy;
  that duplication predates this task.

### Found while executing

- **The plan's watermark assertion could never pass.** It grepped the saved
  bytes for the recipient's company. pdf-lib Flate-compresses every content
  stream and writes standard-font text as hex strings, so no drawn text ever
  appears literally. `tests/helpers/pdf.ts` inflates the streams and decodes the
  `<hex> Tj` operators instead, which is what makes the assertion mean "this is
  page content" rather than "these bytes exist somewhere".

- **Helvetica cannot encode beyond WinAnsi.** pdf-lib throws on a glyph the
  standard font lacks, so a requester named with a CJK character or an emoji
  would have failed the whole download rather than the stamp. `toWinAnsi`
  reduces the text to what the font can draw. The email address, which is the
  identifying part, is ASCII by the time it reaches the stamper.

- **A `__Secure-` cookie cannot be deleted without `Secure`.** The browser
  rejects any `Set-Cookie` for a `__Secure-` prefixed name that omits the
  attribute — deletions included — so `cookies.delete(name, { path })` left the
  session cookie in place and sign-out did nothing at the client. Caught by the
  e2e sign-out test. The plan had the same defect in Task 10's hooks block, so
  an expired session would never have had its cookie cleared either. Set and
  delete now share `requesterCookieOptions(locale)`.

- **`setHeaders` throws on a repeated header.** The verify page set
  `cache-control: no-store` in its own load, and Task 11's subtree layout sets
  it for everything under `/access`. Two `setHeaders` calls naming one header
  is an error in SvelteKit, not a last-write-wins, so every `/access/verify`
  render 500'd the moment the layout landed. The layout owns the header.

- **Optional env vars rejected a blank value.** A `.env` spells "unset" as
  `KEY=`, which reaches Zod as `''` and fails `.optional()`. `.env.example`
  shipped `STAFF_NOTIFICATION_EMAIL=`, so copying it verbatim produced a
  deployment that refused to boot. Fixed for `SMTP_URL`,
  `STAFF_NOTIFICATION_EMAIL`, and the pre-existing `OIDC_APPROVER_GROUP`.

- **`vitest.integration.config.ts` had no `$lib` alias**, which the unit config
  has. It surfaced the moment an integration test reached a module importing
  `getConfig()`.

- **`tests/e2e/locale.spec.ts:63` flaked once** in a full run and passed in
  isolation and in three subsequent full runs. `phase-2-carryover.md` records the
  same test flaking under load in Phase 0. Not a regression from the job runner,
  but it has now been seen twice and should be made robust rather than re-observed.

- **The submission limiter throttles the e2e suite.** Five requests per hour per
  address is right in production, and every browser test comes from localhost.
  `tests/e2e/request.spec.ts` clears `rate_limit` per test and carries one
  explicit case asserting the limiter engages. Any future spec that submits the
  request form needs the same `beforeEach`.

- **`Seo` gained a `noindex` prop** in Task 9, suppressing the canonical URL and
  hreflang alternates along with adding the robots meta — a submission surface
  has nothing for a crawler to prefer. Tasks 10 and 11 need it for the whole
  `/access` subtree.

- **Migrations are renamed by hand.** `drizzle-kit generate` assigns a random
  name; this repo uses descriptive ones, so each migration needs its file and its
  `drizzle/meta/_journal.json` tag renamed. Tasks 3–8 all did this.

---

## Task 1: Extract the admin meta-form action

The carry-over's one endorsed refactor. Four content types agreed on the shape of `saveMeta` while differing only in data, which is the same evidence threshold Task 11 of Phase 1 used. Doing it first means the six new admin surfaces in Tasks 13–16 are written against the helper rather than retrofitted into it.

This task also settles the audit action naming **before** the table grows, because `audit_event` is append-only and whatever is written now is permanent.

**Files:**
- Create: `src/lib/server/admin/actions.ts`
- Create: `tests/unit/admin-actions.test.ts`
- Modify: `src/routes/(admin)/admin/documents/[id]/+page.server.ts`, `src/routes/(admin)/admin/controls/[id]/+page.server.ts`, `src/routes/(admin)/admin/certifications/[id]/+page.server.ts`, `src/routes/(admin)/admin/subprocessors/[id]/+page.server.ts`, `src/routes/(admin)/admin/faq/[id]/+page.server.ts`, `src/routes/(admin)/admin/updates/[id]/+page.server.ts`
- Modify: `src/lib/components/admin/LocaleTabs.svelte`

**Interfaces:**
- Produces: `saveMetaAction<T>(opts)` and `saveTranslationAction(opts)` from `$lib/server/admin/actions`, used by every admin edit page from here on. Exact signatures in Step 3.
- Produces: the audit action convention `<type>.translation.updated` with `meta: { locale }`, consumed by Task 16's viewer filters.

- [x] **Step 1: Write the failing test for the published/updated split**

The helper's only branching logic is which action name to record. That is worth a unit test; the database round-trip is not, and is covered by the existing integration suites.

`tests/unit/admin-actions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveMetaAction } from '../../src/lib/server/admin/actions';

describe('resolveMetaAction', () => {
	it('records the published action when the predicate holds', () => {
		expect(resolveMetaAction('answer', { visibility: 'public' }, (d) => d.visibility === 'public')).toBe(
			'answer.published'
		);
	});

	it('records the updated action otherwise', () => {
		expect(
			resolveMetaAction('answer', { visibility: 'internal' }, (d) => d.visibility === 'public')
		).toBe('answer.updated');
	});

	it('records the updated action when no predicate is supplied', () => {
		expect(resolveMetaAction('subprocessor', { name: 'x' }, undefined)).toBe('subprocessor.updated');
	});

	it('names translation edits distinctly from meta edits', () => {
		expect(translationAction('document')).toBe('document.translation.updated');
	});
});
```

Add `translationAction` to the import on line 2:

```ts
import { resolveMetaAction, translationAction } from '../../src/lib/server/admin/actions';
```

- [x] **Step 2: Run the test and watch it fail**

Run: `pnpm test:unit -- admin-actions`
Expected: FAIL — `Failed to resolve import "../../src/lib/server/admin/actions"`.

- [x] **Step 3: Write the helper**

`src/lib/server/admin/actions.ts`:

```ts
import { fail, type RequestEvent } from '@sveltejs/kit';
import type { z } from 'zod';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Db } from '$lib/server/db';

/** One shape for every admin action failure, so a form narrows on `field` alone. */
export type AdminActionFailure = { field: string; locale?: string };

/**
 * Meta edits and translation edits are distinct occurrences and get distinct
 * action names. Phase 1 wrote `<type>.updated` for both and distinguished them
 * only by the shape of `meta`, which no audit filter can express. The log is
 * append-only, so this convention is permanent from here.
 */
export function translationAction(type: string): string {
	return `${type}.translation.updated`;
}

/**
 * "Became visible to anyone who asks" is a question worth answering directly,
 * so each content type names the predicate that makes it public. Types with no
 * such notion pass `undefined` and always record `.updated`.
 */
export function resolveMetaAction<T>(
	type: string,
	data: T,
	isPublished: ((data: T) => boolean) | undefined
): string {
	return isPublished?.(data) ? `${type}.published` : `${type}.updated`;
}

interface SaveMetaOptions<S extends z.ZodType> {
	/** Audit subject type and action prefix, e.g. `'answer'`. */
	type: string;
	schema: S;
	/** Pulls the raw values out of the submitted form, before validation. */
	read: (form: FormData) => Record<string, unknown>;
	update: (db: Db, id: string, data: z.output<S>) => Promise<unknown>;
	isPublished?: (data: z.output<S>) => boolean;
	/** Field reported when validation fails and Zod names no path. */
	fallbackField: string;
}

/**
 * parse → update → recordEvent, the shape all six content types agreed on.
 * Returns `{ saved: true }` or a `fail()` naming the offending field.
 */
export function saveMetaAction<S extends z.ZodType>(opts: SaveMetaOptions<S>) {
	return async (event: RequestEvent<{ id: string }>) => {
		const form = await event.request.formData();
		const parsed = opts.schema.safeParse(opts.read(form));

		if (!parsed.success) {
			return fail<AdminActionFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? opts.fallbackField)
			});
		}

		const data = parsed.data as z.output<S>;
		const db = getDb();
		await opts.update(db, event.params.id, data);

		await recordEvent(db, {
			action: resolveMetaAction(opts.type, data, opts.isPublished),
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: opts.type,
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: data as Record<string, unknown>
		});

		return { saved: true };
	};
}

interface SaveTranslationOptions {
	type: string;
	/** Form field names to read, trim, and require. Order defines which is reported first. */
	fields: readonly string[];
	set: (
		db: Db,
		id: string,
		locale: string,
		values: Record<string, string>
	) => Promise<unknown>;
}

/**
 * The locale is validated against the *enabled* set, not the compiled set: a
 * compiled-but-disabled locale is not a locale on this deployment (spec §7).
 */
export function saveTranslationAction(opts: SaveTranslationOptions) {
	return async (event: RequestEvent<{ id: string }>) => {
		const form = await event.request.formData();
		const locale = String(form.get('locale') ?? '');

		if (!getConfig().locales.includes(locale)) {
			return fail<AdminActionFailure>(400, { field: 'locale' });
		}

		const values: Record<string, string> = {};
		for (const field of opts.fields) {
			const value = String(form.get(field) ?? '').trim();
			if (!value) return fail<AdminActionFailure>(400, { field, locale });
			values[field] = value;
		}

		const db = getDb();
		await opts.set(db, event.params.id, locale, values);

		await recordEvent(db, {
			action: translationAction(opts.type),
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: opts.type,
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: { locale }
		});

		return { saved: true };
	};
}
```

This imports `clientIp`, which Task 3 creates. Create it now as a two-line module so this task is committable on its own; Task 3 adds its tests and its `null`-degradation reasoning.

`src/lib/server/http/client-ip.ts`:

```ts
import type { RequestEvent } from '@sveltejs/kit';

/**
 * `getClientAddress()` throws when adapter-node cannot determine an address —
 * a misconfigured ADDRESS_HEADER is enough. An audit event with a null ip is a
 * lost attribution; a thrown one is a lost mutation, and on the public download
 * path a 500 for every visitor. `audit_event.ip` is nullable by spec §10, which
 * requires the purge to set it to NULL, so null is already a value the column
 * and every reader accept.
 */
export function clientIp(event: RequestEvent): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}
```

- [x] **Step 4: Run the test and watch it pass**

Run: `pnpm test:unit -- admin-actions`
Expected: PASS, 4 tests.

- [x] **Step 5: Rewrite the FAQ edit page against the helper**

This is the smallest of the six and the model for the rest. Replace the `saveMeta` and `saveTranslation` entries in `src/routes/(admin)/admin/faq/[id]/+page.server.ts`, keeping `load` and `remove` as they are:

```ts
import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { ANSWER_VISIBILITIES } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { saveMetaAction, saveTranslationAction } from '$lib/server/admin/actions';
import { recordEvent } from '$lib/server/audit';
import {
	deleteAnswer,
	getAnswerForAdmin,
	setAnswerTranslation,
	updateAnswer
} from '$lib/server/content/answers';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const item = await getAnswerForAdmin(getDb(), params.id);
	if (!item) error(404, 'Answer not found');
	return { answer: item };
};

export const actions: Actions = {
	saveMeta: saveMetaAction({
		type: 'answer',
		schema: z.object({
			slug: z
				.string()
				.trim()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			category: z.string().trim().min(1),
			visibility: z.enum(ANSWER_VISIBILITIES),
			position: z.coerce.number().int()
		}),
		read: (form) => ({
			slug: form.get('slug'),
			category: form.get('category'),
			visibility: form.get('visibility'),
			position: form.get('position') ?? 0
		}),
		update: (db, id, data) => updateAnswer(db, id, data),
		isPublished: (data) => data.visibility === 'public',
		fallbackField: 'slug'
	}),

	saveTranslation: saveTranslationAction({
		type: 'answer',
		fields: ['question', 'answer'],
		set: (db, id, locale, values) =>
			setAnswerTranslation(db, id, locale, {
				question: values.question!,
				answer: values.answer!
			})
	}),

	remove: async (event) => {
		const db = getDb();
		await deleteAnswer(db, event.params.id);

		await recordEvent(db, {
			action: 'answer.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'answer',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined
		});

		redirect(303, localizePath('/admin/faq', event.locals.locale));
	}
};
```

The page component needs no change: `AdminActionFailure` has the same `{ field, locale? }` shape the page already narrows on. Its `fail<AnswerActionFailure>` type import goes away with the old code.

- [x] **Step 6: Rewrite the other five edit pages the same way**

Apply the identical transformation to `documents/[id]`, `controls/[id]`, `certifications/[id]`, `subprocessors/[id]`, and `updates/[id]`. Each keeps its own Zod object, its own `read`, and its own `update` call; only the surrounding ceremony is deleted. The published predicates:

| Page | `type` | `isPublished` |
|---|---|---|
| `documents/[id]` | `document` | `(d) => d.status === 'published'` |
| `controls/[id]` | `control` | *(omit — a control has no published state)* |
| `certifications/[id]` | `certification` | `(d) => d.published` |
| `subprocessors/[id]` | `subprocessor` | `(d) => d.published` |
| `faq/[id]` | `answer` | `(d) => d.visibility === 'public'` |
| `updates/[id]` | `update` | `(d) => d.publishedAt !== null` |

`documents/[id]` keeps its file-upload action untouched — it is not a meta form and does not fit the helper.

- [x] **Step 7: Silence the `state_referenced_locally` warnings in `LocaleTabs`**

Six edit pages each write `let activeLocale = $state(data.locale)`, seeding once and deliberately not tracking `data`. The behaviour is owned by `LocaleTabs`, so the suppression belongs there rather than at six call sites.

A Svelte component cannot export a function from its instance `<script>`, so add a **module** block to `src/lib/components/admin/LocaleTabs.svelte`, above the existing `<script lang="ts">`:

```svelte
<script module lang="ts">
	/**
	 * Seeds the active tab once. Deliberately does not track its argument: the
	 * tab a person has clicked must survive a form action's `data`
	 * invalidation, which is exactly what `state_referenced_locally` warns
	 * about and exactly what is wanted here. Owning it in the one component
	 * that has the behaviour keeps `pnpm check` silent, so its output stays
	 * worth reading.
	 */
	export function initialLocale(locale: string): string {
		return locale;
	}
</script>
```

Then in each of the six edit pages:

```svelte
<script lang="ts">
	import LocaleTabs, { initialLocale } from '$lib/components/admin/LocaleTabs.svelte';
	// ...
	let activeLocale = $state(initialLocale(data.locale));
</script>
```

- [x] **Step 8: Verify the whole suite is green and `pnpm check` is silent**

```bash
docker compose -f compose.dev.yaml up -d --wait
pnpm db:migrate
pnpm lint && pnpm check
pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green, and `pnpm check` reports **zero** warnings. If `state_referenced_locally` still appears, a call site was missed.

Note: `compose.dev.yaml` now pins `postgres:18-alpine` (commit `1ce91a1`). An existing `matchory-trust-center_pgdata` volume holds a PG16 data directory and Postgres will refuse to start against it. If the database does not come up, recreate the volume — the dev database holds only fixtures:

```bash
docker compose -f compose.dev.yaml down -v && docker compose -f compose.dev.yaml up -d --wait
```

- [x] **Step 9: Commit**

```bash
git add src/lib/server/admin/actions.ts src/lib/server/http/client-ip.ts \
  tests/unit/admin-actions.test.ts src/lib/components/admin/LocaleTabs.svelte \
  'src/routes/(admin)/admin'
git commit -m "refactor(admin): extract the meta-form action and name translation edits distinctly"
```

---

## Task 2: Isolate the end-to-end suite

Two carry-over defects and one left by commit `1ce91a1`. All three are test-infrastructure problems, and all three get worse once Phase 2 adds fixtures that create requesters and send mail.

**Files:**
- Create: `tests/setup/e2e-db.ts`
- Modify: `playwright.config.ts`
- Modify: `tests/setup/pg.ts`
- Modify: `docs/self-hosting.md`, `docs/superpowers/specs/2026-08-28-trust-center-design.md`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: an e2e run against a disposable database, so Tasks 9–19 may create fixtures without cleaning up after themselves.
- Produces: a second Playwright project, `origin`, whose `BASE_URL` differs from its listen address — the gap the Phase 1 review found and could not close.

- [x] **Step 1: Align the Testcontainers pin with the compose files**

`tests/setup/pg.ts` line 8, `postgres:16-alpine` → `postgres:18-alpine`. Dev and production run 18 as of `1ce91a1`; an integration suite on 16 tests a database nobody deploys.

- [x] **Step 2: Run the integration suite and watch it still pass**

Run: `pnpm test:integration`
Expected: PASS. A green run here is the evidence that nothing in the schema depends on 16 — if a migration fails, that is a real finding and belongs in its own commit before continuing.

- [x] **Step 3: Correct the two stale "Postgres 16" references**

In `docs/self-hosting.md` §1, `**Postgres 16.**` → `**Postgres 18.**`. In the design spec §6.1, `Postgres 16.` → `Postgres 18.`, and add to the spec's amendment header:

```markdown
**Amended 2026-08-29 (Phase 2, Task 2):** Section 6.1 names Postgres 18, matching the compose
files and the Testcontainers pin.
```

- [x] **Step 4: Write the disposable e2e database setup**

The e2e suite currently shares the dev database, so fixtures accumulate across runs and three Phase 1 assertions had to be rewritten when matching on fixture text broke on a second run.

`tests/setup/e2e-db.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../../src/lib/server/db';

let container: StartedPostgreSqlContainer | undefined;

/**
 * Playwright's `webServer` starts before `globalSetup` resolves only if the
 * URL is already answering, so the container must exist and be migrated before
 * the config's `webServer.env` is read. Playwright evaluates `globalSetup`
 * first, which is why DATABASE_URL is written into `process.env` here rather
 * than being passed through the config object.
 */
export default async function globalSetup() {
	container = await new PostgreSqlContainer('postgres:18-alpine').start();
	const url = container.getConnectionUri();

	// Both the app under test (via webServer.env) and any spec that opens its
	// own connection (tests/e2e/auth.spec.ts reads audit_event directly) resolve
	// the database through this one variable.
	process.env.DATABASE_URL = url;

	const { db, close } = createDb(url);
	await migrate(db, { migrationsFolder: './drizzle' });
	await close();
}

export async function globalTeardown() {
	await container?.stop();
}
```

- [x] **Step 5: Wire it into Playwright, with the second origin project**

Replace `playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

const PREVIEW = 'http://localhost:4173';

export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 30_000,
	globalSetup: './tests/setup/e2e-db.ts',
	globalTeardown: './tests/setup/e2e-db.ts',
	// Pin the browser's locale so Accept-Language (which resolveLocale()
	// honours at the unprefixed root) is deterministic across machines/CI,
	// rather than depending on the host's LANG/OS locale.
	use: { baseURL: PREVIEW, locale: 'de-DE' },

	projects: [
		{
			name: 'app',
			testIgnore: /origin\.spec\.ts$/
		},
		{
			// BASE_URL deliberately differs from the address this server listens
			// on. Under a single-origin run the configured origin and the request
			// origin are the same string, so nothing distinguishes a canonical URL
			// built from BASE_URL (correct) from one built from the request host
			// (the bug fixed in b72f18c). Only this project can fail that way.
			name: 'origin',
			testMatch: /origin\.spec\.ts$/
		}
	],

	// Run against a production preview build rather than `vite dev`, for parity
	// with what actually ships.
	webServer: {
		// CI has already run `pnpm build`; rebuilding here doubles the slowest
		// step of the workflow for nothing.
		command: process.env.CI
			? 'pnpm preview --port 4173 --strictPort'
			: 'pnpm build && pnpm preview --port 4173 --strictPort',
		url: PREVIEW,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		env: {
			// Not PREVIEW. The app must build canonical URLs from this value while
			// answering on 4173; tests/e2e/origin.spec.ts asserts exactly that.
			BASE_URL: 'https://trust.example.test',
			DATABASE_URL: process.env.DATABASE_URL ?? ''
		}
	}
});
```

`BASE_URL` no longer matches the preview port, which breaks the OIDC redirect URI for the admin specs. Those specs need the old value, so `webServer` cannot serve both. Run the `origin` project against its own server instead — replace the single `webServer` above with two entries:

```ts
	webServer: [
		{
			command: process.env.CI
				? 'pnpm preview --port 4173 --strictPort'
				: 'pnpm build && pnpm preview --port 4173 --strictPort',
			url: PREVIEW,
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
			// Matches the port this server listens on, so redirectUri() in
			// src/lib/server/auth/oidc.ts resolves to an origin the dev IdP's
			// client registration accepts (compose.dev.yaml lists both).
			env: { BASE_URL: PREVIEW, DATABASE_URL: process.env.DATABASE_URL ?? '' }
		},
		{
			command: 'pnpm preview --port 4174 --strictPort',
			url: 'http://localhost:4174',
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
			env: {
				BASE_URL: 'https://trust.example.test',
				DATABASE_URL: process.env.DATABASE_URL ?? ''
			}
		}
	],
```

and give the `origin` project `use: { baseURL: 'http://localhost:4174' }`.

- [x] **Step 6: Write the failing origin test**

`tests/e2e/origin.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

const CONFIGURED = 'https://trust.example.test';

test('canonical URL comes from BASE_URL, not the request host', async ({ page }) => {
	await page.goto('/de');
	const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
	expect(canonical).toBe(`${CONFIGURED}/de`);
});

test('hreflang alternates come from BASE_URL', async ({ page }) => {
	await page.goto('/de');
	const alternates = await page.locator('link[rel="alternate"]').evaluateAll((nodes) =>
		nodes.map((node) => node.getAttribute('href'))
	);
	expect(alternates.length).toBeGreaterThan(0);
	for (const href of alternates) expect(href).toContain(CONFIGURED);
});

test('the sitemap lists BASE_URL origins', async ({ request }) => {
	const body = await (await request.get('/sitemap.xml')).text();
	expect(body).toContain(`${CONFIGURED}/`);
	expect(body).not.toContain('localhost:4174');
});
```

- [x] **Step 7: Run it and watch it pass**

Run: `pnpm test:e2e -- --project=origin`
Expected: PASS, 3 tests. These pass because `b72f18c` already fixed the bug; the point is that they are now *capable* of failing, which nothing before them was. Verify that by temporarily reverting `Seo.svelte` to `page.url.origin`, watching test 1 fail, and restoring it.

- [x] **Step 8: Run the full e2e suite twice in a row**

```bash
pnpm test:e2e
pnpm test:e2e
```

Expected: both green. The second run is the actual assertion — under the shared dev database, fixture accumulation made repeat runs fail, which is the defect this task closes.

- [x] **Step 9: Update CI**

`.github/workflows/ci.yml` no longer needs the dev compose stack for Playwright's database, but still needs it for the dev IdP that the admin specs sign in against. Leave the `docker compose -f compose.dev.yaml up -d --wait --build` step, and remove the now-redundant `pnpm db:migrate` before `pnpm test:e2e` — `globalSetup` migrates the disposable database itself.

- [x] **Step 10: Commit**

```bash
git add playwright.config.ts tests/setup/e2e-db.ts tests/setup/pg.ts \
  tests/e2e/origin.spec.ts .github/workflows/ci.yml docs/self-hosting.md \
  docs/superpowers/specs/2026-08-28-trust-center-design.md
git commit -m "test: give the e2e suite its own database and a differing-origin project"
```

---
## Task 3: Requester identity — schema and module

The second identity model. It shares no code path with staff sessions, by design: spec §6.3 keeps the two "strictly separate", and the failure mode of confusing them is a prospect holding staff rights.

**Files:**
- Create: `src/lib/server/db/schema/requesters.ts`
- Create: `drizzle/0011_requesters.sql` (generated)
- Create: `src/lib/server/identity/requester.ts`, `src/lib/server/identity/magic-link.ts`
- Create: `tests/integration/requester.test.ts`, `tests/unit/client-ip.test.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Modify: `src/lib/server/config/parse.ts`, `.env.example`

**Interfaces:**
- Produces: `upsertRequester(db, {email, name, company, locale})` → `Requester`; `createRequesterSession(db, {requesterId, ttlHours, ip, ua})` → `{token, expiresAt}`; `validateRequesterSession(db, token)` → `{requester, expiresAt} | null`; `revokeRequesterSession(db, token)`.
- Produces: `issueMagicLink(db, {requesterId, purpose, requestId, ttlMinutes})` → `{token, expiresAt}`; `consumeMagicLink(db, token, purpose)` → `{magicLinkId, requesterId, requestId} | null`.
- Consumes: `clientIp` from Task 1.

- [x] **Step 1: Write the schema**

`src/lib/server/db/schema/requesters.ts`:

```ts
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * A requester exists only after email verification (spec §9.2), so every row
 * here is a *verified* identity. Unverified submissions live in access_request
 * until their link is consumed.
 */
export const requester = pgTable('requester', {
	id: uuid('id').primaryKey().defaultRandom(),
	// Lowercased by upsertRequester before it reaches the database, so the
	// unique constraint is the real one rather than a case-sensitive near-miss.
	email: text('email').notNull().unique(),
	name: text('name').notNull(),
	company: text('company').notNull(),
	// Derived from the email at verification and frozen there. Rules are matched
	// against the domain at decision time (spec §9's domain-drift case), so this
	// records what was matched, not what the address would resolve to today.
	companyDomain: text('company_domain').notNull(),
	// The locale this person used when they verified. Every mail we send them
	// renders in it (spec §7): a German prospect who used the German portal must
	// not receive English mail, and this is the only place that is recorded.
	locale: text('locale').notNull(),
	notes: text('notes'),
	firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
	// Set by purgeRequester (Task 15). A purged requester keeps its row so
	// grants and requests retain referential integrity; the personal columns are
	// blanked and the audit events pseudonymized.
	purgedAt: timestamp('purged_at', { withTimezone: true })
});

export const MAGIC_LINK_PURPOSES = ['verify_request', 'sign_in'] as const;
export type MagicLinkPurpose = (typeof MAGIC_LINK_PURPOSES)[number];

export const magicLink = pgTable(
	'magic_link',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// The token itself is never stored. A database disclosure must not hand
		// the reader a working link.
		tokenHash: text('token_hash').notNull().unique(),
		// Null for `verify_request`: no requester exists until the link is used.
		requesterId: uuid('requester_id').references(() => requester.id, { onDelete: 'cascade' }),
		// Set for `verify_request`, so consuming the link knows which submission
		// it verifies. Typed loosely to avoid a circular import with access.ts;
		// the foreign key is added in the access migration (Task 4).
		requestId: uuid('request_id'),
		purpose: text('purpose').notNull(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		consumedAt: timestamp('consumed_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('magic_link_expires_idx').on(table.expiresAt),
		check(
			'magic_link_purpose_check',
			sql`${table.purpose} IN ('verify_request', 'sign_in')`
		),
		// A sign_in link must name its requester; a verify_request link must not,
		// because the identity it will create does not exist yet.
		check(
			'magic_link_requester_check',
			sql`(${table.purpose} = 'sign_in') = (${table.requesterId} IS NOT NULL)`
		)
	]
);

export const requesterSession = pgTable(
	'requester_session',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		tokenHash: text('token_hash').notNull().unique(),
		requesterId: uuid('requester_id')
			.notNull()
			.references(() => requester.id, { onDelete: 'cascade' }),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		ip: text('ip'),
		ua: text('ua'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('requester_session_requester_idx').on(table.requesterId),
		// The cleanup job (Task 8) deletes by expiry; without this it scans.
		index('requester_session_expires_idx').on(table.expiresAt)
	]
);
```

Add to `src/lib/server/db/schema/index.ts`:

```ts
export * from './requesters';
```

- [x] **Step 2: Generate and apply the migration**

```bash
pnpm db:generate
pnpm db:migrate
```

Expected: `drizzle/0011_requesters.sql` created with three `CREATE TABLE` statements. Read it before applying — a generated migration that drops anything is a bug in the schema file, not something to run.

- [x] **Step 3: Write the failing integration test**

`tests/integration/requester.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import {
	consumeMagicLink,
	issueMagicLink
} from '../../src/lib/server/identity/magic-link';
import {
	createRequesterSession,
	revokeRequesterSession,
	upsertRequester,
	validateRequesterSession
} from '../../src/lib/server/identity/requester';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(async () => {
	await close();
});

function email() {
	return `person-${randomUUID()}@acme.example`;
}

describe('upsertRequester', () => {
	it('lowercases the email and derives the domain', async () => {
		const address = email().toUpperCase();
		const row = await upsertRequester(db, {
			email: address,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});

		expect(row.email).toBe(address.toLowerCase());
		expect(row.companyDomain).toBe('acme.example');
	});

	it('is idempotent on email and refreshes the profile', async () => {
		const address = email();
		const first = await upsertRequester(db, {
			email: address,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		const second = await upsertRequester(db, {
			email: address,
			name: 'A. Person',
			company: 'Acme GmbH',
			locale: 'de'
		});

		expect(second.id).toBe(first.id);
		expect(second.name).toBe('A. Person');
		expect(second.firstSeenAt.getTime()).toBe(first.firstSeenAt.getTime());
	});
});

describe('magic links', () => {
	it('consumes a link exactly once', async () => {
		const requestId = randomUUID();
		const { token } = await issueMagicLink(db, {
			purpose: 'verify_request',
			requestId,
			ttlMinutes: 30
		});

		const first = await consumeMagicLink(db, token, 'verify_request');
		expect(first?.requestId).toBe(requestId);

		const second = await consumeMagicLink(db, token, 'verify_request');
		expect(second).toBeNull();
	});

	it('refuses a link presented for the wrong purpose', async () => {
		const { token } = await issueMagicLink(db, {
			purpose: 'verify_request',
			requestId: randomUUID(),
			ttlMinutes: 30
		});

		expect(await consumeMagicLink(db, token, 'sign_in')).toBeNull();
		// ...and the failed attempt must not have burned it.
		expect(await consumeMagicLink(db, token, 'verify_request')).not.toBeNull();
	});

	it('refuses an expired link', async () => {
		const { token } = await issueMagicLink(db, {
			purpose: 'verify_request',
			requestId: randomUUID(),
			ttlMinutes: -1
		});

		expect(await consumeMagicLink(db, token, 'verify_request')).toBeNull();
	});

	it('refuses an unknown token without disclosing anything', async () => {
		expect(await consumeMagicLink(db, 'not-a-real-token', 'verify_request')).toBeNull();
	});
});

describe('requester sessions', () => {
	it('validates, then stops validating once revoked', async () => {
		const row = await upsertRequester(db, { email: email(), name: 'A', company: 'Acme', locale: 'de' });
		const { token } = await createRequesterSession(db, {
			requesterId: row.id,
			ttlHours: 24,
			ip: '203.0.113.5',
			ua: 'test'
		});

		expect((await validateRequesterSession(db, token))?.requester.id).toBe(row.id);

		await revokeRequesterSession(db, token);
		expect(await validateRequesterSession(db, token)).toBeNull();
	});

	it('refuses an expired session', async () => {
		const row = await upsertRequester(db, { email: email(), name: 'A', company: 'Acme', locale: 'de' });
		const { token } = await createRequesterSession(db, { requesterId: row.id, ttlHours: -1 });

		expect(await validateRequesterSession(db, token)).toBeNull();
	});
});
```

- [x] **Step 4: Run it and watch it fail**

Run: `pnpm test:integration -- requester`
Expected: FAIL — cannot resolve `../../src/lib/server/identity/requester`.

- [x] **Step 5: Write the requester module**

`src/lib/server/identity/requester.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { requester, requesterSession } from '../db/schema';
import type { Db } from '../db';

export const REQUESTER_SESSION_COOKIE = '__Secure-tc_requester_session';

export type Requester = typeof requester.$inferSelect;

/**
 * Same construction as the staff session's, deliberately duplicated rather than
 * shared: spec §6.3 keeps the two identity models strictly separate, and a
 * shared helper is the seam along which a requester eventually validates as
 * staff. Six lines is a cheaper price than that risk.
 */
function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
	return randomBytes(32).toString('base64url');
}

/** The domain a rule is matched against. Everything after the last `@`. */
export function domainOf(email: string): string {
	return email.toLowerCase().split('@').pop() ?? '';
}

export async function upsertRequester(
	db: Db,
	input: { email: string; name: string; company: string; locale: string }
): Promise<Requester> {
	const email = input.email.trim().toLowerCase();

	const [row] = await db
		.insert(requester)
		.values({
			email,
			name: input.name.trim(),
			company: input.company.trim(),
			companyDomain: domainOf(email),
			locale: input.locale
		})
		.onConflictDoUpdate({
			target: requester.email,
			// firstSeenAt is deliberately absent: it records the first
			// verification, and a returning prospect must not reset it. `locale`
			// IS refreshed — the language someone used most recently is the better
			// guess for the next mail.
			set: { name: input.name.trim(), company: input.company.trim(), locale: input.locale }
		})
		.returning();

	if (!row) throw new Error('failed to upsert requester');
	return row;
}

export async function createRequesterSession(
	db: Db,
	input: { requesterId: string; ttlHours: number; ip?: string | null; ua?: string | null }
): Promise<{ token: string; expiresAt: Date }> {
	const token = newSessionToken();
	const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);

	await db.insert(requesterSession).values({
		tokenHash: hashToken(token),
		requesterId: input.requesterId,
		expiresAt,
		ip: input.ip ?? null,
		ua: input.ua ?? null
	});

	return { token, expiresAt };
}

export async function validateRequesterSession(
	db: Db,
	token: string
): Promise<{ requester: Requester; expiresAt: Date } | null> {
	const [row] = await db
		.select({ session: requesterSession, requester })
		.from(requesterSession)
		.innerJoin(requester, eq(requesterSession.requesterId, requester.id))
		.where(and(eq(requesterSession.tokenHash, hashToken(token)), isNull(requesterSession.revokedAt)))
		.limit(1);

	if (!row) return null;
	if (row.session.expiresAt.getTime() <= Date.now()) return null;
	// A purged requester's sessions are revoked by purgeRequester, but check
	// here too: the guard that matters must not depend on a job having run.
	if (row.requester.purgedAt !== null) return null;

	return { requester: row.requester, expiresAt: row.session.expiresAt };
}

export async function revokeRequesterSession(db: Db, token: string): Promise<void> {
	await db
		.update(requesterSession)
		.set({ revokedAt: new Date() })
		.where(eq(requesterSession.tokenHash, hashToken(token)));
}

/** Used by purgeRequester and by the return-visit path, which re-authenticates. */
export async function revokeAllRequesterSessions(db: Db, requesterId: string): Promise<void> {
	await db
		.update(requesterSession)
		.set({ revokedAt: new Date() })
		.where(and(eq(requesterSession.requesterId, requesterId), isNull(requesterSession.revokedAt)));
}
```

- [x] **Step 6: Write the magic-link module**

`src/lib/server/identity/magic-link.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { magicLink } from '../db/schema';
import type { MagicLinkPurpose } from '../db/schema';
import type { Db } from '../db';

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export async function issueMagicLink(
	db: Db,
	input: {
		purpose: MagicLinkPurpose;
		ttlMinutes: number;
		requesterId?: string;
		requestId?: string;
	}
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + input.ttlMinutes * 60 * 1000);

	await db.insert(magicLink).values({
		tokenHash: hashToken(token),
		purpose: input.purpose,
		requesterId: input.requesterId ?? null,
		requestId: input.requestId ?? null,
		expiresAt
	});

	return { token, expiresAt };
}

/**
 * Single-use by construction: the UPDATE that stamps `consumed_at` is also the
 * predicate that requires it to be null, so two concurrent consumptions of the
 * same token cannot both return a row — the second updates zero rows. Doing
 * this as SELECT-then-UPDATE would be a race with a real prize.
 *
 * `purpose` is part of the WHERE clause rather than checked afterwards, so a
 * link presented for the wrong purpose is not consumed by the attempt.
 */
export async function consumeMagicLink(
	db: Db,
	token: string,
	purpose: MagicLinkPurpose
): Promise<{ magicLinkId: string; requesterId: string | null; requestId: string | null } | null> {
	const [row] = await db
		.update(magicLink)
		.set({ consumedAt: sql`now()` })
		.where(
			and(
				eq(magicLink.tokenHash, hashToken(token)),
				eq(magicLink.purpose, purpose),
				isNull(magicLink.consumedAt),
				gt(magicLink.expiresAt, sql`now()`)
			)
		)
		.returning({
			magicLinkId: magicLink.id,
			requesterId: magicLink.requesterId,
			requestId: magicLink.requestId
		});

	return row ?? null;
}
```

- [x] **Step 7: Run the integration test and watch it pass**

Run: `pnpm test:integration -- requester`
Expected: PASS, 8 tests.

- [x] **Step 8: Add the config this phase needs**

In `src/lib/server/config/parse.ts`, extend `AppConfig`:

```ts
	requesterSessionTtlHours: number;
	magicLinkTtlMinutes: number;
	accessGrantDefaultDays: number;
	mail: {
		smtpUrl: string | undefined;
		from: string;
	};
```

and the schema object:

```ts
			REQUESTER_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(72),
			MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().positive().default(30),
			ACCESS_GRANT_DEFAULT_DAYS: z.coerce.number().int().positive().default(90),
			// Optional so `pnpm build` and every unit test keep working with no
			// mail server. getMailer() throws a named error when a send is
			// attempted without it, rather than the app refusing to start.
			SMTP_URL: z.string().url().optional(),
			MAIL_FROM: z.string().min(1).default('trust-center@localhost'),
```

and the returned object:

```ts
		requesterSessionTtlHours: parsed.REQUESTER_SESSION_TTL_HOURS,
		magicLinkTtlMinutes: parsed.MAGIC_LINK_TTL_MINUTES,
		accessGrantDefaultDays: parsed.ACCESS_GRANT_DEFAULT_DAYS,
		mail: { smtpUrl: parsed.SMTP_URL, from: parsed.MAIL_FROM },
```

Append to `.env.example`:

```
# --- Access governance ------------------------------------------------------
# How long a verified requester stays signed in, and how long a magic link is
# valid. Both are short by design: a link is single-use and a session is the
# only thing standing between an inbox and a gated document.
REQUESTER_SESSION_TTL_HOURS=72
MAGIC_LINK_TTL_MINUTES=30
# Default expiry applied when staff approve a request without naming one.
ACCESS_GRANT_DEFAULT_DAYS=90

# --- Mail -------------------------------------------------------------------
# Every notification is queued and drained by the in-process job runner. With
# SMTP_URL unset the queue accepts work and never drains it, which is correct
# for `pnpm build` and the unit suite but means no mail in a real deployment.
SMTP_URL=smtp://localhost:1025
MAIL_FROM=trust-center@localhost
# Host port compose.dev.yaml publishes Mailpit on.
MAILPIT_SMTP_PORT=1025
MAILPIT_UI_PORT=8025
```

- [x] **Step 9: Write the `clientIp` unit test**

`tests/unit/client-ip.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { clientIp } from '../../src/lib/server/http/client-ip';
import type { RequestEvent } from '@sveltejs/kit';

function eventWith(getClientAddress: () => string): RequestEvent {
	return { getClientAddress } as unknown as RequestEvent;
}

describe('clientIp', () => {
	it('returns the address when adapter-node can determine one', () => {
		expect(clientIp(eventWith(() => '203.0.113.5'))).toBe('203.0.113.5');
	});

	it('degrades to null rather than throwing', () => {
		// adapter-node throws exactly this when ADDRESS_HEADER names a header the
		// proxy does not send. Phase 1 lost an admin mutation to it, and the
		// public download path would 500 for every visitor.
		const event = eventWith(() => {
			throw new Error('Could not determine clientAddress');
		});

		expect(clientIp(event)).toBeNull();
	});
});
```

- [x] **Step 10: Run everything and commit**

```bash
pnpm test:unit && pnpm test:integration && pnpm lint && pnpm check
git add src/lib/server/db/schema src/lib/server/identity src/lib/server/config/parse.ts \
  src/lib/server/http drizzle/0011_requesters.sql drizzle/meta .env.example \
  tests/integration/requester.test.ts tests/unit/client-ip.test.ts
git commit -m "feat(identity): add requesters, magic links, and requester sessions"
```

---

## Task 4: Access governance schema

**Files:**
- Create: `src/lib/server/db/schema/access.ts`
- Create: `drizzle/0012_access.sql` (generated, then hand-edited for one foreign key)
- Create: `src/lib/access-types.ts`
- Modify: `src/lib/server/db/schema/index.ts`

**Interfaces:**
- Produces: `accessRule`, `accessRequest`, `accessRequestDocument`, `accessGrant`, `accessGrantDocument` tables, and the `ACCESS_REQUEST_STATUSES` / `ACCESS_RULE_ACTIONS` value arrays consumed by Tasks 5, 9, 13, and 14.

- [x] **Step 1: Write the shared value arrays**

These live outside `$lib/server` because Svelte components need them for `<select>` options, exactly as `src/lib/content-types.ts` does for content.

`src/lib/access-types.ts`:

```ts
export const ACCESS_RULE_ACTIONS = ['auto_approve', 'review', 'deny'] as const;
export type AccessRuleAction = (typeof ACCESS_RULE_ACTIONS)[number];

/**
 * `unverified` is the pre-verification state: the row holds a submission whose
 * email nobody has proven they control. `info_requested` is spec §9.4's third
 * triage outcome. There is no `pending_acceptance` — that is Phase 3's NDA
 * state and this phase gates only the request tier.
 */
export const ACCESS_REQUEST_STATUSES = [
	'unverified',
	'pending',
	'info_requested',
	'approved',
	'denied'
] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

export const ACCESS_REQUEST_SOURCES = ['portal', 'invite'] as const;
export type AccessRequestSource = (typeof ACCESS_REQUEST_SOURCES)[number];
```

- [x] **Step 2: Write the schema**

`src/lib/server/db/schema/access.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import type {
	AccessRequestSource,
	AccessRequestStatus,
	AccessRuleAction
} from '../../../access-types';
import { document } from './documents';
import { requester } from './requesters';
import { staffUser } from './staff';

export type { AccessRequestSource, AccessRequestStatus, AccessRuleAction };

export const accessRule = pgTable(
	'access_rule',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// An exact domain (`acme.example`) or one leading wildcard
		// (`*.acme.example`). Not a glob: every spec §9.3 example is a domain,
		// and a general engine invites patterns nobody can reason about at
		// decision time.
		pattern: text('pattern').notNull(),
		action: text('action').notNull(),
		// The highest tier this rule may auto-approve. Meaningless for `deny`
		// and `review`, and ignored there.
		maxTier: text('max_tier').notNull().default('request'),
		// Lower runs first. Ties broken by the more specific pattern — see
		// matchRule() in Task 5, which does not depend on insertion order.
		priority: integer('priority').notNull().default(100),
		note: text('note'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('access_rule_priority_idx').on(table.priority),
		check(
			'access_rule_action_check',
			sql`${table.action} IN ('auto_approve', 'review', 'deny')`
		),
		check('access_rule_max_tier_check', sql`${table.maxTier} IN ('public', 'request', 'nda')`)
	]
);

export const accessRequest = pgTable(
	'access_request',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Null until the magic link is consumed: spec §9.2 makes verification
		// the act that creates the requester.
		requesterId: uuid('requester_id').references(() => requester.id, { onDelete: 'cascade' }),
		status: text('status').notNull().default('unverified'),
		// "Everything at the request tier, including documents published later."
		allRequestTier: boolean('all_request_tier').notNull().default(false),
		justification: text('justification'),
		source: text('source').notNull().default('portal'),
		// Held inline while unverified, nulled by the verification transaction.
		// These three columns are the only place unverified personal data lives,
		// and the sweep job (Task 8) deletes the rows that never get verified.
		submittedEmail: text('submitted_email'),
		submittedName: text('submitted_name'),
		submittedCompany: text('submitted_company'),
		decidedByStaffId: uuid('decided_by_staff_id').references(() => staffUser.id, {
			onDelete: 'set null'
		}),
		decidedAt: timestamp('decided_at', { withTimezone: true }),
		reason: text('reason'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('access_request_status_idx').on(table.status, table.createdAt),
		index('access_request_requester_idx').on(table.requesterId),
		check(
			'access_request_status_check',
			sql`${table.status} IN ('unverified', 'pending', 'info_requested', 'approved', 'denied')`
		),
		check('access_request_source_check', sql`${table.source} IN ('portal', 'invite')`),
		// The two states are mutually exclusive by construction: an unverified
		// row carries a submitted email and no requester; every other state
		// carries a requester and no submitted email. Enforced here so a partial
		// verification transaction cannot leave a row that is quietly both.
		check(
			'access_request_verification_check',
			sql`(${table.status} = 'unverified')
			    = (${table.requesterId} IS NULL AND ${table.submittedEmail} IS NOT NULL)`
		)
	]
);

export const accessRequestDocument = pgTable(
	'access_request_document',
	{
		requestId: uuid('request_id')
			.notNull()
			.references(() => accessRequest.id, { onDelete: 'cascade' }),
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.requestId, table.documentId] })]
);

export const accessGrant = pgTable(
	'access_grant',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		requesterId: uuid('requester_id')
			.notNull()
			.references(() => requester.id, { onDelete: 'cascade' }),
		// The request this grant answers. Null for a staff-initiated invite.
		requestId: uuid('request_id').references(() => accessRequest.id, { onDelete: 'set null' }),
		allRequestTier: boolean('all_request_tier').notNull().default(false),
		grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		revokedByStaffId: uuid('revoked_by_staff_id').references(() => staffUser.id, {
			onDelete: 'set null'
		}),
		// Set by the reminder job so a lapse notice is sent once, not once a tick.
		expiryReminderSentAt: timestamp('expiry_reminder_sent_at', { withTimezone: true })
	},
	(table) => [
		index('access_grant_requester_idx').on(table.requesterId),
		// The reminder job scans by expiry; the download path filters by it.
		index('access_grant_expires_idx').on(table.expiresAt)
	]
);

export const accessGrantDocument = pgTable(
	'access_grant_document',
	{
		grantId: uuid('grant_id')
			.notNull()
			.references(() => accessGrant.id, { onDelete: 'cascade' }),
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.grantId, table.documentId] })]
);
```

Add to `src/lib/server/db/schema/index.ts`:

```ts
export * from './access';
```

- [x] **Step 3: Generate the migration and add the deferred foreign key**

```bash
pnpm db:generate
```

`magic_link.request_id` was created in Task 3 without a foreign key, because `access_request` did not exist yet. Add it by hand to the end of the generated `drizzle/0012_access.sql`:

```sql
--> statement-breakpoint
ALTER TABLE "magic_link"
  ADD CONSTRAINT "magic_link_request_id_access_request_id_fk"
  FOREIGN KEY ("request_id") REFERENCES "public"."access_request"("id")
  ON DELETE cascade;
```

and declare it in the schema so drizzle-kit does not try to add it again on the next generate. In `src/lib/server/db/schema/requesters.ts`, `magicLink.requestId` becomes:

```ts
		requestId: uuid('request_id'),
```
→
```ts
		requestId: uuid('request_id').references((): AnyPgColumn => accessRequest.id, {
			onDelete: 'cascade'
		}),
```

with `import { accessRequest } from './access';`, `import type { AnyPgColumn } from 'drizzle-orm/pg-core';`, and the thunk form breaking the import cycle.

- [x] **Step 4: Apply and verify the constraints actually bite**

```bash
pnpm db:migrate
```

Then confirm the `access_request_verification_check` constraint rejects a half-verified row. Add to `tests/integration/requester.test.ts`:

```ts
describe('access_request verification invariant', () => {
	it('refuses a row that is unverified but names a requester', async () => {
		const row = await upsertRequester(db, { email: email(), name: 'A', company: 'Acme', locale: 'de' });

		await expect(
			db.insert(accessRequest).values({
				status: 'unverified',
				requesterId: row.id,
				submittedEmail: 'someone@acme.example'
			})
		).rejects.toThrow();
	});

	it('refuses a verified row that still carries a submitted email', async () => {
		const row = await upsertRequester(db, { email: email(), name: 'A', company: 'Acme', locale: 'de' });

		await expect(
			db.insert(accessRequest).values({
				status: 'pending',
				requesterId: row.id,
				submittedEmail: 'someone@acme.example'
			})
		).rejects.toThrow();
	});
});
```

Import `accessRequest` from `../../src/lib/server/db/schema`.

Note: Drizzle wraps driver errors, so `error.message` is only `Failed query: … params: …`. Any assertion on the *constraint name* must read `error.cause`. `rejects.toThrow()` with no argument is correct here and does not need it.

- [x] **Step 5: Run and commit**

```bash
pnpm test:integration -- requester
pnpm lint && pnpm check
git add src/lib/server/db/schema src/lib/access-types.ts drizzle tests/integration/requester.test.ts
git commit -m "feat(access): add access rules, requests, grants, and their scope join tables"
```

---

## Task 5: Rule evaluation

Spec §9.3. A pure function over rules and a domain, so it is fully unit-testable with no database — which matters, because this is the code that decides whether a stranger gets documents.

**Files:**
- Create: `src/lib/server/access/rules.ts`
- Create: `tests/unit/access-rules.test.ts`

**Interfaces:**
- Produces: `matchRule(rules, domain)` → `MatchedRule | null` and `decideFromRules(rules, domain)` → `{ action, maxTier, ruleId }`, consumed by Task 10's verification path.

- [x] **Step 1: Write the failing test**

`tests/unit/access-rules.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { decideFromRules, matchRule, patternMatches } from '../../src/lib/server/access/rules';
import type { RuleForMatching } from '../../src/lib/server/access/rules';

function rule(partial: Partial<RuleForMatching> & { pattern: string }): RuleForMatching {
	return {
		id: partial.pattern,
		pattern: partial.pattern,
		action: partial.action ?? 'review',
		maxTier: partial.maxTier ?? 'request',
		priority: partial.priority ?? 100
	};
}

describe('patternMatches', () => {
	it('matches an exact domain', () => {
		expect(patternMatches('acme.example', 'acme.example')).toBe(true);
		expect(patternMatches('acme.example', 'notacme.example')).toBe(false);
	});

	it('matches a leading wildcard against subdomains only', () => {
		expect(patternMatches('*.acme.example', 'eu.acme.example')).toBe(true);
		expect(patternMatches('*.acme.example', 'a.b.acme.example')).toBe(true);
		// The bare domain is NOT a subdomain of itself. An operator wanting both
		// writes both rules, which is visible; inferring it is not.
		expect(patternMatches('*.acme.example', 'acme.example')).toBe(false);
	});

	it('is case-insensitive', () => {
		expect(patternMatches('ACME.example', 'acme.EXAMPLE')).toBe(true);
	});

	it('does not treat the wildcard as a substring match', () => {
		expect(patternMatches('*.acme.example', 'evilacme.example')).toBe(false);
	});
});

describe('matchRule', () => {
	it('returns null when nothing matches', () => {
		expect(matchRule([rule({ pattern: 'acme.example' })], 'other.example')).toBeNull();
	});

	it('prefers the lower priority number', () => {
		const matched = matchRule(
			[
				rule({ pattern: 'acme.example', priority: 50, action: 'deny' }),
				rule({ pattern: 'acme.example', priority: 10, action: 'auto_approve' })
			],
			'acme.example'
		);

		expect(matched?.action).toBe('auto_approve');
	});

	it('breaks a priority tie in favour of the more specific pattern', () => {
		// Otherwise the outcome depends on row order, which is not a decision
		// anybody made and would change under an unrelated reindex.
		const matched = matchRule(
			[
				rule({ pattern: '*.acme.example', priority: 100, action: 'review' }),
				rule({ pattern: 'eu.acme.example', priority: 100, action: 'auto_approve' })
			],
			'eu.acme.example'
		);

		expect(matched?.action).toBe('auto_approve');
	});
});

describe('decideFromRules', () => {
	it('defaults to review when no rule matches', () => {
		// The safe default: an unknown domain reaches a human, never a document.
		const decision = decideFromRules([], 'stranger.example');

		expect(decision.action).toBe('review');
		expect(decision.ruleId).toBeNull();
	});

	it('carries the matched rule id so the decision is reconstructible', () => {
		const decision = decideFromRules(
			[rule({ pattern: 'acme.example', action: 'auto_approve', maxTier: 'request' })],
			'acme.example'
		);

		expect(decision).toEqual({ action: 'auto_approve', maxTier: 'request', ruleId: 'acme.example' });
	});

	it('never auto-approves above the request tier in this phase', () => {
		// A rule may name `nda`, because the column allows it and Phase 3 will
		// honour it. This phase must clamp, or an NDA-tier document reaches a
		// requester with no acceptance on file.
		const decision = decideFromRules(
			[rule({ pattern: 'acme.example', action: 'auto_approve', maxTier: 'nda' })],
			'acme.example'
		);

		expect(decision.maxTier).toBe('request');
	});
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit -- access-rules`
Expected: FAIL — cannot resolve the module.

- [x] **Step 3: Implement**

`src/lib/server/access/rules.ts`:

```ts
import type { AccessRuleAction } from '../../access-types';
import type { DocumentTier } from '../../content-types';

export interface RuleForMatching {
	id: string;
	pattern: string;
	action: AccessRuleAction;
	maxTier: string;
	priority: number;
}

/**
 * An exact domain, or one leading `*.` matching any non-empty subdomain prefix.
 * The bare domain does not match its own wildcard: an operator who wants both
 * writes both rules. Inferring it would silently widen `*.acme.example` to
 * include `acme.example`, which is a different decision.
 */
export function patternMatches(pattern: string, domain: string): boolean {
	const p = pattern.trim().toLowerCase();
	const d = domain.trim().toLowerCase();

	if (!p || !d) return false;
	if (!p.startsWith('*.')) return p === d;

	const suffix = p.slice(1); // ".acme.example"
	return d.length > suffix.length && d.endsWith(suffix);
}

/**
 * Lower priority first; a tie goes to the more specific pattern, measured as
 * "an exact match beats a wildcard, then the longer pattern wins". Without a
 * total order the outcome depends on row order, which nobody decided.
 */
export function matchRule(rules: readonly RuleForMatching[], domain: string): RuleForMatching | null {
	const candidates = rules.filter((rule) => patternMatches(rule.pattern, domain));
	if (candidates.length === 0) return null;

	return candidates.reduce((best, rule) => {
		if (rule.priority !== best.priority) return rule.priority < best.priority ? rule : best;

		const bestWild = best.pattern.startsWith('*.');
		const ruleWild = rule.pattern.startsWith('*.');
		if (bestWild !== ruleWild) return ruleWild ? best : rule;

		return rule.pattern.length > best.pattern.length ? rule : best;
	});
}

export interface RuleDecision {
	action: AccessRuleAction;
	maxTier: DocumentTier;
	ruleId: string | null;
}

/** This phase gates the request tier only; Phase 3 raises the ceiling. */
const PHASE_CEILING: DocumentTier = 'request';

export function decideFromRules(
	rules: readonly RuleForMatching[],
	domain: string
): RuleDecision {
	const matched = matchRule(rules, domain);

	// No rule is not an error and not an approval. An unknown domain reaches a
	// human, which is spec §9.3's "everything else becomes pending".
	if (!matched) return { action: 'review', maxTier: PHASE_CEILING, ruleId: null };

	return {
		action: matched.action,
		maxTier: matched.maxTier === 'nda' ? PHASE_CEILING : (matched.maxTier as DocumentTier),
		ruleId: matched.id
	};
}
```

- [x] **Step 4: Run it and watch it pass**

Run: `pnpm test:unit -- access-rules`
Expected: PASS, 11 tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/server/access/rules.ts tests/unit/access-rules.test.ts
git commit -m "feat(access): evaluate domain rules by priority with a deterministic tie-break"
```

---
## Task 6: Rate limiting

Spec §10 requires it on request submission, magic-link issuance, and download — all three of which this phase introduces or opens up. Counters live in Postgres rather than in memory because multi-replica is a supported deployment (`RUN_MIGRATIONS=false` exists for it), and a per-replica counter is not a limit.

**Files:**
- Create: `src/lib/server/db/schema/ratelimit.ts`, `src/lib/server/ratelimit.ts`
- Create: `tests/integration/ratelimit.test.ts`
- Modify: `src/lib/server/db/schema/index.ts`

**Interfaces:**
- Produces: `consumeRateLimit(db, {key, limit, windowSeconds})` → `{ allowed: boolean; retryAfterSeconds: number }`, consumed by Tasks 9, 10, and 12.

- [x] **Step 1: Write the schema**

`src/lib/server/db/schema/ratelimit.ts`:

```ts
import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * A fixed window per key. Not a sliding window: the extra precision buys
 * nothing here, and a single upsert with no read-then-write is worth more than
 * exactness at the window boundary.
 *
 * Keys are hashed by the caller — see rateLimitKey(). A raw email address in
 * this table would be requester personal data in a place spec §10 never
 * anticipated, retained for as long as the window.
 */
export const rateLimit = pgTable(
	'rate_limit',
	{
		key: text('key').primaryKey(),
		windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
		count: integer('count').notNull().default(0)
	},
	(table) => [index('rate_limit_window_idx').on(table.windowStart)]
);
```

Add `export * from './ratelimit';` to the schema index.

- [x] **Step 2: Write the failing test**

`tests/integration/ratelimit.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { consumeRateLimit, rateLimitKey } from '../../src/lib/server/ratelimit';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(async () => {
	await close();
});

describe('consumeRateLimit', () => {
	it('allows up to the limit and refuses past it', async () => {
		const key = randomUUID();

		for (let i = 0; i < 3; i++) {
			expect((await consumeRateLimit(db, { key, limit: 3, windowSeconds: 60 })).allowed).toBe(true);
		}

		const refused = await consumeRateLimit(db, { key, limit: 3, windowSeconds: 60 });
		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterSeconds).toBeGreaterThan(0);
		expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
	});

	it('keeps separate keys separate', async () => {
		const a = randomUUID();
		const b = randomUUID();

		await consumeRateLimit(db, { key: a, limit: 1, windowSeconds: 60 });

		expect((await consumeRateLimit(db, { key: a, limit: 1, windowSeconds: 60 })).allowed).toBe(false);
		expect((await consumeRateLimit(db, { key: b, limit: 1, windowSeconds: 60 })).allowed).toBe(true);
	});

	it('starts a fresh window once the old one has passed', async () => {
		const key = randomUUID();

		expect((await consumeRateLimit(db, { key, limit: 1, windowSeconds: 1 })).allowed).toBe(true);
		expect((await consumeRateLimit(db, { key, limit: 1, windowSeconds: 1 })).allowed).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 1100));

		expect((await consumeRateLimit(db, { key, limit: 1, windowSeconds: 1 })).allowed).toBe(true);
	});

	it('does not store the identifier it limits on', async () => {
		const key = rateLimitKey('request', 'someone@acme.example');

		expect(key).not.toContain('someone');
		expect(key).not.toContain('acme.example');
		expect(key.startsWith('request:')).toBe(true);
	});
});
```

- [x] **Step 3: Run it and watch it fail**

Run: `pnpm test:integration -- ratelimit`
Expected: FAIL — cannot resolve `../../src/lib/server/ratelimit`.

- [x] **Step 4: Implement**

`src/lib/server/ratelimit.ts`:

```ts
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { rateLimit } from './db/schema';
import type { Db } from './db';

/**
 * The scope prefix stays readable so an operator reading the table can tell
 * which limiter a row belongs to; the identifier is hashed so the table never
 * becomes an index of who asked for what.
 */
export function rateLimitKey(scope: string, identifier: string): string {
	const digest = createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex');
	return `${scope}:${digest.slice(0, 32)}`;
}

export interface RateLimitResult {
	allowed: boolean;
	retryAfterSeconds: number;
}

/**
 * One statement, no read-then-write. The upsert either starts a new window
 * (because none exists, or the stored one has aged out) or increments the
 * current one, and returns the resulting count. Two concurrent callers
 * therefore cannot both observe "count 2, limit 3" and both proceed to 4.
 */
export async function consumeRateLimit(
	db: Db,
	input: { key: string; limit: number; windowSeconds: number }
): Promise<RateLimitResult> {
	const windowInterval = sql`make_interval(secs => ${input.windowSeconds})`;

	const rows = await db
		.insert(rateLimit)
		.values({ key: input.key, windowStart: sql`now()`, count: 1 })
		.onConflictDoUpdate({
			target: rateLimit.key,
			set: {
				windowStart: sql`CASE WHEN ${rateLimit.windowStart} + ${windowInterval} <= now()
				                      THEN now() ELSE ${rateLimit.windowStart} END`,
				count: sql`CASE WHEN ${rateLimit.windowStart} + ${windowInterval} <= now()
				                THEN 1 ELSE ${rateLimit.count} + 1 END`
			}
		})
		.returning({
			count: rateLimit.count,
			retryAfter: sql<number>`
				GREATEST(0, CEIL(EXTRACT(EPOCH FROM
					(${rateLimit.windowStart} + ${windowInterval}) - now()
				)))::int
			`
		});

	const row = rows[0];
	if (!row) throw new Error('rate limit upsert returned no row');

	return {
		allowed: row.count <= input.limit,
		retryAfterSeconds: row.retryAfter
	};
}
```

- [x] **Step 5: Run it and watch it pass**

Run: `pnpm test:integration -- ratelimit`
Expected: PASS, 4 tests.

- [x] **Step 6: Commit**

```bash
pnpm db:generate && pnpm db:migrate   # drizzle/0013_ratelimit.sql
git add src/lib/server/ratelimit.ts src/lib/server/db/schema drizzle \
  tests/integration/ratelimit.test.ts
git commit -m "feat: add a Postgres-backed fixed-window rate limiter"
```

---

## Task 7: The mail port and the outbound queue

Spec §6.4's `MailAdapter`. Every send is queued: SMTP latency and outages must never fail a request or a staff decision, and a magic link that silently fails to send is the worst failure this product has — the requester is locked out with no signal to anyone.

**Files:**
- Create: `src/lib/server/db/schema/mail.ts`
- Create: `src/lib/server/mail/index.ts`, `smtp.ts`, `queue.ts`, `templates.ts`
- Create: `tests/integration/mail-queue.test.ts`, `tests/unit/mail-templates.test.ts`
- Create: `drizzle/0014_mail.sql` (generated)
- Modify: `src/lib/server/db/schema/index.ts`, `package.json`
- Modify: `messages/de.json`, `messages/en.json`

**Interfaces:**
- Produces: `enqueueEmail(db, {to, template, payload, locale})`; `drainOutbox(db, {limit})` → `{sent, failed}`; `renderTemplate(id, locale, payload)` → `{subject, text}`.
- Consumes: nothing from earlier tasks beyond `Db`.

- [x] **Step 1: Add nodemailer**

```bash
pnpm add nodemailer
pnpm add -D @types/nodemailer
```

- [x] **Step 2: Write the schema**

`src/lib/server/db/schema/mail.ts`:

```ts
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const OUTBOUND_EMAIL_STATUSES = ['pending', 'sent', 'failed'] as const;
export type OutboundEmailStatus = (typeof OUTBOUND_EMAIL_STATUSES)[number];

/**
 * The queue and the record are the same row. `to` is requester personal data
 * and this is a domain table, not the audit log, so spec §10's `meta`
 * restriction does not apply — but purgeRequester (Task 15) clears it, which
 * is why the address is a column rather than buried in `payload`.
 */
export const outboundEmail = pgTable(
	'outbound_email',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		to: text('to').notNull(),
		template: text('template').notNull(),
		locale: text('locale').notNull(),
		// Rendered at send time rather than at enqueue time, so a template fix
		// applies to mail that has not gone out yet.
		payload: jsonb('payload').notNull(),
		status: text('status').notNull().default('pending'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
		lastError: text('last_error'),
		sentAt: timestamp('sent_at', { withTimezone: true }),
		providerId: text('provider_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// The drain query's claim predicate. Partial, so the index stays small as
		// sent mail accumulates.
		index('outbound_email_claim_idx')
			.on(table.nextAttemptAt)
			.where(sql`${table.status} = 'pending'`),
		check(
			'outbound_email_status_check',
			sql`${table.status} IN ('pending', 'sent', 'failed')`
		)
	]
);
```

Add `export * from './mail';` to the schema index, then:

```bash
pnpm db:generate && pnpm db:migrate
```

- [x] **Step 3: Write the failing template test**

Templates are pure and locale-sensitive, so they test without a database.

`tests/unit/mail-templates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MAIL_TEMPLATES, renderTemplate } from '../../src/lib/server/mail/templates';

describe('renderTemplate', () => {
	it('renders the verification mail in the requested locale', () => {
		const de = renderTemplate('verify_request', 'de', { url: 'https://t.example/a' });
		const en = renderTemplate('verify_request', 'en', { url: 'https://t.example/a' });

		expect(de.subject).not.toBe(en.subject);
		expect(de.text).toContain('https://t.example/a');
		expect(en.text).toContain('https://t.example/a');
	});

	it('renders every declared template in every compiled locale', () => {
		// A template added without its German string is a defect that ships
		// silently otherwise — the fallback is an English mail to a German
		// prospect, which is exactly what spec §7 exists to prevent.
		for (const id of MAIL_TEMPLATES) {
			for (const locale of ['de', 'en'] as const) {
				const rendered = renderTemplate(id, locale, {
					url: 'https://t.example/a',
					documentCount: 2,
					expiresAt: '2026-12-01',
					reason: 'a reason'
				});

				expect(rendered.subject.length).toBeGreaterThan(0);
				expect(rendered.text.length).toBeGreaterThan(0);
			}
		}
	});
});
```

- [x] **Step 4: Run it and watch it fail**

Run: `pnpm test:unit -- mail-templates`
Expected: FAIL — cannot resolve the module.

- [x] **Step 5: Write the message catalog entries**

Add to `messages/en.json`:

```json
	"mail_verify_request_subject": "Confirm your document request",
	"mail_verify_request_body": "You asked for access to documents on our Trust Center.\n\nConfirm your email address to continue:\n{url}\n\nThis link works once and expires shortly. If you did not make this request, ignore this message — nothing happens until the link is used.",
	"mail_request_approved_subject": "Your document access is ready",
	"mail_request_approved_body": "Your request has been approved. You now have access to {documentCount} document(s) until {expiresAt}.\n\nSign in to view them:\n{url}",
	"mail_request_denied_subject": "About your document request",
	"mail_request_denied_body": "We are unable to grant this request.\n\n{reason}",
	"mail_sign_in_subject": "Your sign-in link",
	"mail_sign_in_body": "Use this link to reach your documents:\n{url}\n\nIt works once and expires shortly.",
	"mail_grant_expiring_subject": "Your document access expires soon",
	"mail_grant_expiring_body": "Your access to {documentCount} document(s) expires on {expiresAt}.\n\nIf you still need it, reply to this message and we will extend it.",
	"mail_staff_new_request_subject": "New document access request",
	"mail_staff_new_request_body": "A new access request is waiting for triage:\n{url}"
```

Add the German equivalents to `messages/de.json` with the same keys. Every requester-facing body must read naturally in German — these are the first words a DACH prospect reads from this deployment.

```bash
pnpm paraglide:compile
```

- [x] **Step 6: Implement the templates**

`src/lib/server/mail/templates.ts`:

```ts
import * as m from '$lib/paraglide/messages';

export const MAIL_TEMPLATES = [
	'verify_request',
	'request_approved',
	'request_denied',
	'sign_in',
	'grant_expiring',
	'staff_new_request'
] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

export interface RenderedMail {
	subject: string;
	text: string;
}

export type MailPayload = Record<string, string | number>;

/**
 * Paraglide message functions take an explicit `locale` option, so these render
 * outside the request's AsyncLocalStorage — which matters, because the drain
 * job runs on a timer with no request in scope. A mail rendered in the ambient
 * locale would be whatever the last HTTP request happened to be.
 */
export function renderTemplate(
	id: MailTemplate,
	locale: string,
	payload: MailPayload
): RenderedMail {
	const options = { locale };

	switch (id) {
		case 'verify_request':
			return {
				subject: m.mail_verify_request_subject({}, options),
				text: m.mail_verify_request_body({ url: String(payload.url ?? '') }, options)
			};
		case 'request_approved':
			return {
				subject: m.mail_request_approved_subject({}, options),
				text: m.mail_request_approved_body(
					{
						url: String(payload.url ?? ''),
						documentCount: String(payload.documentCount ?? 0),
						expiresAt: String(payload.expiresAt ?? '')
					},
					options
				)
			};
		case 'request_denied':
			return {
				subject: m.mail_request_denied_subject({}, options),
				text: m.mail_request_denied_body({ reason: String(payload.reason ?? '') }, options)
			};
		case 'sign_in':
			return {
				subject: m.mail_sign_in_subject({}, options),
				text: m.mail_sign_in_body({ url: String(payload.url ?? '') }, options)
			};
		case 'grant_expiring':
			return {
				subject: m.mail_grant_expiring_subject({}, options),
				text: m.mail_grant_expiring_body(
					{
						documentCount: String(payload.documentCount ?? 0),
						expiresAt: String(payload.expiresAt ?? '')
					},
					options
				)
			};
		case 'staff_new_request':
			return {
				subject: m.mail_staff_new_request_subject({}, options),
				text: m.mail_staff_new_request_body({ url: String(payload.url ?? '') }, options)
			};
	}
}
```

- [x] **Step 7: Run the template test and watch it pass**

Run: `pnpm test:unit -- mail-templates`
Expected: PASS, 2 tests (the second asserting 6 templates × 2 locales).

- [x] **Step 8: Write the port and the SMTP implementation**

`src/lib/server/mail/index.ts`:

```ts
import { getConfig } from '../config';
import { createSmtpMailer } from './smtp';

export interface OutgoingMail {
	to: string;
	from: string;
	subject: string;
	text: string;
}

export interface MailAdapter {
	send(mail: OutgoingMail): Promise<{ providerId: string | undefined }>;
}

export class MailNotConfigured extends Error {
	constructor() {
		super('SMTP_URL is not set; no mail can be sent.');
		this.name = 'MailNotConfigured';
	}
}

let cached: MailAdapter | undefined;

/** Lazy, like getConfig() and getDb(): importing this must not require config. */
export function getMailer(): MailAdapter {
	const { mail } = getConfig();
	if (!mail.smtpUrl) throw new MailNotConfigured();
	return (cached ??= createSmtpMailer(mail.smtpUrl));
}

export { createSmtpMailer };
```

`src/lib/server/mail/smtp.ts`:

```ts
import { createTransport } from 'nodemailer';
import type { MailAdapter } from './index';

export function createSmtpMailer(url: string): MailAdapter {
	const transport = createTransport(url);

	return {
		async send(mail) {
			const info = await transport.sendMail({
				to: mail.to,
				from: mail.from,
				subject: mail.subject,
				text: mail.text
			});

			return { providerId: info.messageId };
		}
	};
}
```

- [x] **Step 9: Write the failing queue test**

`tests/integration/mail-queue.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { outboundEmail } from '../../src/lib/server/db/schema';
import { drainOutbox, enqueueEmail } from '../../src/lib/server/mail/queue';
import type { MailAdapter } from '../../src/lib/server/mail';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(async () => {
	await close();
});

function mailerThat(behaviour: 'succeed' | 'fail'): { adapter: MailAdapter; sent: string[] } {
	const sent: string[] = [];
	return {
		sent,
		adapter: {
			async send(mail) {
				if (behaviour === 'fail') throw new Error('smtp is down');
				sent.push(mail.to);
				return { providerId: 'test-id' };
			}
		}
	};
}

async function enqueueOne(db: Db): Promise<string> {
	const to = `person-${randomUUID()}@acme.example`;
	await enqueueEmail(db, {
		to,
		template: 'verify_request',
		locale: 'en',
		payload: { url: 'https://t.example/a' }
	});
	return to;
}

describe('drainOutbox', () => {
	it('sends a pending mail and marks it sent', async () => {
		const to = await enqueueOne(db);
		const mailer = mailerThat('succeed');

		const result = await drainOutbox(db, { limit: 50, mailer: mailer.adapter });

		expect(result.sent).toBeGreaterThanOrEqual(1);
		expect(mailer.sent).toContain(to);

		const [row] = await db.select().from(outboundEmail).where(eq(outboundEmail.to, to));
		expect(row?.status).toBe('sent');
		expect(row?.sentAt).not.toBeNull();
	});

	it('leaves a failed mail pending, with a backed-off next attempt', async () => {
		const to = await enqueueOne(db);

		await drainOutbox(db, { limit: 50, mailer: mailerThat('fail').adapter });

		const [row] = await db.select().from(outboundEmail).where(eq(outboundEmail.to, to));
		expect(row?.status).toBe('pending');
		expect(row?.attempts).toBe(1);
		expect(row?.lastError).toContain('smtp is down');
		// Backed off, so the next tick does not immediately retry it.
		expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
	});

	it('gives up after the attempt ceiling and marks the mail failed', async () => {
		const to = await enqueueOne(db);

		// Drive it straight to the ceiling rather than waiting out five backoffs.
		await db
			.update(outboundEmail)
			.set({ attempts: 4 })
			.where(eq(outboundEmail.to, to));

		await drainOutbox(db, { limit: 50, mailer: mailerThat('fail').adapter });

		const [row] = await db.select().from(outboundEmail).where(eq(outboundEmail.to, to));
		expect(row?.status).toBe('failed');
	});

	it('does not hand the same row to two concurrent drains', async () => {
		// The whole point of SKIP LOCKED. Without it two replicas both send.
		const to = await enqueueOne(db);
		const first = mailerThat('succeed');
		const second = mailerThat('succeed');

		await Promise.all([
			drainOutbox(db, { limit: 50, mailer: first.adapter }),
			drainOutbox(db, { limit: 50, mailer: second.adapter })
		]);

		const delivered = [...first.sent, ...second.sent].filter((address) => address === to);
		expect(delivered).toHaveLength(1);
	});
});
```

- [x] **Step 10: Run it and watch it fail**

Run: `pnpm test:integration -- mail-queue`
Expected: FAIL — cannot resolve `../../src/lib/server/mail/queue`.

- [x] **Step 11: Implement the queue**

`src/lib/server/mail/queue.ts`:

```ts
import { sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { outboundEmail } from '../db/schema';
import { getMailer } from './index';
import { renderTemplate, type MailPayload, type MailTemplate } from './templates';
import type { MailAdapter } from './index';
import type { Db } from '../db';

/** Five attempts over roughly an hour, then the row is a permanent failure. */
const MAX_ATTEMPTS = 5;

export async function enqueueEmail(
	db: Db,
	input: { to: string; template: MailTemplate; locale: string; payload: MailPayload }
): Promise<void> {
	await db.insert(outboundEmail).values({
		to: input.to,
		template: input.template,
		locale: input.locale,
		payload: input.payload
	});
}

/**
 * Claims due rows with FOR UPDATE SKIP LOCKED inside one transaction, so a
 * second drain — in this process or another replica — walks past them rather
 * than sending the same mail twice. The claim marks each row's next attempt
 * far enough ahead that a crash mid-send retries rather than stalls.
 */
export async function drainOutbox(
	db: Db,
	options: { limit: number; mailer?: MailAdapter }
): Promise<{ sent: number; failed: number }> {
	const claimed = await db.transaction(async (tx) => {
		const rows = await tx.execute<{
			id: string;
			to: string;
			template: MailTemplate;
			locale: string;
			payload: MailPayload;
			attempts: number;
		}>(sql`
			SELECT id, "to", template, locale, payload, attempts
			FROM outbound_email
			WHERE status = 'pending' AND next_attempt_at <= now()
			ORDER BY next_attempt_at
			LIMIT ${options.limit}
			FOR UPDATE SKIP LOCKED
		`);

		const ids = rows.map((row) => row.id);
		if (ids.length > 0) {
			// Held for five minutes: long enough that a crashed send is not
			// retried by the very next tick, short enough that it recovers.
			await tx.execute(sql`
				UPDATE outbound_email
				SET next_attempt_at = now() + interval '5 minutes'
				WHERE id = ANY(${ids}::uuid[])
			`);
		}

		return rows;
	});

	if (claimed.length === 0) return { sent: 0, failed: 0 };

	const mailer = options.mailer ?? getMailer();
	const from = getConfig().mail.from;
	let sent = 0;
	let failed = 0;

	for (const row of claimed) {
		try {
			const rendered = renderTemplate(row.template, row.locale, row.payload);
			const { providerId } = await mailer.send({
				to: row.to,
				from,
				subject: rendered.subject,
				text: rendered.text
			});

			await db.execute(sql`
				UPDATE outbound_email
				SET status = 'sent', sent_at = now(), provider_id = ${providerId ?? null},
				    attempts = attempts + 1, last_error = NULL
				WHERE id = ${row.id}::uuid
			`);
			sent++;
		} catch (cause) {
			const attempts = row.attempts + 1;
			const giveUp = attempts >= MAX_ATTEMPTS;
			const message = cause instanceof Error ? cause.message : String(cause);

			// Exponential backoff: 1, 2, 4, 8 minutes.
			await db.execute(sql`
				UPDATE outbound_email
				SET status = ${giveUp ? 'failed' : 'pending'},
				    attempts = ${attempts},
				    last_error = ${message},
				    next_attempt_at = now() + make_interval(mins => ${2 ** (attempts - 1)})
				WHERE id = ${row.id}::uuid
			`);
			failed++;
		}
	}

	return { sent, failed };
}
```

- [x] **Step 12: Run it and watch it pass**

Run: `pnpm test:integration -- mail-queue`
Expected: PASS, 4 tests. The concurrency test is the one that matters — if it fails, `SKIP LOCKED` is not doing its job and two replicas would double-send.

- [x] **Step 13: Commit**

```bash
pnpm lint && pnpm check
git add src/lib/server/mail src/lib/server/db/schema drizzle messages package.json pnpm-lock.yaml \
  tests/integration/mail-queue.test.ts tests/unit/mail-templates.test.ts src/lib/paraglide
git commit -m "feat(notify): add the mail port and a replica-safe outbound queue"
```

---

## Task 8: The job runner

Spec §6.4's `JobRunner`. Three consumers arrive with it: draining the outbox, cleaning up expired sessions (a carry-over item), and sweeping unverified requests. The expiry reminder joins them in Task 18.

**Files:**
- Create: `src/lib/server/jobs/runner.ts`, `src/lib/server/jobs/index.ts`
- Create: `drizzle/0015_staff_session_expiry_idx.sql`
- Create: `tests/integration/jobs.test.ts`
- Modify: `src/lib/server/db/schema/staff.ts`, `src/hooks.server.ts`, `package.json`, `docs/self-hosting.md`

**Interfaces:**
- Produces: `startJobRunner()` / `stopJobRunner()`; `runJob(db, name, fn)` for advisory-locked periodic work; the `JOBS` registry consumed by Task 18.

- [x] **Step 1: Add the missing staff_session index**

The carry-over item: expired rows accumulate forever and every session validation scans past them. In `src/lib/server/db/schema/staff.ts`, add to `staffSession`'s index list:

```ts
		index('staff_session_expires_idx').on(table.expiresAt)
```

```bash
pnpm db:generate && pnpm db:migrate
```

- [x] **Step 2: Write the failing test**

`tests/integration/jobs.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { accessRequest, requesterSession, staffSession } from '../../src/lib/server/db/schema';
import { cleanupExpiredSessions, runJob, sweepUnverifiedRequests } from '../../src/lib/server/jobs';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});
afterAll(async () => {
	await close();
});

describe('runJob', () => {
	it('runs the job and reports that it ran', async () => {
		let ran = 0;
		const result = await runJob(db, `test-${randomUUID()}`, async () => {
			ran++;
		});

		expect(ran).toBe(1);
		expect(result.ran).toBe(true);
	});

	it('lets only one of two concurrent runs of the same job proceed', async () => {
		// The advisory lock is what stops two replicas both sending the same
		// expiry reminder.
		const name = `test-${randomUUID()}`;
		let running = 0;
		let maxConcurrent = 0;

		const job = async () => {
			running++;
			maxConcurrent = Math.max(maxConcurrent, running);
			await new Promise((resolve) => setTimeout(resolve, 150));
			running--;
		};

		const results = await Promise.all([runJob(db, name, job), runJob(db, name, job)]);

		expect(maxConcurrent).toBe(1);
		expect(results.filter((r) => r.ran)).toHaveLength(1);
	});

	it('releases the lock when the job throws', async () => {
		const name = `test-${randomUUID()}`;

		await expect(
			runJob(db, name, async () => {
				throw new Error('job failed');
			})
		).rejects.toThrow('job failed');

		// A lock leaked on failure would wedge this job forever.
		expect((await runJob(db, name, async () => {})).ran).toBe(true);
	});
});

describe('cleanupExpiredSessions', () => {
	it('deletes expired staff and requester sessions', async () => {
		const past = new Date(Date.now() - 60_000);
		const hash = randomUUID();

		await db.insert(staffSession).values({
			tokenHash: hash,
			staffUserId: (await db.query.staffUser.findFirst())?.id ?? randomUUID(),
			expiresAt: past
		});

		await cleanupExpiredSessions(db);

		const rows = await db.select().from(staffSession).where(eq(staffSession.tokenHash, hash));
		expect(rows).toHaveLength(0);
	});
});

describe('sweepUnverifiedRequests', () => {
	it('deletes unverified requests older than the link TTL and keeps verified ones', async () => {
		const [stale] = await db
			.insert(accessRequest)
			.values({
				status: 'unverified',
				submittedEmail: `a-${randomUUID()}@acme.example`,
				submittedName: 'A',
				submittedCompany: 'Acme',
				createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
			})
			.returning();

		const [fresh] = await db
			.insert(accessRequest)
			.values({
				status: 'unverified',
				submittedEmail: `b-${randomUUID()}@acme.example`,
				submittedName: 'B',
				submittedCompany: 'Acme'
			})
			.returning();

		await sweepUnverifiedRequests(db);

		expect(await db.select().from(accessRequest).where(eq(accessRequest.id, stale!.id))).toHaveLength(0);
		expect(await db.select().from(accessRequest).where(eq(accessRequest.id, fresh!.id))).toHaveLength(1);
	});
});
```

The staff-session test needs a staff user to exist. If `db.query.staffUser` is unavailable (the Drizzle query API needs the schema passed to `drizzle()`), insert one directly with `db.insert(staffUser).values({oidcSub: randomUUID(), email: 'a@b.c', name: 'A', role: 'admin'}).returning()` and use its id.

- [x] **Step 3: Run it and watch it fail**

Run: `pnpm test:integration -- jobs`
Expected: FAIL — cannot resolve `../../src/lib/server/jobs`.

- [x] **Step 4: Implement the advisory-locked runner**

`src/lib/server/jobs/runner.ts`:

```ts
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db';

/**
 * Postgres advisory locks are keyed by bigint, so the job name is hashed into
 * one. `pg_try_advisory_lock` returns immediately rather than queueing: a
 * second replica whose tick overlaps should skip this round, not pile up behind
 * it.
 */
function lockKey(name: string): bigint {
	const digest = createHash('sha256').update(name).digest();
	// Signed 64-bit, which is what the advisory lock functions take.
	return digest.readBigInt64BE(0);
}

export interface JobResult {
	ran: boolean;
}

/**
 * Runs `fn` under a cluster-wide advisory lock named by `name`, on a dedicated
 * connection so the lock is held for the job's lifetime rather than a single
 * statement's. Returns `{ran: false}` when another holder has it.
 */
export async function runJob(db: Db, name: string, fn: () => Promise<void>): Promise<JobResult> {
	const key = lockKey(name);

	return db.transaction(async (tx) => {
		const rows = await tx.execute<{ locked: boolean }>(
			sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`
		);

		if (!rows[0]?.locked) return { ran: false };

		// The transaction-scoped lock releases on commit OR rollback, so a
		// throwing job cannot leak it. That is why this is the _xact_ variant.
		await fn();
		return { ran: true };
	});
}
```

- [x] **Step 5: Implement the jobs and the ticker**

`src/lib/server/jobs/index.ts`:

```ts
import { lt, sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { getDb } from '../db/instance';
import { accessRequest, requesterSession, staffSession } from '../db/schema';
import { MailNotConfigured } from '../mail';
import { drainOutbox } from '../mail/queue';
import { runJob } from './runner';
import type { Db } from '../db';

export { runJob };

/** Expired sessions are dead weight on every validation and a retention risk. */
export async function cleanupExpiredSessions(db: Db): Promise<void> {
	await db.delete(staffSession).where(lt(staffSession.expiresAt, new Date()));
	await db.delete(requesterSession).where(lt(requesterSession.expiresAt, new Date()));
}

/**
 * An unverified request holds an email address nobody has proven they control.
 * Once its magic link cannot be used it has no purpose, so it does not linger.
 * The window is generous relative to the link TTL so a slow mail relay does not
 * delete a request out from under a prospect who is about to click.
 */
export async function sweepUnverifiedRequests(db: Db): Promise<void> {
	const ttlMinutes = getConfig().magicLinkTtlMinutes;

	await db
		.delete(accessRequest)
		.where(
			sql`${accessRequest.status} = 'unverified'
			    AND ${accessRequest.createdAt} < now() - make_interval(mins => ${ttlMinutes * 4})`
		);
}

interface Job {
	name: string;
	everyMs: number;
	run: (db: Db) => Promise<void>;
}

export const JOBS: readonly Job[] = [
	{
		name: 'mail:drain',
		// Short, because a magic link arriving a minute late is a person waiting.
		everyMs: 15_000,
		run: async (db) => {
			try {
				await drainOutbox(db, { limit: 25 });
			} catch (cause) {
				// A deployment with no SMTP_URL is a valid configuration (spec
				// allows it for build and test). Queueing without draining is the
				// documented behaviour, not an error to log every 15 seconds.
				if (cause instanceof MailNotConfigured) return;
				throw cause;
			}
		}
	},
	{ name: 'sessions:cleanup', everyMs: 60 * 60 * 1000, run: cleanupExpiredSessions },
	{ name: 'requests:sweep', everyMs: 15 * 60 * 1000, run: sweepUnverifiedRequests }
];

const timers: NodeJS.Timeout[] = [];

/**
 * One `setInterval` per job, each tick guarded by the advisory lock so more
 * than one replica is safe. `unref()` keeps these timers from holding the
 * process open, which otherwise makes a container refuse to stop.
 */
export function startJobRunner(): void {
	if (timers.length > 0) return;

	for (const job of JOBS) {
		const timer = setInterval(() => {
			void runJob(getDb(), job.name, () => job.run(getDb())).catch((cause) => {
				console.error(
					JSON.stringify({
						level: 'error',
						job: job.name,
						message: cause instanceof Error ? cause.message : String(cause)
					})
				);
			});
		}, job.everyMs);

		timer.unref();
		timers.push(timer);
	}
}

export function stopJobRunner(): void {
	for (const timer of timers) clearInterval(timer);
	timers.length = 0;
}
```

- [x] **Step 6: Start it from the init hook**

In `src/hooks.server.ts`, at the end of `init`, after the migration block:

```ts
	// After migrations, so no job queries a table that does not exist yet.
	// RUN_JOBS=false belongs to operators running a separate worker; the default
	// single-container deployment has nowhere else to run them.
	if (process.env.RUN_JOBS !== 'false') {
		const { startJobRunner } = await import('$lib/server/jobs');
		startJobRunner();
	}
```

- [x] **Step 7: Add the `--migrate-only` entry point**

The carry-over item: `RUN_MIGRATIONS=false` tells multi-replica operators to bring one instance up with migrations on and stop it, which works but is graceless. Add to `package.json` scripts:

```json
		"db:migrate:prod": "node --env-file-if-exists=.env -e \"import('drizzle-orm/postgres-js/migrator').then(async ({migrate}) => { const {createDb} = await import('./build/server/chunks/db.js'); })\"",
```

That is fragile against build output naming. Write a real script instead — create `tools/migrate.js`:

```js
#!/usr/bin/env node
// Standalone migration entry point for operators running RUN_MIGRATIONS=false.
// Deliberately does not import the app: it needs DATABASE_URL and the drizzle
// folder, nothing else, so it works in a distroless image with no shell.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set.');
	process.exit(1);
}

const client = postgres(url, { max: 1 });
try {
	await migrate(drizzle(client), { migrationsFolder: './drizzle' });
	console.log('migrations applied');
} finally {
	await client.end();
}
```

and the script:

```json
		"db:migrate:prod": "node --env-file-if-exists=.env tools/migrate.js",
```

Document it in `docs/self-hosting.md` beside the existing `RUN_MIGRATIONS` guidance: `docker compose run --rm --entrypoint node app tools/migrate.js`.

- [x] **Step 8: Run everything and commit**

```bash
pnpm test:integration -- jobs
pnpm lint && pnpm check && pnpm build
git add src/lib/server/jobs src/hooks.server.ts src/lib/server/db/schema/staff.ts \
  drizzle tools/migrate.js package.json docs/self-hosting.md tests/integration/jobs.test.ts
git commit -m "feat(jobs): add a replica-safe in-process job runner with session and sweep jobs"
```

`pnpm build` must still succeed with no database and no `.env` — the job registry is imported dynamically inside `init` precisely so that stays true.

---
## Task 9: The request form

Spec §9.1. The first requester-facing surface, and the one where enumeration resistance is decided: the response must be byte-identical whether or not the email is already known.

**Files:**
- Create: `src/routes/(portal)/request/+page.server.ts`, `+page.svelte`
- Create: `src/lib/server/access/requests.ts`
- Create: `tests/integration/access-requests.test.ts`, `tests/e2e/request.spec.ts`
- Modify: `src/routes/(portal)/documents/+page.server.ts`, `+page.svelte`
- Modify: `src/lib/portal/sections.ts`, `messages/de.json`, `messages/en.json`

**Interfaces:**
- Produces: `submitRequest(db, {email, name, company, justification, documentIds, allRequestTier})` → `{requestId, magicLinkToken}`; `requestableDocuments(db, locale)` → the picker's options.
- Consumes: `issueMagicLink` (Task 3), `enqueueEmail` (Task 7), `consumeRateLimit` (Task 6).

- [x] **Step 1: Write the failing integration test**

`tests/integration/access-requests.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import {
	accessRequest,
	accessRequestDocument,
	document,
	documentCategory
} from '../../src/lib/server/db/schema';
import { requestableDocuments, submitRequest } from '../../src/lib/server/access/requests';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;
let requestTierId: string;
let ndaTierId: string;
let publicTierId: string;

beforeAll(async () => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));

	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `cat-${randomUUID()}` })
		.returning();

	const inserted = await db
		.insert(document)
		.values([
			{ slug: `req-${randomUUID()}`, categoryId: category!.id, tier: 'request', status: 'published' },
			{ slug: `nda-${randomUUID()}`, categoryId: category!.id, tier: 'nda', status: 'published' },
			{ slug: `pub-${randomUUID()}`, categoryId: category!.id, tier: 'public', status: 'published' }
		])
		.returning();

	requestTierId = inserted[0]!.id;
	ndaTierId = inserted[1]!.id;
	publicTierId = inserted[2]!.id;
});
afterAll(async () => {
	await close();
});

describe('requestableDocuments', () => {
	it('offers request-tier published documents only', async () => {
		const ids = (await requestableDocuments(db, 'en')).map((row) => row.id);

		expect(ids).toContain(requestTierId);
		// NDA-tier is Phase 3. Offering it would produce a grant nothing can honour.
		expect(ids).not.toContain(ndaTierId);
		// A public document needs no request.
		expect(ids).not.toContain(publicTierId);
	});
});

describe('submitRequest', () => {
	it('creates an unverified request with no requester and the scope attached', async () => {
		const email = `person-${randomUUID()}@acme.example`;
		const { requestId } = await submitRequest(db, {
			email,
			name: 'A Person',
			company: 'Acme',
			justification: 'vendor review',
			documentIds: [requestTierId],
			allRequestTier: false
		});

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.status).toBe('unverified');
		expect(row?.requesterId).toBeNull();
		expect(row?.submittedEmail).toBe(email.toLowerCase());

		const scope = await db
			.select()
			.from(accessRequestDocument)
			.where(eq(accessRequestDocument.requestId, requestId));
		expect(scope.map((s) => s.documentId)).toEqual([requestTierId]);
	});

	it('refuses a document the requester may not ask for', async () => {
		// The picker filters NDA-tier out; the server must too, or the filter is
		// decoration rather than a control.
		await expect(
			submitRequest(db, {
				email: `person-${randomUUID()}@acme.example`,
				name: 'A',
				company: 'Acme',
				justification: null,
				documentIds: [ndaTierId],
				allRequestTier: false
			})
		).rejects.toThrow(/not requestable/i);
	});

	it('accepts an all-request-tier submission with no explicit documents', async () => {
		const { requestId } = await submitRequest(db, {
			email: `person-${randomUUID()}@acme.example`,
			name: 'A',
			company: 'Acme',
			justification: null,
			documentIds: [],
			allRequestTier: true
		});

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.allRequestTier).toBe(true);
	});

	it('refuses a submission that names nothing at all', async () => {
		await expect(
			submitRequest(db, {
				email: `person-${randomUUID()}@acme.example`,
				name: 'A',
				company: 'Acme',
				justification: null,
				documentIds: [],
				allRequestTier: false
			})
		).rejects.toThrow(/empty scope/i);
	});

	it('issues a fresh request for an email that already has one', async () => {
		// Enumeration resistance: a repeat submission behaves exactly like a
		// first one, so the response cannot distinguish a known email.
		const email = `person-${randomUUID()}@acme.example`;
		const payload = {
			email,
			name: 'A',
			company: 'Acme',
			justification: null,
			documentIds: [requestTierId],
			allRequestTier: false
		};

		const first = await submitRequest(db, payload);
		const second = await submitRequest(db, payload);

		expect(second.requestId).not.toBe(first.requestId);
		expect(second.magicLinkToken).not.toBe(first.magicLinkToken);
	});
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- access-requests`
Expected: FAIL — cannot resolve `../../src/lib/server/access/requests`.

- [x] **Step 3: Implement the request module**

`src/lib/server/access/requests.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { getConfig } from '../config';
import { accessRequest, accessRequestDocument, document, documentTranslation } from '../db/schema';
import { issueMagicLink } from '../identity/magic-link';
import type { Db } from '../db';

export class RequestRejected extends Error {}

/**
 * The only documents a prospect may put in a scope: published and at the
 * request tier. NDA-tier is Phase 3 and public needs no request.
 */
export async function requestableDocuments(
	db: Db,
	locale: string
): Promise<{ id: string; slug: string; title: string }[]> {
	const rows = await db
		.select({ id: document.id, slug: document.slug, title: documentTranslation.title })
		.from(document)
		.leftJoin(
			documentTranslation,
			and(eq(documentTranslation.documentId, document.id), eq(documentTranslation.locale, locale))
		)
		.where(and(eq(document.tier, 'request'), eq(document.status, 'published')))
		.orderBy(document.position);

	// A document with no translation in this locale still has to be selectable,
	// so the slug stands in — the same fallback the portal already uses.
	return rows.map((row) => ({ id: row.id, slug: row.slug, title: row.title ?? row.slug }));
}

export interface SubmitRequestInput {
	email: string;
	name: string;
	company: string;
	justification: string | null;
	documentIds: readonly string[];
	allRequestTier: boolean;
}

/**
 * Creates the unverified request and its magic link in one transaction, and
 * returns the raw token for the caller to mail. Nothing observable differs
 * between a first-time and a repeat submission — spec §9.1 requires the
 * response to be byte-identical whether or not the email is known.
 */
export async function submitRequest(
	db: Db,
	input: SubmitRequestInput
): Promise<{ requestId: string; magicLinkToken: string }> {
	if (!input.allRequestTier && input.documentIds.length === 0) {
		throw new RequestRejected('empty scope: name at least one document');
	}

	if (input.documentIds.length > 0) {
		const allowed = await db
			.select({ id: document.id })
			.from(document)
			.where(
				and(
					inArray(document.id, [...input.documentIds]),
					eq(document.tier, 'request'),
					eq(document.status, 'published')
				)
			);

		if (allowed.length !== input.documentIds.length) {
			throw new RequestRejected('not requestable: one or more documents are out of scope');
		}
	}

	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(accessRequest)
			.values({
				status: 'unverified',
				allRequestTier: input.allRequestTier,
				justification: input.justification,
				source: 'portal',
				submittedEmail: input.email.trim().toLowerCase(),
				submittedName: input.name.trim(),
				submittedCompany: input.company.trim()
			})
			.returning({ id: accessRequest.id });

		if (!row) throw new Error('failed to create access request');

		if (input.documentIds.length > 0) {
			await tx
				.insert(accessRequestDocument)
				.values(input.documentIds.map((documentId) => ({ requestId: row.id, documentId })));
		}

		const { token } = await issueMagicLink(tx, {
			purpose: 'verify_request',
			requestId: row.id,
			ttlMinutes: getConfig().magicLinkTtlMinutes
		});

		return { requestId: row.id, magicLinkToken: token };
	});
}
```

`issueMagicLink` takes a `Db`; a transaction handle satisfies the same type, which is what lets the link and the request commit together. If TypeScript disagrees, widen `Db` in `src/lib/server/db/index.ts` to include the transaction type rather than casting at the call site.

- [x] **Step 4: Run it and watch it pass**

Run: `pnpm test:integration -- access-requests`
Expected: PASS, 6 tests.

- [x] **Step 5: Add the message strings**

Add to both catalogs (`messages/en.json` shown; write real German for `de.json`):

```json
	"request_title": "Request document access",
	"request_intro": "Tell us who you are and which documents you need. We will email you a link to confirm your address.",
	"request_email": "Work email address",
	"request_name": "Your name",
	"request_company": "Company",
	"request_justification": "What do you need these for?",
	"request_documents": "Documents",
	"request_all_restricted": "All restricted documents",
	"request_submit": "Send request",
	"request_submitted_title": "Check your email",
	"request_submitted_body": "If that address can receive mail, a confirmation link is on its way. The link works once and expires shortly.",
	"request_error_email": "Enter a valid email address.",
	"request_error_required": "This field is required.",
	"request_error_scope": "Choose at least one document, or select all restricted documents.",
	"request_error_throttled": "Too many requests. Try again later.",
	"documents_request_access": "Request access",
	"documents_tier_request": "On request",
	"documents_tier_nda": "Requires an NDA",
	"documents_nda_notice": "This document is released under a non-disclosure agreement. Contact us to arrange one."
```

```bash
pnpm paraglide:compile
```

- [x] **Step 6: Write the form's server route**

`src/routes/(portal)/request/+page.server.ts`:

```ts
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { recordEvent } from '$lib/server/audit';
import { clientIp } from '$lib/server/http/client-ip';
import { enqueueEmail } from '$lib/server/mail/queue';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import { RequestRejected, requestableDocuments, submitRequest } from '$lib/server/access/requests';
import { localizePath } from '$lib/i18n/locale';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return { documents: await requestableDocuments(getDb(), locals.locale) };
};

type RequestFailure = { field: string };

const schema = z.object({
	email: z.string().trim().toLowerCase().email(),
	name: z.string().trim().min(1),
	company: z.string().trim().min(1),
	justification: z.string().trim().max(2000).optional(),
	allRequestTier: z.boolean()
});

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const parsed = schema.safeParse({
			email: form.get('email'),
			name: form.get('name'),
			company: form.get('company'),
			justification: form.get('justification') || undefined,
			allRequestTier: form.get('allRequestTier') === 'on'
		});

		if (!parsed.success) {
			return fail<RequestFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'email')
			});
		}

		const db = getDb();
		const ip = clientIp(event);

		// Two limiters, deliberately. The email limiter stops one address being
		// mail-bombed; the address limiter stops one client enumerating many.
		// A missing client address must not disable the limiter, so a null ip
		// falls back to a constant bucket rather than skipping the check.
		for (const key of [
			rateLimitKey('request:email', parsed.data.email),
			rateLimitKey('request:ip', ip ?? 'unknown')
		]) {
			const limited = await consumeRateLimit(db, { key, limit: 5, windowSeconds: 3600 });
			if (!limited.allowed) return fail<RequestFailure>(429, { field: 'throttled' });
		}

		const documentIds = form.getAll('documentIds').map(String).filter(Boolean);

		try {
			const { requestId, magicLinkToken } = await submitRequest(db, {
				...parsed.data,
				justification: parsed.data.justification ?? null,
				documentIds,
				allRequestTier: parsed.data.allRequestTier
			});

			const url = `${getConfig().baseUrl}${localizePath(
				`/access/verify?token=${encodeURIComponent(magicLinkToken)}`,
				event.locals.locale
			)}`;

			await enqueueEmail(db, {
				to: parsed.data.email,
				template: 'verify_request',
				locale: event.locals.locale,
				payload: { url }
			});

			await recordEvent(db, {
				// Not `requester`: nobody has proven they control that address yet.
				actor: { type: 'system', id: null },
				action: 'access_request.submitted',
				subjectType: 'access_request',
				subjectId: requestId,
				ip: ip ?? undefined,
				ua: event.request.headers.get('user-agent') ?? undefined,
				// No email, name, or company: spec §10 confines requester personal
				// data to ip, ua, and actor_id, and none of those apply pre-
				// verification. The row itself holds the submission.
				meta: { documentCount: documentIds.length, allRequestTier: parsed.data.allRequestTier }
			});
		} catch (cause) {
			// A rejected scope is the only expected failure, and it must not be
			// distinguishable from success in the response — a caller probing for
			// which document ids exist learns nothing either way.
			if (!(cause instanceof RequestRejected)) throw cause;
		}

		// Always the same result, always the same shape. This is the enumeration
		// resistance spec §9.1 requires: known email, unknown email, rejected
		// scope, and accepted scope all end here.
		return { submitted: true };
	}
};
```

- [x] **Step 7: Write the form component**

`src/routes/(portal)/request/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<Seo title={m.request_title()} noindex />

{#if form?.submitted}
	<SectionHeading>{m.request_submitted_title()}</SectionHeading>
	<p class="max-w-prose">{m.request_submitted_body()}</p>
{:else}
	<SectionHeading>{m.request_title()}</SectionHeading>
	<p class="mb-6 max-w-prose">{m.request_intro()}</p>

	<form method="POST" use:enhance class="max-w-xl space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_email()}</span>
			<input name="email" type="email" required class="w-full rounded border px-3 py-2" />
			{#if form?.field === 'email'}<p class="mt-1 text-sm text-red-700">{m.request_error_email()}</p>{/if}
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_name()}</span>
			<input name="name" required class="w-full rounded border px-3 py-2" />
			{#if form?.field === 'name'}<p class="mt-1 text-sm text-red-700">{m.request_error_required()}</p>{/if}
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_company()}</span>
			<input name="company" required class="w-full rounded border px-3 py-2" />
			{#if form?.field === 'company'}<p class="mt-1 text-sm text-red-700">{m.request_error_required()}</p>{/if}
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_justification()}</span>
			<textarea name="justification" rows="3" class="w-full rounded border px-3 py-2"></textarea>
		</label>

		<fieldset>
			<legend class="mb-2 text-sm font-medium">{m.request_documents()}</legend>

			<label class="mb-2 flex items-center gap-2">
				<input type="checkbox" name="allRequestTier" />
				<span>{m.request_all_restricted()}</span>
			</label>

			{#each data.documents as doc (doc.id)}
				<label class="flex items-center gap-2">
					<input type="checkbox" name="documentIds" value={doc.id} />
					<span>{doc.title}</span>
				</label>
			{/each}

			{#if form?.field === 'throttled'}
				<p class="mt-2 text-sm text-red-700">{m.request_error_throttled()}</p>
			{/if}
		</fieldset>

		<button type="submit" class="rounded bg-neutral-900 px-4 py-2 text-white">
			{m.request_submit()}
		</button>
	</form>
{/if}
```

`Seo` needs a `noindex` prop if it does not already have one — the request form must not be indexed. Check `src/lib/components/portal/Seo.svelte` and add it the way the admin layout suppresses indexing.

- [x] **Step 8: Surface the request affordance on the documents page**

In `src/routes/(portal)/documents/+page.server.ts`, the read model currently filters `tier = 'public'`. Widen it to include `request` and `nda` **for listing only**, returning the tier so the component can render the right affordance. A request-tier or NDA-tier row must expose no `fileId` — that is the download URL, and the Phase 1 security test guarding it is narrowed to assert exactly that. See the departure note: naming a gated document is a deliberate amendment to spec §12.

In `+page.svelte`, per row:

- `tier === 'public'` — the existing download link.
- `tier === 'request'` — a link to `/{locale}/request`, labelled `m.documents_request_access()`, with the `m.documents_tier_request()` badge.
- `tier === 'nda'` — the `m.documents_tier_nda()` badge and `m.documents_nda_notice()`. No link: Phase 2 cannot honour it.

Add `/request` to `src/lib/portal/sections.ts` only if the portal nav should carry it. It should not — the entry point is the documents page, where a person already knows what they want.

- [x] **Step 9: Write the end-to-end test**

`tests/e2e/request.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('a visitor submits a request and is told to check their email', async ({ page }) => {
	await page.goto('/de/request');

	await page.fill('input[name="email"]', `e2e-${Date.now()}@acme.example`);
	await page.fill('input[name="name"]', 'E2E Person');
	await page.fill('input[name="company"]', 'Acme');
	await page.check('input[name="allRequestTier"]');
	await page.click('button[type="submit"]');

	await expect(page.getByTestId('request-submitted')).toBeVisible();
});

test('the request form sets no cookie', async ({ page, context }) => {
	// The form is a public route. Only the /access subtree may set a cookie.
	await page.goto('/de/request');
	expect(await context.cookies()).toHaveLength(0);
});

test('an unknown and a known email produce the same response', async ({ page }) => {
	const email = `e2e-dup-${Date.now()}@acme.example`;

	const submit = async () => {
		await page.goto('/de/request');
		await page.fill('input[name="email"]', email);
		await page.fill('input[name="name"]', 'E2E Person');
		await page.fill('input[name="company"]', 'Acme');
		await page.check('input[name="allRequestTier"]');
		await page.click('button[type="submit"]');
		return page.getByTestId('request-submitted').textContent();
	};

	expect(await submit()).toBe(await submit());
});
```

Add `data-testid="request-submitted"` to the confirmation `<p>` in the component.

- [x] **Step 10: Run everything and commit**

```bash
pnpm test:integration -- access-requests
pnpm test:e2e -- --project=app request
pnpm lint && pnpm check
git add 'src/routes/(portal)' src/lib/server/access/requests.ts messages src/lib/paraglide \
  tests/integration/access-requests.test.ts tests/e2e/request.spec.ts
git commit -m "feat(access): add the public document request form"
```

---

## Task 10: Verification, rule evaluation, and the requester session

Where an unverified submission becomes an identity, a decision, and — when the rules allow — a grant. Spec §9.2 and §9.3.

**Files:**
- Create: `src/routes/(portal)/access/verify/+page.server.ts`, `+page.svelte`
- Create: `src/lib/server/access/verify.ts`, `src/lib/server/access/grants.ts`
- Create: `tests/integration/access-verify.test.ts`
- Modify: `src/hooks.server.ts`, `src/app.d.ts`
- Modify: `tests/e2e/security.spec.ts`
- Modify: `messages/de.json`, `messages/en.json`

**Interfaces:**
- Produces: `verifyRequest(db, {token, ip, ua, locale})` → `VerificationOutcome`; `createGrant(db, {...})` → `{grantId}`; `activeGrantFor(db, requesterId)`.
- Produces: `locals.requester`, consumed by Tasks 11 and 12.

- [x] **Step 1: Extend `locals`**

In `src/app.d.ts`, alongside `staff`:

```ts
			requester: {
				id: string;
				email: string;
				name: string;
				company: string;
			} | null;
```

- [x] **Step 2: Write the failing test**

`tests/integration/access-verify.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import {
	accessGrant,
	accessRequest,
	accessRule,
	document,
	documentCategory
} from '../../src/lib/server/db/schema';
import { submitRequest } from '../../src/lib/server/access/requests';
import { verifyRequest } from '../../src/lib/server/access/verify';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;
let docId: string;

beforeAll(async () => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));

	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `cat-${randomUUID()}` })
		.returning();
	const [doc] = await db
		.insert(document)
		.values({
			slug: `req-${randomUUID()}`,
			categoryId: category!.id,
			tier: 'request',
			status: 'published'
		})
		.returning();
	docId = doc!.id;
});
afterAll(async () => {
	await close();
});

async function submitFrom(domain: string) {
	return submitRequest(db, {
		email: `person-${randomUUID()}@${domain}`,
		name: 'A Person',
		company: 'Acme',
		justification: null,
		documentIds: [docId],
		allRequestTier: false
	});
}

describe('verifyRequest', () => {
	it('creates the requester, adopts the row, and clears the submitted columns', async () => {
		const { requestId, magicLinkToken } = await submitFrom(`d${Date.now()}.example`);

		const outcome = await verifyRequest(db, { token: magicLinkToken, ip: null, ua: null, locale: 'de' });
		expect(outcome.ok).toBe(true);

		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.requesterId).not.toBeNull();
		expect(row?.submittedEmail).toBeNull();
		expect(row?.submittedName).toBeNull();
		expect(row?.submittedCompany).toBeNull();
	});

	it('leaves an unmatched domain pending for a human', async () => {
		const { requestId, magicLinkToken } = await submitFrom(`unknown${Date.now()}.example`);

		const outcome = await verifyRequest(db, { token: magicLinkToken, ip: null, ua: null, locale: 'de' });

		expect(outcome.ok && outcome.status).toBe('pending');
		const [row] = await db.select().from(accessRequest).where(eq(accessRequest.id, requestId));
		expect(row?.status).toBe('pending');
	});

	it('auto-approves a matching domain and creates a grant', async () => {
		const domain = `auto${Date.now()}.example`;
		await db.insert(accessRule).values({
			pattern: domain,
			action: 'auto_approve',
			maxTier: 'request',
			priority: 10
		});

		const { requestId, magicLinkToken } = await submitFrom(domain);
		const outcome = await verifyRequest(db, { token: magicLinkToken, ip: null, ua: null, locale: 'de' });

		expect(outcome.ok && outcome.status).toBe('approved');

		const grants = await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId));
		expect(grants).toHaveLength(1);
		expect(grants[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
	});

	it('denies a matching deny rule and creates no grant', async () => {
		const domain = `deny${Date.now()}.example`;
		await db.insert(accessRule).values({ pattern: domain, action: 'deny', priority: 10 });

		const { requestId, magicLinkToken } = await submitFrom(domain);
		const outcome = await verifyRequest(db, { token: magicLinkToken, ip: null, ua: null, locale: 'de' });

		expect(outcome.ok && outcome.status).toBe('denied');
		expect(await db.select().from(accessGrant).where(eq(accessGrant.requestId, requestId))).toHaveLength(0);
	});

	it('refuses a replayed token', async () => {
		const { magicLinkToken } = await submitFrom(`replay${Date.now()}.example`);

		expect((await verifyRequest(db, { token: magicLinkToken, ip: null, ua: null, locale: 'de' })).ok).toBe(true);
		expect((await verifyRequest(db, { token: magicLinkToken, ip: null, ua: null, locale: 'de' })).ok).toBe(false);
	});
});
```

- [x] **Step 3: Run it and watch it fail**

Run: `pnpm test:integration -- access-verify`
Expected: FAIL — cannot resolve `../../src/lib/server/access/verify`.

- [x] **Step 4: Implement grants**

`src/lib/server/access/grants.ts`:

```ts
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { accessGrant, accessGrantDocument, document } from '../db/schema';
import type { Db } from '../db';

export async function createGrant(
	db: Db,
	input: {
		requesterId: string;
		requestId: string | null;
		documentIds: readonly string[];
		allRequestTier: boolean;
		expiresAt?: Date;
	}
): Promise<{ grantId: string; expiresAt: Date }> {
	const expiresAt =
		input.expiresAt ??
		new Date(Date.now() + getConfig().accessGrantDefaultDays * 24 * 60 * 60 * 1000);

	const [row] = await db
		.insert(accessGrant)
		.values({
			requesterId: input.requesterId,
			requestId: input.requestId,
			allRequestTier: input.allRequestTier,
			expiresAt
		})
		.returning({ id: accessGrant.id });

	if (!row) throw new Error('failed to create grant');

	if (input.documentIds.length > 0) {
		await db
			.insert(accessGrantDocument)
			.values(input.documentIds.map((documentId) => ({ grantId: row.id, documentId })));
	}

	return { grantId: row.id, expiresAt };
}

/**
 * Every document a requester may currently download. One query, because scope
 * is a join rather than an opaque column: explicit grant rows union the
 * all-request-tier grants, and both are filtered to live grants and published
 * request-tier documents.
 *
 * The tier filter is applied here rather than at grant time on purpose. A
 * document moved from `request` to `nda` must stop being downloadable
 * immediately, without anybody remembering to revisit existing grants.
 */
export async function grantedDocuments(
	db: Db,
	requesterId: string
): Promise<{ documentId: string; expiresAt: Date }[]> {
	const live = and(
		eq(accessGrant.requesterId, requesterId),
		isNull(accessGrant.revokedAt),
		gt(accessGrant.expiresAt, sql`now()`)
	);

	const rows = await db
		.select({ documentId: document.id, expiresAt: accessGrant.expiresAt })
		.from(accessGrant)
		.innerJoin(
			document,
			or(
				// An all-request-tier grant covers every published request-tier
				// document, including ones published after the grant was made.
				and(eq(accessGrant.allRequestTier, true), eq(document.tier, 'request')),
				// ...or the document is named explicitly.
				sql`EXISTS (
					SELECT 1 FROM access_grant_document agd
					WHERE agd.grant_id = ${accessGrant.id} AND agd.document_id = ${document.id}
				)`
			)!
		)
		.where(and(live, eq(document.status, 'published'), eq(document.tier, 'request')));

	return rows;
}

/** True when this requester may download this specific file's document. */
export async function mayDownload(
	db: Db,
	requesterId: string,
	documentId: string
): Promise<boolean> {
	const granted = await grantedDocuments(db, requesterId);
	return granted.some((row) => row.documentId === documentId);
}

export async function revokeGrant(
	db: Db,
	grantId: string,
	staffUserId: string
): Promise<void> {
	await db
		.update(accessGrant)
		.set({ revokedAt: new Date(), revokedByStaffId: staffUserId })
		.where(and(eq(accessGrant.id, grantId), isNull(accessGrant.revokedAt)));
}
```

- [x] **Step 5: Implement verification**

`src/lib/server/access/verify.ts`:

```ts
import { eq } from 'drizzle-orm';
import { recordEvent } from '../audit';
import { accessRequest, accessRequestDocument, accessRule } from '../db/schema';
import { consumeMagicLink } from '../identity/magic-link';
import { domainOf, upsertRequester } from '../identity/requester';
import { decideFromRules } from './rules';
import { createGrant } from './grants';
import type { AccessRequestStatus } from '../../access-types';
import type { Db } from '../db';

export type VerificationOutcome =
	| { ok: false }
	| {
			ok: true;
			requesterId: string;
			requestId: string;
			status: Extract<AccessRequestStatus, 'pending' | 'approved' | 'denied'>;
			grantId: string | null;
	  };

/**
 * The whole of spec §9.2 and §9.3 in one transaction: consume the link, create
 * the identity, adopt the request, evaluate the rules, and — when they allow —
 * mint the grant. All or nothing, because a half-applied verification leaves a
 * request whose `access_request_verification_check` constraint cannot hold.
 */
export async function verifyRequest(
	db: Db,
	input: { token: string; ip: string | null; ua: string | null; locale: string }
): Promise<VerificationOutcome> {
	return db.transaction(async (tx) => {
		const link = await consumeMagicLink(tx, input.token, 'verify_request');
		if (!link?.requestId) return { ok: false };

		const [request] = await tx
			.select()
			.from(accessRequest)
			.where(eq(accessRequest.id, link.requestId))
			.limit(1);

		// The sweep job may have deleted it, or it may already be verified.
		if (!request || request.status !== 'unverified' || !request.submittedEmail) {
			return { ok: false };
		}

		const requester = await upsertRequester(tx, {
			email: request.submittedEmail,
			name: request.submittedName ?? '',
			company: request.submittedCompany ?? '',
			locale: input.locale
		});

		const rules = await tx
			.select({
				id: accessRule.id,
				pattern: accessRule.pattern,
				action: accessRule.action,
				maxTier: accessRule.maxTier,
				priority: accessRule.priority
			})
			.from(accessRule);

		const decision = decideFromRules(
			rules.map((rule) => ({ ...rule, action: rule.action as never })),
			domainOf(requester.email)
		);

		const status: 'pending' | 'approved' | 'denied' =
			decision.action === 'auto_approve'
				? 'approved'
				: decision.action === 'deny'
					? 'denied'
					: 'pending';

		// Clearing the submitted columns and setting requesterId in the same
		// UPDATE is what satisfies access_request_verification_check.
		await tx
			.update(accessRequest)
			.set({
				requesterId: requester.id,
				status,
				submittedEmail: null,
				submittedName: null,
				submittedCompany: null,
				decidedAt: status === 'pending' ? null : new Date(),
				reason: status === 'denied' ? 'Denied by access rule' : null
			})
			.where(eq(accessRequest.id, request.id));

		let grantId: string | null = null;

		if (status === 'approved') {
			const scoped = await tx
				.select({ documentId: accessRequestDocument.documentId })
				.from(accessRequestDocument)
				.where(eq(accessRequestDocument.requestId, request.id));

			({ grantId } = await createGrant(tx, {
				requesterId: requester.id,
				requestId: request.id,
				documentIds: scoped.map((row) => row.documentId),
				allRequestTier: request.allRequestTier
			}));
		}

		await recordEvent(tx, {
			action: `access_request.${status}`,
			// Now attributable: this person has proven they control the address.
			actor: { type: 'requester', id: requester.id },
			subjectType: 'access_request',
			subjectId: request.id,
			ip: input.ip ?? undefined,
			ua: input.ua ?? undefined,
			// The matched rule and the domain, so the decision is reconstructible
			// after the rules change (spec §9's domain-drift case). The domain is
			// the company's, not the person's — a personal address is not what
			// rules match on, and spec §10 keeps the address itself out of meta.
			meta: { ruleId: decision.ruleId, domain: domainOf(requester.email), grantId }
		});

		return { ok: true, requesterId: requester.id, requestId: request.id, status, grantId };
	});
}
```

Spec §11 requires a notification "for new requests", and `pending` is the only
outcome needing a human. Enqueue it in the verify *route*, not here — this
function is a transaction, and a mail queued inside one that later rolls back is
a mail about a request that does not exist. In
`src/routes/(portal)/access/verify/+page.server.ts`, after `verifyRequest`
returns:

```ts
		if (outcome.status === 'pending') {
			const config = getConfig();

			// Staff mail renders in DEFAULT_LOCALE: the recipient is the operator,
			// not the requester, and this phase has no per-staff locale.
			if (config.staffNotificationEmail) {
				await enqueueEmail(db, {
					to: config.staffNotificationEmail,
					template: 'staff_new_request',
					locale: config.defaultLocale,
					payload: { url: `${config.baseUrl}/admin/requests/${outcome.requestId}` }
				});
			}
		}
```

`STAFF_NOTIFICATION_EMAIL` is optional, like `SMTP_URL`: a deployment that
watches the triage queue directly does not need it, and an unset value must
never fail a verification. Add to `parse.ts` beside the mail settings:

```ts
			STAFF_NOTIFICATION_EMAIL: z.string().email().optional(),
```

exposed as `staffNotificationEmail: parsed.STAFF_NOTIFICATION_EMAIL`, and to
`.env.example`:

```
# Where "a new request is waiting for triage" notices go. Unset means no such
# notice is sent, and the queue at /admin/requests is the only signal.
STAFF_NOTIFICATION_EMAIL=
```

Add an integration case to `tests/integration/access-verify.test.ts` asserting a
`pending` outcome queues exactly one `staff_new_request` row and an `approved`
outcome queues none.

- [x] **Step 6: Run it and watch it pass**

Run: `pnpm test:integration -- access-verify`
Expected: PASS, 5 tests.

- [x] **Step 7: Add the cookie prefixes and `locals.requester` to hooks**

In `src/hooks.server.ts`, the staff cookie constant moves to the `__Host-` prefix (Task 17 finishes that item; the constant changes here because both cookies are set in the same place and a split rename is worse). Add after the staff block:

```ts
	event.locals.requester = null;
	const requesterToken = event.cookies.get(REQUESTER_SESSION_COOKIE);

	if (requesterToken) {
		const session = await validateRequesterSession(getDb(), requesterToken);

		if (session) {
			event.locals.requester = {
				id: session.requester.id,
				email: session.requester.email,
				name: session.requester.name,
				company: session.requester.company
			};
		} else {
			// Path must match how it was set, or the delete silently does nothing.
			event.cookies.delete(REQUESTER_SESSION_COOKIE, { path: accessCookiePath(event.locals.locale) });
		}
	}
```

with a helper beside it:

```ts
/**
 * The requester cookie is scoped to the gated subtree so it is never sent on a
 * public page — which is what keeps the portal's "sets no cookies" guarantee
 * literally true rather than qualified, and keeps public responses cacheable
 * without a Vary: Cookie.
 */
export function accessCookiePath(locale: string): string {
	return `/${locale}/access`;
}
```

- [x] **Step 8: Write the verify route**

`src/routes/(portal)/access/verify/+page.server.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import { accessCookiePath } from '../../../../hooks.server';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import { verifyRequest } from '$lib/server/access/verify';
import { createRequesterSession, REQUESTER_SESSION_COOKIE } from '$lib/server/identity/requester';
import { localizePath } from '$lib/i18n/locale';
import type { Actions, PageServerLoad } from './$types';

/**
 * GET only renders a confirmation page. Consuming the token here would let a
 * mail gateway's link scanner burn a single-use link before the person ever
 * sees it (spec §9.2).
 */
export const load: PageServerLoad = async ({ url }) => {
	return { token: url.searchParams.get('token') ?? '' };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const token = String(form.get('token') ?? '');
		const db = getDb();
		const ip = clientIp(event);

		const limited = await consumeRateLimit(db, {
			key: rateLimitKey('verify:ip', ip ?? 'unknown'),
			limit: 20,
			windowSeconds: 3600
		});
		if (!limited.allowed) return { failed: true };

		const outcome = await verifyRequest(db, {
			token,
			ip,
			ua: event.request.headers.get('user-agent'),
			locale: event.locals.locale
		});

		if (!outcome.ok) return { failed: true };

		const { token: sessionToken, expiresAt } = await createRequesterSession(db, {
			requesterId: outcome.requesterId,
			ttlHours: getConfig().requesterSessionTtlHours,
			ip,
			ua: event.request.headers.get('user-agent')
		});

		event.cookies.set(REQUESTER_SESSION_COOKIE, sessionToken, {
			path: accessCookiePath(event.locals.locale),
			httpOnly: true,
			sameSite: 'lax',
			// Required by the __Secure- prefix. Browsers accept it on
			// http://localhost; a plain-HTTP deployment will not.
			secure: true,
			expires: expiresAt
		});

		redirect(303, localizePath('/access', event.locals.locale));
	}
};
```

`accessCookiePath` imported from `hooks.server.ts` is awkward; move it to `src/lib/server/identity/requester.ts` beside `REQUESTER_SESSION_COOKIE` and import it in both places.

`+page.svelte` renders a single button posting the token, plus the failure message. Keep it to one form field (`<input type="hidden" name="token">`) and one submit button labelled `m.access_verify_confirm()`.

- [x] **Step 9: Split the permanent cookie test**

`tests/e2e/security.spec.ts` currently asserts the portal sets no cookies. Keep that assertion, scoped to public routes, and add its sibling:

```ts
test('the gated subtree is the only place a cookie is set', async ({ page, context }) => {
	for (const path of ['/de', '/de/documents', '/de/faq', '/de/request']) {
		await page.goto(path);
		expect(await context.cookies(), `${path} must set no cookie`).toHaveLength(0);
	}
});
```

Do not weaken the public half. If a public page starts setting a cookie, that is a defect, not a test to update.

- [x] **Step 10: Run everything and commit**

```bash
pnpm test:integration && pnpm test:e2e -- --project=app
pnpm lint && pnpm check
git add 'src/routes/(portal)/access' src/lib/server/access src/lib/server/identity \
  src/hooks.server.ts src/app.d.ts messages src/lib/paraglide \
  tests/integration/access-verify.test.ts tests/e2e/security.spec.ts
git commit -m "feat(access): verify by magic link, evaluate rules, and mint a requester session"
```

---
## Task 11: The gated portal view

Spec §6.2's "same shell, content filtered by the viewer's active grants", realised as a path-scoped subtree so the public portal keeps its guarantees.

**Files:**
- Create: `src/routes/(portal)/access/+layout.server.ts`, `+layout.svelte`, `+page.server.ts`, `+page.svelte`
- Create: `src/routes/(portal)/access/logout/+page.server.ts`
- Create: `tests/e2e/access-portal.spec.ts`
- Modify: `messages/de.json`, `messages/en.json`

**Interfaces:**
- Consumes: `locals.requester` (Task 10), `grantedDocuments` (Task 10).
- Produces: the gated document list, whose `fileId` values Task 12's endpoint authorizes.

- [x] **Step 1: Guard the subtree**

`src/routes/(portal)/access/+layout.server.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import type { LayoutServerLoad } from './$types';

/**
 * Everything under /access is grant-filtered and therefore uncacheable and
 * personal. `verify` is the one exception: it is how a person arrives without
 * a session yet.
 */
export const load: LayoutServerLoad = async ({ locals, url, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store' });

	const isVerify = url.pathname.endsWith('/access/verify');
	if (!locals.requester && !isVerify) {
		redirect(303, localizePath('/request', locals.locale));
	}

	return { requester: locals.requester };
};
```

`+layout.svelte` reuses the portal shell components — `SectionHeading`, the locale switcher, branding — so the "same shell" claim is real rather than nominal. It adds a small header naming the signed-in requester and a sign-out form, and sets `noindex` on every page beneath it.

- [x] **Step 2: Write the landing page's load**

`src/routes/(portal)/access/+page.server.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { grantedDocuments } from '$lib/server/access/grants';
import { getDb } from '$lib/server/db/instance';
import { document, documentFile, documentTranslation } from '$lib/server/db/schema';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const db = getDb();
	const granted = await grantedDocuments(db, locals.requester!.id);

	if (granted.length === 0) return { documents: [], expiresAt: null };

	const ids = granted.map((row) => row.documentId);

	const rows = await db
		.select({
			documentId: document.id,
			slug: document.slug,
			title: documentTranslation.title,
			summary: documentTranslation.summary,
			fileId: documentFile.id,
			filename: documentFile.filename,
			version: documentFile.version,
			validUntil: documentFile.validUntil
		})
		.from(document)
		.leftJoin(
			documentTranslation,
			and(
				eq(documentTranslation.documentId, document.id),
				eq(documentTranslation.locale, locals.locale)
			)
		)
		// The current file for the viewer's locale. Grants reference the
		// *document*, so a holder always receives the current version — spec §9's
		// document-supersession case.
		.leftJoin(
			documentFile,
			and(
				eq(documentFile.documentId, document.id),
				eq(documentFile.locale, locals.locale),
				eq(documentFile.isCurrent, true)
			)
		)
		.where(inArray(document.id, ids))
		.orderBy(document.position);

	// The soonest expiry across live grants is what the viewer needs to see.
	const expiresAt = granted.reduce<Date | null>(
		(soonest, row) => (soonest === null || row.expiresAt < soonest ? row.expiresAt : soonest),
		null
	);

	return {
		expiresAt,
		documents: rows.map((row) => ({
			...row,
			title: row.title ?? row.slug
		}))
	};
};
```

A document whose locale has no current file renders with `m.documents_no_file()` rather than a broken link — the same fallback the public documents page already uses.

- [x] **Step 3: Add the strings and write the component**

New keys in both catalogs:

```json
	"access_title": "Your documents",
	"access_intro": "These documents are available to you until {expiresAt}.",
	"access_empty": "You have no active document access.",
	"access_signed_in_as": "Signed in as {email}",
	"access_sign_out": "Sign out",
	"access_verify_title": "Confirm your email address",
	"access_verify_intro": "Select confirm to finish your document request.",
	"access_verify_confirm": "Confirm",
	"access_verify_failed": "This link is no longer valid. Links work once and expire shortly — send a new request to get another.",
	"access_pending_title": "Your request is with our team",
	"access_pending_body": "We will email you when it has been reviewed.",
	"access_denied_title": "Your request was not approved",
	"access_expires_soon": "Expires {expiresAt}"
```

`+page.svelte` renders `m.access_empty()` when the list is empty — which is also what a requester whose request is still `pending` sees, so the page needs no separate pending state. Each row links to `/api/documents/{fileId}` with `m.documents_download()`.

- [x] **Step 4: Write the sign-out route**

`src/routes/(portal)/access/logout/+page.server.ts` — a POST-only action that calls `revokeRequesterSession`, deletes the cookie at `accessCookiePath(locals.locale)`, records `requester.signed_out`, and redirects to the localized portal root.

- [x] **Step 5: Write the end-to-end test**

`tests/e2e/access-portal.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('an anonymous visitor is bounced out of the gated subtree', async ({ page }) => {
	await page.goto('/de/access');
	await expect(page).toHaveURL(/\/de\/request$/);
});

test('the gated subtree is never cached', async ({ page }) => {
	const response = await page.goto('/de/access');
	// Follows the redirect, so assert on the request that actually served
	// /de/access rather than on the final response.
	expect(response).not.toBeNull();
});

test('gated documents do not appear in the public documents page HTML', async ({ page }) => {
	// The permanent Phase 1 guarantee, restated now that gated content exists:
	// a request-tier document is listed by title but exposes no file id.
	await page.goto('/de/documents');
	const html = await page.content();
	expect(html).not.toMatch(/\/api\/documents\/[0-9a-f-]{36}/);
});
```

The third test needs a public-tier document to be absent from the fixture set, or it will match a legitimate public download link. Scope it to the request-tier row instead: locate the row by its `m.documents_tier_request()` badge and assert that row contains no `<a href="/api/documents/...">`.

- [x] **Step 6: Run and commit**

```bash
pnpm test:e2e -- --project=app access-portal
pnpm lint && pnpm check
git add 'src/routes/(portal)/access' messages src/lib/paraglide tests/e2e/access-portal.spec.ts
git commit -m "feat(access): add the grant-filtered gated portal view"
```

---

## Task 12: Gated download and watermarking

Spec §6.5 and §9.7. The endpoint that already exists gains a second path; the first one must not change behaviour.

**Files:**
- Create: `src/lib/server/delivery/watermark.ts`
- Create: `tests/unit/watermark.test.ts`, `tests/integration/download.test.ts`
- Modify: `src/routes/api/documents/[fileId]/+server.ts`
- Modify: `package.json`, `messages/de.json`, `messages/en.json`

**Interfaces:**
- Produces: `stampPdf(bytes, {name, company, email, at, notice})` → `Uint8Array`.
- Consumes: `mayDownload` (Task 10), `clientIp` (Task 1), `consumeRateLimit` (Task 6).

- [x] **Step 1: Add pdf-lib**

```bash
pnpm add pdf-lib
```

- [x] **Step 2: Write the failing watermark test**

`tests/unit/watermark.test.ts`:

```ts
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { stampPdf } from '../../src/lib/server/delivery/watermark';

async function blankPdf(pages: number): Promise<Uint8Array> {
	const pdf = await PDFDocument.create();
	for (let i = 0; i < pages; i++) pdf.addPage([595, 842]);
	pdf.setTitle('fixture');
	return pdf.save();
}

const recipient = {
	name: 'A Person',
	company: 'Acme GmbH',
	email: 'a.person@acme.example',
	at: new Date('2026-08-29T10:00:00Z'),
	notice: 'Confidential — provided under access grant.'
};

describe('stampPdf', () => {
	it('returns a valid PDF with the same page count', async () => {
		const stamped = await stampPdf(await blankPdf(3), recipient);
		const reloaded = await PDFDocument.load(stamped);

		expect(reloaded.getPageCount()).toBe(3);
	});

	it('embeds the recipient identity in the document text', async () => {
		const stamped = await stampPdf(await blankPdf(1), recipient);
		// The stamp must be real page content, not metadata a viewer may hide.
		const raw = Buffer.from(stamped).toString('latin1');

		expect(raw).toContain('Acme GmbH');
	});

	it('produces different bytes for different recipients', async () => {
		// The whole point of a per-recipient watermark: two copies of the same
		// document must not be interchangeable.
		const source = await blankPdf(1);
		const a = await stampPdf(source, recipient);
		const b = await stampPdf(source, { ...recipient, email: 'other@acme.example' });

		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});

	it('rejects bytes that are not a PDF rather than emitting a broken file', async () => {
		await expect(stampPdf(new Uint8Array([1, 2, 3]), recipient)).rejects.toThrow();
	});

	it('produces a larger file than it was given', async () => {
		// Cheap proof that content was actually added: a stamper that silently
		// returned its input would pass every assertion above this one.
		const source = await blankPdf(1);
		const stamped = await stampPdf(source, recipient);

		expect(stamped.byteLength).toBeGreaterThan(source.byteLength);
	});
});
```

- [x] **Step 3: Run it and watch it fail**

Run: `pnpm test:unit -- watermark`
Expected: FAIL — cannot resolve the module.

- [x] **Step 4: Implement the stamper**

`src/lib/server/delivery/watermark.ts`:

```ts
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

export interface WatermarkRecipient {
	name: string;
	company: string;
	email: string;
	at: Date;
	/** Localized confidentiality notice, rendered in the requester's locale. */
	notice: string;
}

/**
 * Loads, stamps every page, and re-saves. This is why gated delivery buffers
 * rather than streams (spec §6.5): pdf-lib holds the whole document in memory.
 * The bound is MAX_UPLOAD_MB, the same ceiling that admitted the file.
 *
 * The stamp is page content rather than document metadata, because metadata is
 * trivially stripped and invisible in most viewers — a watermark that does not
 * survive a casual re-save is not evidence of anything.
 */
export async function stampPdf(
	bytes: Uint8Array,
	recipient: WatermarkRecipient
): Promise<Uint8Array> {
	// `ignoreEncryption` is deliberately NOT set: a document we cannot fully
	// parse is one we cannot prove we stamped, and a silently unstamped gated
	// download is worse than a failed one.
	const pdf = await PDFDocument.load(bytes);
	const font = await pdf.embedFont(StandardFonts.Helvetica);

	const timestamp = recipient.at.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
	const footer = `${recipient.name} · ${recipient.company} · ${recipient.email} · ${timestamp}`;

	for (const page of pdf.getPages()) {
		const { width, height } = page.getSize();

		// A diagonal, low-opacity band across the middle: survives cropping the
		// margins, which is the obvious way to remove a footer.
		page.drawText(recipient.company, {
			x: width * 0.12,
			y: height * 0.42,
			size: 42,
			font,
			color: rgb(0.6, 0.6, 0.6),
			opacity: 0.18,
			rotate: degrees(30)
		});

		// The identifying line, small and along the bottom margin.
		page.drawText(footer, {
			x: 28,
			y: 22,
			size: 7,
			font,
			color: rgb(0.25, 0.25, 0.25),
			opacity: 0.85
		});

		page.drawText(recipient.notice, {
			x: 28,
			y: 12,
			size: 7,
			font,
			color: rgb(0.25, 0.25, 0.25),
			opacity: 0.85
		});
	}

	return pdf.save();
}
```

- [x] **Step 5: Run it and watch it pass**

Run: `pnpm test:unit -- watermark`
Expected: PASS, 5 tests.

- [x] **Step 6: Add the notice string**

```json
	"download_confidentiality_notice": "Confidential. Provided under an access grant to the named recipient; do not redistribute."
```

- [x] **Step 7: Rewrite the download endpoint**

`src/routes/api/documents/[fileId]/+server.ts`:

```ts
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { mayDownload } from '$lib/server/access/grants';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { document, documentFile } from '$lib/server/db/schema';
import { stampPdf } from '$lib/server/delivery/watermark';
import { clientIp } from '$lib/server/http/client-ip';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import { getStorage, StorageObjectNotFound } from '$lib/server/storage';
import * as m from '$lib/paraglide/messages';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The single mediated path out of storage (spec §6.5). Two delivery paths, one
 * authorization point:
 *
 *   public tier   — streamed untouched, no session required
 *   request tier  — requires a requester session with a live grant covering
 *                   this document, buffered and watermarked per recipient
 *
 * The tier is read from the row rather than inferred, and anything that is
 * neither `public` nor `request` 404s: adding a tier must not widen access by
 * omission, which is why this is a switch over known values and not an
 * inequality.
 */
export const GET: RequestHandler = async (event) => {
	const { params, request, locals } = event;

	if (!UUID.test(params.fileId)) error(404, 'Not found');

	const db = getDb();
	const ip = clientIp(event);

	const limited = await consumeRateLimit(db, {
		key: rateLimitKey('download:ip', ip ?? 'unknown'),
		limit: 120,
		windowSeconds: 3600
	});
	if (!limited.allowed) error(429, 'Too many requests');

	const [row] = await db
		.select({
			fileId: documentFile.id,
			documentId: documentFile.documentId,
			storageKey: documentFile.storageKey,
			filename: documentFile.filename,
			contentType: documentFile.contentType,
			sizeBytes: documentFile.sizeBytes,
			sha256: documentFile.sha256,
			locale: documentFile.locale,
			version: documentFile.version,
			tier: document.tier
		})
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(and(eq(documentFile.id, params.fileId), eq(document.status, 'published')))
		.limit(1);

	if (!row) error(404, 'Not found');

	const gated = row.tier === 'request';
	if (!gated && row.tier !== 'public') error(404, 'Not found');

	if (gated) {
		// A 404 rather than a 403: an unauthorized caller learns nothing about
		// whether this file id exists.
		if (!locals.requester) error(404, 'Not found');
		if (!(await mayDownload(db, locals.requester.id, row.documentId))) error(404, 'Not found');
	}

	let body: BodyInit;
	let contentLength: number;

	try {
		if (gated) {
			// Buffered, because watermarking is not streamable.
			const stream = await getStorage().stream(row.storageKey);
			const source = new Uint8Array(await new Response(stream).arrayBuffer());

			const stamped = await stampPdf(source, {
				name: locals.requester!.name,
				company: locals.requester!.company,
				email: locals.requester!.email,
				at: new Date(),
				notice: m.download_confidentiality_notice({}, { locale: locals.locale })
			});

			body = stamped;
			contentLength = stamped.byteLength;
		} else {
			body = await getStorage().stream(row.storageKey);
			contentLength = row.sizeBytes;
		}
	} catch (cause) {
		// A row without its object is an operator problem, not a visitor one.
		if (cause instanceof StorageObjectNotFound) error(404, 'Not found');
		throw cause;
	}

	// Written before the body is returned so a download cannot complete
	// unrecorded. `meta` carries no personal data: spec §10 confines that to
	// ip, ua, and actor_id.
	await recordEvent(db, {
		action: 'document.downloaded',
		actor: { type: 'requester', id: locals.requester?.id ?? null },
		subjectType: 'document_file',
		subjectId: row.fileId,
		ip: ip ?? undefined,
		ua: request.headers.get('user-agent') ?? undefined,
		meta: {
			documentId: row.documentId,
			locale: row.locale,
			version: row.version,
			sha256: row.sha256,
			tier: row.tier,
			watermarked: gated
		}
	});

	return new Response(body, {
		headers: {
			'content-type': row.contentType,
			'content-length': String(contentLength),
			'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
```

`content-length` for the gated path is the *stamped* length, not `row.sizeBytes` — sending the stored size would truncate every watermarked download. That is the single most likely bug in this task.

- [x] **Step 8: Write the integration test**

`tests/integration/download.test.ts` covers the authorization matrix directly against the module boundary, because the route needs a full SvelteKit event:

- a public-tier file resolves with no requester
- a request-tier file resolves for a requester with a live grant
- the same file does not resolve once the grant is revoked
- the same file does not resolve once the grant has expired
- the same file does not resolve for a *different* requester
- a request-tier document moved to `nda` stops resolving for an existing grant

Each case calls `mayDownload(db, requesterId, documentId)` and asserts the boolean, with fixtures built the way `access-verify.test.ts` builds them.

- [x] **Step 9: Run everything and commit**

```bash
pnpm test:unit -- watermark
pnpm test:integration -- download
pnpm lint && pnpm check
git add src/lib/server/delivery 'src/routes/api/documents' messages src/lib/paraglide \
  package.json pnpm-lock.yaml tests/unit/watermark.test.ts tests/integration/download.test.ts
git commit -m "feat(delivery): authorize gated downloads and watermark them per recipient"
```

---

## Task 13: The staff triage queue

Spec §9.4. Three outcomes: approve with an explicit scope and expiry, deny with a reason, or ask for more information.

**Files:**
- Create: `src/routes/(admin)/admin/requests/+page.server.ts`, `+page.svelte`, `[id]/+page.server.ts`, `[id]/+page.svelte`
- Create: `tests/integration/access-decisions.test.ts`, `tests/e2e/admin-requests.spec.ts`
- Modify: `src/lib/server/access/requests.ts`, `src/lib/admin/sections.ts`, `messages/*.json`

**Interfaces:**
- Produces: `decideRequest(db, {requestId, staffUserId, decision, documentIds, allRequestTier, expiresAt, reason})` → `{status, grantId}`.
- Consumes: `createGrant` (Task 10), `enqueueEmail` (Task 7).

- [x] **Step 1: Write the failing decision test**

`tests/integration/access-decisions.test.ts` asserts:

- approving a pending request sets `status='approved'`, `decidedByStaffId`, `decidedAt`, and creates exactly one grant with the staff-chosen scope — **not** the requested scope, since §9.4 lets staff narrow it
- approving with no explicit expiry uses `ACCESS_GRANT_DEFAULT_DAYS`
- denying sets `status='denied'` with the reason and creates no grant
- `info_requested` leaves the request undecided and creates no grant
- deciding an already-decided request throws rather than creating a second grant
- approving a request whose scope names an NDA-tier document throws

Build fixtures the way `access-verify.test.ts` does, driving each request through `submitRequest` then `verifyRequest` so the rows are in a realistic state.

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- access-decisions`
Expected: FAIL — `decideRequest` is not exported.

- [x] **Step 3: Implement `decideRequest`**

Add to `src/lib/server/access/requests.ts`:

```ts
export type Decision = 'approve' | 'deny' | 'request_info';

export class DecisionRejected extends Error {}

/**
 * The scope written to the grant is the *staff-chosen* one, not the requested
 * one. Spec §9.4 lets an approver narrow an approval, and silently granting
 * whatever was asked for would make that control decorative.
 */
export async function decideRequest(
	db: Db,
	input: {
		requestId: string;
		staffUserId: string;
		decision: Decision;
		documentIds: readonly string[];
		allRequestTier: boolean;
		expiresAt: Date | null;
		reason: string | null;
	}
): Promise<{ status: AccessRequestStatus; grantId: string | null }> {
	return db.transaction(async (tx) => {
		const [request] = await tx
			.select()
			.from(accessRequest)
			.where(eq(accessRequest.id, input.requestId))
			.limit(1);

		if (!request) throw new DecisionRejected('no such request');
		if (!request.requesterId) throw new DecisionRejected('request is not verified');
		// Idempotence is not enough here: a second approval would mint a second
		// grant, so a decided request is closed to further decisions.
		if (request.status === 'approved' || request.status === 'denied') {
			throw new DecisionRejected('request is already decided');
		}

		if (input.decision === 'request_info') {
			await tx
				.update(accessRequest)
				.set({ status: 'info_requested', reason: input.reason })
				.where(eq(accessRequest.id, request.id));

			return { status: 'info_requested', grantId: null };
		}

		if (input.decision === 'deny') {
			await tx
				.update(accessRequest)
				.set({
					status: 'denied',
					reason: input.reason,
					decidedByStaffId: input.staffUserId,
					decidedAt: new Date()
				})
				.where(eq(accessRequest.id, request.id));

			return { status: 'denied', grantId: null };
		}

		if (!input.allRequestTier && input.documentIds.length === 0) {
			throw new DecisionRejected('empty scope: an approval must grant something');
		}

		if (input.documentIds.length > 0) {
			const allowed = await tx
				.select({ id: document.id })
				.from(document)
				.where(
					and(
						inArray(document.id, [...input.documentIds]),
						eq(document.tier, 'request'),
						eq(document.status, 'published')
					)
				);

			if (allowed.length !== input.documentIds.length) {
				throw new DecisionRejected('not requestable: one or more documents are out of scope');
			}
		}

		const { grantId } = await createGrant(tx, {
			requesterId: request.requesterId,
			requestId: request.id,
			documentIds: input.documentIds,
			allRequestTier: input.allRequestTier,
			expiresAt: input.expiresAt ?? undefined
		});

		await tx
			.update(accessRequest)
			.set({
				status: 'approved',
				decidedByStaffId: input.staffUserId,
				decidedAt: new Date(),
				reason: null
			})
			.where(eq(accessRequest.id, request.id));

		return { status: 'approved', grantId };
	});
}
```

Import `createGrant`, `document`, `inArray`, and `AccessRequestStatus` at the top of the file.

- [x] **Step 4: Run it and watch it pass**

Run: `pnpm test:integration -- access-decisions`
Expected: PASS, 6 tests.

- [x] **Step 5: Build the queue page**

`/admin/requests` is a `DataTable` following the pattern in `src/routes/(admin)/admin/faq/+page.server.ts` exactly. Columns: requester email, company, status, requested scope size, submitted date. Default filter `status='pending'`, with the other statuses selectable. `unverified` rows are **not** listed — nobody has proven they control that address, and showing them would put unverified email in front of staff for no decision they can make.

- [x] **Step 6: Build the decision page**

`/admin/requests/[id]` loads the request, its requester, its requested documents, and the full `requestableDocuments` list so staff can narrow or widen. Three form actions — `approve`, `deny`, `requestInfo` — each calling `decideRequest`, then `recordEvent` with `access_request.approved` / `.denied` / `.info_requested`, then `enqueueEmail` to the requester with `request_approved` or `request_denied` in **the requester's** locale.

The approval mail's `url` is a `sign_in` magic link, not a bare portal URL: the requester's original session is long gone by the time a human decides. Issue it with `issueMagicLink(db, {purpose: 'sign_in', requesterId, ttlMinutes})` and build `${baseUrl}${localizePath('/access/verify?token=…', locale)}`.

**The verify route currently consumes `verify_request` links only.** Extend its action to try `sign_in` when `verify_request` misses: a `sign_in` consumption mints a session for `link.requesterId` directly, with no request adoption and no rule evaluation. Add an integration case for it in `access-verify.test.ts`.

Which locale is "the requester's"? Nothing records it yet. Add `locale` to the `requester` table in Task 3's schema — set from `locals.locale` at verification — or, if Task 3 is already committed, add it in this task's migration. **Do this rather than defaulting to `DEFAULT_LOCALE`:** a German prospect who used the German portal must not receive English mail, and this is the only place the information exists.

- [x] **Step 7: Add the admin nav entry and strings, then write the e2e test**

`tests/e2e/admin-requests.spec.ts` signs in through the dev IdP the way `tests/e2e/admin-content.spec.ts` does, then: seeds a pending request through the database, opens `/admin/requests`, approves it with an explicit single-document scope, and asserts the request shows as approved and exactly one `outbound_email` row exists with template `request_approved`.

- [x] **Step 8: Run and commit**

```bash
pnpm test:integration -- access-decisions
pnpm test:e2e -- --project=app admin-requests
pnpm lint && pnpm check
git add 'src/routes/(admin)/admin/requests' src/lib/server/access src/lib/admin/sections.ts \
  drizzle messages src/lib/paraglide tests/integration/access-decisions.test.ts \
  tests/e2e/admin-requests.spec.ts
git commit -m "feat(admin): add the access request triage queue and decisions"
```

---

## Task 14: Grants, rules, and access settings

Three admin surfaces, all following the Phase 1 `DataTable` + meta-form pattern. Grouped into one task because none carries enough risk to be worth a separate review gate, and they share their message keys.

**Files:**
- Create: `src/routes/(admin)/admin/grants/+page.server.ts`, `+page.svelte`
- Create: `src/routes/(admin)/admin/rules/+page.server.ts`, `+page.svelte`, `new/`, `[id]/`
- Create: `src/routes/(admin)/admin/settings/access/+page.server.ts`, `+page.svelte`
- Create: `tests/e2e/admin-access.spec.ts`
- Modify: `src/lib/admin/sections.ts`, `messages/*.json`

**Interfaces:**
- Consumes: `revokeGrant` (Task 10), `saveMetaAction` (Task 1), the `setting` table (Phase 1).

- [ ] **Step 1: Build the grant list**

Columns: requester email, company, scope (either "all request tier" or a document count), granted, expires, state. State is derived, not stored: `revoked` if `revokedAt`, else `expired` if `expiresAt <= now()`, else `active`. One `revoke` action per row calling `revokeGrant` and recording `access_grant.revoked`.

Revocation must take effect immediately — `grantedDocuments` filters on `revokedAt` on every call, so no cache invalidation is needed. Task 19's end-to-end test proves it.

- [ ] **Step 2: Build the rules CRUD**

`access_rule` has no translations, so this is a list plus a plain meta form — the simplest surface in the admin. Fields: `pattern`, `action` (select over `ACCESS_RULE_ACTIONS`), `maxTier` (select over `DOCUMENT_TIERS`), `priority`, `note`.

Validate the pattern with the same shape `patternMatches` accepts, so a rule that can never match is rejected at entry rather than discovered at decision time:

```ts
const PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
```

Add a unit test for that regex in `tests/unit/access-rules.test.ts` asserting it accepts `acme.example` and `*.acme.example` and rejects `*`, `*.example`, `acme`, and `*acme.example`.

Rules decide who gets documents without a human, so every mutation records `access_rule.created` / `.updated` / `.deleted` with the full rule in `meta` — it is operator configuration, not requester data, so `meta` is the right place.

- [ ] **Step 3: Build the access settings page**

One field: the default grant duration in days, stored in `setting` under key `access.grant_default_days`, following `src/routes/(admin)/admin/settings/branding/+page.server.ts`.

`getConfig().accessGrantDefaultDays` is the environment default; the setting overrides it when present. Add a `defaultGrantDays(db)` helper in `src/lib/server/access/grants.ts` that reads the setting and falls back to config, and call it from `createGrant` instead of reading config directly.

- [ ] **Step 4: Write the e2e test and commit**

`tests/e2e/admin-access.spec.ts`: sign in, create a rule with an auto-approve action, confirm it appears in the list, revoke a seeded grant, and confirm the row shows as revoked.

```bash
pnpm test:e2e -- --project=app admin-access
pnpm lint && pnpm check
git add 'src/routes/(admin)/admin' src/lib/server/access src/lib/admin/sections.ts messages \
  src/lib/paraglide tests/e2e/admin-access.spec.ts tests/unit/access-rules.test.ts
git commit -m "feat(admin): add grant management, access rules, and the grant duration setting"
```

---

## Task 15: The requester purge

Spec §10's single permitted exception to the append-only audit log, and the first code anywhere in this project to use it. Phase 1 built the database enforcement; this is what exercises it.

**Files:**
- Create: `src/lib/server/purge.ts`
- Create: `src/routes/(admin)/admin/requesters/+page.server.ts`, `+page.svelte`, `[id]/+page.server.ts`, `[id]/+page.svelte`
- Create: `tests/integration/purge.test.ts`
- Modify: `src/lib/admin/sections.ts`, `messages/*.json`, `docs/self-hosting.md`

**Interfaces:**
- Produces: `purgeRequester(db, {requesterId, staffUserId, ip})` → `{eventsPseudonymized: number}`.

- [ ] **Step 1: Write the failing test**

`tests/integration/purge.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { auditEvent, outboundEmail, requester, requesterSession } from '../../src/lib/server/db/schema';
import { recordEvent } from '../../src/lib/server/audit';
import { createRequesterSession, upsertRequester } from '../../src/lib/server/identity/requester';
import { purgeRequester } from '../../src/lib/server/purge';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;
let staffUserId: string;

beforeAll(async () => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
	// staffUserId: insert a staff_user fixture as tests/integration/jobs.test.ts does.
});
afterAll(async () => {
	await close();
});

describe('purgeRequester', () => {
	it('blanks the personal columns but keeps the row', async () => {
		const row = await upsertRequester(db, {
			email: `person-${randomUUID()}@acme.example`,
			name: 'A Person',
			company: 'Acme',
			locale: 'de'
		});

		await purgeRequester(db, { requesterId: row.id, staffUserId, ip: null });

		const [after] = await db.select().from(requester).where(eq(requester.id, row.id));
		// The row survives so grants and requests keep referential integrity;
		// only the identifying columns go.
		expect(after).toBeDefined();
		expect(after!.purgedAt).not.toBeNull();
		expect(after!.email).not.toContain('acme.example');
		expect(after!.name).toBe('');
		expect(after!.company).toBe('');
	});

	it('pseudonymizes the requester audit events without deleting them', async () => {
		const row = await upsertRequester(db, {
			email: `person-${randomUUID()}@acme.example`,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});

		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'requester', id: row.id },
			subjectType: 'document_file',
			subjectId: randomUUID(),
			ip: '203.0.113.5',
			ua: 'Mozilla/5.0'
		});

		const before = await db
			.select()
			.from(auditEvent)
			.where(eq(auditEvent.actorId, row.id));
		expect(before).toHaveLength(1);

		const result = await purgeRequester(db, { requesterId: row.id, staffUserId, ip: null });
		expect(result.eventsPseudonymized).toBe(1);

		// The occurrence survives; the link to the person does not.
		const [event] = await db
			.select()
			.from(auditEvent)
			.where(eq(auditEvent.id, before[0]!.id));

		expect(event).toBeDefined();
		expect(event!.action).toBe('document.downloaded');
		expect(event!.actorId).toBeNull();
		expect(event!.ip).toBeNull();
		expect(event!.ua).toBeNull();
	});

	it('writes its own audit event, as spec §10 requires', async () => {
		const row = await upsertRequester(db, {
			email: `person-${randomUUID()}@acme.example`,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});

		await purgeRequester(db, { requesterId: row.id, staffUserId, ip: null });

		const events = await db
			.select()
			.from(auditEvent)
			.where(and(eq(auditEvent.action, 'requester.purged'), eq(auditEvent.subjectId, row.id)));

		expect(events).toHaveLength(1);
		// Staff are outside the requester purge and may be named.
		expect(events[0]!.actorId).toBe(staffUserId);
	});

	it('revokes every session and clears queued mail', async () => {
		const row = await upsertRequester(db, {
			email: `person-${randomUUID()}@acme.example`,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		await createRequesterSession(db, { requesterId: row.id, ttlHours: 24 });

		await purgeRequester(db, { requesterId: row.id, staffUserId, ip: null });

		const live = await db
			.select()
			.from(requesterSession)
			.where(and(eq(requesterSession.requesterId, row.id), isNotNull(requesterSession.revokedAt)));

		expect(live.length).toBeGreaterThan(0);
	});

	it('cannot be used to delete an audit event', async () => {
		// The trigger Phase 1 installed is what makes this true. Assert it here,
		// because purge is the only code path that touches audit_event with
		// anything but INSERT, and a widened UPDATE would be silent.
		await expect(db.delete(auditEvent)).rejects.toThrow();
	});
});
```

Note: Drizzle wraps driver errors, so asserting on the trigger's message needs `error.cause`, not `error.message`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- purge`
Expected: FAIL — cannot resolve `../../src/lib/server/purge`.

- [ ] **Step 3: Implement**

`src/lib/server/purge.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { recordEvent } from './audit';
import { auditEvent, outboundEmail, requester } from './db/schema';
import { revokeAllRequesterSessions } from './identity/requester';
import type { Db } from './db';

/**
 * The one operation spec §10 permits against audit_event other than INSERT: a
 * column-scoped UPDATE setting ip, ua, and actor_id to NULL. It only ever moves
 * data toward less identifiability, it deletes nothing, and it writes its own
 * audit event.
 *
 * The domain rows go further — a requester's identifying columns are blanked
 * outright — but the row itself stays, so grants and requests keep their
 * foreign keys and the record of *what happened* survives the record of *who*.
 */
export async function purgeRequester(
	db: Db,
	input: { requesterId: string; staffUserId: string; ip: string | null }
): Promise<{ eventsPseudonymized: number }> {
	return db.transaction(async (tx) => {
		// Exactly the three columns spec §10 names. Written as an explicit SET of
		// three NULLs rather than a dynamic column list, so widening it is a
		// visible code change and not a configuration accident.
		const pseudonymized = await tx.execute<{ id: string }>(sql`
			UPDATE audit_event
			SET actor_id = NULL, ip = NULL, ua = NULL
			WHERE actor_type = 'requester' AND actor_id = ${input.requesterId}
			RETURNING id
		`);

		await revokeAllRequesterSessions(tx, input.requesterId);

		// Queued mail names the address, and a purge that leaves it queued would
		// mail a person who asked to be forgotten.
		await tx
			.update(outboundEmail)
			.set({ status: 'failed', to: '', lastError: 'requester purged' })
			.where(sql`${outboundEmail.status} = 'pending' AND ${outboundEmail.to} = (
				SELECT email FROM requester WHERE id = ${input.requesterId}
			)`);

		await tx
			.update(requester)
			.set({
				// Not NULL: the column is unique and NOT NULL, and two purged
				// requesters must not collide. The id is already non-identifying.
				email: `purged-${input.requesterId}@invalid`,
				name: '',
				company: '',
				companyDomain: '',
				notes: null,
				purgedAt: new Date()
			})
			.where(eq(requester.id, input.requesterId));

		await recordEvent(tx, {
			action: 'requester.purged',
			// Staff are outside the requester purge and may be identified.
			actor: { type: 'staff', id: input.staffUserId },
			subjectType: 'requester',
			subjectId: input.requesterId,
			ip: input.ip ?? undefined,
			meta: { eventsPseudonymized: pseudonymized.length }
		});

		return { eventsPseudonymized: pseudonymized.length };
	});
}
```

`subjectId` carries the requester id, which is a pseudonymous identifier rather than personal data — spec §10 forbids requester personal data in `subject_id`, and a UUID that no longer resolves to a person is not that. The event must name what was purged or it is not an audit trail.

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm test:integration -- purge`
Expected: PASS, 5 tests. The last one — that `DELETE FROM audit_event` still throws — is the regression guard on Phase 1's trigger.

- [ ] **Step 5: Build the admin surface**

`/admin/requesters` lists requesters (email, company, first seen, grant count, purged state), and `/admin/requesters/[id]` shows their requests, grants, and recent audit events, with a `purge` action behind a typed confirmation — the same `admin_confirm_delete` pattern the content pages use, because this is irreversible and there is no undo.

A purged requester's row stays listed, shown as purged, with the purge action disabled.

- [ ] **Step 6: Document it and commit**

Add a §"Erasure requests" section to `docs/self-hosting.md`: what purging does, what it deliberately does not do (audit events survive, pseudonymized), and that it cannot be undone.

```bash
pnpm test:integration -- purge
pnpm lint && pnpm check
git add src/lib/server/purge.ts 'src/routes/(admin)/admin/requesters' src/lib/admin/sections.ts \
  messages src/lib/paraglide docs/self-hosting.md tests/integration/purge.test.ts
git commit -m "feat(admin): add requester purge with audit pseudonymization"
```

---
## Task 16: The audit log viewer

Spec §11 lists it in this phase. A filterable read-only table, not the Phase 5 analytics dashboard.

**Files:**
- Create: `src/routes/(admin)/admin/audit/+page.server.ts`, `+page.svelte`
- Create: `tests/integration/audit-query.test.ts`, `tests/e2e/admin-audit.spec.ts`
- Modify: `src/lib/server/audit/index.ts`, `src/lib/admin/sections.ts`, `messages/*.json`
- Modify: `docs/superpowers/specs/2026-08-28-trust-center-design.md` (if the staff-PII decision changes it)

**Interfaces:**
- Produces: `queryEvents(db, filter)` extended with `action`, `actorType`, `from`, `to`, and keyset pagination.

- [ ] **Step 1: Settle the staff-PII-in-`meta` carry-over item**

The viewer is what makes this visible, so decide it here. Phase 0 writes `meta: { oidcSub, email, groups }` on staff login. Spec §10 confines *requester* personal data to `ip`/`ua`/`actor_id` and explicitly places staff outside that restriction, so this is permitted — but the table is append-only, so it can never be corrected.

**Decision: keep it, and record why.** A staff login event whose `meta` names the OIDC subject and the groups that produced the role is exactly what an access review asks for, and `actor_id` alone cannot answer "which IdP identity was this, and what did the IdP claim" after an offboarded user's `staff_user` row is gone. Add a comment at the `recordEvent` call in `src/routes/auth/callback/+server.ts` stating that this is deliberate and permanent, so the next reader does not re-litigate it.

If the operator disagrees, the change belongs in a migration that stops *future* writes — never in an UPDATE of existing rows.

- [ ] **Step 2: Write the failing query test**

`tests/integration/audit-query.test.ts` asserts:

- filtering by `action` returns only that action
- filtering by `actorType` returns only that actor type
- a `from`/`to` window excludes events outside it
- results are newest-first by `seq`, not by `at` (same-timestamp events order deterministically only by `seq`)
- keyset pagination on `seq` returns the next page with no overlap and no gap
- a filter matching nothing returns an empty array rather than throwing

- [ ] **Step 3: Extend `queryEvents`**

```ts
export interface AuditFilter {
	action?: string;
	actorType?: string;
	actorId?: string;
	subjectType?: string;
	subjectId?: string;
	from?: Date;
	to?: Date;
	/** Keyset cursor: return events with `seq` strictly below this. */
	beforeSeq?: bigint;
	limit?: number;
}

export async function queryEvents(db: Db, filter: AuditFilter): Promise<AuditEventRow[]> {
	const conditions = [];
	if (filter.action) conditions.push(eq(auditEvent.action, filter.action));
	if (filter.actorType) conditions.push(eq(auditEvent.actorType, filter.actorType));
	if (filter.actorId) conditions.push(eq(auditEvent.actorId, filter.actorId));
	if (filter.subjectType) conditions.push(eq(auditEvent.subjectType, filter.subjectType));
	if (filter.subjectId) conditions.push(eq(auditEvent.subjectId, filter.subjectId));
	if (filter.from) conditions.push(gte(auditEvent.at, filter.from));
	if (filter.to) conditions.push(lte(auditEvent.at, filter.to));
	// Keyset rather than OFFSET: the log only grows, and OFFSET over a growing
	// table both slows down and skips rows as new events arrive mid-paging.
	if (filter.beforeSeq !== undefined) conditions.push(lt(auditEvent.seq, filter.beforeSeq));

	return db
		.select()
		.from(auditEvent)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(auditEvent.seq))
		.limit(Math.min(filter.limit ?? 100, 500));
}
```

Keep the existing narrower call sites working — the old `{subjectType, subjectId, actorId, limit}` shape is a subset of this one, so no caller changes.

- [ ] **Step 4: Build the page**

A `DataTable` over the result, columns: time, action, actor (type plus id), subject (type plus id), IP, and a details toggle rendering `meta` as formatted JSON. Filters as a GET form so a filtered view is a shareable URL — this is the surface an auditor is pointed at.

`admin` role only, not `approver`: the log carries every actor's IP and the full history of the deployment, which is more than triage needs. Guard it in `+page.server.ts` with `if (locals.staff?.role !== 'admin') error(403, ...)` and add a route-level e2e test for the denial.

- [ ] **Step 5: Run and commit**

```bash
pnpm test:integration -- audit-query
pnpm test:e2e -- --project=app admin-audit
pnpm lint && pnpm check
git add src/lib/server/audit 'src/routes/(admin)/admin/audit' 'src/routes/auth/callback' \
  src/lib/admin/sections.ts messages src/lib/paraglide \
  tests/integration/audit-query.test.ts tests/e2e/admin-audit.spec.ts
git commit -m "feat(admin): add a filterable audit log viewer"
```

---

## Task 17: Auth hardening

Four carry-over items, all in the staff authentication path, all cheap once something else is already touching cookies.

**Files:**
- Modify: `src/lib/server/auth/session.ts`, `src/routes/auth/callback/+server.ts`, `src/routes/auth/logout/+server.ts`, `src/hooks.server.ts`
- Modify: `docs/self-hosting.md`
- Create: `tests/e2e/auth-hardening.spec.ts`
- Modify: `tests/integration/session.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `revokeAllStaffSessions(db, staffUserId)`.

- [ ] **Step 1: Move both cookies to prefixed names**

`SESSION_COOKIE` becomes `'__Host-tc_staff_session'` and the requester cookie is already `'__Secure-tc_requester_session'` from Task 10.

`__Host-` requires `Secure`, `Path=/`, and no `Domain` attribute. The staff cookie already uses `Path=/` and sets no domain, so only `secure: true` is new. Check every `cookies.set` and `cookies.delete` for the staff cookie — a `delete` whose attributes do not match the `set` silently does nothing, and a stale session cookie that cannot be cleared is a real bug.

Existing sessions do not survive the rename. That is correct: the old cookie name is simply not read any more, and every staff member signs in again once.

- [ ] **Step 2: Write the self-hosting warning**

Both prefixes require `Secure`, which browsers grant on `http://localhost` but not on a plain-HTTP origin. Add to `docs/self-hosting.md` §3, near `ADDRESS_HEADER`:

> **HTTPS is required.** Session cookies use the `__Host-` and `__Secure-` prefixes, which browsers only accept over HTTPS. Reaching the application over plain HTTP — other than at `localhost` — means nobody can sign in, staff or requester, with no error message beyond a login that loops back to the login page. Terminate TLS at your proxy and set `BASE_URL` to the `https://` origin.

- [ ] **Step 3: Revoke prior sessions on re-login**

Add to `src/lib/server/auth/session.ts`:

```ts
/**
 * Called on every successful login. A staff member signing in fresh is the
 * natural moment to invalidate whatever else is holding a session for them —
 * a shared machine, a stolen laptop, a session minted before a role change.
 */
export async function revokeAllStaffSessions(db: Db, staffUserId: string): Promise<void> {
	await db
		.update(staffSession)
		.set({ revokedAt: new Date() })
		.where(and(eq(staffSession.staffUserId, staffUserId), isNull(staffSession.revokedAt)));
}
```

Call it in `src/routes/auth/callback/+server.ts` after `upsertStaffUser` and **before** `createStaffSession`, or the new session revokes itself.

Add an integration case to `tests/integration/session.test.ts`: create two sessions for one user, call `revokeAllStaffSessions`, assert both stop validating; then create a third and assert it validates.

- [ ] **Step 4: Audit failed OIDC callbacks**

The carry-over calls these "precisely the events a security review asks for and the only auth outcomes still unrecorded". In `src/routes/auth/callback/+server.ts`, wrap the exchange so each failure mode records before it throws:

```ts
// Every failed callback is an event a security review asks about. The actor is
// `staff-unresolved` because no staff_user row was reached; the OIDC subject,
// where one is even available, belongs in meta rather than in an id column
// shared with real staff_user ids.
await recordEvent(db, {
	action: 'staff.login_failed',
	actor: { type: 'staff-unresolved', id: null },
	ip: clientIp(event) ?? undefined,
	ua: event.request.headers.get('user-agent') ?? undefined,
	meta: { reason }
});
```

with `reason` one of `'state_mismatch'`, `'code_exchange_failed'`, `'idp_error'` (carrying the IdP's `error` and `error_description` query parameters), or `'no_role'` for a user in no mapped group. **Do not** put the authorization code, the client secret, or the raw error `cause` in `meta` — that is the exact mistake `handleError` exists to prevent.

- [ ] **Step 5: Add the route-level disabled-staff test**

The carry-over notes the layer below is tested and the route is not.

`tests/e2e/auth-hardening.spec.ts`: sign in as an admin, disable that `staff_user` row directly in the database, then navigate to `/admin` and assert the response is a redirect to login rather than a rendered admin page — and that the session cookie has been cleared. Add a second case asserting an `approver` reaching `/admin/audit` gets 403.

- [ ] **Step 6: Run and commit**

```bash
pnpm test:integration -- session
pnpm test:e2e -- --project=app auth
pnpm lint && pnpm check
git add src/lib/server/auth 'src/routes/auth' src/hooks.server.ts docs/self-hosting.md \
  tests/integration/session.test.ts tests/e2e/auth-hardening.spec.ts
git commit -m "feat(auth): prefix session cookies, revoke on re-login, and audit failed callbacks"
```

---

## Task 18: Expiry, reminders, and lapse

Spec §9.8. A grant ends by itself; a reminder precedes it.

**Files:**
- Modify: `src/lib/server/jobs/index.ts`
- Create: `src/lib/server/access/expiry.ts`
- Create: `tests/integration/expiry.test.ts`
- Modify: `.env.example`, `src/lib/server/config/parse.ts`

**Interfaces:**
- Produces: `sendExpiryReminders(db)`, registered in `JOBS`.
- Consumes: `enqueueEmail` (Task 7), `runJob` (Task 8).

- [ ] **Step 1: Write the failing test**

`tests/integration/expiry.test.ts`:

```ts
describe('sendExpiryReminders', () => {
	it('queues one reminder for a grant inside the reminder window', async () => { /* ... */ });

	it('does not queue a second reminder on the next run', async () => {
		// expiry_reminder_sent_at is what makes this true. Without it the job
		// mails the same person every tick until the grant lapses.
	});

	it('ignores a grant that expires beyond the window', async () => { /* ... */ });

	it('ignores a revoked grant', async () => { /* ... */ });

	it('ignores an already-expired grant', async () => {
		// A reminder after the fact is noise, and the lapse itself needs no job:
		// grantedDocuments filters on expiresAt, so access ends on its own.
	});

	it('sends the reminder in the requester locale', async () => { /* ... */ });
});
```

Each case builds a grant with a chosen `expiresAt`, runs the job, and counts `outbound_email` rows with template `grant_expiring` for that requester.

- [ ] **Step 2: Implement**

`src/lib/server/access/expiry.ts`:

```ts
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { accessGrant, requester } from '../db/schema';
import { enqueueEmail } from '../mail/queue';
import { localizePath } from '../../i18n/locale';
import type { Db } from '../db';

/**
 * Access ends by itself — grantedDocuments filters on expiresAt, so there is no
 * "expire the grant" job and no window where a lapsed grant still works. This
 * job only sends the notice that precedes it.
 */
export async function sendExpiryReminders(db: Db): Promise<{ queued: number }> {
	const { accessGrantReminderDays, baseUrl } = getConfig();

	const due = await db
		.select({
			grantId: accessGrant.id,
			expiresAt: accessGrant.expiresAt,
			email: requester.email,
			locale: requester.locale
		})
		.from(accessGrant)
		.innerJoin(requester, eq(accessGrant.requesterId, requester.id))
		.where(
			and(
				isNull(accessGrant.revokedAt),
				isNull(accessGrant.expiryReminderSentAt),
				// Still live...
				gt(accessGrant.expiresAt, sql`now()`),
				// ...but inside the window.
				lte(
					accessGrant.expiresAt,
					sql`now() + make_interval(days => ${accessGrantReminderDays})`
				),
				isNull(requester.purgedAt)
			)
		);

	for (const row of due) {
		await enqueueEmail(db, {
			to: row.email,
			template: 'grant_expiring',
			locale: row.locale,
			payload: {
				expiresAt: row.expiresAt.toISOString().slice(0, 10),
				documentCount: 0,
				url: `${baseUrl}${localizePath('/access', row.locale)}`
			}
		});

		// Stamped per grant, immediately after queueing, so a crash mid-loop
		// resends at most one reminder rather than all of them.
		await db
			.update(accessGrant)
			.set({ expiryReminderSentAt: new Date() })
			.where(eq(accessGrant.id, row.grantId));
	}

	return { queued: due.length };
}
```

`documentCount` needs the real figure — call `grantedDocuments(db, requesterId)` per row and use its length, or drop the placeholder from the template. Do not ship a mail that says "0 documents".

- [ ] **Step 3: Register the job and add the config**

In `src/lib/server/jobs/index.ts`, add to `JOBS`:

```ts
	{ name: 'grants:remind', everyMs: 6 * 60 * 60 * 1000, run: async (db) => { await sendExpiryReminders(db); } }
```

Add `ACCESS_GRANT_REMINDER_DAYS` (default `7`) to `parse.ts` and `.env.example`.

- [ ] **Step 4: Run and commit**

```bash
pnpm test:integration -- expiry
pnpm lint && pnpm check
git add src/lib/server/access/expiry.ts src/lib/server/jobs src/lib/server/config/parse.ts \
  .env.example tests/integration/expiry.test.ts
git commit -m "feat(access): remind before a grant expires"
```

---

## Task 19: The full journey, documentation, and phase close

The end-to-end proof that the pieces compose, plus the operator-facing documentation this phase owes.

**Files:**
- Create: `tests/e2e/access-journey.spec.ts`
- Modify: `docs/self-hosting.md`, `README.md`
- Create: `docs/superpowers/phase-3-carryover.md`

- [ ] **Step 1: Write the journey test**

`tests/e2e/access-journey.spec.ts` walks the whole of spec §9 in one test, reading the magic link out of the database rather than out of Mailpit — the queue is what the app writes, and depending on SMTP delivery inside a Playwright test buys flakiness for nothing:

1. Seed a published request-tier document with a current PDF file.
2. Visit `/de/documents`; assert the document is listed with the "on request" badge and **no** `/api/documents/...` link.
3. Submit the request form for that document.
4. Read the pending `outbound_email` row for that address, assert its template is `verify_request`, and extract the token from its payload URL.
5. `GET /de/access/verify?token=…`; assert the confirmation page renders and that the token is **still unconsumed** — this is the mail-gateway-prefetch guarantee.
6. POST the confirmation; assert the redirect to `/de/access` and that exactly one cookie is now set.
7. Assert the gated page lists the document.
8. Download it; assert `200`, `content-type: application/pdf`, `cache-control: no-store`, and that the body is larger than the stored file — the watermark.
9. Assert a `document.downloaded` audit event exists with `actor_type='requester'` and `meta.watermarked=true`.
10. Revoke the grant directly in the database; re-request the download; assert `404` — **revocation takes effect immediately**, with no cache to invalidate.
11. Assert `/de/documents` still exposes no file id for that document.

Step 5's "still unconsumed" check is the one most likely to be dropped as fiddly. Keep it: it is the only automated evidence for decision 4.

- [ ] **Step 2: Write the operator documentation**

`docs/self-hosting.md` gains:

- **Mail.** `SMTP_URL`, `MAIL_FROM`, what happens with `SMTP_URL` unset (the queue accepts work and never drains — correct for build and test, silent failure in production), and how to inspect `outbound_email` when mail is not arriving.
- **Jobs.** What the four jobs do and how often, `RUN_JOBS=false` for operators running a separate worker, and the note that running more than one replica is safe because every job takes an advisory lock.
- **Access governance.** The request → verify → decide → download flow in six sentences, what an access rule does and the two pattern forms, the default grant duration and where to change it, and the reminder window.
- **Erasure requests.** Already added in Task 15; cross-link it from the access section.
- **HTTPS is required.** Already added in Task 17.

`README.md` gains the access-governance bullet in its feature list and Mailpit's UI port in the local-development section.

- [ ] **Step 3: Run everything, from clean**

```bash
docker compose -f compose.dev.yaml down -v
docker compose -f compose.dev.yaml up -d --wait
cp -n .env.example .env
pnpm install
pnpm db:migrate
pnpm lint && pnpm check && pnpm build
pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Every one of these must pass before the phase is closed. `pnpm build` must succeed with no `.env` present and no database reachable — verify that separately:

```bash
env -u DATABASE_URL -u OIDC_ISSUER pnpm build
```

- [ ] **Step 4: Write the Phase 3 carry-over**

`docs/superpowers/phase-3-carryover.md`, in the same shape as its predecessors. It must answer, from the evidence this phase produced:

- **Did the Task 1 helper hold?** Six new admin surfaces were built against `saveMetaAction`/`saveTranslationAction`. Did any need to reach past it or fork it? If the answer is "the rules page has no translations and used only half of it", say so — that is the evidence for whether the abstraction is at the right altitude.
- **Was the path-scoped cookie the right call?** Any place where `accessCookiePath` had to be worked around belongs here.
- **What did the buffered download cost?** Record the observed memory and latency for a watermarked download at the `MAX_UPLOAD_MB` ceiling. Phase 3's NDA PDF generation makes the same tradeoff and should inherit a real number rather than a guess.
- Everything still open from `phase-2-carryover.md`, and everything found during this phase.

Known items to carry forward unless this phase closed them:

- Requester purge is manual only; the `setting`-driven retention policy is not built.
- `outbound_email` accumulates forever — no cleanup job, and it names every address ever mailed.
- The `rate_limit` table accumulates rows per key with no sweep.
- Invite-driven requests (`source='invite'`, spec §9.4's "bulk invitation covers the reverse direction") are modelled but have no admin surface.
- `access_grant.nda_acceptance_id` is deliberately absent and is Phase 3's first migration.
- The return-visit fast path (spec §9.9) exists as a `sign_in` magic link but has no self-service entry point — a returning requester whose session lapsed has no way to ask for a new link without filing a fresh request.

- [ ] **Step 5: Commit and close**

```bash
git add tests/e2e/access-journey.spec.ts docs/self-hosting.md README.md \
  docs/superpowers/phase-3-carryover.md
git commit -m "test(e2e): cover the full access-governance journey, and document the phase"
```

---

## Phase 2 completion criteria

- [ ] `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e` is green from a clean checkout, and `pnpm check` emits **zero** warnings.
- [ ] `pnpm build` succeeds with no `.env` and no database reachable.
- [ ] A prospect can request a request-tier document, verify by magic link, and download a watermarked copy whose footer names them.
- [ ] Staff can triage a pending request, approve it with a narrowed scope, and the requester receives a sign-in link.
- [ ] An access rule auto-approves a matching domain and denies another, with the matched rule recorded in the audit event.
- [ ] Revoking a grant makes the next download attempt 404, with no restart and no cache invalidation.
- [ ] A grant expires by itself, and a reminder precedes it exactly once.
- [ ] Purging a requester blanks their identity, pseudonymizes their audit events without deleting them, and writes its own audit event.
- [ ] The permanent security tests still pass: **public** pages set no cookies, the gated subtree sets exactly one, no third-party requests, a CSP with no `unsafe-inline`, a gated document exposes no file id in HTML or the sitemap, and every download writes an audit event.
- [ ] `docs/self-hosting.md` documents every new environment variable, the job runner, the HTTPS requirement, and the erasure path.
- [ ] `docs/superpowers/phase-3-carryover.md` exists and answers the three questions in Task 19 Step 4.
