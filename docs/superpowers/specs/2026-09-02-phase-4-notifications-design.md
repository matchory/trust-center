# Trust Center Phase 4 — Notifications and Subscriptions — Design

**Date:** 2026-09-02
**Status:** Approved for planning, amended 2026-09-02 after a review pass — see §15
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
behind a permanent token, offering topic change, locale change and unsubscribe. A subprocessor
picker on the update post editor, and a coverage warning for subprocessor changes no post announces.

The picker is listed deliberately. An earlier draft scoped the warning without scoping the surface
that populates the link table it reads, which would have shipped a badge that fires on every
subprocessor forever — see §7.

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

**The confirmation token is stored hashed (SHA-256, as `magic_link` does). The management token is
not, and that asymmetry is forced rather than chosen.** Every notice mail carries the manage link, so
the job that sends them must be able to produce the token — and a one-way hash cannot be reversed,
so a hashed management token could be mailed exactly once, at confirmation, and never again. Since
the mail must carry it, storage must be able to yield it.

The asymmetry is defensible on its own terms, not merely forced. Ask what a database reader gains
from each. The confirmation token evidences consent: a reader holding one could manufacture a
confirmation that never happened, which is the whole value of double opt-in, so it is hashed. The
management token authorises reading one address's topic list and unsubscribing it — over a row the
same reader has just read in full. Its entire authority is a subset of the disclosure that would
expose it, so storing it recoverably grants an attacker a marginal write capability over data they
already hold, and grants the honest system the only mechanism by which an unsubscribe link can exist
in a mail at all.

Two alternatives were considered and are worse. Encrypting it needs a key this application does not
have and would not survive the key being lost. Deriving it as `HMAC(secret, subscription_id)` stores
nothing at all — genuinely stronger against a dump — but ties every unsubscribe link ever mailed to
one secret, so an ordinary key rotation kills all of them. That is the compliance defect of §4.2
arriving through the front door, and permanence is the requirement that governs here.

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

**What each case audits.** Action names are permanent once written (§10.1), so this is fixed here
rather than at the first call site: the first two rows write `subscription.requested`, and **the
third writes nothing.** An unauthenticated stranger must not be able to append rows against someone
else's subscription id, five per hour per address, into a log with no delete path. The mail is the
only trace the third case leaves, and `outbound_email` already holds it — the same argument P4.12
makes for notice sends.

**Row two invalidates an in-flight confirmation link.** Regenerating the token means a second
submission for the same unconfirmed address kills the link the first mail carried. That is the
correct trade — the alternative lets whoever submitted first decide whether a later submitter can
ever subscribe — but it is also a griefing vector: an attacker re-submitting an address keeps its
owner from ever confirming. The per-address limiter bounds it to five an hour and nothing further is
attempted, because every mitigation requires telling the two submitters apart, which is precisely the
distinction this section exists to refuse to make.

**Row three re-delivers a permanent credential on demand.** `subscription_already` carries the
manage link and the manage token never expires, so anyone who guesses a confirmed address can cause a
fresh mail containing a working, permanent management link, five times an hour. Nothing leaks — the
mail reaches only the mailbox owner — but the property is real and is named here rather than
discovered. It is also the recovery path that makes the rejection of rotation survivable: a
subscriber who has lost every mail we sent them can get the link back.

**Rotating the manage token was considered and rejected.** It would bound the value of a leaked link
and would let row three re-deliver one, but every mail already sent carries the old token, so
rotation turns every historical unsubscribe link dead — the exact defect §4.2 exists to prevent. It
would also be triggerable by a stranger five times an hour, which turns a compliance defect into
something an attacker can inflict. Permanence and rotation cannot both hold, and permanence is the
one with an obligation behind it. What follows is §10.3's handling of the token in transit: it is the
only long-lived secret this phase mints, so the pages carrying it must not be cached, and its
presence in access logs is documented rather than assumed away.

---

## 5. Topics

`subscription_topic` holds any subset of the four values `update_post_kind_check` already enforces.
No new vocabulary is invented, and the subscribe form is four checkboxes.

**A join table, not `topics[]`.** §8 of the main spec sketches `subscription(email, locale, topics[],
unsubscribe_token)`. Phase 3a settled the opposite convention for sets — `access_request_tier` and
`access_request_document` are join tables, and "scope is a set" was the whole theme of that phase.
The notification query in §6.2 wants a join, not array containment, and a check constraint on a
column is a stronger guarantee than a check on array elements. Deviation recorded in §12.

An empty topic set is refused at the subscribe form **and at the manage page's save**. A subscription
that matches nothing is a row that exists to send no mail, and would read as a bug from both ends.

Saving zero topics is not quietly treated as an unsubscribe. Unsubscribing deletes the row (P4.13),
and a save button that silently destroyed the record the subscriber was editing would be a
destructive action behind a non-destructive control. The save is refused, and the page points at the
unsubscribe button already next to it.

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

**A save on the manage page also advances the cursor to `now()`.** This is not an optimisation;
without it P4.6 fails by a second door. The cursor only moves when a tick finds posts for that
subscription, so a subscriber whose topics matched nothing for six months still carries their
confirmation-time cursor. Ticking a new topic would then deliver every post of that kind published
since they confirmed, in a single mail — the back catalogue, arriving to someone who has been
subscribed the whole time and never saw it coming.

Advanced unconditionally on save, not only when the topic set widens. Comparing the old and new sets
and advancing only on a widening is more code for a worse outcome: a subscriber who narrows their
topics and widens them again in the same sitting would still get the flood. A save is an
interaction — anything published before it is something they could already see on the updates page.

### 6.2 The job

`subscriptions:notify`, every 15 minutes, on the existing `runJob` transaction-scoped advisory lock,
so multiple replicas remain safe with no further thought.

**Fifteen minutes rather than an hour or a day.** A lone post then reaches subscribers promptly
enough that nobody asks for an immediate mode, while a burst of posts published together still
coalesces into one mail by itself. This is what makes a separate digest cadence setting unnecessary:
the interval *is* the digest window, and it is operator-visible in one place rather than being a
per-subscriber preference.

**One select per tick**, joining `subscription → subscription_topic → update_post`, returning per
subscription the posts where `published_at > last_notified_at AND published_at <= now()` and
`kind IN` its topics. The read does not scale with subscriber count in round trips.

**Neither do the writes.** §6.4's translation rules run over the returned rows in memory, and then
the whole tick commits in **one transaction of two statements**: a single multi-row insert into
`outbound_email`, and a single `UPDATE subscription … FROM (VALUES …)` advancing every cursor. Not
one transaction per subscriber — that is the N+1 the select was shaped to avoid, reintroduced on the
write side, and an earlier draft of this section specified exactly that while claiming the opposite
two paragraphs above.

One transaction makes insert and advance atomic together, which is what makes the job at-least-once
rather than at-most-once: a crash before the commit re-sends rather than skips. A subscription whose
mail §6.4 emptied contributes a row to the `VALUES` list and no row to the insert — the cursor
advances, nothing is queued.

**The tick is bounded at 500 subscriptions**, ordered by `last_notified_at` ascending so the most
overdue go first; a tick that fills its bound leaves the rest for the next one, fifteen minutes
later. `drainOutbox` is bounded for the same reason (`limit: 25`): `runJob` holds a
transaction-scoped advisory lock for the whole run, so an unbounded tick holds it for an unbounded
time, and the first deployment with a large list would discover that in production.

**Each cursor advances to the maximum `published_at` actually included for that subscription, never
to `now()`.** A post that goes live between the select and the update would otherwise be stepped over
and never sent. The maximum is per subscription rather than per tick, because two subscribers with
different topic sets legitimately end the same tick at different cursors.

### 6.3 Back-dating suppresses the notice

A post created today with `published_at` set to yesterday is behind every cursor and notifies nobody.

This is the intended rule — back-dating a publication date means "this was already announced", and
the alternative would mail people about a change they were told about last week. But it is a trap for
whoever meets it first, so it is stated here, documented in the operator-facing self-hosting guide,
and pinned by a test rather than left to be discovered.

**The mirror case: moving a live post's date forward re-notifies.** Editing an already-published
post's `published_at` to a later time steps it back over the cursors that had passed it, so it is
sent a second time. That is the same predicate giving the same answer, and distinguishing "edited"
from "newly scheduled" would need a second timestamp this phase declines to add for a case that
requires an operator to re-date a post that already went out. The failure is a duplicate notice
rather than a missing one, which is the right direction to fail in. Documented beside the back-dating
rule so both directions are known, and pinned by the same test.

### 6.4 The mail

`subscription_notice`, rendered in `subscription.locale` with an explicit locale option, exactly as
every other template does — the drain job runs on a timer with no request in scope, so an ambient
locale would be whatever the last HTTP request happened to be.

**The send locale is resolved against the operator's enabled locales, not taken raw.** A subscription
stores whatever locale it was created in, and an operator can later drop that locale from `LOCALES`.
Nothing about the mail would fail: `assertIsLocale` validates against the **compiled** catalogs, not
the enabled ones, so it renders. But the manage link it carries points at `/{locale}/subscribe/manage`
and `classifyPath` deliberately 404s a compiled-but-disabled prefix — so the mail arrives with a dead
unsubscribe link, which §4.2 calls a compliance defect, produced by a configuration change with no
error anywhere. The job therefore maps `subscription.locale` through `getConfig().locales` and falls
back to the default locale when it is no longer enabled; the mail body and the link it carries both
use the resolved locale. `sendExpiryReminders` has the same latent shape today and is left alone —
there the link is a magic link that expires by itself, so a dead one is not a defect.

Post titles resolve through `pickTranslation` against the subscriber's locale, and **the notice
applies the same two rules the portal applies**: a post with no title or body in any locale is
skipped, and a title that resolved by fallback is labelled as such. A reader must not be silently
handed a language they did not ask for.

If those rules leave nothing to say, **no mail is sent but the cursor still advances.** The posts were
considered and found unsendable; reconsidering them every fifteen minutes forever would be a slow
loop that never terminates.

**The payload carries structured items.** `MailPayload` gains one union member —
`readonly { title: string; url: string; isFallback: boolean }[]` — and the job hands `renderTemplate`
the list rather than a string it has already joined. `outbound_email.payload` exists precisely so
that mail is rendered at send time, and a correction to a template reaches mail that has not gone
out yet; pre-rendering the list would have exempted this one template from that invariant, and would
have frozen the fallback label in whichever locale the tick happened to plan under rather than the
row's. The mail port is untouched — `renderTemplate` still produces `{subject, text}` — so this is a
type change inside the queue, not a port change.

---

## 7. Subprocessor notice coverage

`update_post_subprocessor` links a post to the subprocessors it announces. From it, two conditions
are computed with no new state and no new timestamps:

Both conditions require `published`. An unpublished subprocessor has been disclosed to nobody, so
neither its addition nor its removal needs announcing, and the operator can already see `published`
is false in the same row. Warning about it would be the noise P4.10 is about.

- `published` and **no live covering post with `published_at >= started_at` and, when `ended_at` is
  set, `published_at < ended_at`** → *addition not announced*. When `started_at` is null there is no
  lower bound to anchor against and that half degrades to "any live covering post".
- `ended_at` set and **no live covering post with `published_at >= ended_at`** → *removal not
  announced*

**The addition condition is bounded at both ends, and it took two passes to get there.** The case it
exists for is a subprocessor added silently and removed later *with* an announcement: the removal post
is linked, so a naive condition clears the addition warning retroactively on the strength of a post
announcing the opposite fact.

A lower bound alone does not catch it, which an earlier draft of this section got wrong. Anchoring
only to `started_at` asks "is there a covering post on or after the addition?" — and a removal post
published later trivially satisfies that, so the anchored and unanchored conditions behave
*identically* in exactly the scenario the anchor was introduced for. The lower bound does real work,
but different work: it rejects a covering post that **predates** `started_at` and therefore cannot
have announced the addition.

The upper bound is what closes the original case. A post published on or after `ended_at` announces
the removal, not the addition, so it must not count as coverage for the addition — which is the
retroactive clearing this condition exists to prevent. `started_at` is nullable, so its half degrades
to "any live covering post"; `ended_at` being null simply means there is no removal yet and no upper
bound to apply.

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

**The link is created on the update post, not on the subprocessor.** `admin/updates/[id]` gains a
subprocessor multi-select beside `kind` — the operator is writing the announcement at that moment,
which is when they know what it covers. This needs no new mechanism and no new audit action name:
`control_evidence` is already exactly this shape, and `admin/controls/[id]` already edits it inside
`saveMetaAction`'s `update` callback, which receives `db` precisely so a call site can issue more
than one statement. The set is submitted complete every time so an empty selection clears it, and the
audit `meta` records `subprocessorCount` rather than the ids — both following the control editor,
which settled these questions already. Reusing that groove is *not* the generalisation
`docs/superpowers/phase-3-carryover.md` warns against: the helper is unchanged, and an update post is
a translatable content type, which is exactly what it is scoped to.

---

## 8. Data model

```
subscription        id, email unique, locale,
                    confirm_token_hash unique, confirm_expires_at, confirmed_at,
                    manage_token unique, last_notified_at, created_at

subscription_topic  (subscription_id, topic) pk
                    topic IN ('document','subprocessor','certification','advisory')

update_post_subprocessor  (post_id, subprocessor_id) pk
```

`email` is lowercased before insert, as `upsertRequester` does, so the unique constraint is the real
one rather than a case-sensitive near-miss.

**Four** paired check constraints keep the confirmed state from drifting apart, because five columns
change together at confirmation and any one of them being wrong is a silent defect:

```
(confirmed_at IS NULL) = (confirm_token_hash IS NOT NULL)
(confirmed_at IS NULL) = (confirm_expires_at IS NOT NULL)
(confirmed_at IS NULL) = (manage_token IS NULL)
(confirmed_at IS NULL) = (last_notified_at IS NULL)
```

The second is the one an earlier draft left out, and its absence would have been invisible: the sweep
filters `confirmed_at IS NULL` first, so a confirmed row keeping a stale `confirm_expires_at` is read
by nothing and deleted by nothing. It is included because the point of the set is that the confirmed
state is *one* state, not five columns that usually agree.

`locale` carries no check constraint. The enabled set is runtime configuration and the compiled set
is a build input; a constraint against either would make the database start rejecting rows because a
deployment changed an environment variable. §6.4 resolves the locale at send time instead, which is
where the question can actually be answered.

Indexes: `confirm_expires_at`, partial on `confirmed_at IS NULL`, because that is the only half the
sweep looks at; and `last_notified_at`, partial on `confirmed_at IS NOT NULL`, which serves §6.2's
`ORDER BY last_notified_at` under its 500-row bound. The second exists for the **ordering**, not for
the join predicate — the join drives from `subscription`, reading every confirmed row, and correlates
into `update_post`, which already has `update_post_published_idx`. Recorded because "an index on the
column in the WHERE clause" is the wrong reason to have it and would not survive the first person who
asks.

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
   `manage_token`, sets `last_notified_at = now()`, and writes `subscription.confirmed`.
6. Every fifteen minutes, `subscriptions:notify` does §6.2.
7. Every notice mail carries `/{locale}/subscribe/manage?token=…`. That page shows their topics and
   locale, with two POSTs behind it: save — which refuses an empty topic set (§5) and advances
   `last_notified_at` to `now()` (§6.1) — or unsubscribe.
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

**`subscription.requested` is written by `system`, not by `subscriber`.** Nobody has proven control
of the address at that point, so attributing the event to the person would assert exactly the fact
the confirmation step exists to establish — the same reasoning
`access_request.submitted` already applies. The `subscriber` actor begins at confirmation, which is
the moment consent becomes a fact worth attributing, and covers the other three.

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

**Two of the three are `no-store`, not cacheable.** Every other portal page sets
`public, max-age=0, s-maxage=60, must-revalidate`; `access/+layout.server.ts` sets `no-store`, and
the confirm and manage pages belong with it. Both carry a token in the query string, and the manage
token never expires — a shared cache holding a manage page and serving it to the next visitor would
hand over a credential with no expiry and no revocation. `/{locale}/subscribe` itself is a public
form identical for everyone and stays cacheable, exactly as `/request` is. Cookie-free and cacheable
are not the same property, and this phase is the first place in the portal where they come apart.

**Both also send `Referrer-Policy: no-referrer`.** The portal makes no third-party requests, so a
token has nowhere to leak to today; the header costs nothing and means the guarantee does not depend
on no future page ever gaining an outbound link.

**A token in a URL is a token in the access log.** The management token is stored recoverably (§4.2)
and never expires, so a reverse proxy logging request lines accumulates working management tokens
that stay valid indefinitely. The self-hosting guide states this beside the
back-dating note. It is also the other half of §4.3's answer on rotation: permanence is what makes
this exposure matter, and permanence is also what forbids the obvious mitigation, so the residual
risk is documented rather than engineered away.

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
| P4.15 | The notice payload carries structured items, joined by `renderTemplate` at send time | Supersedes the pre-rendered string this table first recorded: `outbound_email.payload` exists so a template fix reaches queued mail, and pre-rendering would have exempted this template from that invariant and frozen the fallback label in the planning locale. Widening `MailPayload` by one union member leaves the mail port unchanged |
| P4.16 | The management token is stored recoverably rather than hashed, and is never rotated | Every notice mail carries the link, so the sending job must be able to produce the token; a hash could be mailed once and never again. Its authority is a subset of the disclosure that would expose it. Rotation is rejected because every mail already sent carries the old one, and a stranger could trigger it five times an hour |
| P4.17 | Re-subscribing an already-confirmed address writes no audit event | An unauthenticated caller must not append rows against a stranger's subscription id into a log with no delete path; `outbound_email` holds the only trace that case leaves |
| P4.18 | A save on the manage page advances `last_notified_at` to `now()`, unconditionally | A subscriber adding a topic would otherwise receive every post of that kind since they confirmed — P4.6's back catalogue by a second door; comparing old and new topic sets is more code and still floods on narrow-then-widen |
| P4.19 | The tick is one select and one transaction of two batched statements, bounded at 500 subscriptions | A transaction per subscriber is the N+1 the select was shaped to avoid; and `runJob` holds an advisory lock for the whole run, so an unbounded tick holds it for an unbounded time |
| P4.20 | The send locale is resolved against `getConfig().locales`, falling back to the default | Disabling a locale would otherwise mail a perfectly rendered notice carrying a manage link that 404s — a dead unsubscribe link produced by a configuration change, with no error anywhere |
| P4.21 | The confirm and manage pages are `no-store` with `Referrer-Policy: no-referrer` | They carry a permanent credential in a query string; a shared cache serving one to the next visitor hands it over outright. Cookie-free and cacheable come apart here for the first time |
| P4.22 | The addition warning is bounded below by `started_at` and above by `ended_at`, each degrading when null | A lower bound alone does not close the motivating case: a removal post published later satisfies it trivially, so anchored and unanchored behave identically there. The upper bound is what stops a post announcing the removal from clearing the addition warning; the lower bound separately rejects a post predating the addition |
| P4.23 | The subprocessor link is edited on the update post, through the existing `saveMetaAction` groove | The operator is writing the announcement at that moment; `control_evidence` is the same shape and settled the set-valued questions already, so this reuses a groove rather than widening an abstraction |

---

## 12. Deviations from the main spec

1. **§8's `subscription(email, locale, topics[], confirmed_at, unsubscribe_token)` becomes two
   tables**, and `topics[]` becomes `subscription_topic` — P4.5.
2. **`unsubscribe_token` is named `manage_token`** and opens a page that also changes topics and
   locale. The token authenticates a subscriber to their own record; unsubscribing
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

**One migration**, hand-read before committing per the migrations rule: three tables, their partial
indexes and four check constraints, plus the widened `audit_event_actor_type_check`. The widened
check is the part Drizzle will regenerate rather than alter, so the generated SQL must be read and
the `drizzle/meta/` snapshot kept consistent.

**One existing admin editor changes.** `admin/updates/[id]` gains the subprocessor multi-select of
§7. No helper changes and no new audit action name: it rides inside `saveMetaAction`'s `update`
callback exactly as the control editor's evidence set does.

**Three new mail templates** — `subscription_confirm`, `subscription_notice`, `subscription_already`
— with their message catalog entries in every compiled locale. `MAIL_TEMPLATES` is a closed union, so
this is a typed change and a missing catalog entry fails `pnpm check` rather than production.

**No port change.** Unlike Phase 3b, which needed attachments through the mail adapter, this phase
fits inside the existing `{to, from, subject, text}` contract. `MailPayload` widens by one union
member to carry P4.15's structured notice items, which is a type change inside the queue rather than
a change to the port the adapter implements.

---

## 14. Testing

**Unit.** Cursor and topic selection over a fixed set of posts: which posts a given cursor and topic
set admits, including the back-dated case (P4.8), the forward-dated re-notification of §6.3, and the
per-subscription maximum-`published_at` advance (P4.7). Fallback labelling and the skip rule for a
post with no usable translation. Locale resolution against an enabled set that no longer contains the
subscription's locale (P4.20). Both coverage conditions as a pure predicate, including the anchored
addition case (P4.22): a subprocessor whose only live covering post predates `started_at` still
warns, and one whose only covering post is its *removal* announcement still warns on the addition.

**Integration.** The opt-in round trip end to end. Re-subscribing a confirmed address leaves its
topics untouched, queues `subscription_already` carrying a manage link that then opens the manage
page, and writes **no** audit event (P4.4, P4.16, P4.17) — the link assertion is what would catch a
future change to hashed storage, which would silently mail a link that authenticates nobody. The
sweep deletes expired unconfirmed rows and spares confirmed ones. A tick that finds only unsendable
posts advances the cursor and queues no mail. A tick with several due subscribers issues one insert
and one update, not one transaction each, and stops at its 500-row bound (P4.19). A subscriber whose
topics matched nothing for a long window, then adds a topic, receives **nothing** older than the save
(P4.18) — the regression test for the second back-catalogue door. A manage save with zero topics is
refused and the row is unchanged (§5). Both coverage-warning conditions and, importantly, their
negatives — a subprocessor *with* a covering post must not warn, or the badge becomes noise. The four
paired check constraints reject a half-confirmed row, the `confirm_expires_at` pairing included.

**E2e.** Subscribe → confirm → receive → manage → unsubscribe against Mailpit. The extended
no-cookie assertion over all three new paths. A GET to the confirm and manage URLs must leave the row
unchanged — the direct test of P4.3, and the one that would catch a future refactor turning the page
back into a mutation. The confirm and manage responses must carry `cache-control: no-store` while
`/{locale}/subscribe` stays cacheable (P4.21); asserting the *negative* on the subscribe form is what
stops the fix being "make the whole subtree no-store" and quietly losing the portal's cacheability.

---

## 15. Amendments — 2026-09-02 review pass

The design was reviewed against the codebase after approval. Every claim it made about existing code
held — `update_post`'s tri-state `published_at`, `magic_link`'s two check constraints, `MailPayload`,
the `audit_event_forbid_rewrite` trigger's clear-only rule, the two-limiter pattern, `pickTranslation`
— so nothing below is a correction of fact. These are defects in the *new* design, found by asking
what each mechanism does at its edges.

Three would have shipped bugs, one would have shipped a disclosure, one was a scope hole, and the
rest were places where the text claimed more than the mechanism delivered. #14 is different in kind:
it was found while writing the implementation plan, by trying to write the code that mails a hashed
token, and it is the only one where the design as written could not have been built at all.

| # | What was wrong | Where it was fixed |
| --- | --- | --- |
| 1 | The cursor only advances when a tick sends something, so a subscriber adding a topic on the manage page would receive every post of that kind since they confirmed — P4.6's back catalogue, by a door P4.6 did not look at | §6.1, P4.18 |
| 2 | The addition-coverage condition was unbounded, so a *removal* announcement cleared the "addition not announced" warning retroactively — the one case the warning exists for | §7, P4.22 |
| 15 | **The fix for #2 did not actually fix it.** Anchoring the addition condition to `started_at` alone leaves the motivating case behaving exactly as before, because a removal post published later satisfies the anchor trivially. Found while reviewing Task 13's tests, when a case named for the removal scenario turned out to be a byte-identical duplicate of the predating-post case — the name described a behaviour the condition did not have. Closed by bounding the condition above by `ended_at` as well | §7, P4.22 |
| 3 | Nothing in scope populated `update_post_subprocessor`, so the badge would have fired on every subprocessor forever | §3, §7, §13, P4.23 |
| 4 | The confirm and manage pages were placed under "the public, cacheable portal" while carrying a permanent credential in a query string | §10.3, P4.21 |
| 5 | §6.2 claimed "not N+1" and then specified one transaction per subscriber; it was also unbounded while holding the advisory lock | §6.2, P4.19 |
| 6 | A locale removed from `LOCALES` produced a notice that renders correctly and carries a manage link that 404s — a dead unsubscribe link, arriving by configuration change | §6.4, P4.20 |
| 7 | The constraint set covered four of the five columns that change at confirmation; `confirm_expires_at` was unpaired and its drift would have been invisible | §8 |
| 8 | The index on `last_notified_at` was justified as serving the join, which it cannot; it serves the new bound's ordering instead | §8 |
| 9 | Forward-dating a live post re-notifies — the mirror of P4.8, unstated | §6.3 |
| 10 | §5's empty-topic rule did not reach the manage page's save | §5, §9 |
| 11 | Which audit action each of §4.3's three cases writes was unstated, in a document whose own §10.1 argues these names are permanent | §4.3, P4.17 |
| 12 | `subscription_already` was justified only as a UX fix, and the rejection of token rotation went unstated | §4.3, P4.16 |
| 13 | Regenerating an unconfirmed row's token is a griefing vector, accepted but unstated | §4.3 |
| 14 | **Hashed storage for the management token is incompatible with mailing the link.** §4.2 stored both tokens hashed and §4.3, §6.4 and §9 all mail the manage link; a one-way hash could produce it exactly once, at confirmation, so every notice mail would have carried a link the job could not build. The confirmation token stays hashed; the management token is stored recoverably, with the argument for why the asymmetry is right rather than merely convenient | §4.2, §8, §12, P4.16 |

Two things the review deliberately did **not** change. Rotation of the manage token stays rejected:
it is the obvious mitigation for #4, #12 and #14 and it directly contradicts §4.2's permanence
requirement, so the residual risk is documented instead. And `sendExpiryReminders` carries the same
latent locale defect as #6 and is left alone — there the link expires by itself, so a dead one is not
a defect.
