# Trust Center Phase 3 — NDA Workflow and Access Groups — Design

**Date:** 2026-08-30
**Status:** Approved for planning
**Author:** Moritz Friedrich (CISO, Matchory), with Claude

Supplements `2026-08-28-trust-center-design.md`. Where the two disagree, this document wins for
Phase 3 and the main spec carries an amendment note pointing here. Everything below is a decision
taken during brainstorming, with the reasoning that produced it, because the reasoning is what the
implementation plan needs and the status is not.

---

## 1. Summary

Phase 3 makes the third document tier reachable. A prospect can request an NDA-gated document; the
system knows whether that person already holds a valid, current acceptance of the agreement that
document requires; if not, an approved grant sits inert until they click through a versioned,
locale-complete template; the act of accepting produces an immutable, hashed record and a PDF sent
to both parties; and only then do the documents unlock and the clock start.

It also introduces **access groups** — operator-defined bundles of documents that carry an optional
NDA of their own — so that "customer-only" and "reseller-only" agreements are configuration rather
than code.

---

## 2. What Phase 2 left

Spec §11 lists four items for Phase 3. One of them already shipped: auto-approval rules with domain
allow and deny lists arrived in Phase 2 as `access_rule`, `matchRule()`, and `/admin/rules`. What
remains of that item is a single clamp at `src/lib/server/access/rules.ts:90`, which reduces a rule
naming `max_tier: 'nda'` down to `'request'` because Phase 2 could not record an acceptance.

Phase 2 refused the NDA tier deliberately and in seven named places, so opening it is a matter of
removing guards rather than discovering them:

| Location | Current behaviour |
| --- | --- |
| `access/rules.ts` | clamps an `nda` ceiling to `request` |
| `access/requests.ts` — `requestableDocuments` | picker filters `tier = 'request'` |
| `access/requests.ts` — `submitRequest` | re-checks tier server-side, rejects NDA |
| `access/requests.ts` — `decideRequest` | re-checks tier, so staff cannot approve one |
| `access/grants.ts` — `grantCoversDocument`, `grantedDocuments`, `countGrantDocuments` | all filter `tier = 'request'` |
| `delivery/serve.ts` | `tier: 'public' \| 'request'` as a literal union, applied as an equality |
| `(portal)/documents/+page.svelte` | NDA branch renders a badge and offers no route |

The absences are equally deliberate: no `nda_template`, no `nda_acceptance`, and no
`access_grant.nda_acceptance_id`, because Phase 2's Decision 1 refused to ship a column referencing
a table that did not exist. This phase creates the tables first and the column second.

---

## 3. Scope

Phase 3 is larger than the main spec's "M" — roughly Phase 2 scale — and splits on the seam between
the workflow and the ergonomics of authoring for it. Both halves are independently reachable.

### Phase 3a — the NDA workflow

Access groups; scope as sets on requests, grants and rules; tier unclamping; the NDA template
family, version and body tables; click-through acceptance; multi-acceptance grant activation; the
record PDF with its layout engine and embedded font; the mail to both parties; the return-visit fast
path. **Templates are authored as typed Markdown in a plain textarea.**

### Phase 3b — authoring ergonomics

PDF text extraction, DOCX conversion, the Milkdown editor, and the preview-before-publish gate.
**No schema changes**: every import path writes the same canonical body 3a already stores.

The split puts every new dependency except `@pdf-lib/fontkit` into 3b, where a wobble costs
ergonomics rather than the gate. It also means the review of a flow producing legally operative
records is not sharing a pass with a WYSIWYG editor.

The cost, stated plainly: between 3a and 3b the NDA is authored in raw Markdown. That is the
friction 3b exists to remove, and it is tolerable only because the document is authored once by the
person who owns it.

---

## 4. The two-axis access model

### 4.1 Tiers stay an enum; cohorts become rows

`document.tier` remains `public | request | nda`. Operator-defined tiers were considered and
rejected.

Every established product in this category separates two axes rather than fusing them: a small
fixed ladder of openness, and an unordered, operator-defined cohort dimension. Conveyor has four
explicitly non-hierarchical access levels plus **access groups**; SafeBase has public / approved /
permission-based plus **permission profiles** segmented by geography, industry and tier; Vanta lets
the approver choose an access level at approval time.

Fusing them — one row per tier, each carrying its own NDA — makes a cohort and an agreement the same
object. Two cohorts under one NDA, or one cohort spanning documents under different NDAs, then force
a tier per *combination*. That is combinatorial, and it is why nobody ships it.

Keeping `tier` as an enum has a second, practical benefit: the 82 tier literals across 35 files, and
every security assertion written against them, stay exactly where they are. The most dangerous
refactor in the phase does not happen.

### 4.2 Groups are document bundles, not people cohorts

Conveyor attaches group membership to the *visitor*, because their flow is "invite a company, it
sees its cohort's documents". This product already has something they do not: a grant carrying an
explicit document list, which is what lets an approver narrow a request.

So a group here is **a named, reusable bundle of documents** — a saved scope. Staff approve with
`groups: {Customer}` rather than ticking eleven checkboxes. There is no membership concept to
administer on the requester side, and resolution stays a single query.

Groups are a staff-side and document-organisation concept. The public request form offers documents
and per-tier blankets; it does not offer groups.

### 4.3 Scope is a set, never a ceiling

`access_request.all_request_tier` and `access_grant.all_request_tier` are booleans meaning
"everything at the request tier, including documents published later". With three tiers they do not
generalise, and a ranked `tier_ceiling` was considered and rejected for two reasons:

1. Purpose-specific NDAs make rank meaningless as an access implication. "Reseller" ranked above
   "Customer" says nothing about who should see what.
2. **A ceiling recomputes.** An operator inserting a new tier at a lower rank retroactively widens
   every existing grant whose ceiling sits above it — documents nobody approved appearing inside
   live grants. That is precisely the failure the main spec's domain-drift rule forbids: decisions
   are recorded, not recomputed.

So scope is three parallel sets, and nothing implies anything else:

- explicit documents (`access_grant_document`, unchanged)
- whole tiers (`access_grant_tier`)
- whole groups (`access_grant_group`)

`access_rule.max_tier` becomes `access_rule_tier` for the same reason — one concept in both places.

### 4.4 Which NDA a document requires

Resolved per document, in this order:

1. If any of the document's groups carries an `nda_template_id`, those templates are required — all
   of them, if it belongs to several such groups.
2. Otherwise, if the document is at the `nda` tier, the **default template** is required, named by
   the `nda.default_template_id` setting.
3. Otherwise, none.

Two consequences worth stating. A group NDA applies to a `request`-tier document too, which is how
an operator adds an agreement to something that would not otherwise need one — Conveyor's
document-specific NDA layered over a global one, expressed through the group. And an `nda`-tier
document with no default template configured **cannot be granted at all**: the resolution fails
closed rather than silently granting an ungated document.

---

## 5. NDA templates

### 5.1 One canonical body

A template body is Markdown, restricted to a subset: headings, paragraphs, bold, italic, ordered and
unordered lists, and horizontal rules. No tables, no images, no raw HTML.

The subset is validated **server-side on save**, rejecting at the form rather than failing at render
— the same discipline as `RULE_PATTERN` refusing a rule that could never match. In 3b, Milkdown's
ProseMirror schema enforces the same subset in the editor, but a client-side schema is a convenience
and never the control.

Everything renders from the parsed AST, never from raw passthrough. The click-through page emits
only nodes we understand, which means there is no HTML sanitisation step because there is no
untrusted HTML — a property worth preserving deliberately.

### 5.2 A version spans every locale

`nda_template_version` carries the version and `effective_from`; `nda_template_body` carries one row
per locale. **A version is effective only when every enabled locale has a body.**

Per-locale independent versions were rejected: under them, two people who both "accepted the current
NDA" are bound by different documents depending on which language their browser asked for, and there
is no version number naming the instrument as a whole. That is a legal problem, not a modelling
preference.

The cost is that publishing becomes all-or-nothing, and that an operator adding a locale to `LOCALES`
has an effective agreement with no body in that language. The click-through **refuses to render**
rather than falling back to `DEFAULT_LOCALE`, because presenting somebody a contract in a language
they did not choose is worse than telling them the page is unavailable.

### 5.3 Immutability

A version becomes immutable the moment it is first accepted, marked by
`nda_template_version.first_accepted_at`. Before that it may be edited freely; after it, edits are
refused and the operator publishes a new version.

`nda_template_body.sha256` is computed over the stored body at save time and copied onto every
acceptance, so the evidence pins the exact bytes the signatory saw even if immutability were somehow
circumvented.

### 5.4 Import (3b)

Every authoring path imports **into** the canonical body; nothing is stored as an opaque blob.

- **DOCX** converts through `mammoth` to semantic HTML, then to Markdown.
- **PDF** extracts text through `pdfjs-dist`. A PDF carries no semantics at all — no headings, no
  lists, no paragraph boundaries, only positioned runs — so reconstruction is heuristic and will
  often be wrong. A PDF yielding no extractable text is **refused** with a message naming the cause:
  it is a scan.
- **Typed Markdown** is native, and is the only path in 3a.

Imports are normalised through the same parser on the way in, so the stored body is canonical from
the start and every later version diff shows semantic change rather than formatting churn.

The import is a *starting point*, and the risk it creates is an operator uploading, not reading the
result, publishing, and a counterparty accepting a mangled contract. The control is that publishing
is already a deliberate, separate, all-or-nothing act: **import → draft → edit → preview exactly what
the requester will see → publish.** The preview is not a nicety.

---

## 6. Acceptance

### 6.1 The record

An acceptance is a fact about a person and a template version:

```
nda_acceptance   requester_id, version_id, method, accepted_at,
                 ip, ua, typed_name, template_sha256, record_pdf_key
```

`method` ships with a CHECK admitting only `'clickthrough'`. It widens when something can produce
another value — deliberately unlike Phase 1's `tier` CHECK, which admitted `'nda'` a phase early and
needed a clamp to stay safe.

Unique on `(requester_id, version_id)`, so a double-submit is idempotent rather than a second
record. The conflict is treated as "already accepted, proceed".

Accepting requires the requester to type their full name and take an explicit accept action,
rate-limited alongside the other requester-facing endpoints.

### 6.2 No `SignatureAdapter`

Spec §6.4 lists the port and §11 puts a real implementation in Phase 7. Phase 3 does not define the
interface, because the seam that matters already exists elsewhere.

Click-through completes synchronously; e-signature completes on a webhook. But activation is already
decoupled from initiation — a grant activates when every required agreement has a matching valid
acceptance, which is a query over `nda_acceptance` and is indifferent to how a row arrived. The
click-through inserts a row and calls `activate`; a Phase 7 webhook inserts a row and calls the same
function. An interface across one implementation would buy nothing that this does not.

No `envelope_id` column ships for the same reason.

### 6.3 Person or domain

Validity is evaluated at a scope named by the `nda.acceptance_scope` setting: `person` or `domain`.
Under `domain`, an acceptance by anyone at `requester.company_domain` satisfies the requirement for
their colleagues.

The row itself is always per-person — a person clicked, and that is the fact being recorded. Only
*validity* varies. Conveyor defaults to per-domain, on the reasoning that an enterprise expects one
agreement per company rather than one per employee, and DACH practice matches that.

### 6.4 Rendering the record

The record PDF is laid out by us from the canonical Markdown, via `pdf-lib` and
`@pdf-lib/fontkit` with an embedded face — regular, bold and italic, since the subset has emphasis.

`pdf-lib`'s standard fonts are WinAnsi-only, which is unacceptable for contract text: `Łukasz` and
`Şule` are not representable, and on an NDA the mangled string would be the typed name standing in
for a signature. No single bundled font covers Unicode — Noto Sans CJK alone is ~16 MB — so:

- **Bundled:** a Latin / Latin Extended / Greek / Cyrillic face. Every European locale this product
  plausibly serves renders correctly.
- **Overridable:** `NDA_PDF_FONT_PATH`, naming a TTF path, defaulting to the bundled one. A
  deployment needing CJK supplies its own face. A hard wall becomes a self-hosting decision, which
  is this project's posture everywhere else.
- **Degrading:** text beyond the loaded font's coverage degrades visibly in the *rendering*. The
  `nda_acceptance` row carries the truth and the email body carries it in UTF-8. Rejecting a name at
  the moment somebody is signing something would be an ugly thing to do to a person.

`delivery/watermark.ts` moves to the same embedded font and `toWinAnsi()` is deleted. It is the
identical defect one layer over — a requester named `Šimon Čech` currently downloads a PDF stamped
`?imon ?ech` — and this phase is in that code anyway for the NDA tier.

Page count stays bounded because we author the document: the carry-over's 16,200-page measurement
applies to files we accept, not to files we write.

---

## 7. The grant lifecycle

### 7.1 Approval mints an inert grant

Staff approval is final and recorded when it is made. The grant exists immediately, and is inert
until every requirement is satisfied.

The alternative — holding the *request* open in a `pending_acceptance` status and minting the grant
at acceptance — was rejected because it makes `decideRequest` stop being the thing that mints grants
for NDA scopes, and puts a fourth outcome in the triage queue that is not a decision.

### 7.2 The clock starts at acceptance

`access_grant.expires_at` becomes **nullable**, and NULL means exactly one thing: *waiting on an
acceptance*.

This is worth naming as an invariant rather than sliding into, because it does real work for free.
`grantedDocuments`, `mayDownload` and `countGrantDocuments` all filter `expires_at > now()`, and
SQL's NULL comparison excludes the row without any of them being modified. **An inert grant grants
nothing by construction, not by remembering.**

`term_days` is added and set at approval; acceptance computes `expires_at = now() + term_days`.
Without it, the term would be re-derived from `defaultGrantDays()` at acceptance time, silently
substituting whatever the setting says *then* — and `/admin/settings/access` exists precisely so
operators change it. Staff's decision is recorded, like every other decision here.

A `request`-tier grant with no requirements sets both at creation and never touches them again.

### 7.3 Requirements freeze at the family

`access_grant_required_nda` holds `(grant_id, nda_template_id)` — the **instrument**, not the
version — computed at approval from the documents in scope via §4.4 and frozen there.

Freezing matters because recomputing live would mean adding a document to a group retroactively
changes what an existing grant is waiting on: the same recompute failure that killed the tier
ceiling.

Freezing the *family* rather than the version matters because the requester signs whichever version
is effective when they actually click. Legal retiring v3 must not leave somebody signing v3 a week
later. Once accepted, the grant pins that acceptance in `access_grant_acceptance`, and a later
version does not disturb it — spec §9's "active grants retain the version accepted".

A grant activates when every row in `access_grant_required_nda` has a matching valid acceptance for
that requester, at the configured scope. Zero rows, or all already satisfied at approval, activates
immediately — which is the §9.9 fast path, and makes the pending state the exception for a returning
prospect rather than the rule.

### 7.4 States and deadlines

`grantState()` returns five values, all derived rather than stored:

| State | Condition |
| --- | --- |
| `revoked` | `revoked_at` set — wins over everything, because a person ended it |
| `pending_acceptance` | `expires_at IS NULL`, deadline not passed |
| `unaccepted` | `expires_at IS NULL`, `acceptance_due_at` passed |
| `expired` | `expires_at <= now()` |
| `active` | otherwise |

`unaccepted` is distinct from `expired` on purpose: "approved but never accepted" is a different
fact from "used and lapsed", it is a funnel signal Phase 5 will want, and an administrator looking
at the list should be able to tell them apart.

`acceptance_due_at` is **stored** at approval, computed from a setting at that moment, rather than
derived from `granted_at` plus a live setting. A derived window would *resurrect* dead grants when an
operator lengthened it. The window a grant was issued under is the window it lives by.

One nudge precedes the deadline, reusing the `grants:remind` job, the `expiry_reminder_sent_at`
pattern, and its once-only stamping. A prospect who genuinely missed the first mail should not lose
an approval they were granted.

### 7.5 The bypass

An approver may waive the requirement on an individual approval: the grant is created with no rows
in `access_grant_required_nda` and activates immediately. Every product in this category ships one —
SafeBase calls it NDA bypass, Conveyor "no NDA required" — and its absence would be the first
support request, because the case it serves is real: a counterparty who has already signed a paper
agreement out of band.

It is a per-decision act by a named person, recorded in the audit event for that decision alongside
the reason. It is deliberately not a rule action and not a setting: waiving an agreement is
precisely the kind of decision that should cost somebody a deliberate click and leave their name on
it.

`request_approved` splits into two templates. Today it means "here are your documents"; under this
design it sometimes means "one step remains", and the two land the reader in different places.

---

## 8. Data model

New and changed tables. Everything not listed is unchanged.

```
access_group              id, slug, position, nda_template_id?, created_at
access_group_translation  (group_id, locale) name, description
document_group            (document_id, group_id)

nda_template              id, slug, created_at
nda_template_version      id, template_id, version, effective_from, first_accepted_at?
nda_template_body         (version_id, locale) body_md, sha256

nda_acceptance            id, requester_id, version_id, method, accepted_at,
                          ip, ua, typed_name, template_sha256, record_pdf_key
                          unique (requester_id, version_id)

access_request_tier       (request_id, tier)          replaces access_request.all_request_tier
access_grant_tier         (grant_id, tier)            replaces access_grant.all_request_tier
access_grant_group        (grant_id, group_id)
access_grant_required_nda (grant_id, nda_template_id)
access_grant_acceptance   (grant_id, acceptance_id)
access_rule_tier          (rule_id, tier)             replaces access_rule.max_tier

access_grant              + term_days int not null
                          + acceptance_due_at timestamptz?
                          ~ expires_at now nullable
```

New settings: `nda.default_template_id`, `nda.acceptance_scope`, `nda.acceptance_due_days`.

The `all_request_tier` migration is mechanical: `true` becomes one `access_grant_tier` row naming
`request`, `false` becomes none.

`term_days` is NOT NULL and existing rows have no such column, so it is backfilled from the grant
they already have — the whole days between `granted_at` and `expires_at`, which is exactly the term
those grants were issued under.

One CHECK enforces the pairing that §7.4's state table depends on: **a grant with a NULL `expires_at`
must have an `acceptance_due_at`.** Without it a grant could sit in neither `pending_acceptance` nor
`unaccepted` — inert, with no deadline, and invisible to every sweep.

---

## 9. Flow, end to end

1. **Request.** The public form offers `request`- and `nda`-tier documents and per-tier blankets.
   NDA-tier entries state which agreement they require.
2. **Verify.** Unchanged from Phase 2.
3. **Rules.** `decideFromRules` returns a set of permitted tiers rather than a ceiling. The clamp at
   `rules.ts:90` is removed.
4. **Decision.** Staff approve with an explicit scope across documents, tiers and groups, a term,
   and optionally a bypass. Required agreements are resolved and frozen.
5. **Acceptance.** If requirements are outstanding, the grant is inert and the requester is mailed a
   link into `/{locale}/access`. They read the current version in their locale, type their name, and
   accept. A record PDF is generated, stored, and mailed to them and to
   `STAFF_NOTIFICATION_EMAIL`. That variable is optional and unset is a valid deployment, in which
   case the requester's copy is the only mail and the operator's copy is the stored record and the
   portal view — "both parties" degrades to one, and the record itself never depends on mail.
6. **Activation.** The last outstanding requirement satisfied sets `expires_at = now() + term_days`
   on every grant of that requester which is thereby complete — one acceptance can activate several.
7. **Download, lapse, revocation.** Unchanged from Phase 2, with the tier filters widened.
8. **Return visit.** A requester holding a valid acceptance is approved and activated in one step.
   The §9.9 entry point missing since Phase 2 is built here.

---

## 10. Security and privacy

### 10.1 Auto-approval may not hand out a blanket carrying an NDA

An automatically approved decision may grant explicitly named documents at any tier, but **may not
grant a whole tier or a whole group that carries an NDA requirement**.

Without the guard, the full path is: a stranger from an allow-listed domain submits, verifies by
magic link, is auto-approved with no human involved, clicks through, and holds every NDA-tier
document — including ones published next month — for the full term. Every step is something an
operator configured and the audit records it, but nobody looked.

The guard costs an operator who wants genuinely hands-off NDA-tier access for a partner domain, who
must approve those by hand. That is the intended trade: the broadest grant in the system is never
made by a pattern match.

### 10.2 Erasure and the acceptance record

No incumbent documents what happens to a signed NDA record under an Art. 17 request, so this is a
judgment rather than a convention.

**The acceptance survives `purgeRequester` with `typed_name` intact**, on Art. 17(3)(e) —
establishment, exercise or defence of legal claims — which fits a signed agreement more squarely
than the legal-obligation ground. A record of agreement whose signatory has been blanked is not
evidence of anything, and blanking it would destroy the artifact's only purpose.

**`ip` and `ua` on the acceptance survive with it**, which is a deliberate exception to the
handling everywhere else. They are not incidental telemetry here: timestamp, IP and user agent are
the evidentiary elements that make a click-through agreement enforceable at all. Pseudonymising them
would leave a record saying only that somebody once typed a name, which is the same as not keeping
it. The narrow ground that justifies retaining the signature justifies retaining what proves it.

Everything else about that person is still erased, and `audit_event` is pseudonymised exactly as
spec §10 requires — the exception is confined to this one domain table and does not touch the audit
log.

The honest part is disclosure: **the click-through text states that this record outlives an erasure
request**, before anyone types their name. A person signing something is entitled to know which part
of it they cannot later withdraw.

### 10.3 Placement

The click-through, the record view, and everything else requester-facing live under
`/{locale}/access`. That is the only path the requester cookie is scoped to; anywhere else the
request arrives anonymous, exactly as Task 12 found for downloads.

The requester can view their own acceptance record in the portal, not only in email — every
incumbent does this, and it costs one route.

### 10.4 Unchanged guarantees

The public portal still sets no cookies and makes no third-party requests. Milkdown, `pdfjs-dist`
and `mammoth` are bundled into the **admin** entry point and are never loaded by a public route.
Requester personal data still appears in `audit_event` only in `ip`, `ua` and `actor_id`.

---

## 11. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| P3.1 | Approval mints an inert grant; the clock starts at acceptance | The approval is a decision and is recorded when made; a prospect who takes a week to read an NDA should not lose a week of access |
| P3.2 | `expires_at IS NULL` means "waiting on acceptance" | Every existing expiry filter then excludes an inert grant with no change — fail-closed by construction |
| P3.3 | `term_days` and `acceptance_due_at` are stored, not derived | A live setting would silently rewrite terms, and a derived deadline would resurrect dead grants |
| P3.4 | Tiers stay an enum; cohorts become `access_group` rows | Fusing them makes cohort and agreement one object and forces a tier per combination; it also avoids refactoring 82 security-relevant literals |
| P3.5 | Scope is sets of documents, tiers and groups — never a ceiling | A ceiling recomputes, retroactively widening live grants when a tier is inserted |
| P3.6 | Groups are document bundles, not people cohorts | A grant already carries an explicit document list; a people axis would duplicate it |
| P3.7 | A version spans every enabled locale, published together | Otherwise "the current NDA" names different obligations per browser language |
| P3.8 | Templates import into one canonical Markdown body; no stored blobs | Uniform, diffable, hashable, accessible, and layout stays under our control |
| P3.9 | Requirements freeze at the family; the version resolves at acceptance | Freezing prevents retroactive change; family-not-version stops anyone signing a retired text |
| P3.10 | No `SignatureAdapter` and no `envelope_id` | Activation is already decoupled from initiation; an interface over one implementation buys nothing |
| P3.11 | Acceptance rows are per-person; validity scope is a setting | A person clicked, and that is the fact; enterprises expect one agreement per company |
| P3.12 | An embedded Unicode font, operator-overridable | WinAnsi cannot render a European name, and no bundled font covers Unicode |
| P3.13 | Auto-approval may not grant a blanket carrying an NDA | The broadest grant in the system requires a person |
| P3.14 | The acceptance survives erasure, and says so beforehand | Art. 17(3)(e); a blanked signature is not evidence, and disclosure is owed |

---

## 12. Deviations from the main spec

1. **§8's flat `nda_template(version, locale, body_md | file_key, effective_from)` becomes three
   tables** — family, version, body. Forced by per-group agreements: with more than one instrument,
   "which NDA" and "which version of it" are different questions, and the locale set hangs off the
   version.
2. **`file_key` is not built.** §8 offers a stored file as an alternative body. Every authoring path
   imports into the canonical body instead — see P3.8.
3. **`access_grant.nda_acceptance_id` is a join table, not a column.** A scope spanning two groups
   with different agreements needs both before anything unlocks, so the singular column the Phase 2
   carry-over anticipated does not survive.
4. **`nda_acceptance.envelope_id` is not built.** See P3.10.
5. **Auto-approval rules shipped in Phase 2,** not here; §11 lists them under Phase 3.
6. **Phase 3 splits into 3a and 3b.** §11's numbering is otherwise unchanged, so Phases 4–7 keep
   their numbers.

---

## 13. Dependencies

**3a:** `@pdf-lib/fontkit`; a bundled TTF family (Latin / Latin Extended / Greek / Cyrillic, under a
licence permitting redistribution); a Markdown parser producing an AST.

`remark-parse` / mdast is preferred over alternatives because Milkdown normalises through remark in
3b, and a shared AST keeps the subset validator, the HTML renderer and the PDF layout agreeing with
the editor rather than approximately agreeing.

**3b:** `pdfjs-dist`, `mammoth`, `@milkdown/*`. All admin-bundle only.

---

## 14. Testing

Phase 2's strategy carries forward unchanged. Additions:

- **Unit:** the restricted-subset validator; NDA resolution per §4.4, including the fail-closed case
  of an `nda`-tier document with no default template; `grantState()` across all five values;
  activation when one acceptance completes several grants; the auto-approval blanket guard.
- **Integration:** the frozen requirement set surviving a document being added to a group; a version
  refusing to become effective with a locale missing; immutability after `first_accepted_at`;
  `purgeRequester` leaving `typed_name` intact while pseudonymising `ip` and `ua`; the
  `(requester_id, version_id)` conflict being idempotent.
- **End-to-end:** the full NDA journey — request an NDA-tier document, verify, approve, land on the
  inert grant, accept, download; and the fast path, where a second request by a requester already
  holding a current acceptance activates without a second click-through.
- **Security:** the existing assertion that no gated file id reaches public HTML extends to the NDA
  tier; the public portal still sets no cookies with the NDA routes present.

An **end-to-end test of the admin file upload** is folded in here. It predates this phase and is the
one gap where a page-count cap and a size cap are unit-tested but the route applying them has never
been driven by a browser — and 3b adds a second upload route, which would otherwise inherit the same
gap.

---

## 15. Carry-over folded in

| Item | Where |
| --- | --- |
| No end-to-end test covers the admin file upload | 3a (see §14) |
| The return-visit fast path has no entry point (spec §9.9) | 3a |
| `toWinAnsi()` mangles non-WinAnsi names in watermarks | 3a (§6.4) |

Deliberately **not** folded in, because they touch unrelated code and folding them is how a phase
quietly doubles: the e2e suite starting two application servers against one database; requester
retention being manual only; invite-driven requests being modelled but unreachable;
`document_file.page_count` still unstored.

---

## 16. Deferred

- A real `SignatureAdapter` implementation and the `esign` method — Phase 7, per §11.
- Per-download re-acceptance of a document-specific agreement, which Conveyor supports. Nothing here
  needs an agreement re-accepted on every download, and the mechanism would double the acceptance
  surface.
- People-cohort access groups. Groups are document bundles here; a membership axis on the requester
  arrives if and when invite-driven requests become reachable.
- An acceptance expiring on its own. An acceptance is valid until a new version supersedes it; the
  main spec asks for no NDA term and one should not be invented.
