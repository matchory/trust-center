# Phase 1 carry-over into Phase 2

Written at the end of Phase 1, in the same shape as `phase-1-carryover.md`.
Everything here is a decision or a defect Phase 1 saw and deliberately did not
fold in.

## Did the Task 11 primitives need to go further?

The plan asked this explicitly, with Tasks 12–15 as the evidence. **No — and
the evidence is fairly clean.**

Tasks 12–15 added four content types (certifications, subprocessors, answers,
updates) on top of the four primitives extracted in Task 11 (`DataTable`,
`LocaleTabs`, `FormField`, `saveTranslationsFromForm`). What that showed:

- **The primitives held.** Every one of the four list pages is a `DataTable`
  with a `columns` array and a `cell` snippet, and every edit page is a meta
  form plus `LocaleTabs`. None of them needed to reach past the primitive or
  fork it.
- **What stayed duplicated is the part that differs.** Each `+page.server.ts`
  repeats a Zod object, a `fail()` payload type, an `updateX` call, and a
  `recordEvent`. The repetition is real — roughly 90 lines per type — but each
  copy differs in its field set, its validation, its audit action names, and
  which action counts as "published". A configuration object expressing all of
  that would be a worse spec than the code.
- **The one thing worth extracting next** is the meta-form action itself:
  parse → update → `recordEvent` with a published/updated split. Four examples
  now exist, and they agree on shape while differing only in data. That is the
  same evidence threshold Task 11 used, so it is a fair candidate — but it is a
  refactor, not a feature, and belongs at the start of a phase rather than
  bolted onto one.
- **Do not** generalise the Svelte edit pages further. Their differences are
  presentational (a checkbox here, a date pair there, a multi-select for
  evidence) and a schema-driven form generator would have to model all of it.

So: spec §6.6's "a schema plus a configuration object" is right about the
*server* half and wrong about the *form* half, on the evidence of six content
types.

## Not folded into Phase 1

Carried forward from `phase-1-carryover.md`, still open:

- **`__Host-` cookie prefix** for the session cookie. The CSP half of that item
  landed in Task 16; the cookie prefix did not.
- **Revoke prior sessions on re-login**, or add an explicit "sign out other
  devices".
- **Audit failed OIDC callbacks** — state mismatch, replayed code, an IdP
  `error=`. These are precisely the events a security review asks for and the
  only auth outcomes still unrecorded.
- **`staff_session.expires_at` index and a cleanup job.** Expired rows
  accumulate forever and every session validation scans past them.
- **A route-level test for the disabled-staff denial.** The layer below it is
  tested; the route is not.

## Found during Phase 1

- **`getClientAddress()` can throw, and it takes the mutation with it.** Every
  admin action calls it to populate the audit event's `ip`. When it throws the
  action 500s and *no* audit event is written — the mutation is lost, not
  merely unattributed. Seen once as
  `500 Could not determine clientAddress` on `POST /(admin)/admin/documents/[id]`
  during a full e2e run. Decide whether `ip` should degrade to `null` rather
  than failing the write. Note that `docs/self-hosting.md` §8 now tells
  operators to set `ADDRESS_HEADER`/`XFF_DEPTH`, which is the related but
  separate correctness issue: without them every audit event records the
  proxy's address.

- **The e2e suite is not isolated from the dev database.** Fixtures accumulate
  across runs (`cat-<suffix>`, `cert-<suffix>`, …) and are never cleaned up.
  Three assertions had to be rewritten during Phase 1 because matching on a
  fixture's display text broke on the second run. Give the e2e suite its own
  disposable database, as the integration suite already has.

- **Staff email and OIDC subject are written into `audit_event.meta`** on
  login (`meta: { oidcSub, email, groups }`, from Phase 0). Spec §10 confines
  *requester* personal data to `ip`/`ua`/`actor_id`, and staff are identified
  rather than pseudonymous, so this is defensible — but the append-only trigger
  means it can never be corrected or redacted. Confirm it is the intended
  policy before the table grows.

- **Two `state_referenced_locally` warnings** (now six, one per admin edit
  page): `let activeLocale = $state(data.locale)` seeds once and deliberately
  does not track `data`. Intentional, but it leaves `pnpm check` permanently
  noisy, which trains people to ignore its output. Silence it inside
  `LocaleTabs.svelte` — the one place that owns the behaviour — rather than at
  six call sites.

- **`RUN_MIGRATIONS=false` has no companion migration command.** The
  self-hosting guide tells multi-replica operators to bring one instance up
  with migrations on and stop it, which works but is graceless. A
  `--migrate-only` entry point would be three lines.

## Resolved in Phase 1, recorded because the reasoning matters

- Drizzle wraps driver errors: `error.message` is only
  `Failed query: <sql> params: …`. Any test asserting on a database constraint
  must read `error.cause`. Phase 0's delete test passed only because
  `append-only` happened to appear in its bound parameter.
- `svelte/no-navigation-without-resolve` is narrowed to `ignoreLinks`:
  locale-prefixed paths are not route ids, because `reroute` strips the prefix
  before matching, so `resolve()` cannot express them. `goto`/`pushState` stay
  checked.
- Admin action `fail()` payloads need one explicit type per route
  (`fail<XActionFailure>`), or the union does not discriminate on `field` and
  the page cannot read `form.locale`.
- A Playwright test must not inject DOM before hydration: Svelte reconciles the
  claimed tree and the injected node disappears, which reads as a click
  timeout. Phase 0's client-navigation test did this and flaked under load.
