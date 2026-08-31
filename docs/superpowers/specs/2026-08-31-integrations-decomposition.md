# Integrations — Decomposition and Scoping Note

**Date:** 2026-08-31
**Status:** Scoping note. **Not an approved design.** Each subsystem below needs its own design
document before it is planned; §9 records what each of those must still settle.
**Author:** Moritz Friedrich (CISO, Matchory), with Claude

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

## 6. Open decision: the outbound payload

**Unresolved. A cannot be planned until this is settled, because it decides whether D is a
prerequisite.**

§6.6 confines requester personal data in `audit_event` to `ip`, `ua` and `actor_id`, which is what
makes the erasure path in §10 expressible as a trigger. But a useful Teams card reads "someone at
acme.example requested the SOC 2 report" — a name, a company, an address, none of which are in the
audit row. Enriching from domain tables reintroduces the problem the schema was shaped to avoid: once
an address is in an n8n execution history, erasure cannot reach it — and the product's "erasure on
request" claim, stated without qualification in the README and mechanised as a column-scoped purge in
§10, acquires an asterisk.

| Option | Consequence |
| --- | --- |
| **Identifiers only; the consumer calls back** through D's read API | Erasure stays authoritative — after a purge the callback returns blanked data. Consistent with the thesis. Makes D a prerequisite for a *useful* A. |
| **Enriched payloads, documented boundary** | Immediately useful with no callback. Honest only if the documentation states that erasure stops at the egress edge, which weakens a claim §1 currently makes without qualification. |

A per-subscription toggle is available and should be resisted: it makes the erasure story "it
depends," which is worse than either answer.

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

Serves Matchory's own requirement: access requests to Teams, and to n8n, which updates HubSpot.

Must settle: the payload question (§6); the subscription model and event filtering; secret storage
and signature scheme; retry and failure policy, including when a subscription is disabled; whether
Teams gets a first-party Adaptive Card formatter or is expected to sit behind n8n.

### B — Audit sink

Nearly free once A's spine exists, and evidentially the strongest item here: an auditor asking
whether someone with database access could have removed a row gets a materially better answer when
events are shipped continuously to object-locked storage the application holds no credentials to
rewrite.

Must settle: which protocols ship first (S3 with object lock, OTLP-logs, syslog/CEF); batch sizing
and cursor durability; what happens when the sink is unreachable for a long period.

### C — OTel egress

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
