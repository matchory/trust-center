# Phase 3c carry-over into Phase 3d

Written at the end of Phase 3c, in the same shape as `phase-3c-carryover.md`.
Everything here is a decision, a measurement, or a defect that Phase 3c saw and
deliberately did not fold in.

## The three questions the plan asked

### Did the serializer actually enforce P3.21?

**Mechanically yes, and the tests prove the mechanism — but only against
fixtures this repository builds in code. No real contract has been through it.**

`remark-stringify` escapes a paragraph opening `1. ` as `1\. `, which re-parses
as text rather than as an ordered list. Both import paths assert it, and they
assert it two different ways, which is what makes the claim worth something:
`tests/unit/agreement-import.test.ts` checks the PDF path for the literal
`1\. Definitionen` **and** re-parses the output through `parseAgreementBody` to
confirm no `list` node appears; the DOCX case asserts only the re-parse. So the
property under test is "the subset parser sees no list", not "the string looks
escaped", and it holds on both paths.

The bet the plan made was that this is *structural* — a serializer guarantee
rather than a check somebody has to remember. That much held: nothing in
`pdf.ts` or `docx.ts` special-cases enumerators, and the escape falls out of
`remark-stringify` alone.

**What is not established is the interesting half.** Both cases feed synthetic
input: `textPdf([...])` draws three lines with a chosen point size, and
`docxWith([...])` builds a minimal ZIP. A real NDA numbers clauses as `1.`,
`1.1`, `(a)`, `§ 1`, and often inside a table or a numbered Word list — and a
Word *list* does not arrive as the text `1.` at all, it arrives as `numPr`
markup that `mammoth` renders as `<ol>`, which becomes a real list node and is
then downgraded, not escaped. That path is exercised by neither case. P3.21 is
enforced for enumerators that arrive as text; enumerators that arrive as list
markup take the downgrade pass instead, and no test pins what a reader sees at
the end of it.

### What did the PDF grouper's constants have to become?

**Nothing. They are exactly what the plan wrote down, because no real document
was ever put through them.**

| Constant | Planned | Shipped |
| --- | --- | --- |
| `LINE_TOLERANCE_PT` | 2 | 2 |
| `PARAGRAPH_GAP_RATIO` | 1.8 | 1.8 |
| `HEADING_SIZE_RATIO` | 1.15 | 1.15 |
| `TITLE_SIZE_RATIO` | 1.5 | 1.5 |

`git log -p` over `src/lib/server/nda/import/pdf.ts` shows each of the four
added once and never touched again.

§16 predicted the thresholds would be wrong on the first real document. That
prediction is **untested, not disproven** — and the distinction matters, because
the fixture cannot disprove it. `textPdf` draws each line at a size the test
chose, so `HEADING_SIZE_RATIO` is being asked to separate 20pt from 11pt, a
ratio of 1.8 against a threshold of 1.15. Any value from 1.05 to 1.75 passes the
suite identically. The same is true of the gap ratio: the fixture's line spacing
is uniform by construction.

So the constants are unvalidated in the only way that would count. The task
comment already says "adjust the constants only if a fixture case fails, never
to make a real document look nicer", which is the right rule for keeping the
suite honest — but it also means the first operator to import a real NDA is the
first real test, and there is no way to tell them apart from a bug.

### Did the Milkdown schema get restricted, or did the escape hatch get used?

**Restricted. The escape hatch was not used.**

`MarkdownEditor.svelte` builds `subsetOnly(commonmark)`, which filters the
preset's own plugin array down to the nodes §5.1 admits, rather than shipping
the full commonmark preset and relying on the server to refuse what comes back.
Two details in there are worth keeping:

- Plugins are dropped as **groups**, matched against the preset's own exports. A
  Milkdown node is a schema *plus* attributes, a keymap, input rules and
  commands; dropping the schema while keeping the input rule that looks its type
  up throws at construction rather than degrading.
- `@milkdown/preset-gfm` is never imported at all, which is what keeps tables
  out (P3.24) — an absent preset cannot be re-enabled by a filter bug.

§5.1's position that the server refusal is the real control is unchanged, and
`parseAgreementBody` still runs on every save. The editor restriction is the
convenience layer it was always described as, and it is now genuinely a subset
rather than a promise.

## Decisions this phase settled that the plan did not

- **The documents editor cannot take the multi-locale form shape the other five
  took.** Its `LocaleTabs` snippet also carries the per-file delete forms and the
  upload form, so wrapping the tab strip in the translation form nests a `<form>`
  inside a `<form>` — which the HTML parser resolves by dropping the inner one,
  silently disabling uploads while `pnpm check` stays green. The fields associate
  with the form by `form="document-translations"` id instead, and the form
  element carries only the save button. `new FormData(form)` collects controls
  associated by id, so the POST shape is identical to the other five.
- **`saveTranslationsFromForm` and `saveTranslationsAction` express the same rule
  wherever there is one required field, and the split between them is
  historical.** The first *skips* a locale whose name is blank; the second
  *refuses* a locale filled in halfway — but "halfway" cannot occur with a single
  required field, which is what agreements and groups both have, so the two are
  equivalent at those call sites. A first pass through this phase recorded the
  difference as a real behavioural distinction; it is not, and the comments at
  both call sites were corrected. They keep the older helper because two other
  admin surfaces (`admin/controls/groups`, `admin/documents/categories`) still
  use it, so moving these two would leave both mechanisms standing. **Consolidate
  all four onto `saveTranslationsAction`, or none.**

## Defects found and fixed in 3c, recorded because the reasoning matters

- **Task 12 broke the upload rejection notice, and the phase's own gate is what
  caught it — two tasks late.** Keeping every locale pane mounted (so a one-form
  save posts fields for locales nobody opened) meant the `{#if form?.field ===
  'file'}` notice, which was never scoped to a locale, rendered once per pane.
  Both upload-cap e2e cases then failed on a Playwright strict-mode violation —
  two matching elements — rather than on the behaviour they assert. The action
  already knew the locale and `AdminActionFailure` already carried one; the
  notice now narrows on it exactly as the translation errors on that page do.

  **The lesson is about the verification step, not the change.** Task 12's own
  step said "verify nothing that used tabs regressed" and named the specs that
  drive the tab strip — but `admin-upload.spec.ts` drives forms that merely *sit
  inside* it, and it was not in the list. A step that names the specs to run is
  only as good as whoever enumerated them; "run the suite" would have caught this
  at the commit that caused it instead of at Gate 3.

- **The plan's e2e line-number table pointed every task at another task's
  case.** Tasks 14–19 were listed in task order, but `admin-content.spec.ts`
  orders its cases control, certification, subprocessor, answer, update. Nothing
  was mis-implemented, because each case is identifiable by its `test(...)` name
  — but an agent following the line numbers would have edited the wrong one, and
  the numbers shift under every task in the sequence anyway. Corrected in place.

## Still open

- **P3.21 is unproven for enumerators that arrive as list markup**, per the
  first question above. A Word numbered list reaches `mammoth` as `numPr`, not as
  the text `1.`, so it becomes a real `list` node and takes the downgrade pass
  rather than the serializer escape. Worth one fixture case.
- **The PDF grouper's four constants have never met a real document**, per the
  second question above. The fixture cannot distinguish 1.15 from 1.75.
- **A name outside the loaded font's coverage fails the download**, unchanged
  from 3c. `stampPdf` throws rather than degrading visibly, which is the third
  behaviour §6.4 actually asks for and neither implementation provides.
- **Nothing in the suite proves the SMTP adapter attaches the acceptance
  record**, unchanged from 3c. `createSmtpMailer`'s pass-through to nodemailer is
  still unexercised.
- **`AdminRequestDetail` still carries both `tiers` and `requestedTiers`**,
  unchanged since 3a. One is probably redundant.
- **The e2e suite still starts two application servers against one database**,
  unchanged since Phase 2.
- **Requester retention is still manual only.** Erasure happens when an operator
  clicks it; nothing sweeps.
- **Invite-driven requests remain modelled but unreachable**, unchanged since
  Phase 2.
- **`document_file.page_count` is still unstored.** `assertPdfPages` reads the
  count at upload and discards it.
- **Eleven commits in the published history are unsigned** — `59f6bf4` through
  `938eb0e`, from 3b's signing stall. They are on `origin/main`, so correcting
  them means rewriting published history, which is a decision rather than a
  chore. Everything on this branch is signed; signing did not stall in 3c.

## Closed in 3c, from 3c's own "Still open"

Four items 3b recorded as deliberately deferred were the read-path theme, and
all four are now closed:

- The delivery re-check's extra query when nothing is gated — **closed by Task
  21.** `document.tier` and the two group joins fold into the select both callers
  already ran, so the probe is answered from rows the join had. The rule stays
  `proposeFrom`; no second expression of it in SQL.
- `countGrantDocuments` fetching rows to count them — **closed by Task 22.** The
  aggregate is back for the case where narrowing provably cannot remove a row.
  `count` is `DISTINCT` because the group left joins multiply a document by its
  memberships; the new test seeds a document in two plain groups precisely so it
  fails with 2 where it expects 1 if the `DISTINCT` is dropped, and that was
  confirmed by removing it.
- `effectiveVersion` fetching every candidate's full `bodyMd` — **closed by Task
  23.** Completeness is tested on `(versionId, locale)`; bodies are fetched for
  the winning version alone.
- `request.spec.ts`'s intermittent flood failure — **closed by Task 1 and then
  again at Gate 2**, which is worth recording because the first fix was only
  half of it. Task 1 stopped other specs from resetting the *email* bucket the
  case depends on. Gate 2 surfaced the second failure mode: the *address* bucket
  is shared by every parallel worker, so a concurrent submission could eat the
  five-per-hour address allowance before the loop reached its fifth, and the
  case failed claiming the limiter refused when it had never got that far. The
  flood case now clears everything except the email bucket before *each*
  submission, leaving the email limiter as the only one that can trip — which
  also makes the refusal on the sixth unambiguous.

## Cleaned up after the phase closed

A quality pass over the branch diff found four things and fixed three:

- **`requirementsByDocument` was dead**, and was deleted. Task 21 moved its only
  caller onto `proposeFrom`; the plan had said to keep it exported because "it is
  the read `proposeRequirements` is built on", which is false —
  `proposeRequirements` is built on `scopedDocuments`. Deleting it also removed a
  duplicated fail-closed resolve loop, without minting a single-use helper to
  share between one live caller and one dead one.
- **`foldConferred` hand-rolled `groupByKey`**, in a file that already imports it,
  and whose module comment names inline rewrites as the exact anti-pattern it
  exists to prevent. It now uses the helper.
- **`saveTranslationsAction` wrote its locales one round trip at a time.** They
  are independent upserts on different rows, so they now go together.

One finding was **not** taken: migrating the agreements and groups editors onto
`saveTranslationsAction`. The reasoning offered was that their hand-rolled
actions are equivalent to the helper — which is true, and the comments there
were corrected to say so, because they had claimed a behavioural difference that
a single required field makes impossible. But `saveTranslationsFromForm` has two
*other* callers (`admin/controls/groups`, `admin/documents/categories`), so
migrating these two would leave both mechanisms standing and merely move the
boundary. The consolidation is worth doing across all four or not at all.

## Known items carried forward

- **`pdfjs-dist`, `mammoth` and `@milkdown/*` are admin-only** and must stay
  that way (§10.4). Milkdown loads through a dynamic `import()` inside
  `onMount`; the extraction libraries are imported only from
  `src/lib/server/**`. The public portal still sets no cookies and makes no
  third-party requests, and `tests/e2e/security.spec.ts` asserts both.
- **Import writes nothing.** `?/saveBody` remains the only writer, which is why
  this phase minted no audit action name.
- **A group carrying an agreement has a public meaning**, unchanged from 3c: the
  requester sees the agreement, never the group that carried it.
- **`access_request` still has tiers but not groups**, per §4.2.

## The numbers, at the close of 3c

| Check | Result |
| --- | --- |
| `pnpm check` | 0 errors, 0 warnings, 2282 files |
| `pnpm lint` | clean |
| `pnpm test:unit` | 177 passed, 20 files |
| `pnpm test:integration` | 242 passed, 26 files |
| `pnpm test:e2e` | 99 passed |
| `pnpm build` with `DATABASE_URL`, `OIDC_CLIENT_SECRET` and `SMTP_URL` unset | succeeds |

**No migrations.** `git diff --name-only main..HEAD -- drizzle/` is empty, which
is what the Global Constraint required; a non-zero count would have meant a task
was misread.

Nine dependencies added, all admin-only: `@milkdown/core`,
`@milkdown/preset-commonmark`, `@milkdown/plugin-listener`,
`@milkdown/theme-nord`, `mammoth`, `pdfjs-dist`, `rehype-parse`,
`rehype-remark`, `remark-stringify`.
