# Integrations — Decomposition and Scoping Note

**Date:** 2026-08-31
**Status:** Scoping note. **Not an approved design.** Each subsystem below needs its own design
document before it is planned; §9 records what each of those must still settle.
**Author:** Moritz Friedrich (CISO, Matchory), with Claude

**Amended 2026-09-02.** Section 6 is settled: enriched payloads, with the erasure boundary at the
egress edge, and the enrichment performed at delivery so no payload is ever at rest. Sections 9 A and
9 D record the consequence — D is no longer a prerequisite for a useful A. No other section changed.

This note exists because integrations were never designed as a subsystem. They are not absent from
`2026-08-28-trust-center-design.md` — they are scattered through it as feature bullets in five
different phases, which is how five ad-hoc implementations get built:

| Where | What it promises |
| --- | --- |
| D4, §6.4 | `SignatureAdapter` as one of the four ports |
| §6.2 | `api/` is "deliberately thin: e-signature webhooks and document download streaming only" |
| §11 Phase 4 | "outbound webhooks for Slack and Teams" |
| §11 Phase 5 | CSV export and per-company access reports |
| §11.2 | CRM (HubSpot, Salesforce, Pipedrive); importers from Vanta, Drata, Comp AI; uptime signals; SAML and SCIM |

The gap is an integration *architecture*: no outbound event surface, no inbound API, no credential
model, no delivery semantics, and no way for a self-hoster to add an integration without forking.

---

## 1. What the market offers

Surveyed 2026-08-31 across the incumbents named in §3 of the main design.

| Category | What it does | Who |
| --- | --- | --- |
| **CRM** | Bidirectional. Out: security-review activity on the opportunity record, pipeline/ARR attribution. In: auto-approve on deal stage or amount, NDA bypass when an MSA exists, lead creation from an access request. | SafeBase (Salesforce + HubSpot), Conveyor, Vanta, Orbiq |
| **Chat ops** | Access requests into a channel with inline approve/reject, invites by slash command, activity digests | SafeBase, Conveyor, Vanta |
| **E-signature** | DocuSign, Dropbox Sign, where click-through is not enough | SafeBase, most |
| **Ticketing** | Jira, for review and questionnaire tasks | SafeBase, Whistic |
| **Data warehouse** | Snowflake, BigQuery, Databricks, S3 — no-code activity sync | SafeBase |
| **Upstream content** | Sync controls from an ISMS; SharePoint, Drive, Confluence as document sources | Orbiq, Vanta, Drata |
| **TPRM exchanges** | Publish a profile into buyer-side networks and marketplaces | Whistic Trust Center Exchange, SecurityScorecard |
| **Public API** | Analytics API and Portal API for automating access | Conveyor |
| **Identity** | SAML and SCIM for staff | Enterprise tiers broadly |

Two observations shaped everything below. **CRM is the headline everywhere**, and the direction that
changes the workflow is the inbound one — auto-approval driven by deal state, not activity reporting.
And **Conveyor is the only incumbent shipping a real API** rather than only bespoke connectors.

Sources: [SafeBase integrations](https://safebase.io/integrations),
[SafeBase Salesforce](https://safebase.io/products/integrations/salesforce),
[Conveyor integrations](https://www.conveyor.com/integrations),
[Conveyor Salesforce](https://docs.conveyor.com/docs/salesforce-1),
[Conveyor Slack](https://docs.conveyor.com/docs/slack),
[Vanta Trust Center](https://www.vanta.com/products/trust-center),
[Whistic Profile](https://www.whistic.com/whistic-profile),
[Orbiq](https://www.orbiqhq.com/platform/trust-center-platform).

---

## 2. The constraint that shapes our answer

**Self-hosting inverts the build-versus-expose calculus.** A SaaS vendor builds N bespoke connectors
because it owns the runtime and cannot let customers run code. Our operator already runs a container
and can already run n8n, Windmill, or a cron job beside it. Every connector built into the
application is one the operator could have built themselves, and one we maintain forever.

**Sovereignty turns that from a cost into a thesis problem.** §3.5 sells "no third-party requests"
and EU sovereignty *by construction*. An application holding a Salesforce OAuth token and calling
`*.salesforce.com` on every access decision has quietly reintroduced exactly the CLOUD Act exposure
§3.2 calls a disqualifying procurement criterion. Glue running in the operator's own tenancy has not:
the egress is theirs, disclosed on their subprocessor list, not ours.

**Therefore: a narrow surface, not a catalogue.** The following are explicitly *not* planned as
in-application connectors — they fall out of the surface for free, or belong to a different product:

- CRM connectors (HubSpot, Salesforce, Pipedrive) — an event out, a fact in, and the operator's own
  automation between them. This supersedes the §11.2 deferral, which assumed bespoke connectors.
- Data-warehouse sync — subsumed by the audit sink (B below).
- Jira and other ticketing — a webhook consumer.
- TPRM exchange publishing — another product's distribution channel.

---

## 3. Findings from the code

Established 2026-08-31 against `de0ffea`.

- **`STAFF_NOTIFICATION_EMAIL` already exists.** New-request triage notices render the
  `staff_new_request` template to one configured address. Pointing it at a Teams channel address or a
  distribution list satisfies the "forward access requests to mail" requirement with no work.
- **`audit_event.request_id` exists and nothing populates it.** A correlation column with no writer.
  Separately, `handleError` mints a `crypto.randomUUID()` correlation id that reaches the log line and
  nothing else. Together these are a ready-made seam for trace correlation (C below).
- **`src/lib/server` makes no outbound HTTP requests.** SMTP is the only egress. Every subsystem here
  except SCIM makes the application an HTTP client for the first time, which is a new security
  boundary rather than only a new feature (§7).

---

## 4. The decomposition

Five subsystems. They are not one spec, and only two of them share code.

| | Subsystem | Source | Delivery semantics |
| --- | --- | --- | --- |
| **A** | **Event egress** — business events out: Teams, n8n, generic webhook | `audit_event` plus enrichment | At-least-once, retried, low-latency, per-subscription filtering |
| **B** | **Audit sink** — the compliance record shipped off-box: S3/WORM, syslog, OTLP-logs | `audit_event` verbatim | Bulk, ordered, resumable, unfiltered |
| **C** | **OTel egress** — operator telemetry: traces, metrics, logs | Runtime instrumentation | Lossy, sampled, high-volume |
| **D** | **Inbound API** — scoped tokens: read activity, assert facts that drive decisions | HTTP in | Request/response |
| **E** | **SCIM** — staff provisioning and deprovisioning | HTTP in | Spec-defined |

**A and B share a spine (§5). C, D and E share nothing with them.** C is not an integration
subsystem at all — it is a cross-cutting concern configured by environment variables, with no tables
and no state.

---

## 5. The spine A and B share

> **Corrected 2026-09-03, after implementing A.** The claim below that "a consumer is a cursor
> holding one bigint — no deduplication, no ordering problem" is **false**, and B would inherit the
> defect. `seq` is assigned by `nextval()` when `recordEvent` runs, but a row becomes visible at
> COMMIT, and `recordEvent` is called last in a transaction — so a slow transaction commits a *lower*
> `seq` after a fast one that started later. A `seq` high-watermark therefore silently drops events,
> and cannot be repaired by advancing to "lowest excluded seq − 1": the mirror case, where the
> blocking row is invisible and no visible row is excluded, is indistinguishable from the permanent
> gaps that rollbacks and sequence caching leave behind. The cursor is a composite keyset over
> `(xmin, seq)`. See `2026-09-03-event-egress-design.md` §5.2 **and** that plan's correction C1 — the
> spec's own first fix was also insufficient, so C1 is the authority, not §5.2 alone.
>
> Deduplication does not disappear either: at-least-once delivery plus render-at-delivery means a
> consumer must deduplicate on the delivery id, because retries are not byte-identical.

`audit_event` is already a durable log: append-only enforced by triggers (`drizzle/0003`,
`drizzle/0004`), with a monotonic `seq`. A consumer is therefore *a cursor holding one bigint*. No
deduplication, no ordering problem, no compaction.

Both A and B reduce to "tail `seq` from position N, do something, advance." Retry and at-least-once
are solved once, on the existing `JobRunner` with its advisory lock, which already makes multi-replica
safe. The two differ only in tick interval and in what they do per batch — a Teams notice fifteen
minutes late is a defect; an S3 batch does not care.

This is §6.6's governing rule paying off: *domain tables hold state, `audit_event` holds occurrences,
and analytics is a read model over it.* Integration egress is another read model over the same log.

---

## 6. Settled: the outbound payload

**Resolved 2026-09-02. Enriched payloads, enriched at delivery. A no longer depends on D.**

### The question as it stood

§6.6 confines requester personal data in `audit_event` to `ip`, `ua` and `actor_id`, which is what
makes the erasure path in §10 expressible as a trigger. But a useful Teams card reads "someone at
acme.example requested the SOC 2 report" — a name, a company, an address, none of which are in the
audit row. Enriching from domain tables looked like it reintroduced the problem the schema was shaped
to avoid: once an address is in an n8n execution history, erasure cannot reach it.

| Option | Consequence as originally weighed |
| --- | --- |
| **Identifiers only; the consumer calls back** through D's read API | Erasure stays authoritative — after a purge the callback returns blanked data. Makes D a prerequisite for a *useful* A. |
| **Enriched payloads, documented boundary** | Immediately useful with no callback. Held to require qualifying a claim §1 makes without one. |

### What the question got wrong

**This note was applying two different principles to the same n8n.** §2 refuses to build CRM
connectors precisely because operator-run glue is the operator's own exposure — "the egress is
theirs, disclosed on their subprocessor list, not ours." §6 then treated that same glue as breaking
*our* erasure claim. Both cannot govern. The operator's n8n is their processor, and their Art. 17
obligation reaches its execution history exactly as it reaches the HubSpot record that execution
wrote. Our claim is about what we hold and what we control, and it remains true unqualified.

**Identifiers-only bought less than it appeared to.** If the operator's automation writes the
requester into HubSpot, the personal data is in HubSpot under either option — the consumer merely
calls back for the name first. What identifiers-only actually buys is narrower: that our payload is
not a permanent copy, and that anything re-reading after a purge sees blanks. the rule below obtains the second
of those without the callback, and without making A wait on D.

### The rule that replaces it

**Nothing is ever at rest.** A tails `audit_event` by `seq` and renders each payload at delivery from
live domain state, exactly as §5 describes the spine — a consumer is a cursor holding one bigint. No
outbox row holds a rendered payload.

This is the whole of the erasure story, and it is structural rather than maintained. `purgeRequester`
needs no new path: a purge landing before delivery means the card renders blank, which is the correct
outcome and not a special case. The alternative — enriching at queue time, as the mail queue does —
would make `outbound_email`'s purge path (which matches on `to`) the first of two such paths rather
than the only one, and that is the kind of path that rots silently when somebody adds a field.

Two costs, both accepted. A delayed delivery reflects current state rather than state at event time,
which for "someone requested X" is right rather than merely tolerable. And a retried delivery is not
byte-identical, which rules out signing a stored payload once and replaying it.

A per-subscription enrichment toggle stays resisted — no longer because it would make the erasure
story "it depends", but because it is surface with nothing left to buy.

### What must still be written down, and where

The boundary statement — that egress leaves our erasure mechanism and enters the operator's own
obligation — belongs in A's design document and in `docs/self-hosting.md` when A ships.

It does **not** belong as a qualification on the README's erasure bullet. That claim is accurate for
what the application holds; bolting an asterisk onto a true statement to describe someone else's
processor makes it read as weaker than it is.

---

## 7. Egress is a new security boundary

"The application makes no outbound HTTP requests" is true today (§3) and worth defending
deliberately rather than losing by accident.

Operator-configurable webhook URLs are server-side request forgery by construction. The feature is
admin-only, which bounds but does not remove it. Minimum for A: do not follow redirects, and enforce
a configurable destination denylist covering link-local and private ranges. The same applies to any
URL-valued setting B accepts.

---

## 8. Why the roadmap gets simpler, not larger

- §11 Phase 4's "outbound webhooks for Slack and Teams" stops being two connectors and becomes two
  *consumers* of A.
- §11 Phase 5's CSV export becomes one endpoint of D.
- §11.2's CRM integrations are withdrawn as connectors and satisfied by A plus D (§2).
- §6.4's four ports are unaffected. `SignatureAdapter`, `StorageAdapter` and `MailAdapter` are
  synchronous and sit inside the request path; they cannot be webhooks, and that boundary is already
  correct.

---

## 9. Per-subsystem notes, and what each spec must still settle

### A — Event egress

> **Governed by `2026-09-03-event-egress-design.md`, which supersedes this note for A.** Everything
> under "must settle" below is settled there; where the two differ, that document and its plan's
> corrections C1–C5 are authoritative.

Serves Matchory's own requirement: access requests to Teams, and to n8n, which updates HubSpot.

The payload question is settled (§6): enriched, rendered at delivery from live domain state, nothing
at rest. A is therefore plannable now, and does not wait on D.

Must settle: the subscription model and event filtering; secret storage and signature scheme; retry
and failure policy, including when a subscription is disabled; whether Teams gets a first-party
Adaptive Card formatter or is expected to sit behind n8n. Note that §6 rules out signing a stored
payload once and replaying it, so the signature scheme must sign what is rendered at delivery.

### B — Audit sink

Nearly free once A's spine exists, and evidentially the strongest item here: an auditor asking
whether someone with database access could have removed a row gets a materially better answer when
events are shipped continuously to object-locked storage the application holds no credentials to
rewrite.

Must settle: which protocols ship first (S3 with object lock, OTLP-logs, syslog/CEF); batch sizing
and cursor durability; what happens when the sink is unreachable for a long period.

### C — OTel egress

**Designed 2026-09-02 in `2026-09-02-otel-egress-design.md`, which governs C where the two differ.**
That document supersedes two claims below: the `pg` gotcha names a driver this project does not use
(it is postgres-js, for which no maintained instrumentation exists), and `@opentelemetry/sdk-node`
with auto-instrumentation is rejected in favour of manual spans. The rest of this section stands.

Cheapest piece, independent of the rest, and the only one that makes the other four debuggable in
production — an argument for shipping it early rather than last.

`@opentelemetry/sdk-node` with an OTLP exporter, inert unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set —
the same opt-in shape as `SMTP_URL`. Populating `audit_event.request_id` with the trace id makes "who
downloaded this" and "why was that request slow" the same query.

This does not contradict §3.5. That claim concerns the public portal making no *browser-side*
third-party requests and setting no cookies. Server-side, operator-configured, off-by-default egress
to the operator's own collector is the same shape as SMTP, and belongs on their subprocessor list
rather than ours.

Two gotchas that are requirements, not notes:

- **`pg` auto-instrumentation must not capture statement parameters.** That would ship requester
  addresses into a monitoring platform, which is a different trust boundary from the database.
- **Spans carry `http.route`, not `http.target`** — the same discipline that makes `handleError`
  refuse to log `error.cause`.

Must settle: which signals ship (traces, metrics, logs, or a subset); the metric set worth exporting;
sampling defaults.

### D — Inbound API

Scoped tokens. Two capabilities: read activity (subsuming Phase 5's CSV export), and assert facts
about a company that the Phase 2 rules engine consumes — which is how CRM-driven auto-approval works
with no egress from the application at all.

**Prerequisite:** the company-cohort axis. `access_group` is a bundle of *documents*, not of people;
§17 of `2026-08-30-phase-3-nda-workflow-design.md` defers people-cohort groups explicitly
("a membership axis arrives if and when invite-driven requests become reachable"). D needs that axis
to exist.

Strictly, the *assert-facts* half needs it — that is the half the rules engine consumes, and the half
that reasons about people. The read-activity half is keyed by request and requester and needs no
cohort. Recorded because §6 no longer forces the split: with A independent of D, there is nothing
left waiting on the read half, and splitting D on this seam should be a decision D's own design makes
on its merits rather than one inherited from A's sequencing.

Must settle: token scoping model and storage; **a new `AuditActor` variant** — an API token that
causes a grant is neither `staff`, `requester` nor `system`, and attributing it to `system` would make
"who approved this" unanswerable in precisely the case an auditor cares about. Audit action names are
permanent once written (see the Phase 2 carry-over on `translationAction`), so this must be decided
before the first row is written, not after.

### E — SCIM

Last, as intended. Worth recording *why* it earns its place, because it is not provisioning
convenience.

§6.3 states that roles are re-evaluated on every login "so IdP offboarding takes effect immediately."
That is not quite true: a live session survives offboarding until it expires, because nothing
re-checks between logins. SCIM `DELETE` is what makes revocation actually immediate. That is the
argument.

Must settle: the interaction with just-in-time provisioning, which currently owns staff user
creation and role assignment, and which SCIM partially duplicates.

---

## 10. Proposed sequencing

**C → A → B → D → E.**

C first because it is independent, cheap, and makes the rest observable in production. A next because
it is what the sales side is waiting on. B nearly free on A's spine. D once the cohort axis exists.
E last.

C and A are independently reachable and each carries one reviewable theme, in the sense §11 uses.
