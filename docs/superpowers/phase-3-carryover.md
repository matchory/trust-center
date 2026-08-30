# Phase 2 carry-over into Phase 3

Written at the end of Phase 2, in the same shape as `phase-2-carryover.md`.
Everything here is a decision, a measurement, or a defect that Phase 2 saw and
deliberately did not fold in.

## The three questions the plan asked

### Did the Task 1 helper hold?

**It held, but Phase 2 barely tested it — and that is the finding.**

Task 1 extracted `saveMetaAction` / `saveTranslationAction` from six Phase 1
content types. Phase 2 added six admin surfaces. Exactly **one** of them,
`/admin/rules/[id]`, used the helper, and it used only half:
`access_rule` has no translations and no published state, so the call is
`saveMetaAction` at its plainest — parse, update, record `access_rule.updated`.
`saveTranslationAction` was not used once.

The other five are not content-type editors at all, and no amount of
generalisation would have made them one:

| Surface | What it actually is |
| --- | --- |
| `/admin/requests` + `[id]` | A decision: approve with a narrowed scope, deny with a reason, or ask a question |
| `/admin/grants` | A revocation, and nothing else |
| `/admin/requesters` + `[id]` | An erasure, refusing a second one |
| `/admin/settings/access` | One integer |
| `/admin/audit` | Read-only, with filters in the query string |

So: the helper is correctly scoped to "edit a translatable content type", it did
not need to be forked or reached past, and Phase 2 added one such type rather
than six. **Do not treat this phase as evidence that the abstraction generalises
further.** The next content type is the test that matters, and there is not one
yet.

One thing Task 1 did settle permanently: `translationAction()` gives translation
edits their own action name, which Phase 1 had folded into `<type>.updated`.
The table is append-only, so **every row written before Task 1 keeps the old
convention** — an auditor filtering on `<type>.translation.updated` sees nothing
from Phase 1, and that is not a bug to fix but a boundary to know about.

### Was the path-scoped cookie the right call?

**The benefit is real and worth keeping. The *locale* in the path is the part
that does not pay for itself, and it currently has a live defect.**

The benefit, asserted permanently in `tests/e2e/security.spec.ts`: no public
route sets a cookie, so the public portal needs no consent banner and every
public response stays unconditionally cacheable. That is a property this product
is partly *about*, and a `Path=/` session cookie would have cost it.

What it cost, each item observed rather than anticipated:

1. **A verified requester who switches language is silently signed out.**
   Verified during this write-up, not deduced: on `/de/access` the portal shell
   renders the locale switcher, whose EN link is `/en/access`. The cookie is
   scoped to `/de/access`, which is not a prefix of `/en/access`, so the browser
   sends nothing, the subtree layout finds no requester, and the person lands on
   `/en/request` being asked to file a fresh request they do not need — their
   grant is still live. The affordance that breaks the session is rendered
   directly above the documents it breaks access to.

   A locale-free cookie path cannot fix this: `/de/access` and `/en/access`
   share no prefix but `/`, which is exactly what the design refuses. The cheap
   fix is a route **under the current locale's path** that the switcher posts
   to — that request still carries the cookie, so the server can mint the
   session cookie at the target locale's path and redirect. Roughly the shape of
   `access/logout`, which already works for the same reason.

2. **Gated delivery needed a second route.** Task 12 found that
   `/api/documents/{fileId}` never receives the requester cookie, so every gated
   download arrived anonymous and 404'd. Delivery now lives at
   `/{locale}/access/documents/{fileId}` as well, sharing one implementation in
   `src/lib/server/delivery/serve.ts` that takes the tier as an argument.

3. **The cookie cannot carry `__Host-`,** which mandates `Path=/`. It settles
   for `__Secure-`, a weaker guarantee: `__Host-` also forbids a `Domain`
   attribute, which is what stops a sibling subdomain from planting a session
   cookie. The staff cookie, being `Path=/` already, took `__Host-` in Task 17.

4. **Set and delete must agree exactly, or the delete silently does nothing.**
   Cost two defects during the phase — a `__Secure-` cookie cannot be cleared by
   a `Set-Cookie` that omits `Secure`, so sign-out did nothing at the client
   until `requesterCookieOptions(locale)` became the single source for both.

### What did the buffered download cost?

Measured, on an Apple Silicon laptop under Node 26, calling `stampPdf` directly
in a fresh process so the number is the stamp and not the fixture:

| Input | Pages | Output | Elapsed | Peak RSS |
| --- | --- | --- | --- | --- |
| 25.1 MB | 16,200 | 31.8 MB | 9,095 ms | 1,580 MB (baseline 136 MB) |
| 24.0 MB | 100 | 24.1 MB | 399 ms | 211 MB (baseline 134 MB) |

**The cost is dominated by page count, not by bytes.** Two files of the same
size, at the `MAX_UPLOAD_MB` ceiling, differ by 23× in time and by roughly 19×
in memory over baseline. `MAX_UPLOAD_MB` therefore bounds the wrong dimension:
it admits a 25 MB document that costs 1.4 GB of resident memory to serve once,
and two concurrent downloads of it would exhaust a 2 GB container.

Two consequences for Phase 3:

- **Bound page count at upload, not just bytes.** `pdf-lib` reports the count
  from the loaded document, and the upload path already loads it. This is also
  the reader that `document_file.page_count` has been waiting for since Phase 1,
  where it was deferred as "a denormalization with no reader" — the download
  path could then refuse, or degrade to an unstamped-but-logged delivery,
  without opening the file first.
- **Phase 3's NDA generation is safe only while it writes the document itself.**
  It controls the page count, so the 100-page row is the relevant one. The
  moment an NDA is bound to a customer-supplied PDF, the 16,200-page row is back
  and it is a denial-of-service vector, not a performance note.

## Not folded into Phase 2

From `phase-2-carryover.md`, one item remains open, and it is the same one twice:

- **Thirteen routes still call `getClientAddress()` raw.** Decision 6 made
  `clientIp(event)` return `string | null` precisely so a misconfigured
  `ADDRESS_HEADER` costs an audit attribution rather than the whole mutation,
  and new code uses it. The Phase 1 routes were never converted:
  `documents/new`, `documents/categories`, `controls/new`, `controls/groups`,
  `certifications/new`, `faq/new`, `subprocessors/new`, `updates/new`,
  `settings/branding`, and `auth/logout`. Each one still loses the *mutation*,
  not merely its attribution, if the call throws. A one-line change per site.

Everything else that `phase-2-carryover.md` carried is closed:
the `__Host-` prefix, revoking prior sessions on re-login, auditing failed OIDC
callbacks, and the route-level disabled-staff test (all Task 17); the
`staff_session.expires_at` index and its cleanup job (`sessions:cleanup`); the
e2e suite's isolation from the dev database (Task 2); the staff-PII-in-`meta`
decision (settled and recorded at the call site in Task 16); the six
`state_referenced_locally` warnings (`LocaleTabs` owns the selection, one
suppression); the missing migration-only entry point (`tools/migrate.js`); the
`BASE_URL`-versus-request-host gap (the `origin` Playwright project); and the
shared action name for meta and translation edits (`translationAction`).

## Found during Phase 2

- **The locale switcher signs a requester out.** See the second question above.
  Recorded here as well because it is a user-visible defect, not only a design
  tension, and it is the single most likely thing in this phase to be reported
  as a bug by a real prospect.

- **Filling a form field before hydration silently submits the server's value.**
  An input rendered as `value={data.x}` has its DOM value written again when
  Svelte claims the server-rendered tree, discarding whatever Playwright typed —
  and the form then posts the server's value as if the test had never touched
  it. The grant-duration spec failed roughly one run in three with
  `expected "14", received "90"`, and the row in `setting` really did hold `90`:
  **the test passed its own "saved" assertion while storing the opposite of what
  it typed.** `awaitHydration()` in `tests/helpers/admin.ts` waits for the entry
  module to have run. Every admin form spec has the same hazard; it is applied
  where it has been observed rather than pre-emptively everywhere.

- **`outbound_email` names every address ever mailed, forever.** There is no
  cleanup job. `purgeRequester` blanks `to` on that requester's rows, so an
  erasure is honoured — but a requester who never asks is retained
  indefinitely, which is a retention policy nobody chose. The rows are also the
  only record that a notification went out, so deleting them is not obviously
  right either. Decide the policy before the table is large.

- **`rate_limit` accumulates a row per key with no sweep.** Harmless at the
  current scale and unbounded in principle; the e2e suite already deletes the
  whole table between tests, which is a hint that nothing else ever does.

- **The e2e run starts two application servers against one database.** The
  `origin` project's server exists only to prove canonical URLs come from
  `BASE_URL`, but it runs migrations and the full job runner too. Nothing has
  gone wrong because of it, and it is the first thing to suspect when something
  does.

- **`tests/e2e/locale.spec.ts:63` flaked twice more,** making four sightings
  across three phases. It is now the only known flake in the suite;
  `phase-2-carryover.md` already asked for it to be made robust rather than
  re-observed, and it has now been re-observed.

## Known items carried forward

- **Requester purge is manual only.** The `setting`-driven retention policy is
  not built; nothing expires a requester who simply stopped coming back.
- **Invite-driven requests are modelled but unreachable.** `access_request.source`
  admits `'invite'` and `access_grant.request_id` is nullable for a
  staff-initiated one, but nothing writes either and there is no admin surface.
  Spec §9.4's "bulk invitation covers the reverse direction" is schema only.
- **`access_grant.nda_acceptance_id` is deliberately absent** and is Phase 3's
  first migration, per decision 1: nothing unreachable ships, and the column
  would have referenced a table that does not exist.
- **The return-visit fast path has no entry point.** `sign_in` magic links work
  and are minted by the staff decision route, but a returning requester whose
  session lapsed has no self-service way to ask for one — the subtree redirects
  them to `/request`, where filing a fresh request is the only offer. Spec §9.9
  describes the behaviour; half of it exists.
- **NDA-tier documents render their condition and nothing else.** They are
  excluded from the request form's picker and rejected by the server if posted
  anyway, which is correct for Phase 2 and is Phase 3's starting point.

## Resolved in Phase 2, recorded because the reasoning matters

- **Configuration is an argument, never a `getConfig()` call, below the route
  layer.** Established in Tasks 7 and 8 and held by Tasks 10, 13, 14 and 18.
  The forcing function is the integration suite, which provides
  `TEST_DATABASE_URL` and nothing else: any module that reaches for a fully
  configured environment to answer a question about rows becomes untestable.
  The route or the job owns the lookup.
- **A verification CHECK written as an equivalence is also satisfied when both
  sides are false.** Task 4's constraint was meant to guarantee a verified
  request holds no submitted email; as written it also admitted a verified row
  that kept one — the exact leak it existed to prevent. It is a `CASE` covering
  both directions.
- **A `__Secure-` or `__Host-` cookie cannot be deleted without `Secure`.** The
  browser rejects the whole `Set-Cookie`, deletions included, so the session
  survives a sign-out that reported success.
- **`setHeaders` throws on a repeated header** rather than last-write-wins. Two
  loads in one route tree naming `cache-control` is a 500, not a preference.
- **An optional env var must accept a blank value.** A `.env` spells "unset" as
  `KEY=`, which reaches Zod as `''` and fails `.optional()`. `.env.example`
  shipped exactly that, so copying it verbatim produced a deployment that
  refused to boot.
- **A gated document's *file* is what must never appear in public HTML, not the
  document.** Spec §12 was amended in Task 9: naming a gated document is what a
  trust centre is for, and the guarantee that matters is that no file id and no
  download link escape. The sitemap guarantee is unchanged.
- **Sessions are revoked on re-login, which breaks a shared test account.** Two
  Playwright workers signing in as the same staff member revoke each other
  mid-test. The dev IdP now synthesizes one identity per parallel slot rather
  than the suite giving up its parallelism.
- **Migrations are renamed by hand.** `drizzle-kit generate` assigns a random
  name; this repo uses descriptive ones, so each migration needs its file and
  its `drizzle/meta/_journal.json` tag renamed.
