# Phase 3b carry-over into Phase 3c

Written at the end of Phase 3b, in the same shape as `phase-3b-carryover.md`.
Everything here is a decision, a measurement, or a defect that Phase 3b saw and
deliberately did not fold in.

## The three questions the plan asked

### Did the two-axis model survive a real agreement?

**`saveMetaAction` took the fifth content type unchanged. The translation half
was routed around for the third phase running — and this time the plan was wrong
about why.**

`nda_template` uses `saveMetaAction` at `/admin/agreements/[id]` with a `z.object`
schema, a `read` that pulls the slug, and an `update` that receives `db`: the
same call shape as `access_group` and `access_rule`, no props added, no fork.
That is now three consecutive phases in which the meta half generalised on
first contact.

The translation half did not fit, for the reason it has not fitted since Phase
1: `saveTranslationAction` writes **one locale per POST**, and the agreement form
submits every locale at once. It uses a bespoke `saveTranslations` action, as the
group editor does.

**The correction worth carrying:** 3a's carry-over recorded the singular helper
as "unused, three phases in… the next phase touching translations should delete
it", and 3b's plan turned that into a task. It is not unused. Six admin forms —
FAQ, subprocessors, updates, controls, certifications, documents — post to
`?/saveTranslation` one locale at a time, and five e2e cases drive them.
Deleting it would have removed a working feature and broken those tests, so
Task 21 skipped that step.

What was actually true is narrower and still worth acting on: **the helper does
not fit content types whose editor is a single multi-locale form**, which is
every content type added since Phase 1. Two shapes coexist. The question for 3c
is whether the six older editors should move to the multi-locale shape, not
whether the helper is dead.

**The general lesson: "no caller" and "no caller among the things I have been
looking at" are different claims, and a carry-over note is exactly where the
second gets written down as the first.**

### What did the layout engine actually cost?

**One task, not the two or three §16 budgeted — and the defect it predicted
never happened. A different one did, one layer out.**

§16 called the layout engine the largest single unknown and predicted the first
defect would be a nested list crossing a page boundary. It was not. That test
passed on the first run of the implementation, because the fit check is written
at the *line* rather than at the block: the engine asks before every single line
whether that line still fits, so a list is not a unit that can overflow, and
page-break correctness is not something the list code has to remember.

`layout.ts` is 271 lines against a ~200 budget, and the overrun is honest — the
extra is the closing-block support Task 14 needed and the run-merging described
below.

**What actually cost the time was reading the output back.** The plan's tests
assert on `drawnText()`, and an embedded font writes **glyph indices, not
characters**: `Łukasz` is `<0001000200030004000500060007>`. The existing helper
decoded `Tj` operands as latin1, so every assertion in the new suite compared
against mojibake. The helper now follows `Tf` to the font in the page's
resources and runs its `ToUnicode` CMap over the codes, the way a viewer does —
per font, because one CMap applied to every font produces confident nonsense the
moment a paragraph has a bold word in it. It became async; four call sites now
await it.

A second, smaller one followed: wrapping splits a line into one piece per word,
and drawing it that way emitted a text operator per word, so `drawnText` read
back `Tail\nheading` and no assertion on a phrase could pass. Adjacent pieces in
one face are now merged into one run — better output as well as readable tests.

**The general lesson: when a change alters how output is *encoded*, the
assertion layer is part of the change.** Three of the six layout tests failed
for reasons that had nothing to do with layout, and reading them as layout bugs
would have sent the engine in a wrong direction.

### Which of §7.3's three paths did a test actually catch?

**All three, by the live check, in `nda-delivery.test.ts` — plus a fourth the
spec implies and does not enumerate.**

| Path | Caught by |
| --- | --- |
| 1 — a request-tier document joins a group carrying an agreement | `stops delivering a document that gains an agreement after approval` |
| 2 — an operator sets a granted group's `nda_template_id` later | the same test; the fixture does both, and they are the same mechanism |
| 3 — a document moves to the `nda` tier | `stops delivering a document moved to the nda tier` |
| 4 — an `nda`-tier document with no default agreement configured | `refuses an nda-tier document when no default agreement is configured` |

None was caught only by review. The narrowing-only invariant has its own test,
as §7.3 demands.

Paths 1 and 2 collapsing into one test is not a gap: the frozen set does not
name the agreement in either case, and the live check re-derives the requirement
from the document's groups, so the two differ only in which row an operator
edited.

## Decisions this phase settled that the plan did not

- **The live delivery check reuses `proposeFrom` and `validAcceptance` rather
  than restating them in SQL.** The plan asked for one `NOT EXISTS` subquery.
  Writing it that way meant reimplementing `validAcceptance` — including
  `matchRule`'s ordering and §6.3's `auto_approve` bound — in SQL, which
  `domainIsRuleMatched`'s own comment warns will drift, and getting the `domain`
  acceptance scope wrong in the meantime. What shipped is a SQL pre-check that
  finds the unwaived, currently-required templates (usually none, at zero further
  cost) and a JS call to the one true implementation when it finds some.
  `locales` therefore reaches `grantedDocuments`, `mayDownload` and
  `countGrantDocuments` as an argument.
- **`serveDocumentFile` takes a tier *set*, not a tier.** The plan widened the
  parameter to a three-value union, but the gated route serves two tiers from
  one path. Both are named explicitly — adding a tier must not widen access by
  omission.
- **No `AutoApprovalBlocked` error class.** The plan listed one; nothing throws.
  The guard's answer picks a status and an audit meta key, and an unused export
  is worse than a missing one.
- **`NDA_FONT_DIR` names a directory, not a path.** §6.4 specified a singular
  `NDA_PDF_FONT_PATH`; four faces cannot be named by one path, and a deployment
  needing CJK now drops four files into a directory and changes nothing else.

## Defects found and fixed in 3b, recorded because the reasoning matters

- **`publishVersion` stamped `effective_from` from the application clock while
  `effectiveVersion` compares it against `now()` in Postgres.** Two clocks: with
  the database even milliseconds behind — which the Testcontainers container
  reliably is — a version just published is briefly not in force, so nobody can
  be shown the agreement they were just told to sign. It surfaced as a flake two
  integration suites were already carrying. **A timestamp written by one clock
  and compared against another is a race whether or not anybody has seen it
  fail.**
- **`deleteGroup`'s error handler was wrong twice over and untested.** 3a wrote
  `cause.code === '23503'`. Drizzle *wraps* the driver error, so the code is not
  where `cause.code` looks for it; and Postgres reports an explicit
  `ON DELETE RESTRICT` as **23001**, not 23503. Deleting a group a live grant
  named therefore returned a 500 rather than the "in use" message the route has
  been rendering for it since 3a. Both readings now go through one `pgErrorCode`
  helper, both codes are matched, and there is a test. **The plan's Task 21 text
  still instructed copying the broken precedent** — "`cause.code`, not
  `cause.cause.code`: this is the shape postgres-js actually throws" — and
  following it produced a helper that never matched, found by driving a duplicate
  slug through a browser. The SDD ledger's Ruling P3-AMENDED had already caught
  both halves during Task 6 and redirected Task 21; the plan document was never
  updated to match. **When a ruling supersedes plan text, the plan text is what
  the next reader follows.**
- **Duplicate slugs 500'd on every content type.** Now caught once in
  `saveMetaAction` for updates and at each of the eleven create actions.
- **Two elements carried `data-testid="agreement-body"`**, which makes every
  assertion on it ambiguous under Playwright's strict mode. The renderer keeps
  it.
- **Test files that seed agreements must clean up children before parents.**
  `nda_acceptance.version_id` and `access_group.nda_template_id` are both
  `ON DELETE RESTRICT`, so a file leaving either behind fails a *different*
  file's cleanup. This is the same class 3a recorded for grant-group pairs, and
  it bit three more files here. **Every future file seeding an agreement
  inherits it.**

## Still open

- **A name outside the loaded font's coverage fails the download.**
  `toWinAnsi()` is gone as the plan required, so `stampPdf` no longer degrades an
  unrepresentable character to `?` — it throws. Source Sans 3 covers Latin,
  Latin Extended, Greek and Cyrillic; a CJK or emoji name now breaks the gated
  download outright rather than mangling the stamp. §6.4 calls for degrading
  *visibly in the rendering*, which is a third behaviour neither the old code
  nor the new one implements. The operator answer is `NDA_FONT_DIR`, and it is
  documented, but the failure mode deserves a decision rather than a default.
- **The record mail's Mailpit assertion was folded into the journey instead.**
  Task 15's plan asked the Mailpit-reading e2e to assert the attachment arrives.
  No spec reads Mailpit — both read `outbound_email` deliberately, because the
  mail is queued rather than sent inline and a mail server would buy flakiness
  for nothing. `nda-journey.spec.ts` asserts the queued row carries one
  attachment named `acceptance.pdf`. **Nothing in the suite proves the SMTP
  adapter actually attaches it**; `createSmtpMailer`'s pass-through to nodemailer
  is unexercised.
- **`AdminRequestDetail` still carries both `tiers` and `requestedTiers`**,
  unchanged from 3a. One is probably redundant.
- **The e2e suite still starts two application servers against one database**,
  unchanged since Phase 2.
- **`request.spec.ts`'s flood case is an intermittent failure under the full
  suite** — it passed on one full run and failed on another, and passes alone
  every time. The limiter it exercises is keyed on the *client address*, which
  every worker shares, and several specs call `db.delete(rateLimit)` to avoid
  being throttled themselves; a delete landing mid-flood resets the counter and
  the sixth submission succeeds. `seedRequestForAgreement`'s own comment already
  records the hazard, and 3b widened the window by calling it twice more from
  `nda-journey.spec.ts`. The real fix is for the specs that clear the table to
  clear only their own buckets, which needs the per-address bucket to stop being
  shared — a change to the fixture, not to the limiter.
- **Requester retention is still manual only.** Erasure happens when an operator
  clicks it; nothing sweeps.
- **Invite-driven requests remain modelled but unreachable**, unchanged since
  Phase 2.
- **`document_file.page_count` is still unstored.** `assertPdfPages` reads the
  count at upload and discards it.
- **Commit signing stalled the run again.** The Secretive agent refused mid-phase
  and the remaining nine commits went out with `--no-gpg-sign`, on explicit
  instruction from the human partner after the second refusal. 3a's carry-over
  recorded the constraint as forbidding that flag; it is now a decision on
  record, and the history from `34b9f4d` onward is unsigned.

## Known items carried forward

- **3c inherits the parsing and editing work 3b deliberately left out:**
  `pdfjs-dist` and `mammoth` for extraction, and Milkdown for authoring the
  agreement body against the same subset `parseAgreementBody` enforces. The
  server-side check stays the control; a ProseMirror schema is a convenience.
  Keep all three out of the public bundle — the admin surface is the only place
  they belong.
- **A group carrying an agreement now has a public meaning**, which 3a flagged
  as a genuinely new decision. It was made the plain way: the requester sees the
  agreement they must accept, never the group that carried it. Groups still have
  no public surface.
- **An auto-approved decision still grants no groups**, unchanged from 3a, and
  now additionally cannot grant any blanket whose proposal carries an agreement.
- **`access_request` still has tiers but not groups**, per §4.2.

## The numbers, at the close of 3b

| Check | Result |
| --- | --- |
| `pnpm check` | 0 errors, 0 warnings, 1999 files |
| `pnpm lint` | clean |
| `pnpm test:unit` | 150 passed, 19 files |
| `pnpm test:integration` | 238 passed, 25 files |
| `pnpm test:e2e` | 93 passed |
| `pnpm build` with `DATABASE_URL`, `OIDC_CLIENT_SECRET` and `SMTP_URL` unset | succeeds |

Six migrations, `0019` through `0024`.
