# Integrations subsystem A — Event egress — Design

**Date:** 2026-09-03
**Status:** Approved design, revised 2026-09-03 after adversarial review (§17 records what changed).
Governs subsystem A where it and `2026-08-31-integrations-decomposition.md` differ.
**Author:** Moritz Friedrich (CISO, Matchory), with Claude
**Scoping note:** `docs/superpowers/specs/2026-08-31-integrations-decomposition.md`, §9 A
**Governing design:** `docs/superpowers/specs/2026-08-28-trust-center-design.md`

Section references of the form "§6.6" are to the governing design unless a document is named.
References of the form "note §6" are to the decomposition note.

**This document corrects note §5.** "A consumer is a cursor holding one bigint. No deduplication, no
ordering problem" is false as stated, and §5.2 below says why. B inherits the correction.

---

## 1. What this subsystem is

Business events leave the application over HTTP to operator-configured endpoints. Matchory's own
requirement is access requests reaching Teams, and reaching n8n, which updates HubSpot. Note §2
settles why this is one narrow surface rather than a catalogue of connectors: the operator already
runs a container and can already run n8n beside it, so every connector built into the application is
one they could have built themselves and one we maintain forever — and, worse, one that puts a
vendor's OAuth token inside a product that sells sovereignty by construction.

This subsystem therefore builds **an event out and nothing else**. There is no HubSpot code here, no
Salesforce code, and no vendor SDK.

It is the first subsystem to make the application an HTTP *client*. That is a new security boundary
rather than only a new feature, and §6 is the largest section of this document for that reason.

### 1.1 Why endpoints are rows rather than environment variables

An env-var-only design — one URL, one action list, one formatter — meets the requirement as stated
in one paragraph and deletes most of this document. It was considered and rejected, and the reason
belongs here rather than in a reviewer's head, because everything expensive below follows from it:

- **More than one destination is a near-term need, not a hypothetical.** Teams and n8n are two
  destinations with two payload shapes on day one, and Slack is expected. A single-URL design
  answers the first requirement and is rewritten by the second.
- **Endpoints are reconfigured by people who do not deploy.** Changing which events reach which
  channel should not be a container restart, and the person who owns that decision is not
  necessarily the person with shell access.

The cost is real and is not waved away: a runtime-mutable egress destination makes "does this
deployment call out, and to where?" a database fact rather than an environment fact, and the product
is sold partly on that question being answerable from `docker inspect`. §12's `EVENT_EGRESS_ENABLED`
is the answer — a deploy-time switch, default off, without which no endpoint delivers anything. The
environment therefore still answers "does this deployment call out at all", which is the question a
procurement reviewer actually asks; the database answers "to where", which is the question an
operator needs to change on a Tuesday.

### 1.2 How A differs from B, which will look similar

A and B share a spine, and §4.1's free-form filter means an operator *can* point A at most of the
log. The subsystems remain distinct in delivery semantics, and the distinction is what each is
allowed to assume:

|  | A — event egress | B — audit sink |
| --- | --- | --- |
| Unit of delivery | One event, one HTTP request | A batch, ordered |
| Content | Enriched from live domain state | The audit row, verbatim |
| Filtered | Yes, per endpoint | No |
| Latency | Seconds | Minutes to hours |
| On loss | Retried, then the endpoint disables | Must not lose anything, ever |

A is allowed to drop an event after five attempts and say so. B is not.

**What is genuinely shared, and what is A-only.** The shared spine is §5.2's watermark — the rule for
deciding which audit events are safe to consume and how far a cursor may advance. That is the part B
must inherit, and the part note §5 got wrong. Everything else here — per-endpoint filtering,
enrichment, formatters, retry, auto-disable — is A-only. **B must not be built by widening this
document**; it should take §5.2 and nothing else.

What B inherits is the **composite `(xmin, seq)` keyset**, not the horizon scan this document first
described — see §5.2's correction and plan C1. B's "ordered batch" row above is the line to re-read
in that light: the keyset orders by `(xmin, seq)`, which is commit-ish order, not `seq` order. A
batch is internally ordered and consistent, and B may still assert that no event is lost, but a
reader of B's output must not take `seq` to arrive monotonically.

---

## 2. Data model

Three tables under a new module, `src/lib/server/egress/`. The noun is **endpoint** throughout:
`subscription` is already taken by the portal's update mailing list (`src/lib/server/db/schema/subscriptions.ts`),
and two unrelated concepts sharing a name in one schema is how a later reader joins the wrong table.

### 2.1 `event_endpoint`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | Also an input to the signing secret (§7) |
| `name` | text not null | The operator's label. **Not** a telemetry attribute (§10) |
| `url` | text not null | Validated on save, re-checked at delivery (§6.3) |
| `format` | text not null | Check-constrained to the formatter registry (§3.3) |
| `secret_version` | integer not null default 1 | Bumping it re-keys this endpoint alone (§7) |
| `enabled` | boolean not null default true | |
| `cursor_xmin` | bigint not null | With `cursor_seq`, **one** keyset cursor over `(xmin, seq)` — not two facts. Initialised to the current xmin horizon at creation. Advanced per §5.2 |
| `cursor_seq` | bigint not null | The second half of that keyset. Initialised to `0` |
| `last_success_at` | timestamptz | Drives auto-disable (§5.4), through `coalesce(last_success_at, created_at)` |
| `disabled_at` | timestamptz | |
| `disabled_reason` | text | |
| `created_at` | timestamptz not null default now() | |

**The cursor starts at the current horizon, not at zero.** A new endpoint must not replay eighteen
months of history into a Teams channel on its first tick. This is a one-line default with a
disproportionate failure mode, so it is stated here rather than left to the insert site.

Under §5.2's keyset that has an exact meaning: creation sets `cursor_xmin` to the horizon observed at
that moment and `cursor_seq` to `0`, so *everything already below the horizon is treated as
consumed*. The precise consequence — a transaction in flight at creation commits below the new cursor
and is never delivered — is the same hazard the cursor exists to protect against, and it is harmless
here because "do not replay history" is exactly what was asked for. §5.5's skip-the-backlog jump does
the identical thing for the identical reason. Both are recorded in §16 rather than left to be
rediscovered.

`disabled_at` is paired against `enabled` by a check constraint — `(enabled = false) = (disabled_at
IS NOT NULL)` — in the shape `subscription`'s five confirmation columns use: a state that lives in
more than one column and can disagree with itself is a silent defect, so the constraint says the two
agree. Re-enabling clears both `disabled_at` and `disabled_reason`; a manual disable sets both, so
"disabled" always carries its reason whether a person or the job did it.

### 2.2 `event_endpoint_filter`

`(endpoint_id, pattern)` primary key, cascading from the endpoint. A pattern is either an exact
action name (`access_request.approved`) or one **trailing** wildcard segment (`access_request.*`).

Deliberately not a glob, for the reason `access_rule.pattern` gives for the same restriction: a
general pattern engine invites expressions nobody can reason about, and this one is evaluated at the
moment an event carrying a prospect's name leaves the building. `a.*` matches `a.b` and `a.b.c`; it
does not match `a`, and it does not match `ab.c`.

An endpoint with no filter rows receives nothing. Silence is the safe reading of an empty set.

### 2.3 `event_delivery`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | The idempotency key handed to the consumer (§7.2) |
| `endpoint_id` | uuid not null | Cascades |
| `audit_seq` | bigint not null | **A reference. Never a payload.** |
| `audit_id` | uuid not null | Travels in the payload so gaps are detectable (§4.4) |
| `status` | text not null default `'pending'` | `pending \| delivered \| failed \| skipped` |
| `attempts` | integer not null default 0 | |
| `next_attempt_at` | timestamptz not null default now() | |
| `last_status_code` | integer | |
| `last_error` | text | **A fixed reason phrase. Never a response body** (§6.4) |
| `delivered_at` | timestamptz | |
| `created_at` | timestamptz not null default now() | |

Unique on `(endpoint_id, audit_seq)`, which makes fan-out idempotent, and a partial claim index on
`next_attempt_at where status = 'pending'` — the same shape and the same reason as
`outbound_email_claim_idx`: the index stays small as delivered rows accumulate.

**The row holds a reference to an audit event, not a rendered body.** This is the core of note §6's
erasure story and the reason it is structural rather than maintained. Had we enriched at fan-out
time, `outbound_email`'s purge path — which matches on `to` — would become the first of two such
paths rather than the only one, and a second one is the kind that rots silently when somebody adds a
field.

That property is only preserved if **nothing else on this row holds personal data**, which is why
`last_error` is a fixed reason phrase (§6.4) rather than the captured response body an earlier draft
of this document specified. A receiver that echoes its input — n8n's "respond with incoming items",
most webhook debuggers — would otherwise write the requester's name and address into a column
`purgeRequester` does not know about and does not clear, creating exactly the second purge path this
design exists to avoid.

---

## 3. Three layers

```
audit_event row
  └─ enrich(db, row) -> EventModel          §4
       └─ format(model, locale) -> Body     §3.3
            └─ deliver(url, body, sig)      §6
```

### 3.1 `EventModel` is the stable seam

Everything above it is domain code that reads the database; everything below it is presentation. The
model is the thing this subsystem promises not to break, and the wire shapes are derived from it.

```ts
interface EventModel {
	action: string;                    // the audit action, verbatim
	at: Date;
	eventId: string;                   // audit_event.id
	seq: string;                       // audit_event.seq, as a string (§4.4)
	deliveryId: string;
	subject: { type: string; id: string } | null;
	actor: { type: string; id: string | null };
	/** True when the payload's subject data was never identity-verified (§4.3). */
	verified: boolean;
	/** Enriched, or the audit row's meta as a fallback (§4.2). */
	data: Record<string, unknown>;
	/** Human-readable one-liner. Formatters that render prose use this. */
	summary: string;
	/** Absolute URL into the admin area, where one exists for the subject. */
	link: string | null;
}
```

### 3.2 A formatter is a pure function

`(model: EventModel, locale: string) => { body: string; contentType: string }`. No database, no
config, no `fetch`. This keeps formatter tests in the unit suite, which needs no Postgres, and it is
what makes the next formatter cheap.

The locale is `config.defaultLocale`, passed in by the delivery job. The audience of an egress
payload is the operator's own staff and automation, not the requester, so a per-endpoint locale
setting is surface with nothing to buy — and rendering a card in the *requester's* locale would put a
German card in an English-speaking team's channel because of who happened to submit the form.

### 3.3 The formatter registry

Adding Slack later is: one file, one entry in the registry, one value in the check constraint, and
unit tests. That is the point of the registry and the reason `format` is a column rather than two
branches.

Two ship now:

**`generic`** — `application/json`, the model rendered directly. This is what n8n consumes.

```json
{
  "event": "access_request.pending",
  "at": "2026-09-03T10:12:00.000Z",
  "event_id": "8c1e…",
  "seq": "48213",
  "delivery_id": "0f3c…",
  "verified": true,
  "subject": { "type": "access_request", "id": "…" },
  "actor": { "type": "requester", "id": "…" },
  "summary": "Access request from Acme GmbH needs review",
  "link": "https://trust.example.com/en/admin/requests/…",
  "data": { … }
}
```

**`teams`** — an Adaptive Card in the envelope the Workflows (Power Automate) trigger expects.
Microsoft retired Office 365 Connectors in Teams; `MessageCard` is not the target and must not be
written. The current shape is:

```json
{
  "type": "message",
  "attachments": [
    {
      "contentType": "application/vnd.microsoft.card.adaptive",
      "contentUrl": null,
      "content": { "type": "AdaptiveCard", "version": "1.4", "body": [ … ] }
    }
  ]
}
```

The declared card `version` is **1.4**, not the newest available. Adaptive Card support differs by
Teams surface and client, and a card that fails to render is indistinguishable to the operator from
a delivery that never arrived — the worst possible failure for a notification channel. 1.4 renders
everywhere Workflows posts.

The card carries the summary, a fact set from `data`, and an `Action.OpenUrl` to `link`. It carries
no images and no external references: nothing in a Teams channel should fetch from us.

**Every string a formatter renders is escaped for its target.** Adaptive Card `TextBlock` renders
markdown, and §4.3's data is in part supplied by whoever filled in a public form — so a company name
of `[Password reset required](https://evil.example)` would otherwise become a clickable link in the
security team's own channel, delivered by the trust center. Escaping is a property of the formatter,
tested per formatter, and not a property of the enricher: a second formatter with a different escape
rule must not be able to inherit the first one's assumption.

Since `format` is a check-constrained column, note the caveat `audit_event`'s own check already
records — Drizzle regenerates check constraints rather than altering them, so the constraint text in
the schema file and the hand-written `ALTER` in the migration are kept in sync by hand.

---

## 4. Event vocabulary and filtering

### 4.1 The filter is free-form over `audit_event.action`

An operator subscribes by pattern (§2.2), not by picking from a list this subsystem controls. The
admin UI offers the actions currently present in the log as suggestions, but does not restrict the
field: an operator who wants `control.*` in a channel should not have to wait for us.

**Matching is `starts_with()`, not `LIKE`.** `LIKE` treats `_` as a single-character wildcard, and
this log contains `staff.login_failed` and `staff.login.denied` — so a `LIKE 'staff.login_failed'`
filter also matches a hypothetical `staff.loginXfailed`. That is a subtle, silent widening of an
egress filter, which is exactly the class of bug this subsystem cannot afford.

### 4.2 Enrichment: a registry, with a fallback

Actions with a registered enricher get an `EventModel` whose `data` is read from **live domain
state at delivery time** — note §6's settled rule.

The registry below was walked against `grep -rhoE "action: '[a-z0-9._-]+'" src/` plus the two
template-literal sites (`verify.ts` and `admin/requests/[id]/+page.server.ts`, both
`access_request.${status}`), not against memory. That matters: an earlier draft of this table omitted
`access_request.pending` entirely, which is *the* event the stated requirement is about.

| Action | Written by | `data` carries |
| --- | --- | --- |
| `access_request.pending` | `verify.ts` (auto-approval declined or blocked) | requester name, email, company, domain; requested tiers, document count; matched rule |
| `access_request.approved` | `verify.ts`, admin decision | the above, plus grant id, term days, expiry, outstanding agreements |
| `access_request.denied` | `verify.ts`, admin decision | the above, plus the reason |
| `access_request.info_requested` | admin decision | the above |
| `access_grant.revoked` | admin | requester identity, grant id, what it covered |
| `nda_acceptance.recorded` | acceptance | requester identity, template and version |
| `nda_record.downloaded` | delivery | requester identity, template and version |
| `document.downloaded` | delivery | requester identity where there is one, document title and tier — see below |

`access_request.pending` is the one an operator wants in Teams: it is written when a verified request
needs a human. `access_request.submitted` is deliberately **absent** — see §4.3.

**`document.downloaded` has three cases, not two (plan C5).** Its subject is a `document_file`, not a
document and not a requester: `subject_type` is `document_file` and `subject_id` is a
`document_file.id`, so the enricher resolves file → document → translation for the title. And
`delivery/serve.ts` writes `actor: { type: 'requester', id: requester?.id ?? null }`, while
`/api/documents/{fileId}` is the **cookie-free public path** — so this event is routinely written
with a null actor and no requester row at all. The enricher therefore distinguishes:

- **enriched** — a requester id resolving to a live row;
- **anonymous** — no requester id, as every public-tier download produces. Delivered, with `data`
  describing the document, `actor.id: null` and `verified: false`;
- **skipped** — a requester id that resolves to a purged row, or a subject row that is gone (§4.5).

Reading §4.5 as two cases would mark every public download `skipped`, silently dropping exactly the
notifications an operator subscribed to.

Anything else falls back to the audit row: `action`, `at`, `subject`, `actor`, and `meta` verbatim,
with a `summary` derived from the action name. §6.6 already guarantees `meta` holds no requester
personal data, so the fallback is safe **by construction rather than by filtering** — which is worth
preserving, because a filter is a thing somebody later forgets to extend.

The fallback carries neither `ip` nor `ua`. The governing rule, stated once here and cited by the
code:

> **The payload carries what a consumer needs to act on, never what only the audit log needs to
> prove.**

`ip` and `ua` are forensic columns. No card renders them, no automation branches on them, and
shipping them would put an address in an n8n execution history for *every* event rather than for the
ones an operator chose. Enriched payloads carry name, company and email precisely because those *are*
what the consumer acts on — that is settled and not in tension with this rule.

### 4.3 `access_request.submitted` is not enriched, because its data is unverified

At the moment that event is written (`src/routes/(portal)/request/+page.server.ts`, actor `system`,
with the comment *"Not `requester`: nobody has proven they control that address yet"*) there is no
requester row. The name, company and address live in `access_request.submitted_*`, which is free
text from a **public, unauthenticated form**. The limiter allows five submissions per hour per
address and per IP, and is not a bound across IPs.

Enriching it would make a public form into a delivery mechanism aimed at the operator's own staff
channel and CRM: arbitrary third-party names and addresses on demand, and — before §3.3's escaping
rule — clickable links rendered by the trust center itself.

It therefore takes the fallback path, whose `meta` is `{documentCount, tiers}` and carries nothing a
submitter typed. `access_request.pending`, written after the magic link is consumed, is the enriched
event, and it exists precisely because someone has by then proven they control the address.

`EventModel.verified` states this on the wire rather than leaving it implicit, so a consumer branching
on it does not have to know which of our action names implies verification.

A second reason the same way: `sweepUnverifiedRequests` hard-deletes unverified rows after
`4 × MAGIC_LINK_TTL`, so a backlogged endpoint would enrich from a row that no longer exists. §4.5
defines what happens when a subject is gone, and this avoids the case entirely.

### 4.4 The payload carries `event_id` and `seq`

Neither is decoration. `seq` is what makes a gap detectable by a consumer — without it, an event lost
to the visibility hazard §5.2 describes is invisible to everyone, since the delivery id is minted by
us and is dense by construction. `event_id` is the audit row's own primary key, which is what lets a
consumer correlate a payload back to the log it is a read model over.

They also give B a real upgrade path: an operator who has wired A into object storage and later wants
B has a stream whose rows are identifiable and whose gaps are visible, rather than one that merely
looked like an audit sink.

### 4.5 A purged or absent subject is `skipped`, not blank

`purgeRequester` clears the domain columns the enrichers read. An earlier draft called the resulting
blank payload "the correct outcome and not a special case". That was wrong, and the reason is worth
recording because it is a privacy feature causing a data-integrity failure:

a consumer receiving `access_request.approved` with `name: ""`, `email: ""`, `company: ""` cannot
distinguish it from a person with no name. n8n → HubSpot will create a junk contact, or error, or —
worst — upsert by an empty email and overwrite an unrelated record. Blanks are the one shape a
consumer cannot branch on.

So: **when the enricher finds the subject's requester purged or the subject row gone, the delivery is
marked `skipped` and nothing is sent.** `skipped` already exists as a terminal status (§5.4), and this
is the same thing `purgeRequester` already does to queued mail — it fails pending `outbound_email`
rows rather than sending them blank, on the reasoning that "a purge that leaves one queued would mail
a person who asked to be forgotten." Egress now has that step too, and it is the same step.

Two clarifications the implementation forced, both narrowing where this rule lives:

- **The check lives in the enricher and nowhere else.** "It is the same step" reads as an instruction
  to modify `purge.ts`; it is not. `purgeRequester` is unchanged. Two implementations of one rule is
  precisely the second erasure path §2.3's reference-not-payload shape exists to avoid.
- **The signal is `requester.purged_at IS NOT NULL`, not blank columns.** `purgeRequester` writes
  `email = 'purged-<id>@invalid'` rather than emptying it, so a test for an empty email gets the one
  field a CRM upserts on wrong — the exact failure this section is about.

And "the subject row is gone" is not the same as "there is no subject": see §4.2 on
`document.downloaded`, where an anonymous public download has no requester by design and is
delivered, not skipped.

The erasure property this preserves is stated precisely in §8, where it is also qualified honestly.

---

## 5. Delivery, retry and failure

### 5.1 One job, and the lock is not held across the network

`egress:deliver`, every 15 s — matching `mail:drain`, on the same reasoning: a magic link a minute
late is a person waiting, and a Teams notice fifteen minutes late is a defect.

**The advisory lock is released before any HTTP request is made.** This is a deliberate deviation from
how `mail:drain` uses `runJob`, and it is not optional. `runJob` (`src/lib/server/jobs/runner.ts`)
wraps `fn()` inside `db.transaction`, while `startJobRunner` passes `() => job.run(getDb())` — so the
job body runs on a *different* pooled connection and the lock connection sits `idle in transaction`
for the whole tick. With a 25-row batch and a 10 s timeout that is up to 250 seconds, repeatedly,
which:

- pins the xmin horizon for minutes at a time on a system with high-churn tables (`ratelimit`,
  `outbound_email`, `event_delivery`), so autovacuum reclaims nothing;
- is killed outright by `idle_in_transaction_session_timeout`, which is standard hardening and the
  default on several managed Postgres offerings;
- occupies two of the pool's ten connections (`postgres(url, { max: 10 })`) for the duration, behind
  which request-path queries queue.

Mail gets away with the same shape because it talks to one configured relay on a short timeout. This
talks to arbitrary operator-supplied hosts, and the difference is the whole point.

Each tick therefore runs in two phases:

1. **Under the lock, in one transaction:** fan out (§5.2), then claim due deliveries with
   `FOR UPDATE SKIP LOCKED` and push their `next_attempt_at` forward, exactly as `drainOutbox` does.
   Commit. The pushed-forward claim is what makes the next phase safe without the lock.
2. **Outside any transaction:** render, POST, and record each outcome in its own short write.

Deliveries are **round-robin across endpoints, at most 5 per endpoint per tick**, rather than draining
one endpoint at a time. Without that, a single black-holing endpoint delays every other endpoint's
deliveries by the full tick — and §5.1's own justification for a 15 s interval is that a late notice
is a defect. Total tick wall-time is capped explicitly; work not done this tick is done next tick.

The claim limit is **25 rows globally per tick**, subdivided by the per-endpoint cap. Stating which it
is matters: per-endpoint multiplies tick time by the endpoint count, global starves by claim order —
the round-robin cap is what makes the global limit fair.

### 5.2 The watermark: which events are safe to consume

**This is the part B inherits, and the part note §5 got wrong.**

`audit_event.seq` is a `bigserial`. `nextval()` is consumed at INSERT, but a row becomes *visible* at
COMMIT, and those two orders are not the same. `recordEvent` is routinely called inside a transaction
that does other work first — `verify.ts` writes `access_request.${status}` after `createGrant` and
several updates; `purge.ts` and `admin/actions.ts` do the same. So a concurrent autocommit insert
(`document.downloaded`, say) can take a *higher* seq and commit *first*.

A naive `WHERE seq > cursor` scan landing in that window sees seq 101, misses seq 100, and sets the
cursor to 101. **Event 100 becomes visible a millisecond later and is never scanned again** — a
silently dropped approval notification, indistinguishable from Teams having eaten it.

The fan-out predicate therefore consumes only events whose inserting transaction has already
completed, using the snapshot's xmin horizon — **and the cursor is a composite keyset over
`(xmin, seq)`, not a `seq` high-watermark**:

```sql
SELECT id, seq, action, at, actor_type, actor_id, subject_type, subject_id, meta
FROM audit_event
WHERE xmin::text::bigint < $horizon
  AND (xmin::text::bigint, seq) > ($cursor_xmin, $cursor_seq)
ORDER BY xmin::text::bigint, seq
LIMIT 500
```

The cursor advances to the **last row returned**, not to the highest `seq` scanned.

> **Corrected 2026-09-03, after implementation review (plan C1).** The first draft of this section
> filtered on `seq > $cursor` and advanced to the highest `seq` scanned, justified by the invariant
> *"a row below the horizon was inserted by a transaction that can no longer commit anything beneath
> it, so no lower `seq` can still appear."* **That invariant is false**, and the fix is not a
> refinement of it — a `seq` high-watermark cannot be made exactly correct. Both counterexamples,
> because the second is the one that kills the obvious repair:
>
> 1. **A committed row is skipped.** `T_early` begins and takes xid 499. `T_slow` begins and takes
>    xid 500, and is still running. `T_fast` autocommits, taking xid 501 and **seq 50**. `T_early`
>    then calls `recordEvent`, taking **seq 51**, and commits. At the next tick the horizon is 500:
>    seq 51 is scanned (xmin 499 < 500) but seq 50 is excluded (xmin 501 ≥ 500), and the cursor
>    advances to 51. Seq 50 is committed, visible, and permanently below the cursor. `xmin < horizon`
>    excludes rows from transactions that started *later* and committed *already*, which is not what
>    the invariant assumed.
> 2. **The obvious repair does not work.** Advancing to "lowest excluded `seq` − 1" fixes case 1 but
>    not the mirror case, where the blocking row is still *invisible* and no visible row is excluded
>    — there is nothing to notice. And that gap is indistinguishable from the permanent gaps that
>    rollbacks and sequence caching leave in a `bigserial`.
>
> **The invariant that actually holds** is the keyset one: the cursor is only ever set to a row whose
> `xmin` was strictly below the horizon observed in that tick, so every unconsumed row — invisible
> (in flight, `xmin ≥ horizon`) or visible-but-excluded (`xmin ≥ horizon`) — has a key strictly
> greater than the cursor. Each row is consumed exactly once, in the tick where the horizon crosses
> its `xmin`.
>
> Two consequences, written down rather than discovered: delivery order becomes commit-ish order
> rather than `seq` order (§15 already promises no ordering guarantee, and `seq` in the payload still
> makes gaps detectable, but **a consumer must not assume monotonicity**); and `purgeRequester`'s
> `UPDATE audit_event` bumps `xmin`, so a pseudonymised row is re-scanned — harmless, because the
> fan-out insert is `ON CONFLICT DO NOTHING` against the unique `(endpoint_id, audit_seq)`.
>
> **The obvious alternative, recorded because it is obvious:** a trigger on `audit_event` INSERT
> writing `event_delivery` rows in the same transaction deletes the watermark problem entirely —
> visibility is inherited from the commit. Rejected because it puts egress on the critical path of
> every audited action: a fan-out bug or a missing egress table would then roll back an access
> approval. The audit write must not be able to fail because egress is misconfigured.

The failure mode this trades into is **delay, not loss**: a long-running transaction holds the horizon
back and events wait for it. That is the right direction, and it is bounded by the longest
transaction in the system rather than unbounded.

Implementation note. The horizon comes from `pg_snapshot_xmin(pg_current_snapshot())`, whose 64-bit
`xid8` form does not wrap the way a 32-bit `xid` comparison would; it is compared against
`xmin::text::bigint`. `xmin` is a system column and not an immutable expression, so it cannot be
indexed and the window scan is sequential — fine at a trust center's volume, and §16 records the row
count at which to bound it. The test named in §13 asserts both counterexamples above.

**Backpressure.** Fan-out is skipped for an endpoint whose pending depth already exceeds 1000.
Without this the two limits fight: 500 fanned out per tick against 25 delivered per tick means a
catch-up grows `event_delivery` twenty times faster than it drains it. The cursor is the backlog's
durable record, so pausing fan-out loses nothing.

Fan-out and the cursor update are one transaction (phase 1 above). Even if they were not, the unique
`(endpoint_id, audit_seq)` makes a replayed fan-out a no-op — worth writing down as the reason a crash
between the two is safe.

### 5.3 Retry classification

| Outcome | Treatment |
| --- | --- |
| Network error, timeout, 408, 429, 5xx | Retryable |
| 429 with `Retry-After` | Retryable, honouring the header, capped at 15 minutes |
| Any other 4xx | **Terminal on the first attempt** |
| Any 3xx | **Terminal on the first attempt** (§6.1) |

Retrying a 404 or a 401 five times over fifteen minutes buys nothing and delays the operator seeing a
misconfiguration by a quarter of an hour.

Attempts and backoff are `outbound_email`'s numbers verbatim — **5 attempts, 1/2/4/8 minutes** — so
the deployment has one retry story rather than two that differ for no reason. When they are exhausted
the row goes `failed`.

### 5.4 Auto-disable is time-based, not a failure count

An endpoint is disabled when **no delivery has succeeded for 24 hours and at least one has been
attempted in that window** — `coalesce(last_success_at, created_at)` against `now()`, evaluated per
tick.

The `coalesce` is not incidental. `last_success_at` is NULL until the first success, and NULL
compared against `now()` is NULL, so an endpoint that has **never** succeeded would never disable —
the dead-endpoint case this section exists for, and the state every misconfigured endpoint is in from
the moment it is created. Falling back to `created_at` gives a never-successful endpoint the same 24
hours as one that has gone quiet.

A consecutive-failure counter was specified first and is wrong in both directions. A low-volume
deployment sending three events a day takes four days to reach ten failures, so a permanently dead
endpoint stays "enabled" and silent for four days. And a high-volume one reaches ten inside a single
25-row batch — so a routine `secret_version` rotation, which makes the consumer return 401, which
§5.3 makes terminal on the first attempt, would **auto-disable the endpoint within one 15-second
tick**. §7.2's overlap window closes that particular hole, but the counter would still be measuring
the wrong thing. "No success in 24 h" states the intent directly.

Disabling writes `enabled = false`, `disabled_at`, `disabled_reason`, and one audit event (§9).

### 5.5 A disabled endpoint neither fans out nor delivers

Its cursor stalls. The alternative — continuing to fan out while disabled — accumulates a day of
deliveries and floods the channel with stale cards the moment somebody re-enables it.

Stalling makes re-enabling an explicit choice, with the backlog count in front of the operator:

- **Enable and catch up** — resume from `cursor_seq`, bounded by §5.2's fan-out and backpressure.
- **Enable, skipping the backlog** — jump `cursor_seq` to the current maximum; queued rows go
  terminal as `skipped`.

Skipping is the option the UI presents first. A channel flooded with a day of stale notices is worse
than a gap, and `audit_event` remains the record of record under either choice — nothing is lost, only
un-notified. `skipped` exists as a status rather than being a delete so that the gap is visible
afterwards.

### 5.6 Retention

Terminal `event_delivery` rows older than 30 days are swept by the existing `retention:sweep` tick.
Folded in there rather than becoming an eighth timer, for the reason the subscription sweep was
folded in: the interval is right and a tick that finds nothing costs one indexed query.

---

## 6. The egress client, and SSRF

Note §7: operator-configurable webhook URLs are server-side request forgery by construction. The
feature being admin-only bounds this but does not remove it. The delivery client is therefore not a
general HTTP client and is not reusable as one.

**The threat model is stated, because §6.3's design depends on which one it is:** this control exists
against *a malicious or compromised admin account*, not only against operator accident. That is why
the residual DNS-rebinding window an earlier draft accepted is closed here rather than documented —
against an accident, a documented window is fine; against an actor who chooses the hostname, it is
the whole attack.

### 6.1 No redirects

`redirect: 'manual'`; any 3xx is a failure. A redirect is the cheapest way to launder a denied
destination into an allowed one, and no legitimate webhook receiver needs one.

### 6.2 Method, scheme and headers are fixed

`POST` only, over `https://` — with `http://` permitted only when the resolved address is inside
§6.3's allowlist, since an in-cluster n8n on a private address is the one case where TLS is
reasonably absent.

The header set is closed (§7.2), no cookie jar is used, and no operator-supplied header is forwarded.
**A URL containing userinfo (`https://user:pass@host/…`) is rejected at save**: it is a credential in
a field that §9 deliberately keeps out of the audit log, and it contradicts "no credential is ever
attached".

Destination ports are restricted to 80, 443, and any port explicitly named in the allowlist.

### 6.3 The destination check runs at delivery, and the validated address is what gets connected

An allowlist, not a boolean. `EVENT_EGRESS_ALLOW` names the destinations that may resolve into
otherwise-denied space — `n8n:5678`, or a CIDR — and is empty by default.

An earlier draft had a single `EVENT_EGRESS_ALLOW_PRIVATE=true`, which is worse than it looks. The
spec itself said the opt-out "is the primary use case", so it would be on in most deployments — and it
grants **all** of RFC1918, ULA and CGNAT to reach *one* host. That opens the Kubernetes API server on
a ClusterIP, kubelet on :10250, every internal admin panel, and — because CGNAT is in scope — Alibaba
Cloud's metadata service at `100.100.100.200`, which the unconditional denylist does not name. Same
operator effort, three orders of magnitude more surface.

**Denied unconditionally, allowlist or not:** loopback, link-local (`169.254.0.0/16`, `fe80::/10`),
unspecified (`0.0.0.0`, `::`), and multicast. `169.254.169.254` is the cloud metadata endpoint; no
legitimate webhook lives there, and no configuration makes reaching it the operator's intent.

**Resolution and connection are bound together.** `dns.lookup(host, { all: true })` resolves, every
returned address is classified, and then the **validated address is handed to the connection itself**
via `node:https`'s `lookup` option — so the socket connects to the address that was checked, not to
whatever a second resolution returns. This closes the DNS-rebinding window at the cost of not using
`fetch`; it needs no new dependency, and it is also what gives §6.4 its bounded read. An earlier draft
priced this at "a direct undici dependency" and accepted the window instead. That was wrong on the
price and, given the threat model above, wrong on the acceptance.

Address classification normalises before comparing. `::ffff:169.254.169.254`, decimal and octal IPv4
literals, and a trailing dot on the hostname are all cases in the unit table (§13), because a
classifier that is correct only for canonical input is not a classifier.

### 6.4 Bounds, and why no response body is kept

A 10-second timeout. The response body is **read to a bound and discarded**: `event_delivery` records
`last_status_code` and a fixed reason phrase, never bytes the receiver chose.

Three reasons, any one sufficient. A receiver that echoes its input would put requester personal data
into a column `purgeRequester` cannot reach (§2.3). A slowloris or a multi-gigabyte response defeats a
`await res.text()`-then-`slice` bound, because that buffers first. And with §11's inline test send, a
stored response body turns an admin-triggered request into an **SSRF read primitive** — 2 KB of any
HTTP response reachable from the container, returned through the admin UI.

Operators who need the body for debugging get it in a log line, which is not a table and is not
subject to erasure guarantees.

---

## 7. Signing

Note §6 rules out signing a stored payload once and replaying it, because a retry re-renders from
live state and is not byte-identical. **Each attempt is signed over the body it actually sends.**

### 7.1 The secret is derived, not stored

```
secret(endpoint) = HMAC-SHA256(EVENT_SIGNING_KEY, `${endpoint.id}:${endpoint.secret_version}`)
```

`event_endpoint` has **no secret column**. What this buys is narrower than an earlier draft claimed,
and worth stating accurately: it is *not* true that this would be the codebase's only readable-back
secret — `subscription.manage_token` is stored unhashed today, with its own written rationale. What
derivation actually buys is that **a database-only compromise yields no signing material**: a leaked
backup, a read replica, or a SQL-injection read gives an attacker every endpoint row and still no
ability to forge a signature. That threat is real and the property is worth the machinery.

`secret_version` buys per-endpoint rotation without rotating the root: bumping one integer re-keys one
endpoint. Rotating `EVENT_SIGNING_KEY` rotates every endpoint at once, which is the right behaviour
for a compromised root.

**A key-change canary.** `HMAC(EVENT_SIGNING_KEY, 'canary')` is stored in a `setting` row on first
use. If it stops matching, delivery halts and the admin UI says why. Without it, restoring a backup
into an environment with a different or absent key silently re-keys every endpoint and nothing
detects it — which is the one property a stored secret gets for free and derivation otherwise loses.
One row, and it converts a silent failure into a loud one.

**`EVENT_SIGNING_KEY` is required when any endpoint uses `format = 'generic'`.** It stays optional for
`teams`, because Teams verifies nothing and a Teams-only operator should not manage a key they cannot
use.

An earlier draft made it globally optional "in the same sense `SMTP_URL` is". That analogy is wrong in
the way that matters: `SMTP_URL` absent means *nothing happens*, while a missing signing key means
*the thing happens without its security property* — a payload carrying a prospect's name and address,
POSTed to an HTTP endpoint with no authentication.

**Enforced at save time, and at boot as a delivery halt rather than an exit (plan C4).** The draft
said "validated at save time and at boot", by analogy with `OIDC_CLIENT_SECRET`, which refuses to
boot. That analogy breaks on a detail: `parseConfig` has no database, and this precondition is a
*database row*. Enforcing it in `hooks.server.ts`'s init means one `format = 'generic'` row plus an
unset key exits the process on start — and the only way to fix either the row or the key is the admin
UI that the container serves. That is a bootstrap deadlock: a database row must not be able to brick
the container that serves the only surface for repairing it.

So: a hard refusal in the admin action at save time, and at boot the same treatment as a canary
mismatch — delivery halts, the reason is logged and surfaced in the admin UI, and the container stays
healthy.

### 7.2 Headers, and the rotation overlap

```
Content-Type:              application/json
X-Trust-Center-Event:      access_request.pending
X-Trust-Center-Delivery:   <event_delivery.id>
X-Trust-Center-Signature:  t=1756900000,v1=<hex>[,v1=<hex-previous>]
```

The signature covers `${t}.${body}`. `t` is seconds since epoch, and a consumer should reject a
timestamp outside a tolerance of a few minutes. Our own retries span at most fifteen minutes but each
attempt re-signs with a fresh `t`, so a tight consumer tolerance does not conflict with our backoff.

**Rotation emits both signatures for a grace period** — the new secret and the one for
`secret_version - 1` — which the comma-separated header format already accommodates and which is what
consumer libraries expect. Without it a rotation makes every consumer return 401 until it is updated,
and §5.3 makes 401 terminal on the first attempt.

**`X-Trust-Center-Delivery` is load-bearing, not decoration.** Because retries re-render, a consumer
*cannot* deduplicate on a body hash. The delivery id is stable across every attempt of the same
`(endpoint, audit_seq)` pair, so it is the idempotency key, and `docs/self-hosting.md` says so
explicitly rather than leaving a consumer to discover it.

---

## 8. The erasure boundary

Stated here and, per note §6, in `docs/self-hosting.md` when this ships:

> An event that leaves this application has left the reach of its erasure mechanism. `purgeRequester`
> clears personal data from this database and from mail queued but not yet sent; it cannot reach an
> n8n execution history, a Teams channel, or a CRM record that an earlier delivery caused to be
> written. Those are your systems, on your subprocessor list, and your Art. 17 obligation reaches
> them exactly as it reaches the HubSpot record your automation wrote.

This is a boundary statement, not a qualification on what the product claims. Note §6 settles the
point: the claim in the README is about what the application holds and controls, it is true
unqualified, and bolting an asterisk onto a true statement to describe someone else's processor makes
it read as weaker than it is.

**What the application guarantees on its own side, stated with its actual precondition.** Nothing is
at rest (§2.3), and a delivery whose subject is purged **before that delivery is first attempted** is
`skipped` rather than sent (§4.5).

The precondition is not decorative, and an earlier draft's unqualified "a purge renders blanks" was
wrong. §7.2 makes the delivery id an idempotency key precisely because retries re-render — so a
consumer that dedupes as instructed **keeps the first attempt**. If attempt 1 went out before the
purge and attempt 2 after it, the consumer already holds the pre-purge payload and correctly discards
the second. That is a consequence of at-least-once delivery, not a defect in the purge, and it is
exactly the boundary the paragraph above describes: once it has been delivered, it is theirs.

---

## 9. Egress writes no audit events

This is a loop-prevention rule, not a stylistic preference.

An audit event written on delivery success or failure would match its own endpoint's filter, fan out
into a new `event_delivery`, deliver or fail, write another audit event, and recur — an unbounded
loop whose first symptom is an operator's Teams channel filling at 15-second intervals.

**Stated as a property of the table, because that is where the next contributor will break it:** no
audit event is written for *any* mutation of `event_endpoint` or `event_delivery` performed by the
egress job, with the single exception of `event_endpoint.disabled`. The job mutates the endpoint row
routinely — `last_success_at`, `cursor_seq` — and a later contributor adding a generic "endpoint
changed → record `event_endpoint.updated`" helper, or a trigger, reintroduces the loop without
touching the delivery path. §13 asserts the counting version: a day of failures produces exactly one
audit event, not one per failure.

The `disabled` exception is safe because by the time it is written that endpoint is disabled and
cannot deliver it. Another endpoint delivering it is desirable: "your Teams endpoint just went down"
is exactly the notice an operator wants in the channel that still works.

Admin management of endpoints is audited normally and is egress-eligible:

- `event_endpoint.created`
- `event_endpoint.updated`
- `event_endpoint.deleted`
- `event_endpoint.disabled`

Action names are permanent once written — the convention `translationAction()` and
`resolveMetaAction()` own — so these four are decided here, before the first row exists. All four
carry `subjectType: 'event_endpoint'` and the endpoint id as `subjectId`, so the endpoint is found by
the existing `audit_event_subject_idx` rather than by digging through `meta`. `meta` carries the name
and format, and — on `event_endpoint.disabled` — the reason and the last status code.

`meta` does **not** carry the URL. A URL has a query string, a Teams Workflows URL carries its shared
secret *in* that query string, and §6.2 admits userinfo only to reject it — writing any of that to an
append-only table would put a credential somewhere nothing can delete it from.

### 9.1 High-frequency events are the operator's to choose, with the consequence stated

`document.downloaded` is registered (§4.2) and is not throttled. One grant holder working through
forty documents produces forty cards, which §5.5's own reasoning ("a channel flooded with stale cards
is worse than a gap") suggests an operator will regret.

Throttling it here would be this subsystem deciding what an operator's channel should contain, which
is note §2's line. Instead the admin UI warns when a filter selects an action whose 7-day rate exceeds
a threshold, and `docs/self-hosting.md` names the high-frequency actions. The operator chooses; they
are told what they are choosing.

---

## 10. Telemetry

Following the conventions subsystem C established (`2026-09-02-otel-egress-design.md`), including
§8's rule that telemetry never carries an address, name, company, IP, token or query string.

**Spans.** `event fanout` and `event deliver`, instrumented by wrapping rather than reindenting, so
git blame survives.

| Attribute | Notes |
| --- | --- |
| `egress.endpoint_id` | The endpoint's UUID. Bounded, non-identifying, joinable to the admin UI |
| `egress.action` | The audit action. A bounded vocabulary |
| `egress.format` | |
| `egress.attempt` | |
| `http.response.status_code` | On `event deliver` |
| `egress.enqueued` | On `event fanout` |

**The endpoint's `name` is not an attribute, and neither is the URL or its host.** A host can be a
literal IP address, and §8 bans IP addresses from telemetry outright — an attribute whose value is
*sometimes* an IP cannot be sanitised into compliance. That is C's carry-over §1.1 reasoning for
dropping `server.address`, and it applies to `name` for the same reason: it is unvalidated operator
free text, and an operator who names an endpoint after its URL or a contact address puts exactly that
into a metric label. The UUID costs one lookup and is not a judgement call.

**Metrics**, on the `trustcenter.*` convention already in `metrics.ts`:

- `trustcenter.egress.delivery` — counter, by `outcome` and `egress.endpoint_id`
- `trustcenter.egress.delivery.duration` — histogram
- `trustcenter.egress.queue.depth` — observable gauge, mirroring `trustcenter.mail.queue.depth`

`tests/helpers/telemetry.ts`'s `expectNoSensitiveAttributes` states the §8 rule once; these tests use
it rather than hand-rolling the assertion.

---

## 11. Admin surface

`/admin/settings/integrations` (list) and `/admin/settings/integrations/[id]` (edit).

The list shows name, format, destination **host only**, enabled/disabled with reason, last delivery
outcome, and pending depth. The edit page covers name, URL, format, filter patterns, revealing the
derived secret, bumping `secret_version`, enabling and disabling — and **send test event**.

The test send renders a synthetic model and delivers it inline, bypassing the cursor, the filter and
the queue. It is the only way an operator learns their URL is wrong before a real access request does.

**It does not bypass §6.3, and it does not bypass the kill switch.** The destination check, the
scheme and port restrictions, the redirect refusal, §6.4's discard-the-body rule and
`EVENT_EGRESS_ENABLED` all apply unchanged — an inline, admin-triggered request that skipped them
would be a hand-built SSRF probe with a UI. The three things it bypasses are named exhaustively
above; nothing else is bypassed. With the switch off the test send reports `egress_disabled` and
opens no socket, because §1.1's claim is that nothing leaves the container, and an admin-triggered
send is not an exception to it.

Its `action` is `egress.test`, which is deliberately **not** an audit action: nothing writes it to
`audit_event`, no filter can match it, and it is therefore outside the permanent-name convention §9
records. It exists only on the wire, so a consumer can branch on it and discard it.

**These two routes gate on `role === 'admin'`, and it is not a deviation (plan C2).** An earlier draft
justified this at length as one, believing no page below the admin layout checked `role`.
`/admin/audit` already does exactly this, and `ADMIN_SECTIONS` already carries an optional `role`
documented as *"the nav hides what the route would refuse, so an approver is never offered a link
that 403s."* This is an established two-part pattern and both halves are required here: the route
refuses, and the nav entry carries `role: 'admin'` so the link is never offered.

The reason it applies is one sentence: an endpoint URL is where a prospect's name and address get
sent, and §6's threat model is explicitly the compromised admin, so it is a different kind of object
from a FAQ entry.

---

## 12. Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `EVENT_EGRESS_ENABLED` | `false` | Deploy-time switch. With it off, no endpoint delivers anything (§1.1) |
| `EVENT_SIGNING_KEY` | unset | ≥32 characters. Required when any endpoint uses `generic` (§7.1) |
| `EVENT_EGRESS_ALLOW` | empty | Hosts or CIDRs permitted to resolve into otherwise-denied space (§6.3) |

`EVENT_EGRESS_ENABLED` exists so the sovereignty claim stays verifiable from the environment even
though endpoints live in the database (§1.1), and so there is a kill switch that is not `RUN_JOBS=false`
— which would also stop mail.

Three variables and no more. The timeout, the batch sizes, the attempt count, the backoff schedule and
the 24-hour disable window are constants: none of them is a thing an operator has information to tune,
and every knob is a support conversation.

Parsed through `config/parse.ts`, which means `pnpm build` under `env -i` continues to work — this
subsystem adds no import-time requirement and no eager connection.

**"Like everything else" was not accurate, and the precedent matters here.** `RUN_JOBS` and
`RUN_MIGRATIONS` are read straight from `process.env` in `hooks.server.ts`, not through the schema, so
the two existing run-flags are exactly the wrong model to copy. `EVENT_EGRESS_ENABLED` goes in
`parse.ts` regardless — it is consulted on every delivery rather than only at boot, so it wants to be
validated once and read from a typed config rather than re-parsed from a string per tick — and in
doing so it becomes the schema's **first boolean**. The two run-flags stay outside it because they are
read before config exists; that is worth a comment at the boolean helper rather than a silent
inconsistency.

---

## 13. Testing

**Unit** (no database):

- Filter matching: `a.*` matches `a.b` and `a.b.c`; does not match `a`; does not match `ab.c`. The
  `staff.login_failed` case specifically, which is the `LIKE`-underscore trap (§4.1).
- Secret derivation: deterministic for a given `(id, version)`; a version bump changes it; a
  different id changes it. The canary comparison (§7.1).
- Signature header format, the signed input `${t}.${body}`, and the two-signature rotation header.
- The SSRF address classification table, including `::ffff:169.254.169.254`, decimal and octal IPv4
  literals, `0.0.0.0`, `::`, `100.100.100.200`, and a trailing-dot hostname — with an empty allowlist
  and with a populated one. URL rejection: userinfo, non-http(s) scheme, disallowed port.
- Both formatters, including that the Teams envelope declares card version 1.4, contains no external
  references, and **escapes markdown** in every rendered string (§3.3).
- The backoff schedule, and the retry classification table (§5.3).

**Integration** (Testcontainers Postgres, plus a new `tests/helpers/webhook-server.ts` fixture):

- Fan-out inserts one delivery per matching event, respects the filter, and advances `cursor_seq` to
  the highest seq **scanned**.
- A new endpoint's cursor starts at the current maximum and its first tick delivers nothing.
- Each retry transition, and that a 404 fails on attempt one.
- Auto-disable after 24 hours without a success, with the audit event written.
- A disabled endpoint neither fans out nor delivers.
- Both re-enable paths: catch-up delivers the backlog, skip marks it `skipped` and delivers nothing.
- Fan-out pauses above a pending depth of 1000 and resumes as the queue drains (§5.2).
- Round-robin: one black-holing endpoint does not prevent another endpoint's delivery in the same tick.

Four of these carry the load-bearing claims of this document, and each is written as a guard that is
deleted so the test can be watched failing before it is claimed to defend anything:

1. **The visibility watermark.** Fan out while a transaction holding a *lower* `seq` is still open,
   then commit it. The event must be delivered, not skipped. Against a naive `seq > cursor` scan this
   fails — that is the point (§5.2).
2. **A purged subject is `skipped`, not blanked.** No request is made, and the delivery is terminal
   (§4.5).
3. **A failed delivery writes no audit event**, and a day of failures writes exactly one — the
   counting version, which is what catches a reintroduced loop (§9).
4. **A hostname resolving to `169.254.169.254` is refused at delivery time**, not only on save, and
   the connection is made to the validated address (§6.3).

Any assertion of the form `.some(…) === false` pins the collection's size first. This is a trap the
OTel branch shipped three times before it was caught: an empty array satisfies such an assertion.

**e2e:** admin CRUD for an endpoint. `tests/e2e/security.spec.ts` is unchanged and must stay so —
its claim is that the *portal* makes no browser-side third-party requests, which server-side egress
does not touch.

---

## 14. Documentation

- **New section in `docs/self-hosting.md`**: what an endpoint is, the three environment variables,
  the payload shapes, a signature-verification recipe a consumer can paste, the rotation overlap, the
  delivery id as the idempotency key, which actions are high-frequency (§9.1), the `skipped`-on-purge
  contract (§4.5), and the §8 boundary statement.
- **`docs/self-hosting.md` §9 ("What this deployment does not send anywhere") is amended.** It stops
  being unqualifiedly true the moment an endpoint exists. The amendment must say, in the same
  paragraph, that egress is off unless `EVENT_EGRESS_ENABLED` is set, and that the browser-side claim
  is unchanged and still enforced by `tests/e2e/security.spec.ts` — otherwise a reader takes the
  amendment for a retreat from the whole section rather than an addition to it.
- **The decomposition note's §5 and §9 A** get a line pointing at this document as governing, and §5
  specifically is marked corrected by §5.2 here, since B would otherwise inherit the defect. §5 must
  cite the **plan's C1** as well as §5.2, because this document's own first fix was also insufficient.

Written 2026-09-04. Two additions the list above did not anticipate, both because writing the
operator-facing text is what surfaced them:

- **The three variables also go in `docs/self-hosting.md` §3**, whose title is "Every environment
  variable". A subsystem section further down does not make that title true, and §3 is where an
  operator configuring a deployment actually looks.
- **The derived secret is revealed as hex and must be decoded to bytes** before use as an HMAC key.
  The recipe says so explicitly: it is the one mistake that produces a signature mismatch with
  everything else correct.

---

## 15. What this subsystem does not do

Recorded so the absences are decisions rather than oversights.

- **No inbound anything.** Endpoints are write-only. Approve-from-Teams is an inbound action and
  belongs to D, which has the token model for it.
- **No per-endpoint payload templating.** An operator-supplied template would put a template engine
  in the egress path, with the injection surface that implies, to buy configurability nobody asked
  for. A new formatter is a pull request, and that is the right size for the decision.
- **No delivery ordering guarantee.** Fan-out is ordered by `seq` and retries are rare, so order is
  natural in practice — but a retried event can land after a later one, and nothing here promises
  otherwise. A consumer that needs order has `at` and `seq` (§4.4).
- **No `Retry-After` on 5xx.** Only on 429, where it is a rate-limit signal. On a 5xx it is a server
  guessing about its own recovery, and our backoff is already the right answer.
- **No response body capture** (§6.4), and therefore no "why did it fail" detail beyond a status code
  in the UI. The log line has more.

---

## 16. Known residuals

- **Delivery is delayed by a long-running transaction** (§5.2). Bounded by the longest transaction in
  the system, and the correct direction to fail.
- **A consumer deduplicating on the delivery id keeps a pre-purge payload** (§8). Inherent to
  at-least-once delivery, and on the operator's side of the boundary.
- **`EVENT_EGRESS_ALLOW` is trusted once set.** An operator who allowlists a broad CIDR gets what they
  asked for; the design narrows the default, it does not second-guess an explicit choice.
- **A row frozen by vacuum before it is consumed sorts below any cursor** (§5.2). `xmin` becomes `2`,
  which is below every live cursor, so the row is never delivered. Only reachable for rows older than
  `vacuum_freeze_min_age` — 50 million transactions — which are long consumed on any deployment that
  has ever run the job. Recorded rather than defended against, because the defence would cost a
  column on `audit_event`.
- **Endpoint creation and skip-the-backlog both jump the cursor over events in flight** (§2.1, §5.5).
  A transaction that has not yet committed when the cursor is set to the current horizon commits
  below it and is never delivered. This is the same hazard the keyset exists to prevent, and it is
  harmless in both places because "do not replay history" is precisely what was asked for — but it is
  a jump, not a consume, and the two are worth distinguishing when reading §5.2.
- **The fan-out window scan is sequential, once per enabled endpoint per tick.** `xmin` is a system
  column and not an immutable expression, so it cannot be indexed. At a trust center's volume —
  thousands of audit events a month, a handful of endpoints — that is sub-millisecond every fifteen
  seconds. Past roughly **a million `audit_event` rows**, add a `seq > cursor_seq - N` bound and
  record the bounded gap it introduces. Do not add it speculatively.
- **A 30-day-swept delivery row can be re-enqueued by an `xmin` bump** (§5.6, §5.2). The replay guard
  is `ON CONFLICT DO NOTHING` against `(endpoint_id, audit_seq)`, which needs the row to still exist;
  once retention has swept it, `purgeRequester`'s `UPDATE audit_event` bumps that event's `xmin` and
  fan-out sees it as new. Inert in practice: a purge is exactly what makes the enricher return
  `skipped`, so the re-enqueued row is terminated without an HTTP request. Both halves are
  spec-mandated, so this is a residual rather than a defect.
- **`body_too_large` is declared in the error-reason set and never produced.** A response exceeding
  the 8 KiB cap is destroyed and the status code alone decides the outcome (§6.4), so no code path
  writes this reason. Harmless — an unreachable member of a closed set — but a reader should not go
  looking for the branch that sets it.

---

## 17. Revision history

**2026-09-03, after adversarial review.** The review is summarised here because several changes
reverse things the first draft argued for at length, and a reader who finds only the new reasoning
would not know a considered position was overturned.

| Changed | Was | Now |
| --- | --- | --- |
| §5.2 | `WHERE seq > cursor` | xmin-horizon watermark. The naive scan **silently drops events** committed out of seq order, which `recordEvent(tx, …)` makes routine. Corrects note §5; B inherits the fix. |
| §4.2 | `access_request.pending` absent | Registered. It is the event the stated requirement is about; the table is now walked against grep, not memory. |
| §4.3 | `access_request.submitted` enriched | Not enriched. Its data is unverified public-form input, so enriching it aimed a public form at the operator's staff channel and CRM. |
| §4.5, §8 | "A purge renders blanks, which is correct" | `skipped`. Blanks are indistinguishable from "a person with no name" and corrupt a consumer's records. §8 now states the erasure claim's real precondition. |
| §6.4, §2.3 | Up to 2 KB of response body in `last_error` | Status code and a fixed phrase. The body would have been a second purge path, an unbounded read, and an SSRF read primitive via §11. |
| §5.1 | Inherited `mail:drain`'s use of `runJob` | Lock released before any HTTP call; round-robin across endpoints. The lock connection would otherwise sit `idle in transaction` for minutes. |
| §5.4 | 10 consecutive failures | No success in 24 h. The counter was simultaneously too slow (low volume) and too fast (one batch could disable on a key rotation). |
| §6.3 | `EVENT_EGRESS_ALLOW_PRIVATE` boolean; rebinding accepted | Allowlist; rebinding closed via `node:https`'s `lookup`. The boolean granted three RFC ranges to reach one host, and closing rebinding needs no new dependency. |
| §7.1 | Key globally optional; "the only readable-back secret" | Required for `generic`; premise corrected (`subscription.manage_token` already is one), with the real benefit — no signing material in a database compromise — stated instead. Canary added. |
| §7.2 | Single signature | Overlap window during rotation, without which rotation trips §5.3 and §5.4. |
| §1.1, §12 | Unstated | The rows-not-env choice is now justified in the document, and `EVENT_EGRESS_ENABLED` keeps the sovereignty claim environment-verifiable. |
| §10 | `egress.endpoint` carried the name | `egress.endpoint_id`. Operator free text in a metric label is C's carry-over §1.1 problem again. |

Two review findings were **not** adopted:

- **Rebuild as env-vars-only, deleting ~70% of this document.** The argument is sound where its
  premises hold, and §1.1 now states why they do not here: multiple destinations are a near-term
  need, and reconfiguration by non-deployers is a requirement. `EVENT_EGRESS_ENABLED` addresses the
  strongest part of the objection — that the sovereignty claim should stay verifiable from the
  environment — without giving up the rest.
- **Drop the first-party Teams formatter.** Microsoft's ingestion contract does churn, and that
  maintenance is real. But Teams is a named day-one requirement, a formatter holds no credential and
  calls no vendor API, and §3.3's registry makes it a contained cost. Revisit if the envelope changes
  a second time.

---

## 18. Revision history — 2026-09-03, after implementation

§17 records what an adversarial review of this document changed before anything was built. This
section records what **building it** changed. The distinction matters to a reader: everything below
was found by the code refusing to work as specified, not by argument, and five of these reverse
positions §17 had already settled once.

The corrected behaviour is what shipped. Where an older reading of a section survives anywhere, this
table governs.

| Changed | Was | Now |
| --- | --- | --- |
| §5.2, §2.1, §1.2 (**C1**) | `seq` high-watermark below the xmin horizon, advancing to the highest `seq` scanned | Composite `(xmin, seq)` keyset, advancing to the last row returned. The stated invariant was **false** — `xmin < horizon` also excludes rows from transactions that started later and committed already, which can hold a lower `seq`. Advancing to "lowest excluded seq − 1" repairs the visible case and not the invisible mirror of it, so a `seq` watermark cannot be made exactly correct. B inherits the keyset, not the scan. |
| §11 (**C2**) | The `role === 'admin'` gate is a deviation, justified at length | Not a deviation. `/admin/audit` already gates this way and `ADMIN_SECTIONS` already carries `role`; it is an established two-part pattern, and the nav half is required too. The justification shrinks to a sentence. |
| §5.1 (**C3**) | The two-phase tick expressed as a `JOBS` entry | Not expressible as one. `runJob` wraps the body in the lock's transaction and `startJobRunner` passes the pool, so nesting is worse — postgres-js turns the inner transaction into a savepoint and holds the advisory lock until the outer one ends. `Job` grows an optional `afterLock` phase. |
| §7.1 (**C4**) | `EVENT_SIGNING_KEY` required "at save time and at boot", like `OIDC_CLIENT_SECRET` | Save-time refusal, and at boot a **delivery halt**, not an exit. `parseConfig` has no database and the precondition is a database row, so a boot exit lets one row brick the container that serves the only UI for fixing it. |
| §4.2, §4.5 (**C5**) | `document.downloaded` carries "requester identity"; a subject that does not resolve is `skipped` | Three cases, not two. The public path is cookie-free and writes a null actor, so an anonymous download is **delivered** with `verified: false`; only a purged requester or a missing subject row is `skipped`. Its subject is a `document_file`, which the enricher resolves to a document for the title. |
| §5.4 | `last_success_at` against `now()` | `coalesce(last_success_at, created_at)`. NULL compared against `now()` is NULL, so an endpoint that had never succeeded would never disable — the dead-endpoint case the section exists for. |
| §4.5 | "Egress now has that step too, and it is the same step" | The check lives in the **enricher only**; `purgeRequester` is unmodified. The signal is `purged_at IS NOT NULL`, not blank columns — a purge writes `purged-<id>@invalid`, so testing for an empty email gets the field a CRM upserts on wrong. |
| §12 | `EVENT_EGRESS_ENABLED` parsed "like everything else" | `RUN_JOBS` and `RUN_MIGRATIONS` are read straight from `process.env`, so the run-flags are the wrong precedent. It goes in `parse.ts` and becomes the schema's first boolean. |
| §2.1, §5.5 | Cursor initialisation stated as "start at the maximum" | Stated exactly: creation and skip-the-backlog both **jump** the cursor to the current horizon, so a transaction in flight commits below it and is never delivered. Harmless and intended; now in §16 rather than rediscovered. |
| §16 | Three residuals | Eight. Added: the frozen-`xmin` row; the two cursor jumps; the sequential window scan with the row count at which to bound it; the swept-row re-enqueue; and `body_too_large`, a declared error reason nothing produces. |
| §11, §1.1 | The test send enforces §6.3 | It enforces `EVENT_EGRESS_ENABLED` too. It never read the switch, so an admin could make a deployment with egress off call out to an operator-supplied host — the one claim §1.1 makes to a procurement reviewer. Enforced inside `postEvent` rather than at the call site, because the call site is what omitted it; `egress_disabled` joins the reason set. |
| §6.3 | Each caller validates the stored URL before handing it to `postEvent` | `postEvent` validates it. `deliverClaimed` called `validateEndpointUrl` inside its per-row loop but outside any `try`, so one stored URL the allowlist no longer admitted threw out of the whole batch, abandoning every row claimed after it and repeating every tick. A refusal is now that one delivery's terminal failure, reason `url`. |
| §4.2, §3.2 | `document.downloaded`'s title read from the translation matching the **file's** locale | Resolved through `pickTranslation` against the context locale. The old join put a German title in an English-speaking team's channel because of which rendition a requester clicked — §3.2's stated failure, arrived at through the subject rather than the actor. A document with no title in the operator's locale still falls back to the slug, whatever other locales it carries. |

Two things this implementation did **not** change, recorded so they are not relitigated:

- **`sql.raw` array interpolation in the delivery and admin queries.** Flagged during review as
  unparameterised SQL. Recorded here as unchanged, and then changed: the post-implementation
  simplification passes moved three of the four sites — `claimDeliveries` and its retry-stamp update
  in `deliver.ts`, and the endpoint-id list in `endpoints.ts` — onto `sql.param` and `inArray` while
  they were being rewritten for other reasons. Every interpolated value was a uuid the database
  itself returned, so this closed no hole; it is recorded because the note above promised all four
  would go together and they did not. The fourth, `mail/queue.ts`, predates this subsystem and is
  deliberately untouched on an egress branch — it is the one site where the idiom still stands.
- **`outbound_email.last_error` stores raw SMTP messages** and survives both a purge and the
  retention window. Real, pre-existing, and unrelated to egress. Deliberately not fixed on this
  branch.

---

## Sources

Teams ingestion format, confirmed 2026-09-03:

- [Create an Incoming Webhook — Microsoft Learn](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
- [Migrating automated webhook systems from Office 365 Connectors to Power Automate Workflows](https://www.rickvanrousselt.com/blog/migrating-your-automated-webhook-systems-from-office-365-connectors-to-power-automate-workflows/)
- [How to Create a Microsoft Teams Webhook (Workflows, 2026)](https://webhookrelay.com/blog/microsoft-teams-webhook/)
