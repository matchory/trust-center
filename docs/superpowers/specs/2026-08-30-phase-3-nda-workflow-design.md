# Trust Center Phase 3 — NDA Workflow and Access Groups — Design

**Date:** 2026-08-30
**Status:** Approved for planning
**Author:** Moritz Friedrich (CISO, Matchory), with Claude

**Revised 2026-08-30 after adversarial review.** Two findings were fatal and reshaped the design:
the required-agreement set is now recorded by the approver rather than resolved from a mutable
graph, and requirement checking happens in two layers rather than one. §18 logs every change and
what prompted it.

**Amended 2026-08-31, after Phase 3a landed.** Implementing 3a surfaced five things this document
had not settled, three of which change behaviour and are recorded as P3.18–P3.20. §19 lists all
five and the reasoning; §2, §5.6, §6.4, §8, §9 and §15 carry the amendments themselves.

Supplements `2026-08-28-trust-center-design.md`. Where the two disagree, this document wins for
Phase 3 and the main spec carries an amendment note pointing here. Everything below is a decision
with the reasoning that produced it, because the reasoning is what the implementation plan needs and
the status is not.

---

## 1. Summary

Phase 3 makes the third document tier reachable. A prospect can request an NDA-gated document; the
approver decides which agreements that access requires; an approved grant sits inert until those
agreements are accepted; the act of accepting produces an immutable, hashed record and a PDF sent to
both parties; and only then do the documents unlock and the clock start.

It also introduces **access groups** — operator-defined bundles of documents that may carry an NDA
of their own — so that customer- and purpose-specific agreements are configuration rather than code.

---

## 2. What Phase 2 left

Spec §11 lists four items for Phase 3. One already shipped: auto-approval rules with domain allow
and deny lists arrived in Phase 2 as `access_rule`, `matchRule()`, and `/admin/rules`. What remains
of that item is a single clamp at `src/lib/server/access/rules.ts:90`, which reduces a rule naming
`max_tier: 'nda'` to `'request'` because Phase 2 could not record an acceptance.

Phase 2 refused the NDA tier deliberately, in seven named places, so opening it is a matter of
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
a table that did not exist. This phase creates the tables first and the reference second.

**Phase 3a relocated five of those seven guards without removing any of them,** so the table above
describes Phase 2's arrangement rather than the code this phase opens. The clamp at `rules.ts:90`
and the `tier = 'request'` equalities in `requests.ts` and `grants.ts` are now one constant —
`PHASE_TIERS` in `src/lib/server/access/scope.ts`, applied through `honouredTiers()` at read time —
and `grantCoversDocument` has been folded into `grantConfersDocument`. **`PHASE_TIERS` is what this
phase widens, and it is a one-line edit; everything else follows from it.** Two entries are
untouched by 3a and remain exactly as the table lists them: `delivery/serve.ts`'s
`tier: 'public' | 'request'` literal union, applied as an equality, and the portal document list's
NDA branch, which renders a badge and offers no route.

---

## 3. Scope

Phase 3 is larger than the main spec's "M" and splits three ways. Each part is independently
reachable and has one reviewable theme.

### Phase 3a — scope is a set

Access groups as a content type; scope as sets of documents, tiers and groups on requests, grants
and rules; the `all_request_tier` migration; `term_days`. **The NDA tier stays refused.**

Independently useful: an approver can save a scope as a group and grant it by name rather than
ticking eleven checkboxes. One theme, and a mechanical but high-blast-radius refactor —
`all_request_tier` and `allRequestTier` appear 73 times across 20 files, four of them integration
suites and four end-to-end specs — reviewed on its own.

### Phase 3b — the NDA workflow

Template family, version and body; the tier unclamp; the approver-chosen requirement set;
click-through acceptance; activation; live delivery checking; the record PDF with its layout engine
and embedded font; the mail; the preview; the return-visit fast path. Templates are authored as
typed Markdown in a plain textarea.

Reviewed against a scope model already landed and tested.

### Phase 3c — authoring ergonomics

PDF and DOCX import into the same canonical body, and the Milkdown editor. **No schema changes.**

### Why the seam moved

An earlier draft split between the workflow and its ergonomics, leaving the scope refactor inside
the NDA phase. That put a 73-site refactor of the security-critical path in the same review pass as
a flow producing legally operative records — precisely the pairing the split existed to avoid. The
scope model and the agreement are different subjects and get different passes.

**The preview belongs to 3b, not 3c.** §5.4 argues it is the control against publishing a mangled
contract, and withholding it from the phase most likely to produce one would be incoherent. It is
also nearly free there: the click-through page already renders the AST, and the preview is that
renderer pointed at a draft.

---

## 4. The two-axis access model

### 4.1 Tiers stay an enum; cohorts become rows

`document.tier` remains `public | request | nda`. Operator-defined tiers were considered and
rejected.

Every established product in this category separates two axes rather than fusing them: a small fixed
ladder of openness, and an unordered, operator-defined cohort dimension. Conveyor has four
explicitly non-hierarchical access levels plus **access groups**; SafeBase has public / approved /
permission-based plus **permission profiles** segmented by geography, industry and tier; Vanta lets
the approver choose an access level at approval time.

Fusing them makes a cohort and an agreement the same object, and two cohorts under one NDA — or one
cohort spanning documents under different NDAs — then force a row per *combination*. That is
combinatorial, and it is why nobody ships it.

Keeping `tier` an enum has a second benefit: the tier literals and every security assertion written
against them stay where they are. The most dangerous refactor available does not happen.

### 4.2 Groups are document bundles, not people cohorts

Conveyor attaches group membership to the *visitor*, because their flow is "invite a company, it
sees its cohort's documents". This product already has something they do not: a grant carrying an
explicit document list, which is what lets an approver narrow a request.

So a group here is **a named, reusable bundle of documents** — a saved scope. There is no membership
concept to administer on the requester side, and resolution stays a single query.

Groups are a staff-side and document-organisation concept. The public request form offers documents
and per-tier blankets; it does not offer groups.

### 4.3 Scope is a set, never a ceiling

`all_request_tier` on `access_request` and `access_grant` means "everything at the request tier,
including documents published later". With three tiers it does not generalise, and a ranked
`tier_ceiling` was considered and rejected:

1. Purpose-specific agreements make rank meaningless as an access implication. "Reseller" ranked
   above "Customer" says nothing about who should see what.
2. **A ceiling recomputes.** Inserting a tier at a lower rank retroactively widens every existing
   grant whose ceiling sits above it — documents nobody approved appearing inside live grants. That
   is the failure the main spec's domain-drift rule forbids: decisions are recorded, not recomputed.

So scope is three parallel sets, and nothing implies anything else: explicit documents
(`access_grant_document`), whole tiers (`access_grant_tier`), whole groups (`access_grant_group`).

`access_rule.max_tier` becomes `access_rule_tier` for the same reason — one concept in both places.

### 4.4 Which agreements a grant requires

**The approver records the requirement set. The system proposes it.**

An earlier draft resolved requirements from the document graph alone, per document, taking the union
of every group NDA. That is fatal for the use case this phase exists to serve. Customer A and
Customer B each sign their own agreement and both need the security pack, so the pack sits in both
groups — and the union then requires Customer A to sign Customer B's NDA before downloading
anything. The only escape is one document copy per customer, which is §4.1's combinatorial explosion
relocated from tiers to groups.

The cause is that the agreement was attached to the **document** when the thing it varies by is the
**counterparty**. So it attaches to the decision:

- **The proposal.** At approval the system computes, over the documents in scope, the union of their
  groups' `nda_template_id` **plus** the default template where the document is at the `nda` tier.
  The union is deliberate: an `else` chain would let filing an `nda`-tier document into any
  NDA-carrying group silently remove the general agreement from it, which is a gate weakening
  produced by a filing action.
- **The decision.** The approver confirms, adds, or removes entries, and what is stored is what they
  confirmed. Removing one is a waiver (§7.5) and is recorded as such, with the person and the reason.
- **The floor.** Delivery re-checks live against the document actually being fetched (§7.3), so the
  proposal is also the fail-closed floor for anything the approver never saw.

This is more consistent with "decisions are recorded, not recomputed" than deriving from a graph
that changes underneath the grant, and §4.1 already cites the precedent: Vanta lets the approver
choose at approval time.

An `nda`-tier document with no default template configured **cannot be proposed or granted**:
resolution fails closed rather than silently granting an ungated document.

---

## 5. NDA templates

### 5.1 One canonical body

A template body is Markdown, restricted to a subset: headings, paragraphs, bold, italic, ordered and
unordered lists, and horizontal rules. No tables, no images, no raw HTML.

The subset is validated **server-side on save**, rejecting at the form rather than failing at render
— the same discipline as `RULE_PATTERN` refusing a rule that could never match. In 3c, Milkdown's
ProseMirror schema enforces the same subset in the editor, but a client-side schema is a convenience
and never the control.

Everything renders from the parsed AST, never from raw passthrough. The click-through page emits
only nodes we understand, so there is no HTML sanitisation step because there is no untrusted HTML —
a property worth preserving deliberately.

### 5.2 A version spans every locale

`nda_template_version` carries the version and `effective_from`; `nda_template_body` carries one row
per locale. **A version is effective only when every enabled locale has a body.**

Per-locale independent versions were rejected: under them, two people who both "accepted the current
NDA" are bound by different documents depending on which language their browser asked for, and no
version number names the instrument as a whole. That is a legal problem, not a modelling preference.

The click-through **refuses to render** rather than falling back to `DEFAULT_LOCALE`, because
presenting somebody a contract in a language they did not choose is worse than telling them the page
is unavailable.

That refusal has a consequence on a live grant, and it needs two controls or it is invisible. A
requirement whose template has no currently-effective, locale-complete version leaves the requester
on an "unavailable" page while `acceptance_due_at` ticks down to `unaccepted`, and nobody is told.
So:

- **Approval refuses to record a requirement** on a template with no currently-effective,
  locale-complete version. The failure lands at the decision, where a person is present, rather than
  at the click-through, where one is not.
- **The admin grant list shows a blocked reason** for an inert grant whose requirement cannot
  currently be rendered, and adding a locale to `LOCALES` surfaces which templates now lack a body.

### 5.3 Immutability and retirement

A version becomes immutable the moment it is first accepted, marked by
`nda_template_version.first_accepted_at`. Before that it may be edited freely; after it, edits are
refused and the operator publishes a new version.

`nda_template_body.sha256` is computed over the stored body at save time and copied onto every
acceptance, so the evidence pins the exact bytes the signatory saw.

**Templates and versions are never hard-deleted.** They carry `retired_at`, and the foreign keys
that reference them are `ON DELETE RESTRICT` (§8). Under the house convention of cascading joins,
deleting a superseded template would cascade its requirement rows away and make the activation
predicate vacuously true for every grant waiting on it — turning an administrative tidy-up into a
silent bulk unlock. This is the one place the convention is wrong, so §8 states the FK actions
explicitly rather than leaving them to be inferred.

### 5.4 The preview (3b)

Publishing is a deliberate, separate, all-or-nothing act, and the preview is what stands between a
bad body and a signed agreement: **draft → edit → preview exactly what the requester will see →
publish.** It renders through the same AST path as the click-through, so it cannot drift from it.

### 5.5 Import (3c)

Every authoring path imports **into** the canonical body; nothing is stored as an opaque blob.

- **DOCX** converts through `mammoth` to semantic HTML, then to Markdown.
- **PDF** extracts text through `pdfjs-dist`. A PDF carries no semantics — no headings, no lists, no
  paragraph boundaries, only positioned runs — so reconstruction is heuristic and will often be
  wrong. A PDF yielding no extractable text is **refused**, naming the cause: it is a scan.
- **Typed Markdown** is native, and is the only path in 3b.

Imports normalise through the same parser on the way in, so the stored body is canonical from the
start and every later version diff shows semantic change rather than formatting churn.

### 5.6 The template's name

A template carries `nda_template_translation (template_id, locale) name, description?`, and is
authored as a content type through `saveMetaAction` and `saveTranslationsFromForm` like every other.

That name is requester-facing, which is a departure worth stating plainly, because §4.2 keeps groups
staff-side and a group carrying `nda_template_id` looks like it would give groups a public meaning
for the first time. It does not. What the requester reads is the *template's* name — "you are
accepting: Acme Mutual NDA" — never the group's. §4.4's union means they routinely face more than
one agreement at once, which is what makes naming them load-bearing rather than decorative, and the
group stays what it was: a saved scope nobody outside the admin sees.

Three surfaces need the name and none of them can use the slug — the click-through heading, the
approver's requirement list at decision time, and §5.2's blocked reason on the admin grant list.
Deriving it from the body's first heading was considered and rejected: a body with no heading would
have no name, the name would change whenever a version did, and the admin surfaces must list
templates that have no body in the current locale yet, which is precisely the state §5.2 exists to
report.

---

## 6. Acceptance

### 6.1 The record

An acceptance is a fact about a person and a template version:

```
nda_acceptance   requester_id, version_id, method, accepted_at,
                 ip, ua, typed_name, email, company, company_domain,
                 template_sha256, record_pdf_key
```

`email`, `company` and `company_domain` are **denormalized onto the acceptance at acceptance time**.
Two reasons, both discovered by review rather than by design:

- `purgeRequester` rewrites `requester.email` to `purged-{id}@invalid` and blanks `company_domain`.
  A record retaining `typed_name` while losing the email is the worst of both — it still holds
  personal data and can no longer identify the contracting party by any means the database offers.
  Either the record identifies the counterparty or it should not be retained.
- Domain-scoped validity (§6.3) resolves through `company_domain`. Purging the one colleague who
  signed would otherwise revoke coverage for everyone else at that company, while the record proving
  it still exists but is unreachable by the query.

`method` ships with a CHECK admitting only `'clickthrough'`. It widens when something can produce
another value — deliberately unlike Phase 1's `tier` CHECK, which admitted `'nda'` a phase early and
needed a clamp to stay safe.

Unique on `(requester_id, version_id)`, so a double-submit is idempotent rather than a second record.
The conflict is treated as "already accepted, proceed".

**The form carries the `version_id` and `sha256` it rendered, and the POST accepts only if that
version is still effective.** Otherwise it re-renders with "this agreement was updated — please
review before accepting" and writes nothing. Without this, a version published while somebody is
reading produces a record whose `template_sha256` pins bytes the signatory demonstrably never saw —
a hash that lies with the full authority of the record, which is worse than no hash. The
`(requester_id, version_id)` constraint gives no protection here, because it is a different version
and inserts cleanly.

Accepting requires the requester to type their full name and take an explicit accept action,
rate-limited alongside the other requester-facing endpoints.

### 6.2 No `SignatureAdapter`

Spec §6.4 lists the port and §11 puts a real implementation in Phase 7. Phase 3 does not define the
interface, because the seam that matters already exists elsewhere.

Click-through completes synchronously; e-signature completes on a webhook. But activation is already
decoupled from initiation — a grant activates when every required agreement has a matching valid
acceptance, which is a query over `nda_acceptance` and is indifferent to how a row arrived. The
click-through inserts a row and calls `activate`; a Phase 7 webhook inserts a row and calls the same
function. No `envelope_id` column ships for the same reason.

### 6.3 Person or domain

Validity is evaluated at a scope named by the `nda.acceptance_scope` setting, **defaulting to
`person`**. Under `domain`, an acceptance by anyone at the same `company_domain` satisfies the
requirement for their colleagues.

The row is always per-person — a person clicked, and that is the fact being recorded. Only
*validity* varies, and the safe default is the one where every signature names somebody.

**Domain scope applies only to domains matched by an `auto_approve` rule or named explicitly by a
rule.** Nothing in the schema distinguishes a corporate domain from `gmail.com`, and
`decideFromRules` returns `review` for an unmatched domain rather than denying it. Without the
bound, one hand-approved free-mail requester who clicks through satisfies the requirement for every
future requester at that domain — an unbounded population, activated by the §7.3 fast path with no
click-through, no record naming them, and nothing unusual in the audit log because the fast path is
the designed behaviour.

Conveyor defaults to per-domain and DACH practice expects one agreement per company, so the setting
exists. It is an operator's deliberate, informed widening, not the default.

### 6.4 Rendering the record

The record PDF is laid out from the canonical Markdown AST, via `pdf-lib` and `@pdf-lib/fontkit`
with an embedded face — regular, bold and italic, since the subset has emphasis.

`pdf-lib`'s standard fonts are WinAnsi-only, which is unacceptable for contract text: `Łukasz` and
`Şule` are not representable, and on an NDA the mangled string would be the typed name standing in
for a signature. No single bundled font covers Unicode — Noto Sans CJK alone is ~16 MB — so:

- **Bundled:** Source Sans 3 (SIL OFL 1.1) — Regular, Bold, Italic and BoldItalic, covering Latin,
  Latin Extended, Greek and Cyrillic in about 1.2 MB. Every European locale this product plausibly
  serves renders correctly. **Four faces, not three:** §5.1's subset admits bold and italic, so it
  admits them nested, and a bold-italic run with no face to draw it is a silent substitution inside
  a contract.
- **Overridable:** `NDA_PDF_FONT_PATH`, naming a TTF, defaulting to the bundled one. A deployment
  needing CJK supplies its own face. A hard wall becomes a self-hosting decision.
- **Degrading:** text beyond the loaded font's coverage degrades visibly in the *rendering*. The
  `nda_acceptance` row carries the truth and the email body carries it in UTF-8. Rejecting a name at
  the moment somebody is signing something would be an ugly thing to do to a person.

`delivery/watermark.ts` moves to the same embedded font and `toWinAnsi()` is deleted — the identical
defect one layer over, where a requester named `Šimon Čech` currently downloads a PDF stamped
`?imon ?ech`. That fix needs only the embedded font, not the layout engine.

Page count stays bounded because we author the document: the carry-over's 16,200-page measurement
applies to files we accept, not to files we write.

---

## 7. The grant lifecycle

### 7.1 Approval mints an inert grant

Staff approval is final and recorded when it is made. The grant exists immediately and is inert
until every recorded requirement is satisfied.

The alternative — holding the *request* open in a `pending_acceptance` status and minting the grant
at acceptance — was rejected because it makes `decideRequest` stop being the thing that mints grants
for NDA scopes, and puts a fourth outcome in the triage queue that is not a decision.

### 7.2 The clock starts at acceptance

`access_grant.expires_at` becomes **nullable**, and NULL means exactly one thing: *waiting on an
acceptance*.

`grantedDocuments` (`grants.ts:107`) and `mayDownload`, which delegates to it, both filter
`expires_at > now()`, and SQL's NULL comparison excludes the row. Those are the two call sites that
gate downloads, so an inert grant delivers nothing by construction rather than by remembering.

**`countGrantDocuments` does not filter expiry or revocation at all** (`grants.ts:69-83`) — it is
safe today only because its single caller pre-filters. It gains both predicates here, before §9
reuses it to tell a requester how many documents are waiting behind an acceptance.

Making `expires_at` nullable widens a type that is currently non-null in four places —
`AdminGrantRow.expiresAt`, `grantState()`'s parameter, `AdminRequesterDetail.grants[].expiresAt`,
and two Svelte call sites that would otherwise render `Invalid Date`. The plan absorbs that
explicitly rather than discovering it.

`term_days` is set at approval; acceptance computes `expires_at = now() + term_days`. Without it the
term would be re-derived from `defaultGrantDays()` at acceptance time, silently substituting whatever
the setting says *then* — and `/admin/settings/access` exists precisely so operators change it.

**The approval form takes a term in days, not an absolute date.** It currently takes a date
(`decideRequest(expiresAt: Date | null)`), which cannot survive a clock that starts later: an
approver choosing "until 31 December" would get "N days from whenever they click", landing past the
date they picked. Days is also the native unit already — `ACCESS_GRANT_DEFAULT_DAYS` and the stored
setting are both in days. The form shows the resolved date alongside the term for a grant with no
requirements, where it is knowable.

### 7.3 Two layers: frozen activation, live delivery

Requirements are recorded at approval and **frozen**, because recomputing them would retroactively
change what a grant is waiting on.

But a frozen set cannot be the only check, because scope is future-inclusive. Three paths otherwise
deliver an NDA-gated document with no acceptance and no anomaly in the audit log:

1. Approve `tiers: {request}` with no requirements. Next month a request-tier document joins a group
   carrying an agreement. The grant covers it; the frozen set is empty; `expires_at` is already set.
2. Approve `groups: {partner}` when that group carries no NDA. An operator later sets its
   `nda_template_id`.
3. Grant document D explicitly while D is `request`-tier and ungrouped. D later moves to the `nda`
   tier.

The third also reverses a guarantee Phase 2 shipped on purpose. `grants.ts:91-93` states that the
tier filter is applied at query time *"so a document moved from `request` to `nda` must stop being
downloadable immediately, without anybody remembering to revisit existing grants."* Widening that
filter without a second check would quietly delete the property that comment describes.

So there are two layers, and they answer different questions:

- **Activation** uses the frozen set. A grant activates when every requirement it recorded is
  satisfied.
- **Delivery** re-checks live, per document: a document is deliverable only if every agreement it
  *currently* requires is either satisfied by a valid acceptance or explicitly waived on that grant.

This is live evaluation, and it is consistent with the domain-drift rule, because the rule forbids
recomputation that **widens** a past decision. Narrowing-only live evaluation is already the
established pattern — it is exactly what the tier filter at `grants.ts:108-110` does. **The
invariant is a test: live evaluation may only remove documents from a grant, never add them.**

The mirror case is why both layers are needed rather than one. Because activation freezes, adding an
agreement to a document has no effect on activation for anyone holding a grant — for up to
`term_days`, ninety by default. The live delivery check is what makes an operator's protective
action take effect the same day.

### 7.4 States, activation, and deadlines

`grantState()` returns five values:

| State | Condition |
| --- | --- |
| `revoked` | `revoked_at` set — wins over everything, because a person ended it |
| `unaccepted` | `expires_at IS NULL` and `acceptance_due_at <= now()` |
| `pending_acceptance` | `expires_at IS NULL`, deadline not passed |
| `expired` | `expires_at <= now()` |
| `active` | otherwise |

`unaccepted` is distinct from `expired` on purpose: "approved but never accepted" is a different
fact from "used and lapsed", and it is a funnel signal Phase 5 will want.

**The activation predicate is stated in full, because "every grant thereby complete" is not
sufficient:**

```
expires_at      IS NULL
AND revoked_at  IS NULL
AND acceptance_due_at > now()
AND NOT EXISTS (an entry with disposition 'required' and no valid acceptance)
```

Without the deadline and revocation clauses, one acceptance resurrects the dead. A grant approved in
March and never accepted still has `expires_at IS NULL` and its requirement rows; a click-through in
September for an unrelated request would find it "complete" and set `expires_at = now() +
term_days`, making an approval that lapsed five months earlier live again with whatever scope it
carried. Revocation has the same shape: activation would write an expiry onto a revoked inert grant,
producing a row `grantState()` reports as `revoked` while carrying an active clock.

A sweep stamps `closed_at` on grants past their acceptance deadline. Correctness does not depend on
it — the predicate already excludes them — but it gives the terminal transition a row of its own
rather than a state that only exists as a clock comparison, and it is what Phase 5 will count.

`acceptance_due_at` is **stored** at approval, computed from a setting at that moment. A derived
window would *resurrect* dead grants when an operator lengthened it. The window a grant was issued
under is the window it lives by.

One nudge precedes the deadline, using a **distinct `acceptance_reminder_sent_at`**. Reusing
`expiry_reminder_sent_at` would stamp it while the grant is inert, and `sendExpiryReminders` filters
`isNull(expiryReminderSentAt)` — so access would later end with no warning, for every grant that
went through an NDA, with nothing failing and nothing logged. It is a second query in the same job
rather than a widened predicate: `sendExpiryReminders` filters `gt(expiresAt, now())`, which excludes
exactly the rows the acceptance nudge is looking for.

`request_approved` splits into two templates. Today it means "here are your documents"; under this
design it sometimes means "one step remains", and the two land the reader in different places.

### 7.5 The bypass

An approver may waive an agreement on an individual approval: the entry is recorded with
`disposition = 'waived'` rather than dropped, carrying the approver and the reason. Every product in
this category ships one — SafeBase calls it NDA bypass, Conveyor "no NDA required" — and the case it
serves is real: a counterparty who has already signed on paper.

Recording the waiver rather than omitting the row is what makes it work with §7.3's live delivery
check. An omitted requirement would be silently re-imposed at delivery, making the bypass useless; a
recorded waiver is the grant's answer to a requirement the document still carries.

It is deliberately not a rule action and not a setting. Waiving an agreement should cost somebody a
deliberate click and leave their name on it.

---

## 8. Data model

New and changed tables. Everything not listed is unchanged. **FK actions are stated explicitly**
because the house convention — cascading joins — is wrong for two of these.

```
-- 3a
access_group              id, slug, position, nda_template_id?, created_at
access_group_translation  (group_id, locale) name, description
document_group            (document_id, group_id)            cascade both

access_request_tier       (request_id, tier)     replaces access_request.all_request_tier
access_grant_tier         (grant_id, tier)       replaces access_grant.all_request_tier
access_grant_group        (grant_id, group_id)   cascade on grant, restrict on group
access_rule_tier          (rule_id, tier)        replaces access_rule.max_tier

access_grant              + term_days int not null

-- 3b
access_grant              + acceptance_due_at timestamptz?
                          + acceptance_reminder_sent_at timestamptz?
                          + closed_at timestamptz?
                          ~ expires_at now nullable

nda_template              id, slug, retired_at?, created_at
nda_template_translation  (template_id, locale) name, description?
nda_template_version      id, template_id, version, effective_from,
                          first_accepted_at?, retired_at?
nda_template_body         (version_id, locale) body_md, sha256

nda_acceptance            id, requester_id, version_id, method, accepted_at,
                          ip, ua, typed_name, email, company, company_domain,
                          template_sha256, record_pdf_key
                          unique (requester_id, version_id)
                          version_id  ON DELETE RESTRICT

access_grant_nda          (grant_id, nda_template_id) disposition, decided_by_staff_id, reason
                          disposition IN ('required','waived')
                          grant_id    ON DELETE CASCADE
                          template_id ON DELETE RESTRICT

access_grant_acceptance   (grant_id, acceptance_id)
                          acceptance_id ON DELETE RESTRICT
```

The four acceptance columns land in 3b, not 3a, for the reason Phase 2 gave for withholding
`nda_acceptance_id`: in 3a nothing can leave a grant waiting, so a nullable `expires_at` and a
deadline would be columns nothing could ever write. 3a sets `term_days` and `expires_at` together at
approval, exactly as today.

`ON DELETE RESTRICT` on the two template references is load-bearing. Under a cascade, deleting a
superseded template would remove its requirement rows and make "every recorded requirement is
satisfied" vacuously true for every grant waiting on it — a bulk unlock produced by an
administrative action that looks like tidying up, failing open and silently. Templates and versions
retire; they do not delete.

New settings: `nda.default_template_id`, `nda.acceptance_scope` (default `person`),
`nda.acceptance_due_days`.

**Migrations.** `all_request_tier = true` becomes one `access_grant_tier` row naming `request`;
`false` becomes none. `term_days` is NOT NULL and is backfilled from the whole days between
`granted_at` and `expires_at`, which is the term those grants were issued under. One CHECK enforces
the pairing §7.4 depends on: **a grant with a NULL `expires_at` must have an `acceptance_due_at`**,
or it could sit inert with no deadline, in neither `pending_acceptance` nor `unaccepted`, invisible
to every sweep.

---

## 9. Flow, end to end

1. **Request.** The public form offers `request`- and `nda`-tier documents and per-tier blankets.
   NDA-tier entries state that an agreement is required.
2. **Verify.** Unchanged from Phase 2.
3. **Rules.** `decideFromRules` returns a set of permitted tiers rather than a ceiling. The clamp at
   `rules.ts:90` has since become `honouredTiers()` over `PHASE_TIERS` (§2) and is widened rather
   than deleted, and the set it returns now **bounds the grant**: an auto-approved decision grants
   `ruleTiers ∩ requestTiers`, not the request's set alone (P3.18, §19).
4. **Decision.** Staff approve with a scope across documents, tiers and groups, and a term in days.
   The system proposes the requirement set (§4.4); the approver confirms, adds, or waives; what they
   confirmed is recorded.
5. **Acceptance.** If requirements are outstanding the grant is inert, and the requester is mailed a
   link into `/{locale}/access`. They read the current version in their locale, type their name, and
   accept. A record PDF is generated, stored, and mailed to them and to `STAFF_NOTIFICATION_EMAIL`.
   That variable is optional and unset is a valid deployment, in which case the requester's copy is
   the only mail and the operator's copy is the stored record and the portal view — "both parties"
   degrades to one, and the record never depends on mail.
6. **Activation.** The last outstanding requirement satisfied sets `expires_at = now() + term_days`
   on every grant of that requester matching §7.4's predicate in full — one acceptance can activate
   several, and none of them may be revoked, closed, or past its deadline.
7. **Download.** As Phase 2, with the tier filters widened and §7.3's live per-document check added.
8. **Lapse and revocation.** Unchanged.
9. **Return visit.** A requester holding a valid acceptance is approved and activated in one step.
   The §9.9 entry point missing since Phase 2 is built here.

---

## 10. Security and privacy

### 10.1 Auto-approval may not hand out a blanket carrying an agreement

An automatically approved decision may grant explicitly named documents at any tier, but **may not
grant a whole tier or a whole group whose proposal carries a requirement**.

Without the guard: a stranger from an allow-listed domain submits, verifies by magic link, is
auto-approved with no human involved, clicks through, and holds every NDA-tier document — including
ones published next month — for the full term. Every step is something an operator configured, and
nobody looked.

The guard does not close §7.3's gap, which is about *staff*-approved blankets. Both are needed.

### 10.2 Erasure and the acceptance record

**Lawful basis first.** Art. 17(3)(e) is an *exemption from erasure*, not a basis for the original
processing. The processing basis is Art. 6(1)(b) for the agreement itself and Art. 6(1)(f) for the
evidentiary metadata, the balancing test being that a click-through agreement is unenforceable
without proof of who accepted it, when, and from where. The 17(3)(e) exemption — establishment,
exercise or defence of legal claims — is what answers an erasure request against it.

**What survives a purge, stated exhaustively**, because an earlier draft claimed "everything else
about that person is still erased" and that was false:

- `typed_name`, `email`, `company`, `company_domain`, `ip`, `ua`, `accepted_at`, `template_sha256`.
  The identity fields are the counterparty; the metadata is what makes the signature enforceable.
  Pseudonymising them leaves a record saying somebody once typed a name, which is the same as not
  keeping it. The ground that justifies retaining the signature justifies retaining what proves it.
- `audit_event` is pseudonymised exactly as spec §10 requires. **This exception is confined to one
  domain table and does not touch the audit log.**

**What the purge must now also do**, neither of which it does today:

- **Blank `outbound_email.payload` alongside `to`.** `purgeRequester` blanks only `to`; payloads are
  cleared by `redactDeliveredMail` after `mailRetentionDays`, which is an unrelated window. This
  phase adds the highest-value payload in the system to that gap.
- **Delete the `record_pdf_key` object.** It names the person in full and in richer form than any
  column, and storage is untouched by the purge today. `record_pdf_key` is nulled in the same
  transaction, so no column names an object that is gone. The row survives with its fields; the
  rendering does not, and regenerating it from the row remains possible if it is ever needed.

**The disclosure is system chrome, not template text.** An earlier draft put "this record outlives an
erasure request" in the click-through text — which is the *operator's* Markdown body. An operator
authoring their own NDA will not include it, and nothing would check, so the guarantee would
evaporate for every deployment but ours. It renders above the accept button, from the message
catalog, outside the body, versioned with the application and not authorable.

### 10.3 Placement

The click-through, the record view, and everything requester-facing live under `/{locale}/access` —
the only path the requester cookie is scoped to. Anywhere else the request arrives anonymous,
exactly as Task 12 found for downloads.

The requester can view their own acceptance record in the portal, not only in email.

### 10.4 Unchanged guarantees

The public portal still sets no cookies and makes no third-party requests. Milkdown, `pdfjs-dist`
and `mammoth` are bundled into the **admin** entry point and never loaded by a public route.
Requester personal data still appears in `audit_event` only in `ip`, `ua` and `actor_id`.

---

## 11. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| P3.1 | Approval mints an inert grant; the clock starts at acceptance | The approval is a decision and is recorded when made; a prospect who takes a week to read an NDA should not lose a week of access |
| P3.2 | `expires_at IS NULL` means "waiting on acceptance" | The two call sites gating downloads already exclude NULL; the alternative would need a hand-maintained filter |
| P3.3 | `term_days`, `acceptance_due_at` and the requirement set are stored, not derived | A live setting would rewrite terms; a derived deadline would resurrect dead grants |
| P3.4 | Tiers stay an enum; cohorts become `access_group` rows | Fusing them forces a row per combination and would refactor every security-relevant tier literal |
| P3.5 | Scope is sets of documents, tiers and groups — never a ceiling | A ceiling recomputes, retroactively widening live grants when a tier is inserted |
| P3.6 | Groups are document bundles, not people cohorts | A grant already carries an explicit document list; a people axis would duplicate it |
| P3.7 | A version spans every enabled locale, published together | Otherwise "the current NDA" names different obligations per browser language |
| P3.8 | Templates import into one canonical Markdown body; no stored blobs | Uniform, diffable, hashable, accessible, and layout stays under our control |
| P3.9 | **The approver records the requirement set; the system proposes it** | Resolving from the document graph attaches the agreement to the document when it varies by counterparty, and makes customer-specific NDAs impossible without duplicating documents |
| P3.10 | **Activation freezes; delivery re-checks live, narrowing only** | Freezing alone fails open over future-inclusive scope; live alone would retroactively change what a grant waits on |
| P3.11 | No `SignatureAdapter` and no `envelope_id` | Activation is already decoupled from initiation |
| P3.12 | Acceptance rows are per-person; validity scope is a bounded setting defaulting to `person` | A person clicked, and that is the fact; unbounded domain scope is a free-mail hole |
| P3.13 | An embedded Unicode font, operator-overridable | WinAnsi cannot render a European name, and no bundled font covers Unicode |
| P3.14 | Auto-approval may not grant a blanket carrying a requirement | The broadest grant in the system requires a person |
| P3.15 | The acceptance survives erasure with its identity fields; the record PDF does not | Art. 6(1)(b)/(f) with the 17(3)(e) exemption; a record that cannot name the counterparty is not evidence, and the rendering adds nothing the row lacks |
| P3.16 | Templates and versions retire; the FKs restrict | Under the cascading convention, deleting a template would be a silent bulk unlock |
| P3.17 | The erasure disclosure is system chrome, outside the template body | Anything inside the operator's Markdown is absent from every deployment but ours |
| P3.18 | **A rule's tier set bounds its auto-approval: the grant gets `ruleTiers ∩ requestTiers`** | Computing a permitted set and then ignoring it means a rule permitting nothing still hands out a blanket |
| P3.19 | Templates carry a translated name; groups still have no public surface | A signatory facing two required agreements must tell them apart, and the name they read is the instrument's, not the bundle's |
| P3.20 | Source Sans 3, four faces, `NDA_PDF_FONT_PATH` overriding | OFL, covers every locale this product serves, and the subset admits nested emphasis |

---

## 12. Deviations from the main spec

1. **§8's flat `nda_template(version, locale, body_md | file_key, effective_from)` becomes three
   tables** — family, version, body. Forced by per-group agreements: with more than one instrument,
   "which agreement" and "which version of it" are different questions.
2. **`file_key` is not built.** Every authoring path imports into the canonical body — P3.8.
3. **`access_grant.nda_acceptance_id` is two join tables, not a column.** A grant may require several
   agreements, and a waiver must be recorded rather than omitted.
4. **`nda_acceptance.envelope_id` is not built** — P3.11.
5. **Auto-approval rules shipped in Phase 2,** not here.
6. **Phase 3 splits into 3a, 3b and 3c.** §11's numbering is otherwise unchanged.

---

## 13. Dependencies

**3a:** none.

**3b:** `@pdf-lib/fontkit`; a bundled TTF family (Latin / Latin Extended / Greek / Cyrillic, under a
licence permitting redistribution); a Markdown parser producing an AST.

`remark-parse` / mdast is preferred because Milkdown normalises through remark in 3c, and a shared
AST keeps the subset validator, the HTML renderer, the PDF layout and the editor agreeing rather
than approximately agreeing.

**3b also changes the mail port.** `OutgoingMail` is `{to, from, subject, text}` and `renderTemplate`
returns `{subject, text}`; mailing a record PDF needs attachments through the adapter, the queue
row's payload contract, the drain loop, and the Mailpit assertions. It is small, but it is a port
change and it was missed on the first pass.

**3c:** `pdfjs-dist`, `mammoth`, `@milkdown/*`. Admin bundle only.

---

## 14. Testing

Phase 2's strategy carries forward unchanged. Additions:

**Unit.** The restricted-subset validator. The requirement *proposal* per §4.4, including the union
across several groups, the default template added rather than replaced, and the fail-closed case of
an `nda`-tier document with no default template. `grantState()` across all five values. The
activation predicate, with explicit negative cases for a revoked grant, a closed grant, and one past
its acceptance deadline. The auto-approval blanket guard. Domain-scope bounding on an unmatched
free-mail domain.

**Integration.** **Live delivery evaluation may only narrow** — a document that gains an agreement
after approval stops being deliverable; one that loses its tier stops being deliverable; nothing a
grant did not cover ever becomes deliverable. A recorded waiver survives the live check. Deleting a
referenced template is refused, and a grant waiting on a retired template does not activate. A
version refusing to become effective with a locale missing. Immutability after `first_accepted_at`.
The render→POST version race writing no record. `(requester_id, version_id)` conflict idempotence.
`purgeRequester` leaving the acceptance identity fields intact while blanking `outbound_email.payload`
and deleting the record object — the existing `tests/integration/purge.test.ts` has five cases and
none would catch either.

**End-to-end.** The full NDA journey — request an NDA-tier document, verify, approve, land on the
inert grant, accept, download — and the fast path, where a second request by a requester already
holding a current acceptance activates without a second click-through.

**Security.** The existing assertion that no gated file id reaches public HTML extends to the NDA
tier; the public portal still sets no cookies with the NDA routes present.

An **end-to-end test of the admin file upload** is folded into 3b. It predates this phase and is the
one gap where a page-count cap and a size cap are unit-tested but the route applying them has never
been driven by a browser — and 3c adds a second upload route, which would otherwise inherit it.

---

## 15. Carry-over folded in

| Item | Where |
| --- | --- |
| No end-to-end test covers the admin file upload | 3b |
| The return-visit fast path has no entry point (spec §9.9) | 3b |
| `toWinAnsi()` mangles non-WinAnsi names in watermarks | 3b (§6.4) |
| `saveTranslationAction` (singular) unused for three phases | 3b (§19) |
| Duplicate-slug creation 500s; the group routes catch `23503` but not `23505` | 3b (§19) |

Deliberately **not** folded in, because they touch unrelated code and folding them is how a phase
quietly doubles: the e2e suite starting two application servers against one database; requester
retention being manual only; invite-driven requests being modelled but unreachable;
`document_file.page_count` still unstored.

---

## 16. Known risks

Named rather than solved, so the plan can budget for them.

- **The Markdown-AST→PDF layout engine is the largest single unknown.** Wrapping, list indentation,
  page breaks that do not orphan a heading, emphasis runs mid-paragraph, three faces. §6.4 discusses
  font coverage at length and layout not at all. Budget two to three tasks and expect the first
  defect to be a nested list crossing a page boundary.
- **`access_group` is the fourth content type, and the carry-over says explicitly not to assume the
  Task 1 helper generalises** — *"The next content type is the test that matters, and there is not
  one yet."* Groups are that test. Budget for the helper not fitting rather than being surprised.
- **The NDA e2e journey is the longest chain in the suite**, across two entry points and a job
  runner, on a suite with four hydration-race sightings across three phases. The carry-over's lesson
  — *"an e2e step that interacts before hydration does not fail, it lies"* — applies hardest to the
  accept button, where a lost interaction produces a **passing** test over a missing record.

---

## 17. Deferred

- A real `SignatureAdapter` implementation and the `esign` method — Phase 7.
- Per-download re-acceptance of a document-specific agreement, which Conveyor supports.
- People-cohort access groups. A membership axis arrives if and when invite-driven requests become
  reachable.
- An acceptance expiring on its own. It is valid until a new version supersedes it.
- An explicit "this group's agreement supersedes the default" flag. §4.4 takes the union; if an
  operator genuinely needs supersession it becomes a boolean somebody sets deliberately.

---

## 18. What the adversarial review changed

The first draft was reviewed adversarially before planning. Two findings were fatal:

- **The union rule made customer-specific NDAs impossible** — the use case §1 promises. Requirements
  now attach to the decision (P3.9, §4.4).
- **Freezing requirements over future-inclusive scope failed open**, in three separate paths, and
  silently deleted the immediate-retiering guarantee `grants.ts:91-93` describes. Delivery now
  re-checks live, narrowing only (P3.10, §7.3).

Five more were real and local: activation resurrecting dead grants (§7.4); `ON DELETE CASCADE`
making template deletion a bulk unlock (§5.3, §8); the render→POST version race (§6.1); unbounded
domain scope on free-mail domains (§6.3); and §10.2 claiming an erasure completeness that the code
does not provide.

Several smaller corrections: `countGrantDocuments` has no expiry filter, so the fail-closed claim was
overstated (§7.2); reusing `expiry_reminder_sent_at` would have silently disabled expiry reminders
(§7.4); the approval form's absolute date contradicts a clock that starts later (§7.2); §4.4's
`else` chain let a filing action remove the default agreement (§4.4); the mail port has no attachment
support (§13); and the preview was scheduled a phase after the thing it protects (§3).

The phase was also re-cut from two parts to three, moving the scope refactor out of the phase that
produces legally operative records — the same argument that justified the original split, applied
more honestly.

---

## 19. What Phase 3a's carry-over changed

Phase 3a landed on `main` at `b719a06`. Its carry-over
(`docs/superpowers/phase-3b-carryover.md`) raised five things this spec had not settled. Four are
amendments above; the fifth is a question this section closes.

**`RuleDecision.tiers` was computed and never read** (P3.18). `verify.ts` used only
`decision.action` and `decision.ruleId` and took the grant's tiers from the *request's* set, so a
rule's tier set bounded nothing — a requester who ticked the request-tier blanket got it even from a
rule whose set was empty. This is pre-existing, `decision.maxTier` having been equally unread, and
it stayed harmless only while `honouredTiers` stripped `nda` on both paths. It goes live the moment
`PHASE_TIERS` widens, which is this phase. The grant now takes the intersection.

**No migration is needed for pre-existing `nda` entries**, and the carry-over's warning that one
might be — it called this the sharpest edge in the handoff — is answered here rather than deferred.
Grants and requests already store `honouredTiers`-filtered sets, so `access_rule_tier` is the only
place `nda` can sit when this phase begins. Under P3.18 such a rule can only ever contribute to an
auto-approved *blanket*, and §10.1 forbids that outright: an `nda`-tier document always carries at
least the default template, so its proposal always carries a requirement. The guard this phase
builds anyway is the control, and nothing widens silently on deploy.

**Templates needed a name** (P3.19, §5.6). §8 gave `nda_template` a slug and nothing else, while
three surfaces have to name the instrument and one of them is the click-through itself.

**The font needed choosing** (P3.20, §6.4). §6.4 stated the properties at length and named no face.

**Two carry-over items fold in** (§15). `saveTranslationAction` is deleted — unused for three
phases, routed around twice, and this is the phase that touches translations. Duplicate-slug
creation gets a shared unique-violation to field-error path across every slugged content type;
that one is scoped by an asymmetry 3a introduced rather than by tidiness, since the group routes
now catch `23503` and not `23505`, and `nda_template` adds a sixth slugged type to a codebase where
typing an existing slug returns a 500.

**Phase 3b remains one plan and one branch**, at roughly twenty tasks. 3a's carry-over asks that any
decomposition be justified by the diff it produces rather than by a rollback nobody performs, and
the seams available here — instrument, record, gate — each ship something only the next one makes
reachable, which is the arrangement Phase 2's rule against shipping unreachable code refuses.
