# Integrations subsystem A — Event egress — Design

**Date:** 2026-09-03
**Status:** Approved design. Governs subsystem A where it and
`2026-08-31-integrations-decomposition.md` differ.
**Author:** Moritz Friedrich (CISO, Matchory), with Claude
**Scoping note:** `docs/superpowers/specs/2026-08-31-integrations-decomposition.md`, §9 A
**Governing design:** `docs/superpowers/specs/2026-08-28-trust-center-design.md`

Section references of the form "§6.6" are to the governing design unless a document is named.
References of the form "note §6" are to the decomposition note.

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

### 1.1 How A differs from B, which will look similar

A and B share the spine note §5 describes — a consumer is a cursor over `audit_event.seq` — and §4's
free-form filter means an operator *can* point A at most of the log. The subsystems remain distinct
in delivery semantics, and the distinction is what each is allowed to assume:

|  | A — event egress | B — audit sink |
| --- | --- | --- |
| Unit of delivery | One event, one HTTP request | A batch, ordered |
| Content | Enriched from live domain state | The audit row, verbatim |
| Filtered | Yes, per endpoint | No |
| Latency | Seconds | Minutes to hours |
| On loss | Retried, then the endpoint disables | Must not lose anything, ever |

A is allowed to drop an event after five attempts and say so. B is not. Nothing in this document
should be read as B's design, and B should not be built by widening this one.

---

## 2. Data model

Three tables under a new module, `src/lib/server/egress/`. The noun is **endpoint** throughout:
`subscription` is already taken by the portal's update mailing list (`src/lib/server/db/schema/subscriptions.ts`),
and two unrelated concepts sharing a name in one schema is how a later reader joins the wrong table.

### 2.1 `event_endpoint`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | Also an input to the signing secret (§7) |
| `name` | text not null | The operator's label. Appears in telemetry (§10) |
| `url` | text not null | Validated on save, re-checked at delivery (§6.3) |
| `format` | text not null | Check-constrained to the formatter registry (§3.3) |
| `secret_version` | integer not null default 1 | Bumping it re-keys this endpoint alone (§7) |
| `enabled` | boolean not null default true | |
| `cursor_seq` | bigint not null | Initialised to `max(audit_event.seq)` at creation |
| `consecutive_failures` | integer not null default 0 | Zeroed by any delivery (§5.3) |
| `disabled_at` | timestamptz | |
| `disabled_reason` | text | |
| `created_at` | timestamptz not null default now() | |

**`cursor_seq` starts at the current maximum, not at zero.** A new endpoint must not replay eighteen
months of history into a Teams channel on its first tick. This is a one-line default with a
disproportionate failure mode, so it is stated here rather than left to the insert site.

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
| `id` | uuid pk | The idempotency key handed to the consumer (§7) |
| `endpoint_id` | uuid not null | Cascades |
| `audit_seq` | bigint not null | **A reference. Never a payload.** |
| `status` | text not null default `'pending'` | `pending \| delivered \| failed \| skipped` |
| `attempts` | integer not null default 0 | |
| `next_attempt_at` | timestamptz not null default now() | |
| `last_error` | text | At most 2 KB (§6.4) |
| `delivered_at` | timestamptz | |
| `created_at` | timestamptz not null default now() | |

Unique on `(endpoint_id, audit_seq)`, which makes fan-out idempotent, and a partial claim index on
`next_attempt_at where status = 'pending'` — the same shape and the same reason as
`outbound_email_claim_idx`: the index stays small as delivered rows accumulate.

**The row holds a reference to an audit event, not a rendered body.** This is the whole of note §6's
erasure story and the reason it is structural rather than maintained. `purgeRequester` needs no new
path: a purge landing between fan-out and delivery means the payload renders blank, which is the
correct outcome and not a special case. Had we enriched at fan-out time, `outbound_email`'s purge
path — which matches on `to` — would become the first of two such paths rather than the only one,
and a second one is the kind that rots silently when somebody adds a field.

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
	deliveryId: string;
	subject: { type: string; id: string } | null;
	actor: { type: string; id: string | null };
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
  "event": "access_request.approved",
  "at": "2026-09-03T10:12:00.000Z",
  "delivery_id": "0f3c…",
  "subject": { "type": "access_request", "id": "…" },
  "actor": { "type": "staff", "id": "…" },
  "summary": "Access request from Acme GmbH approved",
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
egress filter, which is exactly the class of bug this subsystem cannot afford. The fan-out predicate
is therefore:

```sql
WHERE seq > $cursor
  AND (action = ANY($exact) OR EXISTS (
        SELECT 1 FROM unnest($prefixes) p WHERE starts_with(action, p || '.')))
ORDER BY seq
LIMIT 500
```

### 4.2 Enrichment: a registry, with a fallback

Actions with a registered enricher get an `EventModel` whose `data` is read from **live domain
state at delivery time** — note §6's settled rule. Registered at first ship:

| Action | `data` carries |
| --- | --- |
| `access_request.submitted` | requester name, email, company, domain; requested tiers and document count |
| `access_request.approved` | the above, plus grant id, term days, expiry, outstanding agreements |
| `access_request.denied` | the above, plus the reason |
| `access_request.info_requested` | the above |
| `access_grant.revoked` | requester identity, grant id, what it covered |
| `nda_acceptance.recorded` | requester identity, template and version |
| `document.downloaded` | requester identity, document title and tier |

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

### 4.3 A purged requester renders blank

`purgeRequester` clears the domain columns the enrichers read. An event delivered after a purge
therefore carries empty identity fields, and this is the intended behaviour, not a degradation to
handle. It is asserted by an integration test (§11) because it is the load-bearing claim of note §6.

---

## 5. Delivery, retry and failure

### 5.1 One job

`egress:deliver`, every 15 s — matching `mail:drain`, on the same reasoning: a magic link a minute
late is a person waiting, and a Teams notice fifteen minutes late is a defect. Each tick, per enabled
endpoint:

1. **Fan out.** Scan `audit_event` from `cursor_seq` (§4.1, `LIMIT 500`), insert an `event_delivery`
   row per matching event, and set `cursor_seq` to the highest seq **scanned** — not the highest
   matched. Advancing only past matches would re-scan every unmatched event on every tick forever.
2. **Deliver.** Claim due rows `FOR UPDATE SKIP LOCKED`, `LIMIT 25`, exactly as `drainOutbox` does,
   then POST each and record the outcome.

Overlapping ticks need no new machinery: a second tick takes a different pooled connection, so
`pg_try_advisory_xact_lock` returns false and it skips. A slow tick makes the job less frequent, not
concurrent.

**Fan-out is skipped for an endpoint whose pending depth already exceeds 1000.** Without this the two
limits fight: 500 fanned out per tick against 25 delivered per tick means a catch-up over a long
backlog grows `event_delivery` twenty times faster than it drains it. The cursor is the backlog's
durable record, so pausing fan-out loses nothing — it makes catch-up self-paced, and it bounds the
table by a number rather than by however long the endpoint was down.

### 5.2 Retry classification

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

### 5.3 Auto-disable

`consecutive_failures` increments on each terminal failure and is zeroed by any delivery. At **10**,
the endpoint is disabled: `enabled = false`, `disabled_at`, `disabled_reason`, and one audit event
(§9).

A counter on the endpoint rather than a query over `event_delivery`: the meaning wanted is "ten
terminal failures with no success in between", which is what the counter states exactly, and it costs
no scan.

### 5.4 A disabled endpoint neither fans out nor delivers

Its cursor stalls. The alternative — continuing to fan out while disabled — accumulates two days of
deliveries and floods the channel with stale cards the moment somebody re-enables it.

Stalling makes re-enabling an explicit choice, with the backlog count in front of the operator:

- **Enable and catch up** — resume from `cursor_seq`, bounded by the 500-row fan-out per tick.
- **Enable, skipping the backlog** — jump `cursor_seq` to the current maximum; queued rows go
  terminal as `skipped`.

Skipping is the option the UI presents first. A channel flooded with two days of stale notices is
worse than a gap, and `audit_event` remains the record of record under either choice — nothing is
lost, only un-notified. `skipped` exists as a status rather than being a delete so that the gap is
visible afterwards.

### 5.5 Retention

Terminal `event_delivery` rows older than 30 days are swept by the existing `retention:sweep` tick.
Folded in there rather than becoming an eighth timer, for the reason the subscription sweep was
folded in: the interval is right and a tick that finds nothing costs one indexed query.

---

## 6. The egress client, and SSRF

Note §7: operator-configurable webhook URLs are server-side request forgery by construction. The
feature being admin-only bounds this but does not remove it. The delivery client is therefore not a
general HTTP client and is not reusable as one.

### 6.1 No redirects

`redirect: 'manual'`; any 3xx is a failure. A redirect is the cheapest way to launder a denied
destination into an allowed one, and no legitimate webhook receiver needs one.

### 6.2 Method and headers are fixed

`POST` only. The header set is closed (§7). No cookie jar, no credential is ever attached, and no
operator-supplied header is forwarded.

### 6.3 The destination check runs at delivery, not only on save

`dns.lookup(host, { all: true })`, and the destination is refused if **any** resolved address is
denied. Validation also happens on save, but only to give the operator an immediate error message:
DNS changes after you save, and the delivery-time check is the authoritative one. An integration test
asserts this at delivery time specifically (§11).

**Denied unconditionally:** loopback, link-local (`169.254.0.0/16`, `fe80::/10`), unspecified
(`0.0.0.0`, `::`), and multicast. `169.254.169.254` is the cloud metadata endpoint; no legitimate
webhook lives there, and there is no configuration under which reaching it is the operator's intent.

**Denied by default, permitted by `EVENT_EGRESS_ALLOW_PRIVATE=true`:** RFC1918, unique-local
(`fc00::/7`), and CGNAT (`100.64.0.0/10`).

That opt-out is not a weakening bolted on for convenience — it is the primary use case. An operator
running n8n beside the container points at `http://n8n:5678/webhook/…`, and a blanket private-range
denylist would break subsystem A's stated purpose on day one. Default-deny with a one-line opt-out
puts the decision where note §7 wants it: made once, deliberately, by the operator.

Address classification normalises before comparing. `::ffff:169.254.169.254`, decimal and octal IPv4
literals, and a trailing dot on the hostname are all cases in the unit table (§11), because a
classifier that is correct only for canonical input is not a classifier.

**Residual risk, recorded rather than papered over.** A hostname can resolve differently between the
lookup and the connect — DNS rebinding. Closing that window properly means an undici `Agent` with a
`connect` hook validating the socket's actual peer address, which would make undici a direct
dependency where it is currently only transitive. That trade is not worth taking for A alone; it
should be revisited when B wants the same client, at which point one hardened client serves both.

### 6.4 Bounds

A 10-second timeout via `AbortSignal.timeout`. At most 2 KB of the response body is read into
`last_error` — otherwise a 500 that returns an HTML error page lands in Postgres, on every attempt,
for every endpoint.

---

## 7. Signing

Note §6 rules out signing a stored payload once and replaying it, because a retry re-renders from
live state and is not byte-identical. **Each attempt is signed over the body it actually sends.**

### 7.1 The secret is derived, not stored

```
secret(endpoint) = HMAC-SHA256(EVENT_SIGNING_KEY, `${endpoint.id}:${endpoint.secret_version}`)
```

`event_endpoint` has **no secret column**. This is the one place this codebase would otherwise need a
secret it can read back: every other token here is hashed one-way (`magic_link`, both session tables,
`subscription.confirm_token_hash`), and a signing secret cannot be, because the signer must reproduce
it. Deriving it keeps that property — the database holds nothing that signs anything.

`secret_version` buys per-endpoint rotation without rotating the root: bumping one integer re-keys one
endpoint, and the operator re-reads the new value from the admin UI. Rotating `EVENT_SIGNING_KEY`
rotates every endpoint at once, which is the right behaviour for a compromised root and is documented
as such.

**With `EVENT_SIGNING_KEY` unset, deliveries go unsigned** and the admin page says so plainly. Teams
verifies nothing, so a Teams-only operator should not be made to manage a key they have no use for.
The key is optional in the same sense `SMTP_URL` is: absent is a supported configuration, not an
error to log every fifteen seconds.

### 7.2 Headers

```
Content-Type:              application/json
X-Trust-Center-Event:      access_request.approved
X-Trust-Center-Delivery:   <event_delivery.id>
X-Trust-Center-Signature:  t=1756900000,v1=<hex>          (omitted when unsigned)
```

The signature covers `${t}.${body}`. `t` is seconds since epoch, and a consumer should reject a
timestamp outside a tolerance of a few minutes. Our own retries span at most fifteen minutes but each
attempt re-signs with a fresh `t`, so a tight consumer tolerance does not conflict with our backoff.

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

The application's side of that boundary stays exact: nothing is at rest (§2.3), and a purge before
delivery renders blanks (§4.3).

---

## 9. Egress writes no audit events

This is a loop-prevention rule, not a stylistic preference.

An audit event written on delivery success or failure would match its own endpoint's filter, fan out
into a new `event_delivery`, deliver or fail, write another audit event, and recur — an unbounded
loop whose first symptom is an operator's Teams channel filling at 15-second intervals.

The single exception is `event_endpoint.disabled`, written once per disablement with actor `system`.
It is safe because by the time it is written that endpoint is disabled and cannot deliver it. Another
endpoint delivering it is desirable: "your Teams endpoint just went down" is exactly the notice an
operator wants in the channel that still works.

Admin management of endpoints is audited normally and is egress-eligible:

- `event_endpoint.created`
- `event_endpoint.updated`
- `event_endpoint.deleted`
- `event_endpoint.disabled`

Action names are permanent once written — the convention `translationAction()` and
`resolveMetaAction()` own — so these four are decided here, before the first row exists. All four
carry `subjectType: 'event_endpoint'` and the endpoint id as `subjectId`, so the endpoint is found by
the existing `audit_event_subject_idx` rather than by digging through `meta`. `meta` carries the name
and format, and — on `event_endpoint.disabled` — the failure count and last error.

`meta` does **not** carry the URL. A URL has a query string, and a Teams Workflows URL carries its
shared secret *in* that query string; writing it to an append-only table would put a credential
somewhere nothing can delete it from.

---

## 10. Telemetry

Following the conventions subsystem C established (`2026-09-02-otel-egress-design.md`), including
§8's rule that telemetry never carries an address, name, company, IP, token or query string.

**Spans.** `event fanout` and `event deliver`, instrumented by wrapping rather than reindenting, so
git blame survives.

| Attribute | Notes |
| --- | --- |
| `egress.endpoint` | The operator's label. Bounded cardinality — one value per endpoint row |
| `egress.action` | The audit action. A bounded vocabulary |
| `egress.format` | |
| `egress.attempt` | |
| `http.response.status_code` | On `event deliver` |
| `egress.enqueued` | On `event fanout` |

**No URL and no host.** A host can be a literal IP address, and §8 bans IP addresses from telemetry
outright — an attribute whose value is *sometimes* an IP cannot be sanitised into compliance. This is
the same reasoning that dropped `server.address` from the request span (subsystem C carry-over §1.1),
and it is why `egress.endpoint` carries the label rather than the destination.

**Metrics**, on the `trustcenter.*` convention already in `metrics.ts`:

- `trustcenter.egress.delivery` — counter, by `outcome` and `egress.endpoint`
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
the queue. It is the only way an operator learns their URL is wrong before a real access request
does, and it is worth the small amount of code that bypassing three things costs.

Its `action` is `egress.test`, which is deliberately **not** an audit action: nothing writes it to
`audit_event`, no filter can match it, and it is therefore outside the permanent-name convention §9
records. It exists only on the wire, so a consumer can branch on it and discard it.

**These two routes gate on `role === 'admin'`.** This is a deviation worth naming: the admin layout
gates on `locals.staff` only and no page below it checks `role` today. An endpoint URL is a
consequential thing for an `approver` to be able to edit — it is where a prospect's name and address
get sent — and it is a different kind of object from a FAQ entry. The deviation is confined to these
two routes; nothing else changes.

---

## 12. Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `EVENT_SIGNING_KEY` | unset | ≥32 characters. Unset means unsigned deliveries (§7.1) |
| `EVENT_EGRESS_ALLOW_PRIVATE` | `false` | Permits RFC1918/ULA/CGNAT destinations (§6.3) |

Two variables and no more. The timeout, the batch sizes, the attempt count and the backoff schedule
are constants: none of them is a thing an operator has information to tune, and every knob is a
support conversation.

Parsed through `config/parse.ts` like everything else, which means `pnpm build` under `env -i`
continues to work — this subsystem adds no import-time requirement and no eager connection.

---

## 13. Testing

**Unit** (no database):

- Filter matching: `a.*` matches `a.b` and `a.b.c`; does not match `a`; does not match `ab.c`. The
  `staff.login_failed` case specifically, which is the `LIKE`-underscore trap (§4.1).
- Secret derivation: deterministic for a given `(id, version)`; a version bump changes it; a
  different id changes it.
- Signature header format, and that the signed input is `${t}.${body}`.
- The SSRF address classification table, including `::ffff:169.254.169.254`, decimal and octal IPv4
  literals, `0.0.0.0`, `::`, and a trailing-dot hostname — under both settings of
  `EVENT_EGRESS_ALLOW_PRIVATE`.
- Both formatters, including that the Teams envelope declares card version 1.4 and contains no
  external references.
- The backoff schedule, and the retry classification table (§5.2).

**Integration** (Testcontainers Postgres, plus a new `tests/helpers/webhook-server.ts` fixture):

- Fan-out inserts one delivery per matching event, respects the filter, and advances `cursor_seq` to
  the highest seq **scanned**.
- A new endpoint's cursor starts at the current maximum and its first tick delivers nothing.
- Each retry transition, and that a 404 fails on attempt one.
- Auto-disable at ten consecutive failures, with the audit event written.
- A disabled endpoint neither fans out nor delivers.
- Both re-enable paths: catch-up delivers the backlog, skip marks it `skipped` and delivers nothing.
- Fan-out pauses above a pending depth of 1000 and resumes as the queue drains (§5.1).

Three of these carry the load-bearing claims of this document, and each is written as a guard that is
deleted so the test can be watched failing before it is claimed to defend anything:

1. **Enrichment after `purgeRequester` renders blanks** — §4.3, note §6's entire erasure story.
2. **A failed delivery writes no audit event** — §9, the loop rule.
3. **A hostname resolving to `169.254.169.254` is refused at delivery time**, not only on save —
   §6.3.

Any assertion of the form `.some(…) === false` pins the collection's size first. This is a trap the
OTel branch shipped three times before it was caught: an empty array satisfies such an assertion.

**e2e:** admin CRUD for an endpoint. `tests/e2e/security.spec.ts` is unchanged and must stay so —
its claim is that the *portal* makes no browser-side third-party requests, which server-side egress
does not touch.

---

## 14. Documentation

- **New section in `docs/self-hosting.md`**, beside the other operational sections: what an endpoint
  is, the two environment variables, the payload shapes, a signature-verification recipe a consumer
  can paste, the delivery id as the idempotency key, and the §8 boundary statement.
- **`docs/self-hosting.md` §9 ("What this deployment does not send anywhere") is amended.** It stops
  being unqualifiedly true the moment an endpoint exists. The amendment must say, in the same
  paragraph, that the browser-side claim is unchanged and still enforced by
  `tests/e2e/security.spec.ts` — otherwise a reader takes the amendment for a retreat from the whole
  section rather than an addition to it.
- **The decomposition note's §9 A** gets the same treatment §9 C got: a line pointing at this
  document as governing.

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
  otherwise. A consumer that needs order has `at` and the audit log.
- **No `Retry-After` on 5xx.** Only on 429, where it is a rate-limit signal. On a 5xx it is a server
  guessing about its own recovery, and our backoff is already the right answer.
- **No fan-out concurrency.** Deliveries within a tick are sequential. With a 10-second timeout and a
  batch of 25, a pathological tick runs long — and that is safe, because the next tick skips on the
  advisory lock rather than piling up. Concurrency is worth adding when an operator has enough
  endpoints for it to matter, and not before.

---

## Sources

Teams ingestion format, confirmed 2026-09-03:

- [Create an Incoming Webhook — Microsoft Learn](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook)
- [Migrating automated webhook systems from Office 365 Connectors to Power Automate Workflows](https://www.rickvanrousselt.com/blog/migrating-your-automated-webhook-systems-from-office-365-connectors-to-power-automate-workflows/)
- [How to Create a Microsoft Teams Webhook (Workflows, 2026)](https://webhookrelay.com/blog/microsoft-teams-webhook/)
