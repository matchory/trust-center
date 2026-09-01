# Trust Center Phase 4 — Notifications and Subscriptions — Design

**Date:** 2026-09-02
**Status:** Approved for planning
**Author:** Moritz Friedrich (CISO, Matchory), with Claude

Supplements `2026-08-28-trust-center-design.md`. Where the two disagree, this document wins for
Phase 4 and the main spec carries an amendment note pointing here. Everything below is a decision
with the reasoning that produced it, because the reasoning is what the implementation plan needs and
the status is not.

It also depends on `2026-08-31-integrations-decomposition.md`, which withdrew one of §11 Phase 4's
four bullets: outbound webhooks for Slack and Teams are consumers of subsystem A (event egress) and
are not built here. §3 records what that leaves.

---

## 1. Summary

Phase 4 makes the Trust Center able to tell people that something changed, without anyone having to
watch it. A visitor subscribes with an address and a choice of topics; a confirmation mail proves
they control the mailbox; from then on a job mails them the update posts that go live and match
their topics, in the locale they subscribed in. One permanent token opens a page where they change
those topics, change their locale, or leave.

It also closes the gap that gives this phase its regulatory weight. Advance notice of a subprocessor
change is frequently a contractual obligation in DACH data processing agreements and feeds NIS2
supply-chain expectations — but under Phase 1 nothing connects a subprocessor row to the post that
announces it, so a forgotten announcement is invisible. Phase 4 links the two and warns when the link
is missing.

---

## 2. What Phase 1 left

§11 Phase 4 lists four items. **One already shipped, and one is withdrawn.**

**Scheduled publishing exists.** `update_post.published_at` already encodes all three states in one
column — null is a draft, a future value is scheduled, a past value is live — and
`listPublicUpdates` already filters `published_at <= now()`. The admin editor already offers a
`datetime-local` field for it. Nothing about the composer needs building.

What that leaves is the reason it matters here: **a post going live on a schedule produces no
event.** Publication is a predicate over a timestamp, evaluated per read. There is no moment at which
anything happens, so there is nothing for a notifier to hook. §6 is the answer.

**Outbound webhooks are withdrawn**, per the integrations decomposition §8: they stop being two
connectors and become two consumers of subsystem A, which has its own unresolved payload question
(that note's §6) and is not planned yet.

Four things Phase 1–3 built are load-bearing here and are reused rather than reinvented:

| What | Where | Why it matters |
| --- | --- | --- |
| The double opt-in shape | `/request` → `verify_request` mail → `consumeMagicLink` | Proof of mailbox control before a record becomes real, already working |
| The two-limiter pattern | `request/+page.server.ts` | Per-address stops mail-bombing, per-IP stops enumeration; a null IP falls back to a shared bucket rather than skipping |
| The mail queue | `enqueueEmail` → `outbound_email` → `mail:drain` | Nothing sends inline; a deployment with no `SMTP_URL` queues and that is supported |
| The kind vocabulary | `update_post_kind_check` | `document \| subprocessor \| certification \| advisory` is already a closed, migrated set |

---

## 3. Scope

**In.** A `subscription` identity with double opt-in. Topic selection over the four existing
`update_post.kind` values. A notification job driven by a per-subscription cursor. A manage page
behind a permanent token, offering topic change, locale change and unsubscribe. A coverage warning
for subprocessor changes no post announces.

**Out.**

- Outbound webhooks — subsystem A, per §2.
- **Modelling the contractual notice period.** Warning that a change is *unannounced* is in; knowing
  that a customer contract requires thirty days' warning is not. The period varies per contract, so a
  single global number would be wrong for someone, and no real DPA has been read against this yet.
  Recorded here as a deliberate deferral, not an oversight — see P4.9.
- Any subscriber-facing surface beyond topics and locale. No preference centre, no digest frequency
  setting, no per-post opt-out.
- Notifying on anything other than an update post. Certifications, documents and subprocessors are
  announced *by* posts; they do not notify on their own.

---

## 4. The subscriber identity

### 4.1 A subscriber is not a requester

`requester` is a verified prospect: it carries a name, a company, a frozen company domain used for
rule matching, and a purge path that grants and requests depend on for referential integrity. A
subscriber is an address and a language. They share only the property of having proven control of a
mailbox.

Conflating them would be actively harmful in one specific way: `requester.purged_at` exists so that a
purged person's row survives for the grants that reference it, with the personal columns blanked. If
a subscription hung off `requester`, subscribing would resurrect a purged address into a live mailing
list. **Separate tables, no foreign key between them, and no attempt to notice that one address
appears in both.**

### 4.2 Two tokens, deliberately different

Confirmation and management have opposite lifetimes, and one token cannot serve both.

- **The confirmation token expires and is single-use.** It exists to prove mailbox control at a
  moment. Its expiry is what makes the unconfirmed sweep possible: a row whose token has expired can
  never become confirmed, so it is garbage.
- **The management token is permanent.** An unsubscribe link in a mail from eighteen months ago must
  still work. That is not a nicety — a dead unsubscribe link is a compliance defect.

Both are stored hashed (SHA-256, as `magic_link` does), so a database disclosure hands the reader no
working link.

**They are not `magic_link` rows.** `magic_link` is single-use and expiring by construction, which is
wrong for the management token; and its two check constraints tie `purpose` to `requester_id`, so
admitting a third purpose means widening both plus adding a nullable `subscription_id` — modifying a
security-critical shared table to store a token that would still need a second mechanism beside it.
The subscription owns its own tokens. See P4.2.

### 4.3 Re-subscription is enumeration-resistant and cannot edit a stranger's record

The subscribe endpoint is unauthenticated, so it must not become a way to read or write someone
else's subscription.

| State of that address | What happens | What the browser sees |
| --- | --- | --- |
| No row | Insert unconfirmed, mail `subscription_confirm` | "Check your email" |
| Unconfirmed row | Regenerate token, reset expiry, replace topics, re-mail `subscription_confirm` | "Check your email" |
| Confirmed row | **Change nothing**, mail `subscription_already` carrying the manage link | "Check your email" |

The third row is the important one. A stranger who guesses an address cannot alter what that person
receives, and cannot learn whether they are subscribed, because the response is identical in all
three cases and every outcome sends exactly one mail. It follows that **changing a confirmed
subscription's topics or locale happens only behind the management token** — the subscribe form is
not a way to reach them. Replacing the topics on an *unconfirmed* row is not the same act: nobody has
proven control of that mailbox yet, no mail is being delivered on its strength, and the row is
indistinguishable from one created fresh by the same submission.

`subscription_already` earns its template by preventing a worse failure: without it the confirmed
case sends nothing, and the person sees "check your email" while no mail arrives, which is
indistinguishable from the system being broken.

---

## 5. Topics

`subscription_topic` holds any subset of the four values `update_post_kind_check` already enforces.
No new vocabulary is invented, and the subscribe form is four checkboxes.

**A join table, not `topics[]`.** §8 of the main spec sketches `subscription(email, locale, topics[],
unsubscribe_token)`. Phase 3a settled the opposite convention for sets — `access_request_tier` and
`access_request_document` are join tables, and "scope is a set" was the whole theme of that phase.
The notification query in §6.2 wants a join, not array containment, and a check constraint on a
column is a stronger guarantee than a check on array elements. Deviation recorded in §12.

An empty topic set is refused at the form. A subscription that matches nothing is a row that exists
to send no mail, and would read as a bug from both ends.

---

## 6. Notification

### 6.1 The cursor

Each confirmed subscription carries `last_notified_at`. The job sends what went live after it, then
advances it.

**It is set to `now()` at confirmation, not to null.** That is what stops a new subscriber receiving
the entire back catalogue in their first mail. Someone subscribing today wants to hear what happens
from today.

A per-subscription cursor rather than a per-post "notified" stamp, because subscribers have different
topic sets and different confirmation dates: one post is due to different people at different times,
so "has this post been sent" is not a property of the post.

### 6.2 The job

`subscriptions:notify`, every 15 minutes, on the existing `runJob` transaction-scoped advisory lock,
so multiple replicas remain safe with no further thought.

**Fifteen minutes rather than an hour or a day.** A lone post then reaches subscribers promptly
enough that nobody asks for an immediate mode, while a burst of posts published together still
coalesces into one mail by itself. This is what makes a separate digest cadence setting unnecessary:
the interval *is* the digest window, and it is operator-visible in one place rather than being a
per-subscriber preference.

One query per tick, joining `subscription → subscription_topic → update_post`, returning per
subscription the posts where `published_at > last_notified_at AND published_at <= now()` and
`kind IN` its topics. **Not N+1**; the tick cost must not scale with subscriber count in round trips.

Then, per subscription the query returned rows for, in one transaction: enqueue one mail and advance
the cursor. Both are database writes, so the transaction makes the pair atomic and the job
at-least-once rather than at-most-once — a crash between them cannot lose a notice. (The translation
rules in §6.4 are applied after this query and can still empty the mail; the cursor advances either
way.)

**The cursor advances to the maximum `published_at` actually included, never to `now()`.** A post
that goes live between the select and the update would otherwise be stepped over and never sent.

### 6.3 Back-dating suppresses the notice

A post created today with `published_at` set to yesterday is behind every cursor and notifies nobody.

This is the intended rule — back-dating a publication date means "this was already announced", and
the alternative would mail people about a change they were told about last week. But it is a trap for
whoever meets it first, so it is stated here, documented in the operator-facing self-hosting guide,
and pinned by a test rather than left to be discovered.

### 6.4 The mail

`subscription_notice`, rendered in `subscription.locale` with an explicit locale option, exactly as
every other template does — the drain job runs on a timer with no request in scope, so an ambient
locale would be whatever the last HTTP request happened to be.

Post titles resolve through `pickTranslation` against the subscriber's locale, and **the notice
applies the same two rules the portal applies**: a post with no title or body in any locale is
skipped, and a title that resolved by fallback is labelled as such. A reader must not be silently
handed a language they did not ask for.

If those rules leave nothing to say, **no mail is sent but the cursor still advances.** The posts were
considered and found unsendable; reconsidering them every fifteen minutes forever would be a slow
loop that never terminates.

**The payload is a pre-rendered string.** `MailPayload` is
`Record<string, string | number | readonly MailAttachment[]>`, so the job builds the list of titles
and URLs into one string field plus a count, rather than widening the payload contract to carry a
structured list. The consequence is that the message catalogs cannot itemise the list themselves —
acceptable for a plain-text mail, and cheaper than a port change. Noted in §13 because it is the kind
of thing that gets missed on a first pass.

---

## 7. Subprocessor notice coverage

`update_post_subprocessor` links a post to the subprocessors it announces. From it, two conditions
are computed with no new state and no new timestamps:

- `published` and **no live covering post at all** → *addition not announced*
- `ended_at` set and **no live covering post with `published_at >= ended_at`** → *removal not
  announced*

"Live" in both conditions means `published_at IS NOT NULL AND published_at <= now()`, the same
predicate `listPublicUpdates` uses. A draft or scheduled post is not coverage: nobody has been told
yet, and a warning that clears the moment an announcement is *written* would clear before the
obligation is discharged — which is the one failure this warning exists to prevent.

**Deliberately not driven by `updated_at`.** That column bumps on any edit, so a typo fix in a
hosting provider's name would raise a notice warning. A warning that fires on noise is a warning
nobody reads, which is worse than no warning.

Shown as a badge on the admin subprocessors list — where the operator is standing at the moment they
make the change — and it is **advisory only**. It does not block publishing a subprocessor, because
the system does not know the contract and must not pretend to (§3, P4.9).

Nothing about this couples the notification path to the subprocessor table: the announcement is still
a human-written post. The link only records which post covers which change, so that its absence is
visible.

---

## 8. Data model

```
subscription        id, email unique, locale,
                    confirm_token_hash unique, confirm_expires_at, confirmed_at,
                    manage_token_hash unique, last_notified_at, created_at

subscription_topic  (subscription_id, topic) pk
                    topic IN ('document','subprocessor','certification','advisory')

update_post_subprocessor  (post_id, subprocessor_id) pk
```

`email` is lowercased before insert, as `upsertRequester` does, so the unique constraint is the real
one rather than a case-sensitive near-miss.

Three paired check constraints keep the confirmed state from drifting apart, because four columns
change together at confirmation and any one of them being wrong is a silent defect:

```
(confirmed_at IS NULL) = (confirm_token_hash IS NOT NULL)
(confirmed_at IS NULL) = (manage_token_hash IS NULL)
(confirmed_at IS NULL) = (last_notified_at IS NULL)
```

Indexes: `confirm_expires_at` for the sweep, and `last_notified_at` for the notification join.

Both join tables cascade on delete of their parent. `update_post_subprocessor` cascading from
`subprocessor` is correct and not a silent unlock of anything — unlike the NDA template FKs of P3.16,
nothing here gates access.

The unconfirmed sweep goes into the existing `retention:sweep` (every six hours, already sweeping
rate-limit counters and redacting delivered mail) rather than becoming a sixth timer. It deletes rows
where `confirmed_at IS NULL AND confirm_expires_at < now()`.

---

## 9. Flow, end to end

1. Visitor opens `/{locale}/subscribe`, enters an address, ticks one or more topics, submits.
2. Two limiters, 5/hour each on `subscribe:email` and `subscribe:ip`, mirroring `/request`.
3. One of the three §4.3 outcomes. In the first two, a `subscription_confirm` mail is queued carrying
   `/{locale}/subscribe/confirm?token=…`.
4. The visitor opens that link. The page **renders** a confirmation button; it does not confirm.
5. They press it. The POST stamps `confirmed_at`, clears the confirmation token and its expiry, mints
   `manage_token_hash`, sets `last_notified_at = now()`, and writes `subscription.confirmed`.
6. Every fifteen minutes, `subscriptions:notify` does §6.2.
7. Every notice mail carries `/{locale}/subscribe/manage?token=…`. That page shows their topics and
   locale, with two POSTs behind it: save, or unsubscribe.
8. Unsubscribing **deletes the row**; the topic rows cascade.

---

## 10. Security and privacy

### 10.1 The fourth actor

`AuditActor` gains a `subscriber` variant carrying the subscription id, and
`audit_event_actor_type_check` is widened to admit it.

A person confirming a subscription is not `staff`, is not a `requester`, and attributing them to
`system` would make "who consented" unanswerable in precisely the case where consent is the thing
being evidenced. This is the same argument the integrations note makes for subsystem D's token actor,
and the same constraint applies: **audit action names and actor types are permanent once written**,
so this is decided before the first row rather than after.

Actions: `subscription.requested`, `subscription.confirmed`, `subscription.topics_changed`,
`subscription.unsubscribed`.

**Sends are not audited.** `outbound_email` already records every send with its status, and an audit
event per notice would write a row per subscriber per tick — a high-volume occurrence log inside the
compliance record, for a fact that is already stored elsewhere. §6.6's rule cuts the other way here
than it usually does, and that is worth stating rather than leaving to look like an omission.

### 10.2 The address appears in no audit column

`actor_id` and `subject_id` hold the subscription UUID. The address is never in `meta` and never in
`subject_id`, which preserves the invariant the append-only triggers rest on: requester-and-subscriber
personal data lives in `ip`, `ua` and `actor_id` alone.

Erasure therefore needs **no new trigger and no new purge path**. Deleting the row on unsubscribe
breaks the link between the occurrence and the person, while the occurrence survives — the same
philosophy §10 of the main spec applies to requester purge, reached by deletion instead of
pseudonymisation because a subscription, unlike a requester, has no dependents that need referential
integrity.

The audit triggers would permit additionally clearing `actor_id` on those events, and **we do not**.
Once the row is gone the UUID points at nothing, so it carries no personal data; keeping it is what
lets an auditor still read "this subscription confirmed on the 3rd and left on the 20th" as one
coherent story. Clearing it would destroy that for no privacy gain.

### 10.3 No cookies, and no GET that mutates

All three routes live under `(portal)` and set no cookie. `tests/e2e/security.spec.ts` asserts that
no public route sets one, and its path list gains all three — the assertion is the point, not the
paths, so extending it is mandatory rather than optional.

**Confirmation and unsubscription are POSTs behind a rendered page.** Corporate mail scanners and
link previewers prefetch URLs in inbound mail. A confirming GET would let a scanner forge the exact
consent that double opt-in exists to evidence, destroying the evidentiary value of the whole
mechanism; an unsubscribing GET would silently drop people who never clicked anything. The token link
opens a page; a human presses a button.

SvelteKit's built-in CSRF protection is origin-header based, so form actions on the cookie-free
portal need no cookie to be safe.

### 10.4 Unchanged guarantees

The public portal still makes no third-party requests and loads no new client dependency; CSP stays
in `auto` mode with no external origins. Nothing in this phase is an outbound HTTP client — SMTP
remains the only egress, which is what keeps the integrations note's §7 boundary intact.

---

## 11. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| P4.1 | A subscriber is a separate identity from a requester, with no FK between them | A subscription hanging off `requester` would resurrect a purged address into a live mailing list |
| P4.2 | The subscription owns two tokens; neither is a `magic_link` row | Confirmation must expire and management must not; admitting a third purpose would widen two constraints on a security-critical shared table and still need a second mechanism beside it |
| P4.3 | Confirming and unsubscribing are POSTs behind a rendered page | A prefetching mail scanner performing a GET would forge consent, or silently unsubscribe someone who never clicked |
| P4.4 | Subscribing to an already-confirmed address changes nothing and mails the manage link | An unauthenticated endpoint must not let a stranger edit or detect someone else's subscription; identical responses in all three cases |
| P4.5 | Topics are a join table over the four existing `update_post.kind` values | Phase 3a's convention for sets, a stronger check constraint than array elements, and the notification query wants a join |
| P4.6 | A per-subscription cursor, set to `now()` at confirmation | Different subscribers have different topics and start dates, so "sent" is not a property of a post; and a new subscriber must not receive the back catalogue |
| P4.7 | The cursor advances to the maximum `published_at` included, never to `now()` | A post going live between the select and the update would otherwise be stepped over permanently |
| P4.8 | A back-dated `published_at` notifies nobody | Back-dating means "already announced"; documented and tested rather than discovered |
| P4.9 | The coverage warning knows nothing about notice periods | The period varies per contract, so one global number would be wrong for someone; the system must not imply it has checked a contract it has not read |
| P4.10 | Coverage is computed from `published`/`ended_at` and the link table, never from `updated_at` | A warning that fires on a typo fix is a warning nobody reads |
| P4.11 | `AuditActor` gains a `subscriber` variant | `system` would make "who consented" unanswerable in the one case where consent is the fact being recorded; actor types are permanent once written |
| P4.12 | Notice sends are not audited | `outbound_email` already records them; one audit row per subscriber per tick is a volume log inside the compliance record |
| P4.13 | Unsubscribing deletes the row rather than retaining a suppression record | Data minimisation; the subscription has no dependents needing referential integrity, so deletion reaches the same place pseudonymisation reaches for requesters |
| P4.14 | 15 minutes, and the interval is the digest window | A lone notice arrives promptly and a burst coalesces by itself, so no cadence setting and no immediate mode are needed |
| P4.15 | The notice payload is a pre-rendered string | Keeps the `MailPayload` contract and the mail port unchanged; the cost is that catalogs cannot itemise the list |

---

## 12. Deviations from the main spec

1. **§8's `subscription(email, locale, topics[], confirmed_at, unsubscribe_token)` becomes two
   tables**, and `topics[]` becomes `subscription_topic` — P4.5.
2. **`unsubscribe_token` is named `manage_token_hash`**, is stored hashed, and opens a page that also
   changes topics and locale. The token authenticates a subscriber to their own record; unsubscribing
   is one of the things they can do there, not the only one.
3. **§11 Phase 4's "outbound webhooks for Slack and Teams" is not built**, per the integrations
   decomposition §8. They are consumers of subsystem A.
4. **§11 Phase 4's "update composer with scheduled publishing" was delivered in Phase 1** and is not
   rebuilt — §2.
5. **`last_notified_at` and `update_post_subprocessor` are not in §8's sketch at all.** The first is
   what makes notification stateful; the second is what makes a missing announcement visible.

---

## 13. Dependencies

**No new packages.** Every mechanism this phase needs — the mail queue, the job runner with its
advisory lock, the Postgres rate limiter, `pickTranslation`, the hashed-token pattern — already
exists and is already tested.

**One migration**, hand-read before committing per the migrations rule: three tables, their indexes
and check constraints, plus the widened `audit_event_actor_type_check`. The widened check is the part
Drizzle will regenerate rather than alter, so the generated SQL must be read and the `drizzle/meta/`
snapshot kept consistent.

**Three new mail templates** — `subscription_confirm`, `subscription_notice`, `subscription_already` —
with their message catalog entries in every compiled locale. `MAIL_TEMPLATES` is a closed union, so
this is a typed change and a missing catalog entry fails `pnpm check` rather than production.

**No port change.** Unlike Phase 3b, which needed attachments through the mail adapter, this phase
fits inside the existing `{to, from, subject, text}` contract — which is exactly why P4.15 pre-renders
the list rather than carrying structure.

---

## 14. Testing

**Unit.** Cursor and topic selection over a fixed set of posts: which posts a given cursor and topic
set admits, including the back-dated case (P4.8) and the maximum-`published_at` advance (P4.7).
Fallback labelling and the skip rule for a post with no usable translation.

**Integration.** The opt-in round trip end to end. Re-subscribing a confirmed address leaves its
topics untouched and queues `subscription_already` (P4.4). The sweep deletes expired unconfirmed rows
and spares confirmed ones. A tick that finds only unsendable posts advances the cursor and queues no
mail. Both coverage-warning conditions and, importantly, their negatives — a subprocessor *with* a
covering post must not warn, or the badge becomes noise. The three paired check constraints reject a
half-confirmed row.

**E2e.** Subscribe → confirm → receive → manage → unsubscribe against Mailpit. The extended
no-cookie assertion over all three new paths. A GET to the confirm and manage URLs must leave the row
unchanged — the direct test of P4.3, and the one that would catch a future refactor turning the page
back into a mutation.
