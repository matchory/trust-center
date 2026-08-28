# Open Trust Center — Design

**Date:** 2026-08-28
**Status:** Approved for planning
**Author:** Moritz Friedrich (CISO, Matchory), with Claude

**Amended 2026-08-28 (Phase 1 planning):** Section 7 now states the two-layer locale contract, and
Section 10 defines the one permitted exception to the append-only audit log. Both resolve
contradictions carried over from Phase 0; no other section changed.

---

## 1. Summary

An open-source, self-hostable **Trust Center**: the buyer-facing proof layer that publishes a
company's security, privacy, and compliance posture, gates sensitive documents behind approval and
NDA, and records who accessed what and when.

Built with SvelteKit and Postgres, deployed as a single container. First-class DE/EN content, EU
data sovereignty by construction, no third-party trackers.

It replaces the email threads, ad-hoc PDF exchanges, and repeated questionnaire answering that
currently sit between an enterprise prospect and a signed contract.

---

## 2. Context and motivation

Matchory sells to enterprise customers in the DACH region. Compliance, security, and privacy are
primary purchasing criteria there, which is why the company invested early in GDPR compliance and
ISO 27001 certification.

The consequence is administrative: every deal drags a long tail of document requests, Excel
security questionnaires, and signed PDF exchanges across an expanding set of email threads. The
work is repetitive, hard to audit, and slow — and it happens at exactly the point in the sales
cycle where friction is most expensive.

Commercial Trust Center products solve this, but are priced far above the complexity of the
problem. This project builds an open alternative, with Matchory as customer zero.

---

## 3. Market analysis

### 3.1 The two categories

The market conflates two distinct products:

| | Compliance automation (GRC) | Trust Center (proof layer) |
|---|---|---|
| Purpose | Evidence collection, control monitoring, policy management, audit prep | Publish posture to buyers, gate documents, handle access and questionnaires |
| Vendors | Vanta, Drata, Secureframe, Sprinto, Thoropass | SafeBase, Conveyor, Orbiq, and bundled add-ons from Vanta/Drata |
| Entry price | approx. USD 7,500–15,000/yr; enterprise contracts USD 100k+ | approx. USD 8,000–20,000+/yr (SafeBase); Orbiq from EUR 299/month |

This project targets the **Trust Center** category only.

### 3.2 Market dynamics

- **Consolidation.** Drata acquired SafeBase for USD 250M in February 2025. The best-in-class
  standalone Trust Center now sits inside a GRC suite, and standalone options are contracting.
- **EU-native entrant.** Orbiq (Hamburg) is the closest competitive reference: EU data residency by
  default, up to 15 published languages, NIS2 and DORA as first-class frameworks, published
  pricing.
- **Regulatory tailwind.** NIS2 (Directive 2022/2555, Art. 21) makes supply-chain security a
  management obligation; DORA (Regulation 2022/2554, Art. 28–30) requires financial entities to
  maintain a register of ICT providers. Both drive buyer-side questionnaire volume onto vendors.
- **Sovereignty as a gate.** EU data residency has moved from preference to disqualifying
  criterion. US incorporation implies CLOUD Act exposure irrespective of where data physically
  resides, which makes vendor jurisdiction a binary procurement filter in regulated sectors.
- **DACH document conventions.** German-speaking legal teams request the AVV
  (Auftragsverarbeitungsvertrag), the TOMs (technische und organisatorische Maßnahmen, GDPR Art.
  32), and the subprocessor list first, every time. Publishing these without a registration wall
  removes the most common early-stage obstacle.

### 3.3 Feature baseline of a complete Trust Center

Synthesized from SafeBase-powered production instances and vendor build guides:

1. Compliance badges with scope and validity dates
2. Tiered document library — public, request-gated, NDA-gated — with versioning, expiry, and
   watermarking
3. Controls catalog grouped by category (product, data, application, access, infrastructure,
   corporate, legal)
4. Subprocessor list with region, purpose, and change notification
5. Knowledge base / FAQ (vendors claim approx. 40% inbound questionnaire deflection)
6. Access request, NDA workflow, approval, and audit trail
7. Updates/changelog feed with email subscriptions
8. Analytics attributing document access back to companies and deals
9. Live operational signals (uptime, security grades, CVE handling)
10. Questionnaire answering against standard frameworks (SIG Lite, CAIQ, VSA)

### 3.4 Prior art

| Project | Stack | Maturity | License | Assessment |
|---|---|---|---|---|
| `kodustech/trust-center` | Next.js 16, Supabase, YAML-driven | 13 stars, 17 commits | MIT | Appealing config-as-code idea. Single tenant, no NDA flow, no audit trail. Demo scale. |
| `kutcode/trust-center` | Next.js 15 + Express + Supabase, Docker | 17 stars, 147 commits | MIT | Closest prior art: magic-link document requests, organization whitelisting, approvals, expiry badges, Salesforce sync. No analytics, no NDA workflow, in-memory rate limiting. |
| `trycompai/comp` | Full GRC platform | Active, funded | AGPLv3 | A Vanta alternative with a bundled trust portal. Adjacent, much larger product. |
| `OpenXPKI` | PKI trust center | Mature | Apache 2.0 | Unrelated — "trust center" in the PKI sense. |

**Conclusion.** No mature, self-hostable, EU/DACH-first Trust Center exists. The two direct
candidates are thin projects under 20 stars, neither implementing NDA e-signing, watermarking,
audit trails, or an answer library. Nothing exists in the Svelte ecosystem. The gap is real.

### 3.5 Differentiation

1. **Self-hostable and EU-sovereign by construction**, not by vendor promise.
2. **DACH-native**: DE/EN content from day one, AVV/TOM document conventions, NIS2 and DORA framing.
3. **No trackers, no cookie banner** on the public portal — a Trust Center that opens with a
   consent wall argues against itself. No incumbent SaaS can make this claim.
4. **Audit trail as the analytics substrate** — one append-only record serving both evidentiary and
   business purposes.
5. **Open source**, auditable by the very buyers whose scrutiny it exists to satisfy.

---

## 4. Scope

### In scope for v1.0

The buyer-facing proof layer: content publication, tiered document access, NDA workflow, access
governance, notifications, audit, analytics, and an internal answer library.

### Out of scope

- **Compliance automation.** No evidence collection integrations, no continuous control monitoring,
  no audit workflow. Compliance state is authored or imported; it is not computed. This is the
  single most important boundary in the project.
- **Multi-tenancy.** One Trust Center per deployment. A hosted multi-tenant offering remains
  possible later via an organization scope column, but no such affordance is built now.
- **AI questionnaire answering.** Deferred to post-1.0 (Section 11.3).

---

## 5. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Trust Center only; no GRC | Ships fast, stays small, avoids competing with a funded AGPLv3 incumbent on its own ground |
| D2 | Database + admin UI for content | Requests, NDAs, audit, and analytics are inherently dynamic and need a database regardless; a single source of truth beats two; non-engineers can maintain content |
| D3 | Docker + Postgres as primary target | Self-hosting is the adoption story and the sovereignty argument; no runtime constraints on PDF processing, jobs, or libraries. Serverless adapters follow post-1.0 behind ports |
| D4 | Click-through NDA plus pluggable e-signature | Built-in flow covers most DACH enterprise buyers with no vendor dependency; an adapter serves counterparties who insist on qualified signatures |
| D5 | Answer library and public FAQ; no AI in v1.0 | Deflection and a canonical answer source capture most of the value; AI questionnaire parsing is a substantial phase of its own |
| D6 | Localized content from day one | Retrofitting per-locale content into a database model means touching every table and form; DACH legal teams prefer German for binding artifacts |
| D7 | Monolithic SvelteKit application | One deployable is the adoption story; a headless CMS would split the admin surface without eliminating it, since grants, acceptances, and audit live outside it regardless |
| D8 | OIDC-only staff authentication | No credential store, no password reset, no TOTP enrollment. Removes an entire class of code and liability. Dex serves as the local and test issuer |
| D9 | Single tenant per deployment | YAGNI. Multi-tenancy is a post-1.0 concern with a clear migration path |

---

## 6. Architecture

### 6.1 Stack

SvelteKit 2 with Svelte 5 runes, TypeScript in strict mode, `adapter-node` in a distroless
container. Postgres 16. Drizzle ORM for schema and migrations. Tailwind with a small set of
hand-rolled components. Paraglide JS (inlang) for interface strings. `pdf-lib` for watermarking and
NDA record generation. `openid-client` for OIDC. Vitest for unit and integration tests,
Testcontainers for Postgres, Playwright for end-to-end.

### 6.2 Route groups

- `(portal)` — public Trust Center. Server-rendered, aggressively cacheable, unauthenticated.
- `(portal)` gated views — the same shell, content filtered by the viewer's active grants.
- `(admin)` — authenticated staff area, `noindex`, separate rate limits.
- `api/` — deliberately thin: e-signature webhooks and document download streaming only.
  Everything else uses SvelteKit form actions.

### 6.3 Identity

Two identity models, kept strictly separate.

**Staff — OIDC only.** Authorization Code with PKCE against one configured issuer per deployment.
No local accounts and no password fields anywhere in the schema.

- Sessions are ours: after the OIDC callback the application mints a server-side session row and an
  opaque cookie, not a JWT. Revocation must be instant and every session must be attributable in
  the audit log. Only `sub`, email, name, and group claims are retained; no access or refresh
  tokens are stored, since the IdP is needed only at login.
- Just-in-time provisioning with claim-based roles. First login creates the staff user. Roles derive
  from a configurable group claim mapping (`OIDC_ADMIN_GROUP`, `OIDC_APPROVER_GROUP`), re-evaluated
  on every login so IdP offboarding takes effect immediately. Two roles: **admin** (full rights)
  and **approver** (triage and decide access requests; no configuration rights). This also removes
  the bootstrap problem — there is no seeded first user and no setup wizard.
- Dex ships in `docker-compose.dev.yml` with static users in both groups. It doubles as the
  Playwright fixture for admin flows and as a reference configuration for self-hosters.
- Back-channel logout and multiple simultaneous issuers are out of scope.

**Requesters — magic link only.** External prospects and their counsel never authenticate against
the operator's IdP. Email verification by single-use, short-TTL, hash-at-rest magic link mints a
requester session bound to that requester's grants.

### 6.4 Ports

The only places the application touches the outside world.

| Port | Default implementation | Later implementations |
|---|---|---|
| `StorageAdapter` | local filesystem | S3-compatible, Cloudflare R2 |
| `MailAdapter` | SMTP | Resend, Postmark |
| `SignatureAdapter` | built-in click-through | DocuSign, Dropbox Sign, eIDAS QES |
| `JobRunner` | in-process scheduler | queue-backed |

These four boundaries are what make a future serverless target a matter of writing implementations
rather than rewriting features.

### 6.5 Document delivery

Files are never served from storage directly, and no publicly reachable URL to a stored object ever
exists. Every download passes through one endpoint that resolves the grant, writes an audit event,
and streams a per-recipient watermarked copy. Watermarks carry recipient name, company, email,
timestamp, and a confidentiality notice. `pdf-lib` is pure JavaScript and therefore survives a
later move to an edge runtime.

### 6.6 Modules

1. `content` — documents, controls, subprocessors, answers, updates, certifications, pages
2. `access` — requests, rules, NDA acceptance, grants, expiry, revocation
3. `identity` — staff accounts and sessions; requester identities and magic links
4. `delivery` — storage port, watermarking, streaming
5. `audit` — append-only event log
6. `notify` — mail port, templates, subscriptions, digests
7. `admin-ui` — generic primitives (filterable table, form scaffold, locale tabs, media picker) so
   each new content type is a schema plus a configuration object rather than a new set of pages

**Governing rule:** domain tables hold *state*; `audit_event` holds *occurrences*. Every module
writes to the audit log, and analytics is a read model over it. A download has no state, only an
occurrence, so there is no downloads table. State that must be enforced — a grant, an acceptance —
gets a real table with real constraints.

---

## 7. Localization

Three distinct kinds of localizable material, and only two live in the database.

**Interface strings — in code.** Navigation, buttons, form validation, email template bodies.
Paraglide JS: compile-time, tree-shaken, typesafe, integrating with SvelteKit's `reroute` hook so
`/de/...` and `/en/...` routing falls out naturally. Changed by developers in pull requests.

**Authored content — in the database, per locale.** Control descriptions, answer library and FAQ
entries, subprocessor purpose and data-category descriptions, update posts, page copy, and document
titles and summaries. Stored in `*_translations` side tables keyed `(entity_id, locale)` rather
than JSONB columns: the answer library and knowledge base need per-locale full-text indexes, since
German and English stemming differ, and Drizzle keeps side tables typed.

**Uploaded files — a variant per locale.** A German AVV and an English DPA are two distinct PDFs,
not a translated string. Because documents require versioning regardless, locale and version share
one table (Section 8).

**Locale configuration is two-layered.** Which locales a deployment *can* render is a build input:
Paraglide compiles one catalog per locale listed in `project.inlang/settings.json`, and a locale
without a catalog is not a locale — adding one means translating the interface strings, which is a
code contribution no environment variable can substitute for. Which of the compiled locales a
deployment *enables*, and which of them is the default, is runtime configuration (`LOCALES`,
`DEFAULT_LOCALE`), validated at startup against the compiled set so a misconfiguration fails at boot
rather than mid-request. An operator can therefore narrow a published image to German only without
rebuilding it; adding French requires a rebuild. Locale prefix routing is structural and recognises
any *compiled* locale, so a compiled-but-disabled locale is a 404 rather than a silent fallback.

**Fallback rule.** Partial translation is the normal steady state. The admin shows one tab per
enabled locale with an explicit "not translated" state; the portal falls back to the default locale
**with a visible label** rather than silently mixing languages. For legal documents this is a
requirement, not a nicety: serving a German-speaking counsel an English AVV without saying so is
worse than showing that it is the only available version.

---

## 8. Data model

Every `*_translations` table is keyed `(entity_id, locale)`.

### Content

```
document_category   + tr(name)
document            + tr(title, summary)
                      slug, category_id, tier(public|request|nda), owner_staff_id,
                      review_interval, status(draft|published|archived)
document_file       (document_id, locale, version)
                      storage_key, sha256, page_count, valid_from, valid_until, is_current
control_group       + tr(name, description)
control             + tr(title, description)   slug, group_id, status, evidence_document_ids
certification       + tr(scope)
                      framework, issuer, valid_from, valid_until, certificate_document_id
subprocessor        + tr(purpose, data_categories)
                      name, legal_entity, country, region, hosting_provider, dpa_url,
                      started_at, ended_at
answer              + tr(question, answer)
                      category, visibility(public|internal), owner_staff_id,
                      last_reviewed_at, review_interval, tags
update              + tr(title, body)
                      kind(document|subprocessor|certification|advisory), published_at
page                + tr(title, body_md)      slug, status, nav_position
```

### Identity

```
staff_user          oidc_sub, email, name, role(admin|approver), last_login_at, disabled_at
staff_session       token_hash, staff_user_id, expires_at, ip, ua
requester           email unique, name, company, company_domain, first_seen_at, notes
magic_link          token_hash, requester_id, purpose, expires_at, consumed_at
requester_session   token_hash, requester_id, expires_at, ip, ua
```

### Access governance

```
access_rule         pattern, action(auto_approve|review|deny), max_tier, priority
access_request      requester_id, scope, justification, status, decided_by,
                    decided_at, reason, source(portal|invite)
nda_template        version, locale, body_md | file_key, effective_from
nda_acceptance      requester_id, nda_template_version, method(clickthrough|esign),
                    accepted_at, ip, ua, typed_name, template_sha256,
                    record_pdf_key, envelope_id
access_grant        requester_id, scope, nda_acceptance_id, granted_at,
                    expires_at, revoked_at, revoked_by
```

### Cross-cutting

```
audit_event         at, actor_type, actor_id, action, subject_type, subject_id,
                    ip, ua, request_id, meta jsonb
subscription        email, locale, topics[], confirmed_at, unsubscribe_token
outbound_email      to, template, sent_at, status, provider_id
setting             key unique, value jsonb
                    branding (logo, colours, custom domain), locale set,
                    default grant duration, retention policy
```

---

## 9. Access governance flow

1. **Request.** The prospect selects documents, or "all restricted", and submits email, name,
   company, and purpose. The response is byte-identical whether or not the email is already known.
2. **Verify.** A single-use, short-TTL magic link, hashed at rest. Verification is what creates the
   `requester` identity, so nobody can request access as somebody else.
3. **Rule evaluation.** `access_rule` entries are matched by priority against the email domain:
   free-mail or competitor domains are denied or flagged; known-customer domains are auto-approved;
   everything else becomes pending and notifies staff.
4. **Triage.** Staff approve with an explicit scope and expiry, deny with a reason, or request more
   information. Bulk invitation covers the reverse direction, where the operator proactively
   invites a prospect.
5. **NDA.** If the scope touches an NDA-tier document and no valid acceptance exists, the grant
   remains pending acceptance. The click-through flow renders the current template in the
   requester's locale; the requester types their full name and submits; the application records IP,
   user agent, timestamp, and the template SHA-256, generates a PDF record, and emails a copy to
   both parties. The e-signature adapter substitutes this step and completes on webhook.
6. **Grant active.** The requester session unlocks the granted document set until `expires_at`
   (default 90 days, configurable).
7. **Download.** Streamed through the delivery endpoint, watermarked per recipient, one audit event
   per download.
8. **Lapse.** A reminder precedes expiry; access then ends automatically. Revocation takes effect
   immediately.
9. **Return visit.** A known requester holding a valid NDA acceptance takes a fast path:
   re-verification by magic link, with no new approval where the rules allow.

### Edge cases designed for explicitly

- **NDA template versioning.** Active grants retain the version accepted; new grants require the
  current version. A template becomes immutable the moment it is first accepted.
- **Document supersession.** Grants reference the *document*, so holders always receive the current
  file. The audit records which file version was actually retrieved.
- **Magic link replay.** Single-use, hashed, short-lived, and rate-limited alongside the request
  endpoint.
- **Domain drift.** Rules are evaluated against the domain at request time and the decision is
  recorded, so later rule changes never retroactively rewrite history.

---

## 10. Security and privacy stance

The product is itself a security artifact; its own posture is part of the argument.

- **No credential store.** Staff authentication is delegated entirely to the operator's IdP.
- **No third-party trackers and no cookies on the public portal.** Analytics derive from the
  server-side audit log, so the public Trust Center requires no consent banner.
- **No public object URLs.** All file access is mediated, authorized, watermarked, and logged.
- **Append-only audit.** Every access decision, acceptance, and download is recorded with actor, IP,
  user agent, and request correlation. Audit events are never deleted and never rewritten, enforced
  at the database rather than by convention. The one exception is pseudonymization on requester
  purge: a database-enforced, column-scoped operation that may only set `ip`, `ua`, and `actor_id`
  to `NULL`, only ever moves data toward less identifiability, and itself writes an audit event.
  It follows that **requester personal data appears in `audit_event` only in those three columns** —
  never in `meta`, never in `subject_id`. Staff identifiers are outside the requester purge and may
  appear in `meta`.
- **Data minimization and retention.** Requester records carry a configurable retention policy;
  audit events are retained per legal need, with the link to the person broken by the
  pseudonymization defined above rather than by deleting the record of the occurrence.
- **Double opt-in** for all subscriptions.
- **Enumeration resistance** on every requester-facing endpoint.
- **Rate limiting** on request submission, magic-link issuance, and download endpoints.
- The deployment ships `security.txt` and a vulnerability disclosure page.

---

## 11. Phases and roadmap

Sizes are relative (S/M/L), not calendar estimates.

### Phase 0 — Foundation (not a release)

Walking skeleton: SvelteKit, Drizzle, Postgres; `docker compose up` bringing app, Postgres, Dex, and
Mailpit. OIDC login with group-to-role mapping. The `audit_event` primitive. Admin shell and generic
admin primitives. Paraglide and locale routing. CI running lint, typecheck, unit, and end-to-end
suites.

The admin primitives belong here rather than spread across later phases, so that every subsequent
content type is cheap.

### Phase 1 — MVP: the public Trust Center · L

Certifications and badges with scope and validity; controls catalog by group; subprocessor list;
public documents with versioning and expiry; public FAQ; updates feed; full DE/EN admin CRUD;
branding configuration; SEO, Open Graph, and sitemap; self-hosting documentation.

This already exceeds both open-source prior-art projects.

### Phase 2 — Access governance · L

Request-gated tier; requester identity and magic links; request form; staff triage queue; grants
with scope and expiry; gated portal view; watermarked streaming downloads; notification emails for
new requests, decisions, access links, and expiry reminders; audit log viewer.

### Phase 3 — NDA workflow · M

Versioned NDA templates per locale; click-through acceptance with a PDF record emailed to both
parties; auto-approval rules with domain allow and deny lists; the NDA-gated tier.

At the end of this phase the product matches SafeBase's core proposition.

### Phase 4 — Notifications and subscriptions · M

Double opt-in subscriptions to subprocessor changes and updates; update composer with scheduled
publishing; digest emails; outbound webhooks for Slack and Teams.

Advance notice of subprocessor changes is frequently a contractual obligation in DACH data
processing agreements and feeds NIS2 supply-chain expectations, so this phase carries regulatory
weight rather than being a convenience.

### Phase 5 — Analytics and content operations · M

Dashboard over the audit log: views, downloads, request funnel, per-company activity, most-asked
questions. Content owners with review intervals and a staleness dashboard. Certificate expiry
warnings. CSV export and per-company access reports.

### Phase 6 — Answer library · M

Internal answers with per-locale full-text search, tags, owners, and review dates; usage counters;
the public subset feeding the knowledge base.

This is the Excel-questionnaire relief valve without AI: one canonical source to answer from, plus
a public FAQ that deflects questions before they are asked.

### Phase 7 — v1.0 hardening · M

One real `SignatureAdapter` implementation; WCAG 2.2 AA accessibility pass (BITV compliance matters
for German public-sector and large-enterprise procurement); security hardening review;
`security.txt` and vulnerability disclosure page; theming, documentation, and localization
completeness.

**Release: v1.0**

### 11.1 Release strategy note

Phases 1 and 2 together are what solve Matchory's own problem. Phase 1 alone is shippable and
useful; the recommendation is to ship it, because putting a real public portal in front of real
prospects reveals which documents are actually requested before the machinery to gate them is
built.

### 11.2 Deferred to post-1.0

Cloudflare and Vercel adapter implementations; AI questionnaire answering (upload a workbook, match
questions against the answer library, draft answers with citations, human review, export back to
the original format); CRM integrations for HubSpot, Salesforce, and Pipedrive; importers from
Vanta, Drata, and Comp AI; uptime and status signals; multi-tenancy and a hosted offering; SAML and
SCIM; multi-product profiles.

---

## 12. Testing strategy

Domain logic is designed as pure functions over state — rule evaluation, grant validity, NDA version
selection, locale fallback — so the interesting parts are testable without a database.

- **Unit (Vitest).** Rule engine, expiry and revocation, NDA version resolution, locale fallback,
  watermark composition.
- **Integration (Vitest with Testcontainers Postgres).** Repositories, migrations, constraints.
- **End-to-end (Playwright).** Request through approval, NDA, and watermarked download; OIDC login
  via Dex, publish, and verify visibility in both locales; expired grant blocks download;
  revocation takes effect immediately.
- **Security regression tests, as first-class citizens.** Enumeration responses are byte-identical
  for known and unknown emails; magic links are single-use; no storage URL is reachable without a
  grant; every download writes an audit event; gated documents never appear in public HTML, JSON,
  or the sitemap.

The final group covers the failures that would be specifically embarrassing in this product, so
they carry permanent tests rather than manual checks.

Implementation follows test-driven development throughout.

---

## 13. Success criteria

1. A prospect can self-serve every public document without contacting anyone.
2. A gated document request completes end to end — request, verification, NDA, download — without
   a single email written by hand.
3. Every document access is attributable, with an exportable record per company.
4. The full deployment runs from one `docker compose up` against a self-hosted Postgres, with no
   external service required beyond SMTP and an OIDC issuer.
5. The public portal sets no cookies and loads no third-party resources.
6. German and English content are maintainable side by side by a non-engineer.
