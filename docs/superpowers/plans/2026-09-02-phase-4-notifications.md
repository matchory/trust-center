# Phase 4 — Notifications and Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A visitor subscribes to update posts by topic with a double opt-in, a job mails them what goes live in their locale, one permanent token opens a page to change topics or leave — and an operator is warned when a subprocessor change has no post announcing it.

**Architecture:** A `subscription` identity that shares nothing with `requester` and owns two tokens with opposite lifetimes — a confirmation token that expires, a management token that never does. Notification is a per-subscription cursor over `update_post.published_at`: one select per tick, rendering in memory, then one transaction of two batched statements. The subprocessor warning is a pure predicate over `published`/`started_at`/`ended_at` and a link table populated from the update post editor, computed on read with no new state.

**Tech Stack:** SvelteKit (Svelte 5 runes) · Drizzle + postgres-js · Paraglide (inlang message-format) · Zod · Vitest · Playwright

**Spec:** `docs/superpowers/specs/2026-09-02-phase-4-notifications-design.md`, as amended by §15. Read §3, §4, §5, §6, §7, §8, §9, §10, §11 and §14 before starting. It supplements `docs/superpowers/specs/2026-08-28-trust-center-design.md` and depends on `docs/superpowers/specs/2026-08-31-integrations-decomposition.md` §8.

## Global Constraints

Every task's requirements implicitly include this section.

- **One migration for the whole phase**, written in Task 1 and never amended by a later task. If a later task appears to need a schema change, stop and escalate — it means Task 1 was misread. Generated SQL is hand-read before committing and the `drizzle/meta/` snapshot kept consistent (CLAUDE.md, Migrations).
- **Audit action names are permanent once written.** This phase writes exactly four: `subscription.requested`, `subscription.confirmed`, `subscription.topics_changed`, `subscription.unsubscribed` (spec §10.1). The subprocessor link rides inside the existing `update.updated` / `update.published` events and mints nothing (P4.23). Notice sends are not audited (P4.12), and re-subscribing an already-confirmed address audits nothing (P4.17).
- **A subscriber's address appears in `audit_event` only via `actor_id`/`subject_id` holding the subscription UUID** — never in `meta`, never as a literal address. This is the invariant the append-only triggers rest on (spec §10.2, CLAUDE.md).
- **The public portal sets no cookies and makes no third-party requests.** `tests/e2e/security.spec.ts` asserts this permanently; its path list grows in Task 15. CSP stays in `auto` mode with no external origins.
- **No new packages.** Every mechanism this phase needs already exists (spec §13). No outbound HTTP client — SMTP remains the only egress.
- **No mail port change.** `MailPayload` is `Record<string, string | number | readonly MailAttachment[]>` and stays that way; the notice list is a pre-rendered string plus a count (P4.15).
- **`vite build` must succeed with `DATABASE_URL`, `OIDC_CLIENT_SECRET` and `SMTP_URL` unset.** Importing a module must never open a connection or require a configured environment.
- **`pnpm check` ends at 0 errors, 0 warnings.** `MAIL_TEMPLATES` is a closed union, so a missing catalog entry must fail `pnpm check` rather than production.
- **Formatting:** tabs, single quotes, no trailing commas, 100-column print width (`.prettierrc`). Run `pnpm format` before every commit and `pnpm lint` before every gate.
- **Comments record why, naming the failure mode or the spec section** (`spec §6.2` and the like). Match the surrounding density; do not restate the code.
- **Build page hrefs with `localizePath()`, never `resolve()`.** `/de/subscribe` is not a route id — `hooks.ts`'s `reroute` strips the prefix.

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `src/lib/server/db/schema/subscriptions.ts` | `subscription`, `subscription_topic`, `update_post_subprocessor`. Owns the four paired check constraints and both partial indexes. |
| `src/lib/server/subscriptions/index.ts` | The identity: subscribe (the three §4.3 cases), confirm, read by manage token, save, unsubscribe, sweep. Owns both token lifetimes and the only `hashToken` in this subtree. |
| `src/lib/server/subscriptions/notify.ts` | `planNotices` (pure: cursor, translation rules, locale resolution, payload string) and `notifySubscribers` (the query, the bound, the one transaction). |
| `src/routes/(portal)/subscribe/+page.server.ts` | The form's load and its single action: two limiters, three outcomes, one mail each. |
| `src/routes/(portal)/subscribe/+page.svelte` | Address field and four topic checkboxes. Identical response in all three cases. |
| `src/routes/(portal)/subscribe/confirm/+page.server.ts` | Renders a button on GET; confirms on POST. `no-store`. |
| `src/routes/(portal)/subscribe/confirm/+page.svelte` | One button, and the confirmed state. |
| `src/routes/(portal)/subscribe/manage/+page.server.ts` | Renders topics and locale on GET; `?/save` and `?/unsubscribe` on POST. `no-store`. |
| `src/routes/(portal)/subscribe/manage/+page.svelte` | Topic checkboxes, locale select, save and unsubscribe. |
| `tests/unit/subscription-notify.test.ts` | `planNotices` over fixed inputs: cursor advance, back- and forward-dating, translation skip and fallback, locale resolution. |
| `tests/unit/subprocessor-coverage.test.ts` | `noticeCoverage` as a pure predicate, both conditions and both negatives. |
| `tests/integration/subscriptions.test.ts` | The four check constraints, the three §4.3 cases, confirmation, the manage-save cursor advance, and the sweep. |
| `tests/integration/subscription-notify.test.ts` | The tick: batching, the bound, the empty-mail cursor advance, the topic-change regression. |
| `tests/e2e/subscribe.spec.ts` | Subscribe → confirm → manage → unsubscribe, and the GET-does-not-mutate assertions. |
| `tests/integration/content.test.ts` (extend) | The `update_post_subprocessor` writer and its cascade. |

**Modified**

| Path | Change |
| --- | --- |
| `src/lib/server/db/schema/index.ts` | Re-exports `./subscriptions`. |
| `drizzle/0018_*.sql` (next number) | Three tables, two partial indexes, five check constraints, and the widened `audit_event_actor_type_check`. |
| `src/lib/server/audit/index.ts` | `AuditActor` gains `{ type: 'subscriber'; id: string }`. |
| `src/lib/server/mail/templates.ts` | Three templates added to `MAIL_TEMPLATES` and to `renderTemplate`'s switch. |
| `messages/de.json`, `messages/en.json` | Six mail keys plus the fallback label; the subscribe, confirm and manage page copy; `admin_announced_subprocessors` and the three `subprocessors_notice_*` keys. |
| `src/lib/server/jobs/index.ts` | `subscriptions:notify` every 15 minutes; the unconfirmed sweep folded into `retention:sweep`. |
| `src/lib/server/content/updates.ts` | `setUpdateSubprocessors`, and `subprocessorIds` on `AdminUpdate`. |
| `src/lib/server/content/subprocessors.ts` | `noticeCoverage` (pure) and the covering-post query behind it; `coverage` on `AdminSubprocessor`. |
| `src/routes/(admin)/admin/updates/[id]/+page.server.ts` | The subprocessor set inside `saveMetaAction`'s `update` callback; `subprocessorCount` in `meta`; `load` also returns the pickable list. |
| `src/routes/(admin)/admin/updates/[id]/+page.svelte` | The subprocessor multi-select. |
| `src/routes/(admin)/admin/subprocessors/+page.svelte` | The coverage badge column. |
| `src/lib/portal/sections.ts` | A `/subscribe` entry in `PORTAL_SECTIONS`. Drives the layout nav and the landing grid; the sitemap does not consume it. |
| `tests/e2e/security.spec.ts` | Two paths on the no-cookie list, plus a new case for the `no-store`, `no-referrer` and still-cacheable assertions. |
| `docs/self-hosting.md` | The back-dating rule, the forward-dating mirror, and the token-in-access-log note. |

## Theme order and gates

Seven themes, in order, each ending at a gate. At every gate run `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration`, and at Gates D, F and G also `pnpm test:e2e`.

**A. Schema** (Task 1) → **B. Identity** (Tasks 2–4) → **C. Mail** (Task 5) → **D. Public routes** (Tasks 6–8) → **E. Notification** (Tasks 9–11) → **F. Subprocessor coverage** (Tasks 12–14) → **G. Close** (Task 15).

Theme F is independent of A–E in everything but its migration, which Task 1 already wrote. If the phase runs long, F is the one to drop whole and record in the carry-over — the subscription half is shippable without it, and the reverse is not true.

---

### Task 1: Schema, migration, and the fourth constraint

**Files:**
- Create: `src/lib/server/db/schema/subscriptions.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Modify: `src/lib/server/audit/index.ts:14-19`
- Create: `drizzle/0018_*.sql` (via `pnpm db:generate`, then hand-extended)
- Test: `tests/integration/subscriptions.test.ts`

**Interfaces:**
- Produces: `subscription`, `subscriptionTopic`, `updatePostSubprocessor` Drizzle tables, re-exported from `$lib/server/db/schema`. `AuditActor` gains `{ type: 'subscriber'; id: string }`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/subscriptions.test.ts`. `rejectionCause` is copied from `tests/integration/audit.test.ts` because Drizzle wraps driver errors and asserting on `message` matches the statement text rather than the database's complaint.

```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { subscription } from '../../src/lib/server/db/schema';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

async function rejectionCause(query: PromiseLike<unknown>): Promise<string> {
	try {
		await query;
	} catch (error) {
		const wrapped = error as Error & { cause?: Error };
		return wrapped.cause?.message ?? wrapped.message;
	}
	throw new Error('expected the query to be rejected, but it succeeded');
}

describe('subscription check constraints', () => {
	it('accepts a well-formed unconfirmed row', async () => {
		const [row] = await db
			.insert(subscription)
			.values({
				email: `unconfirmed-${Date.now()}@example.test`,
				locale: 'de',
				confirmTokenHash: `hash-${Date.now()}`,
				confirmExpiresAt: new Date(Date.now() + 3_600_000)
			})
			.returning({ id: subscription.id });

		expect(row?.id).toBeTruthy();
		await db.delete(subscription).where(eq(subscription.id, row!.id));
	});

	it('accepts a well-formed confirmed row', async () => {
		const [row] = await db
			.insert(subscription)
			.values({
				email: `confirmed-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				manageToken: `manage-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
			.returning({ id: subscription.id });

		expect(row?.id).toBeTruthy();
		await db.delete(subscription).where(eq(subscription.id, row!.id));
	});

	it('rejects a confirmed row that kept its confirmation token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfa-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				confirmTokenHash: `hash-${Date.now()}`,
				manageToken: `manage-a-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_confirm_token_check');
	});

	// The constraint an earlier draft of the spec omitted (§8, §15 #7). Its
	// absence is invisible at runtime: the sweep filters `confirmed_at IS NULL`
	// first, so a confirmed row keeping a stale expiry is read by nothing.
	it('rejects a confirmed row that kept its confirmation expiry', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfb-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				confirmExpiresAt: new Date(),
				manageToken: `manage-b-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_confirm_expires_check');
	});

	it('rejects a confirmed row with no manage token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfc-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				lastNotifiedAt: new Date()
			})
		);
		expect(cause).toContain('subscription_manage_token_check');
	});

	it('rejects a confirmed row with no cursor', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfd-${Date.now()}@example.test`,
				locale: 'de',
				confirmedAt: new Date(),
				manageToken: `manage-d-${Date.now()}`
			})
		);
		expect(cause).toContain('subscription_cursor_check');
	});

	it('rejects an unconfirmed row that already has a manage token', async () => {
		const cause = await rejectionCause(
			db.insert(subscription).values({
				email: `halfe-${Date.now()}@example.test`,
				locale: 'de',
				confirmTokenHash: `hash-e-${Date.now()}`,
				confirmExpiresAt: new Date(Date.now() + 3_600_000),
				manageToken: `manage-e-${Date.now()}`
			})
		);
		expect(cause).toContain('subscription_manage_token_check');
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:integration tests/integration/subscriptions.test.ts`
Expected: FAIL — `subscription` is not exported from the schema barrel.

- [ ] **Step 3: Write the schema module**

Create `src/lib/server/db/schema/subscriptions.ts`:

```ts
import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { subprocessor } from './subprocessors';
import { updatePost } from './updates';

/**
 * A subscriber is not a requester and there is deliberately no foreign key
 * between them (spec §4.1): `requester.purged_at` keeps a purged person's row
 * alive for the grants that reference it, so hanging a subscription off it
 * would resurrect a purged address into a live mailing list.
 *
 * Two tokens with opposite lifetimes, neither a `magic_link` row (P4.2). The
 * confirmation token expires — that expiry is what makes the sweep possible.
 * The management token never does: an unsubscribe link in a mail from eighteen
 * months ago must still work, and a dead one is a compliance defect.
 */
export const subscription = pgTable(
	'subscription',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		// Lowercased before insert, as `upsertRequester` does, so the unique
		// constraint is the real one rather than a case-sensitive near-miss.
		email: text('email').notNull().unique(),
		locale: text('locale').notNull(),
		confirmTokenHash: text('confirm_token_hash').unique(),
		confirmExpiresAt: timestamp('confirm_expires_at', { withTimezone: true }),
		confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
		// NOT hashed, unlike the confirmation token, and §4.2 is worth reading
		// before this looks like an oversight: every notice mail carries the
		// manage link, so the sending job has to be able to produce the token.
		// A one-way hash could be mailed once, at confirmation, and never again.
		manageToken: text('manage_token').unique(),
		lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		// Partial: the sweep only ever looks at the unconfirmed half.
		index('subscription_confirm_expires_idx')
			.on(table.confirmExpiresAt)
			.where(sql`${table.confirmedAt} IS NULL`),
		// For the notify tick's ORDER BY under its 500-row bound, NOT for the
		// join predicate (spec §8): the join drives from this table and
		// correlates into update_post, which already has update_post_published_idx.
		index('subscription_last_notified_idx')
			.on(table.lastNotifiedAt)
			.where(sql`${table.confirmedAt} IS NOT NULL`),
		// Confirmed is ONE state, not five columns that usually agree. Five
		// columns change together at confirmation and any one of them being
		// wrong is a silent defect, so each is paired against `confirmed_at`.
		check(
			'subscription_confirm_token_check',
			sql`(${table.confirmedAt} IS NULL) = (${table.confirmTokenHash} IS NOT NULL)`
		),
		check(
			'subscription_confirm_expires_check',
			sql`(${table.confirmedAt} IS NULL) = (${table.confirmExpiresAt} IS NOT NULL)`
		),
		check(
			'subscription_manage_token_check',
			sql`(${table.confirmedAt} IS NULL) = (${table.manageToken} IS NULL)`
		),
		check(
			'subscription_cursor_check',
			sql`(${table.confirmedAt} IS NULL) = (${table.lastNotifiedAt} IS NULL)`
		)
	]
);

/**
 * A join table rather than `topics[]` (P4.5): 3a settled the convention for
 * sets, the notification query wants a join rather than array containment, and
 * a check constraint on a column is a stronger guarantee than one on array
 * elements. The vocabulary is the closed set `update_post_kind_check` already
 * enforces — no new values are invented here.
 */
export const subscriptionTopic = pgTable(
	'subscription_topic',
	{
		subscriptionId: uuid('subscription_id')
			.notNull()
			.references(() => subscription.id, { onDelete: 'cascade' }),
		topic: text('topic').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.subscriptionId, table.topic] }),
		check(
			'subscription_topic_check',
			sql`${table.topic} IN ('document', 'subprocessor', 'certification', 'advisory')`
		)
	]
);

/**
 * Which post announces which subprocessor change (spec §7). It couples nothing:
 * the announcement is still a human-written post, and this only records the
 * link so that its *absence* is visible. Cascading from `subprocessor` is safe
 * and unlike the NDA template FKs of P3.16 unlocks nothing — no access is gated
 * on a row here.
 */
export const updatePostSubprocessor = pgTable(
	'update_post_subprocessor',
	{
		postId: uuid('post_id')
			.notNull()
			.references(() => updatePost.id, { onDelete: 'cascade' }),
		subprocessorId: uuid('subprocessor_id')
			.notNull()
			.references(() => subprocessor.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.postId, table.subprocessorId] })]
);
```

Add to `src/lib/server/db/schema/index.ts`, after `export * from './nda';`:

```ts
export * from './subscriptions';
```

- [ ] **Step 4: Widen the audit actor union**

In `src/lib/server/audit/index.ts`, extend `AuditActor` and its doc comment:

```ts
export type AuditActor =
	| { type: 'staff'; id: string }
	| { type: 'staff-unresolved'; id: null }
	| { type: 'requester'; id: string | null }
	// A person confirming a subscription is not staff and not a requester, and
	// `system` would make "who consented" unanswerable in precisely the case
	// where consent is the fact being evidenced (spec §10.1, P4.11). The id is
	// always a `subscription.id`; the address never appears in any audit column.
	| { type: 'subscriber'; id: string }
	| { type: 'system'; id: null };
```

- [ ] **Step 5: Generate the migration and hand-extend it**

Run: `pnpm db:generate`

Then open the generated `drizzle/0018_*.sql`, read every statement, and append the actor-type widening. Drizzle regenerates a check constraint rather than altering it, so this is written by hand:

```sql
--> statement-breakpoint
-- Spec §10.1: the fourth actor. Actor types are permanent once written, so
-- this is decided before the first row rather than after. Drizzle regenerates
-- check constraints rather than altering them, so the drop-and-recreate is
-- written by hand and the drizzle/meta snapshot updated to match.
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_actor_type_check";--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_type_check"
	CHECK ("actor_type" IN ('staff', 'staff-unresolved', 'requester', 'subscriber', 'system'));
```

Confirm the generated SQL contains all four paired `subscription_*_check` constraints plus `subscription_topic_check`, both partial indexes with their `WHERE` clauses, and `ON DELETE cascade` on all three foreign keys (`subscription_topic` → `subscription`, and `update_post_subprocessor` → each of `update_post` and `subprocessor`). A partial index Drizzle emitted without its predicate is the failure to look for.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test:integration tests/integration/subscriptions.test.ts`
Expected: PASS, 7 cases.

- [ ] **Step 7: Verify the build needs no environment**

Run: `env -u DATABASE_URL -u OIDC_CLIENT_SECRET -u SMTP_URL pnpm build`
Expected: success. The schema module must not be reachable from anything that opens a connection at import time.

- [ ] **Step 8: Commit**

```bash
pnpm format
git add src/lib/server/db/schema/subscriptions.ts src/lib/server/db/schema/index.ts \
	src/lib/server/audit/index.ts drizzle/ tests/integration/subscriptions.test.ts
git commit -m "feat(subscriptions): schema, migration, and the subscriber actor"
```

**Gate A:** `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration`

---

### Task 2: Subscribing — the three outcomes of §4.3

**Files:**
- Create: `src/lib/server/subscriptions/index.ts`
- Test: `tests/integration/subscriptions.test.ts` (extend)

**Interfaces:**
- Consumes: `subscription`, `subscriptionTopic` from Task 1.
- Produces:
  - `subscribe(db, { email, locale, topics, ttlMinutes }): Promise<SubscribeResult>`
  - `type SubscribeResult = { kind: 'created' | 'resent'; subscriptionId: string; confirmToken: string } | { kind: 'already'; subscriptionId: string }`
  - `replaceTopics(tx, subscriptionId, topics): Promise<void>` (module-private, used by Task 4)

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/subscriptions.test.ts`. Add these imports at the top of the file:

```ts
import { asc } from 'drizzle-orm';
import { subscriptionTopic } from '../../src/lib/server/db/schema';
import { subscribe } from '../../src/lib/server/subscriptions';
```

```ts
async function topicsOf(id: string): Promise<string[]> {
	const rows = await db
		.select({ topic: subscriptionTopic.topic })
		.from(subscriptionTopic)
		.where(eq(subscriptionTopic.subscriptionId, id))
		.orderBy(asc(subscriptionTopic.topic));
	return rows.map((row) => row.topic);
}

describe('subscribe', () => {
	it('creates an unconfirmed row with its topics', async () => {
		const email = `create-${Date.now()}@example.test`;
		const result = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory', 'document'],
			ttlMinutes: 60
		});

		expect(result.kind).toBe('created');
		expect(await topicsOf(result.subscriptionId)).toEqual(['advisory', 'document']);
		await db.delete(subscription).where(eq(subscription.id, result.subscriptionId));
	});

	it('lowercases the address so the unique constraint is the real one', async () => {
		const stamp = Date.now();
		const first = await subscribe(db, {
			email: `Mixed-${stamp}@Example.Test`,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const second = await subscribe(db, {
			email: `mixed-${stamp}@example.test`,
			locale: 'de',
			topics: ['document'],
			ttlMinutes: 60
		});

		expect(second.subscriptionId).toBe(first.subscriptionId);
		expect(second.kind).toBe('resent');
		await db.delete(subscription).where(eq(subscription.id, first.subscriptionId));
	});

	it('replaces the topics and reissues the token on an unconfirmed row', async () => {
		const email = `resend-${Date.now()}@example.test`;
		const first = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const second = await subscribe(db, {
			email,
			locale: 'en',
			topics: ['certification', 'document'],
			ttlMinutes: 60
		});

		if (first.kind === 'already' || second.kind === 'already') {
			throw new Error('fixture produced the wrong outcome');
		}
		expect(second.kind).toBe('resent');
		expect(second.subscriptionId).toBe(first.subscriptionId);
		// The regenerated token kills the link the first mail carried. That is
		// the accepted trade of §4.3 — nobody has proven control of the mailbox,
		// so the row is indistinguishable from one created fresh.
		expect(second.confirmToken).not.toBe(first.confirmToken);
		expect(await topicsOf(first.subscriptionId)).toEqual(['certification', 'document']);

		const [row] = await db
			.select({ locale: subscription.locale })
			.from(subscription)
			.where(eq(subscription.id, first.subscriptionId));
		expect(row?.locale).toBe('en');

		await db.delete(subscription).where(eq(subscription.id, first.subscriptionId));
	});

	// P4.4: an unauthenticated endpoint must not let a stranger edit — or
	// detect — someone else's subscription. This is the case that matters.
	it('changes nothing when the address is already confirmed', async () => {
		const email = `already-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});

		await db
			.update(subscription)
			.set({
				confirmedAt: new Date(),
				confirmTokenHash: null,
				confirmExpiresAt: null,
				manageToken: `manage-${Date.now()}`,
				lastNotifiedAt: new Date()
			})
			.where(eq(subscription.id, created.subscriptionId));

		const again = await subscribe(db, {
			email,
			locale: 'en',
			topics: ['document', 'subprocessor'],
			ttlMinutes: 60
		});

		expect(again.kind).toBe('already');
		expect(again.subscriptionId).toBe(created.subscriptionId);
		expect(await topicsOf(created.subscriptionId)).toEqual(['advisory']);

		const [row] = await db
			.select({ locale: subscription.locale, hash: subscription.confirmTokenHash })
			.from(subscription)
			.where(eq(subscription.id, created.subscriptionId));
		expect(row?.locale).toBe('de');
		expect(row?.hash).toBeNull();

		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:integration tests/integration/subscriptions.test.ts -t subscribe`
Expected: FAIL — cannot resolve `../../src/lib/server/subscriptions`.

- [ ] **Step 3: Write the module**

Create `src/lib/server/subscriptions/index.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { UpdateKind } from '../../content-types';
import { subscription, subscriptionTopic } from '../db/schema';
import type { Db } from '../db';

/** Drizzle's transaction handle is not exported anywhere, and `Db` is not
 * assignable to it. Derived from `Db` rather than re-declared so it cannot
 * drift from whatever `db.transaction` actually hands a callback. */
type DbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0];

/** As `magic_link` does: a database disclosure hands the reader no working link. */
function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
	return randomBytes(32).toString('base64url');
}

/** The form submits the complete set, so an empty selection would clear it —
 * which §5 refuses at the form rather than here, because a subscription that
 * matches nothing is a row that exists to send no mail. */
async function replaceTopics(
	tx: DbTransaction,
	subscriptionId: string,
	topics: readonly UpdateKind[]
): Promise<void> {
	await tx.delete(subscriptionTopic).where(eq(subscriptionTopic.subscriptionId, subscriptionId));
	if (topics.length > 0) {
		await tx.insert(subscriptionTopic).values(topics.map((topic) => ({ subscriptionId, topic })));
	}
}

export type SubscribeResult =
	| { kind: 'created' | 'resent'; subscriptionId: string; confirmToken: string }
	| { kind: 'already'; subscriptionId: string };

/**
 * The three outcomes of spec §4.3. The caller mails exactly one thing in every
 * case and returns the same response, which is what makes the endpoint
 * enumeration-resistant: a stranger who guesses an address learns nothing.
 *
 * A confirmed row is never touched (P4.4). Replacing the topics on an
 * *unconfirmed* row is not the same act — nobody has proven control of that
 * mailbox, no mail is being delivered on its strength, and the row is
 * indistinguishable from one this submission created.
 */
export async function subscribe(
	db: Db,
	input: {
		email: string;
		locale: string;
		topics: readonly UpdateKind[];
		ttlMinutes: number;
	}
): Promise<SubscribeResult> {
	// Lowercased here rather than at the call site, as `upsertRequester` does,
	// so the unique constraint is the real one rather than a near-miss.
	const email = input.email.trim().toLowerCase();
	const token = newToken();
	const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);

	return db.transaction(async (tx) => {
		// Insert-or-nothing rather than select-then-insert: this endpoint is
		// unauthenticated, and two concurrent submissions for one address would
		// otherwise race into a unique violation that surfaces as a 500.
		const [inserted] = await tx
			.insert(subscription)
			.values({
				email,
				locale: input.locale,
				confirmTokenHash: hashToken(token),
				confirmExpiresAt: expiresAt
			})
			.onConflictDoNothing({ target: subscription.email })
			.returning({ id: subscription.id });

		if (inserted) {
			await replaceTopics(tx, inserted.id, input.topics);
			return { kind: 'created', subscriptionId: inserted.id, confirmToken: token };
		}

		const [existing] = await tx
			.select({ id: subscription.id, confirmedAt: subscription.confirmedAt })
			.from(subscription)
			.where(eq(subscription.email, email))
			.for('update');

		// The insert conflicted, so the row exists; a missing one here means the
		// row was deleted between the two statements, which only unsubscribing
		// does. Throwing is right: retrying would be a second surprise.
		if (!existing) throw new Error('subscription disappeared between insert and select');

		if (existing.confirmedAt) return { kind: 'already', subscriptionId: existing.id };

		await tx
			.update(subscription)
			.set({
				locale: input.locale,
				confirmTokenHash: hashToken(token),
				confirmExpiresAt: expiresAt
			})
			.where(eq(subscription.id, existing.id));
		await replaceTopics(tx, existing.id, input.topics);

		return { kind: 'resent', subscriptionId: existing.id, confirmToken: token };
	});
}
```

`src/lib/server/db/index.ts` exports only `Db`, `createDb` and `schema`, and `setControlEvidence` avoids the question by inlining its transaction body. The local alias above is why this module can extract `replaceTopics` and still call it from two transactions.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/subscriptions.test.ts`
Expected: PASS, 11 cases.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/subscriptions/index.ts tests/integration/subscriptions.test.ts
git commit -m "feat(subscriptions): subscribe with the three enumeration-resistant outcomes"
```

---

### Task 3: Confirming, and the cursor that starts at now()

**Files:**
- Modify: `src/lib/server/subscriptions/index.ts`
- Test: `tests/integration/subscriptions.test.ts` (extend)

**Interfaces:**
- Consumes: `subscribe` from Task 2.
- Produces: `confirmSubscription(db, token): Promise<ConfirmedSubscription | null>` where `ConfirmedSubscription = { subscriptionId: string; email: string; locale: string; manageToken: string }`.

- [ ] **Step 1: Write the failing test**

```ts
describe('confirmSubscription', () => {
	it('confirms once, mints a manage token, and starts the cursor at now', async () => {
		const email = `confirm-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const token = created.kind === 'created' ? created.confirmToken : '';

		const before = Date.now();
		const confirmed = await confirmSubscription(db, token);

		expect(confirmed?.subscriptionId).toBe(created.subscriptionId);
		expect(confirmed?.email).toBe(email);
		expect(confirmed?.manageToken).toBeTruthy();

		const [row] = await db
			.select()
			.from(subscription)
			.where(eq(subscription.id, created.subscriptionId));
		expect(row?.confirmedAt).toBeTruthy();
		expect(row?.confirmTokenHash).toBeNull();
		expect(row?.confirmExpiresAt).toBeNull();
		expect(row?.manageToken).toBeTruthy();
		// P4.6: not null. A null cursor would hand a new subscriber the entire
		// back catalogue in their first mail.
		expect(row!.lastNotifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

		// Single-use by construction: the conditional update matches nothing the
		// second time, so a double-clicked button cannot confirm twice.
		expect(await confirmSubscription(db, token)).toBeNull();

		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});

	it('refuses an expired token', async () => {
		const email = `expired-${Date.now()}@example.test`;
		const created = await subscribe(db, {
			email,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const token = created.kind === 'created' ? created.confirmToken : '';

		await db
			.update(subscription)
			.set({ confirmExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(subscription.id, created.subscriptionId));

		expect(await confirmSubscription(db, token)).toBeNull();
		await db.delete(subscription).where(eq(subscription.id, created.subscriptionId));
	});

	it('refuses an unknown token', async () => {
		expect(await confirmSubscription(db, 'not-a-token')).toBeNull();
	});
});
```

Add `confirmSubscription` to the module import at the top of the test file.

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:integration tests/integration/subscriptions.test.ts -t confirmSubscription`
Expected: FAIL — `confirmSubscription is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/lib/server/subscriptions/index.ts` (and add `gt` to the `drizzle-orm` import):

```ts
export interface ConfirmedSubscription {
	subscriptionId: string;
	email: string;
	locale: string;
	/** Stored as-is, not hashed — see §4.2. Every notice mail carries a link
	 * built from it, so it has to be recoverable. */
	manageToken: string;
}

/**
 * One conditional update, as `consumeMagicLink` does: two concurrent presses of
 * the same button cannot both return a row, because the second matches nothing.
 * That is what makes the confirmation token single-use without a second read.
 *
 * Returns null for an unknown, spent, or expired token — the page cannot tell
 * them apart and should not try.
 */
export async function confirmSubscription(
	db: Db,
	token: string
): Promise<ConfirmedSubscription | null> {
	const manageToken = newToken();
	const now = new Date();

	const [row] = await db
		.update(subscription)
		.set({
			confirmedAt: now,
			confirmTokenHash: null,
			confirmExpiresAt: null,
			manageToken,
			// `now()`, never null: this is what stops a new subscriber receiving
			// the entire back catalogue in their first mail (P4.6).
			lastNotifiedAt: now
		})
		.where(
			and(
				eq(subscription.confirmTokenHash, hashToken(token)),
				isNull(subscription.confirmedAt),
				gt(subscription.confirmExpiresAt, now)
			)
		)
		.returning({
			id: subscription.id,
			email: subscription.email,
			locale: subscription.locale
		});

	if (!row) return null;
	return { subscriptionId: row.id, email: row.email, locale: row.locale, manageToken };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/subscriptions.test.ts`
Expected: PASS, 14 cases.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/subscriptions/index.ts tests/integration/subscriptions.test.ts
git commit -m "feat(subscriptions): confirmation mints the manage token and starts the cursor"
```

---

### Task 4: Managing, unsubscribing, and the sweep

**Files:**
- Modify: `src/lib/server/subscriptions/index.ts`
- Test: `tests/integration/subscriptions.test.ts` (extend)

**Interfaces:**
- Consumes: `subscribe`, `confirmSubscription` from Tasks 2–3.
- Produces:
  - `subscriptionByManageToken(db, token): Promise<ManagedSubscription | null>` where `ManagedSubscription = { id: string; email: string; locale: string; manageToken: string; topics: UpdateKind[] }`
  - `saveSubscription(db, id, { locale, topics }): Promise<void>`
  - `unsubscribe(db, id): Promise<void>`
  - `sweepUnconfirmedSubscriptions(db): Promise<{ deleted: number }>`

- [ ] **Step 1: Write the failing test**

```ts
describe('managing a subscription', () => {
	async function confirmed(topics: UpdateKind[] = ['advisory']) {
		const email = `manage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
		const created = await subscribe(db, { email, locale: 'de', topics, ttlMinutes: 60 });
		const token = created.kind === 'created' ? created.confirmToken : '';
		const result = await confirmSubscription(db, token);
		if (!result) throw new Error('fixture failed to confirm');
		return result;
	}

	it('reads a subscription back by its manage token', async () => {
		const it = await confirmed(['advisory', 'document']);
		const found = await subscriptionByManageToken(db, it.manageToken);

		expect(found?.id).toBe(it.subscriptionId);
		expect(found?.topics).toEqual(['advisory', 'document']);
		expect(await subscriptionByManageToken(db, 'wrong')).toBeNull();

		await db.delete(subscription).where(eq(subscription.id, it.subscriptionId));
	});

	// P4.18. Without this, a subscriber who adds a topic receives every post of
	// that kind published since they confirmed — P4.6's back catalogue, by a
	// second door. Unconditional on save, so narrow-then-widen cannot beat it.
	it('advances the cursor on every save', async () => {
		const it = await confirmed();
		await db
			.update(subscription)
			.set({ lastNotifiedAt: new Date('2020-01-01T00:00:00Z') })
			.where(eq(subscription.id, it.subscriptionId));

		const before = Date.now();
		await saveSubscription(db, it.subscriptionId, {
			locale: 'en',
			topics: ['document', 'subprocessor']
		});

		const [row] = await db
			.select()
			.from(subscription)
			.where(eq(subscription.id, it.subscriptionId));
		expect(row?.locale).toBe('en');
		expect(row!.lastNotifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
		expect(await topicsOf(it.subscriptionId)).toEqual(['document', 'subprocessor']);

		await db.delete(subscription).where(eq(subscription.id, it.subscriptionId));
	});

	it('deletes the row and cascades its topics on unsubscribe', async () => {
		const it = await confirmed(['advisory', 'document']);
		await unsubscribe(db, it.subscriptionId);

		const rows = await db
			.select()
			.from(subscription)
			.where(eq(subscription.id, it.subscriptionId));
		expect(rows).toHaveLength(0);
		expect(await topicsOf(it.subscriptionId)).toEqual([]);
	});
});

describe('sweepUnconfirmedSubscriptions', () => {
	it('deletes expired unconfirmed rows and spares confirmed ones', async () => {
		const stale = await subscribe(db, {
			email: `stale-${Date.now()}@example.test`,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		await db
			.update(subscription)
			.set({ confirmExpiresAt: new Date(Date.now() - 1000) })
			.where(eq(subscription.id, stale.subscriptionId));

		const live = await subscribe(db, {
			email: `live-${Date.now()}@example.test`,
			locale: 'de',
			topics: ['advisory'],
			ttlMinutes: 60
		});
		const confirmedRow = await confirmSubscription(
			db,
			live.kind === 'created' ? live.confirmToken : ''
		);

		await sweepUnconfirmedSubscriptions(db);

		expect(
			await db.select().from(subscription).where(eq(subscription.id, stale.subscriptionId))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(subscription)
				.where(eq(subscription.id, confirmedRow!.subscriptionId))
		).toHaveLength(1);

		await db.delete(subscription).where(eq(subscription.id, confirmedRow!.subscriptionId));
	});
});
```

Extend the imports at the top of the test file with `saveSubscription`, `subscriptionByManageToken`, `sweepUnconfirmedSubscriptions`, `unsubscribe`, and `import type { UpdateKind } from '../../src/lib/content-types';`.

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:integration tests/integration/subscriptions.test.ts -t manage`
Expected: FAIL — `subscriptionByManageToken is not a function`.

- [ ] **Step 3: Implement them**

Append to `src/lib/server/subscriptions/index.ts` (add `asc`, `lt`, `sql` to the `drizzle-orm` import):

```ts
export interface ManagedSubscription {
	id: string;
	email: string;
	locale: string;
	/** Carried so the manage page can rebuild its own URL after a locale
	 * change — the caller already holds it, so this exposes nothing new. */
	manageToken: string;
	topics: UpdateKind[];
}

/**
 * The management token is permanent and never rotated (P4.16): an unsubscribe
 * link in a mail from eighteen months ago must still work, and every mail
 * already sent carries this one. Compared directly rather than through a hash
 * — §4.2 explains why this one is not hashed and why the confirmation token is.
 */
export async function subscriptionByManageToken(
	db: Db,
	token: string
): Promise<ManagedSubscription | null> {
	const [row] = await db
		.select({
			id: subscription.id,
			email: subscription.email,
			locale: subscription.locale,
			manageToken: subscription.manageToken
		})
		.from(subscription)
		.where(eq(subscription.manageToken, token));

	if (!row) return null;

	const topics = await db
		.select({ topic: subscriptionTopic.topic })
		.from(subscriptionTopic)
		.where(eq(subscriptionTopic.subscriptionId, row.id))
		.orderBy(asc(subscriptionTopic.topic));

	// manageToken is nullable in the column type but never null on a confirmed
	// row, and only a confirmed row has one to match against.
	return { ...row, manageToken: row.manageToken!, topics: topics.map((item) => item.topic as UpdateKind) };
}

/**
 * Advancing the cursor is not incidental to this write (P4.18). The cursor only
 * moves when a tick finds posts, so a subscriber whose topics matched nothing
 * for months still carries their confirmation-time cursor; adding a topic would
 * then deliver everything of that kind published since. Unconditional rather
 * than conditional on the set widening, because narrowing and widening again in
 * one sitting would slip past a comparison.
 */
export async function saveSubscription(
	db: Db,
	id: string,
	input: { locale: string; topics: readonly UpdateKind[] }
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.update(subscription)
			.set({ locale: input.locale, lastNotifiedAt: new Date() })
			.where(eq(subscription.id, id));
		await replaceTopics(tx, id, input.topics);
	});
}

/**
 * Deletion rather than a suppression record (P4.13). The subscription has no
 * dependents needing referential integrity, so deleting reaches the same place
 * pseudonymisation reaches for a requester: the audit events survive, and the
 * UUID in `actor_id` now points at nothing.
 */
export async function unsubscribe(db: Db, id: string): Promise<void> {
	await db.delete(subscription).where(eq(subscription.id, id));
}

/**
 * A row whose confirmation token has expired can never become confirmed, so it
 * is garbage holding an address nobody proved they control. Folded into
 * `retention:sweep` rather than becoming a sixth timer (spec §8).
 */
export async function sweepUnconfirmedSubscriptions(db: Db): Promise<{ deleted: number }> {
	const deleted = await db
		.delete(subscription)
		.where(and(isNull(subscription.confirmedAt), lt(subscription.confirmExpiresAt, new Date())))
		.returning({ id: subscription.id });

	return { deleted: deleted.length };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/subscriptions.test.ts`
Expected: PASS, 18 cases.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/subscriptions/index.ts tests/integration/subscriptions.test.ts
git commit -m "feat(subscriptions): manage, unsubscribe, and the unconfirmed sweep"
```

**Gate B:** `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration`

---

### Task 5: Three mail templates

**Files:**
- Modify: `src/lib/server/mail/templates.ts`
- Modify: `messages/de.json`, `messages/en.json`
- Test: `tests/unit/mail-templates.test.ts` (extend)

**Interfaces:**
- Produces: `MAIL_TEMPLATES` gains `'subscription_confirm' | 'subscription_notice' | 'subscription_already'`. Payloads: confirm takes `{ url }` (the confirm link); already takes `{ url }` (the manage link); notice takes `{ url, items, count }` (the manage link, the pre-rendered list, and its length).

Read `src/lib/server/mail/templates.ts` in full before editing — the switch destructures its payload fields at the top of the function, and `items`/`count` are added there rather than inline in a case.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/mail-templates.test.ts`:

```ts
describe('subscription templates', () => {
	it('renders the confirmation mail with its link in both locales', () => {
		for (const locale of ['de', 'en']) {
			const mail = renderTemplate('subscription_confirm', locale, {
				url: 'https://trust.example/de/subscribe/confirm?token=abc'
			});
			expect(mail.subject).toBeTruthy();
			expect(mail.text).toContain('https://trust.example/de/subscribe/confirm?token=abc');
		}
	});

	it('renders the notice with the pre-rendered list and the manage link', () => {
		const mail = renderTemplate('subscription_notice', 'de', {
			url: 'https://trust.example/de/subscribe/manage?token=xyz',
			items: 'Neue Unterauftragsverarbeiter\nhttps://trust.example/de/updates#sub-1',
			count: 1
		});
		expect(mail.text).toContain('Neue Unterauftragsverarbeiter');
		expect(mail.text).toContain('https://trust.example/de/updates#sub-1');
		expect(mail.text).toContain('https://trust.example/de/subscribe/manage?token=xyz');
	});

	// P4.4: this template exists so the confirmed case is indistinguishable from
	// the other two, and it carries the manage link because that is the recovery
	// path for a subscriber who has lost every mail we sent.
	it('renders the already-subscribed mail with the manage link', () => {
		const mail = renderTemplate('subscription_already', 'de', {
			url: 'https://trust.example/de/subscribe/manage?token=xyz'
		});
		expect(mail.subject).toBeTruthy();
		expect(mail.text).toContain('https://trust.example/de/subscribe/manage?token=xyz');
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:unit tests/unit/mail-templates.test.ts`
Expected: FAIL — `'subscription_confirm'` is not assignable to `MailTemplate`.

- [ ] **Step 3: Add the catalog entries**

In `messages/de.json`, add (keys stay alphabetically placed as the file already orders them):

```json
"mail_subscription_already_body": "Diese Adresse ist bereits für Benachrichtigungen registriert. Wir haben nichts geändert.\n\nThemen ändern oder abbestellen:\n{url}",
"mail_subscription_already_subject": "Sie sind bereits angemeldet",
"mail_subscription_confirm_body": "Bitte bestätigen Sie, dass Sie Benachrichtigungen aus unserem Trust Center erhalten möchten:\n{url}\n\nDer Link ist einmalig gültig und läuft ab. Wenn Sie das nicht waren, ignorieren Sie diese E-Mail — es wird nichts gesendet.",
"mail_subscription_confirm_subject": "Bestätigen Sie Ihre Benachrichtigungen",
"mail_subscription_notice_body": "Es gibt {count} Neuigkeit(en) in Ihrem Trust Center:\n\n{items}\n\nThemen ändern oder abbestellen:\n{url}",
"mail_subscription_notice_fallback": "in einer anderen Sprache",
"mail_subscription_notice_subject": "Neues in unserem Trust Center",
```

In `messages/en.json`:

```json
"mail_subscription_already_body": "This address is already registered for notifications. We changed nothing.\n\nChange topics or unsubscribe:\n{url}",
"mail_subscription_already_subject": "You are already subscribed",
"mail_subscription_confirm_body": "Please confirm that you would like notifications from our Trust Center:\n{url}\n\nThe link can be used once and expires. If this was not you, ignore this email — nothing will be sent.",
"mail_subscription_confirm_subject": "Confirm your notifications",
"mail_subscription_notice_body": "There are {count} update(s) in your Trust Center:\n\n{items}\n\nChange topics or unsubscribe:\n{url}",
"mail_subscription_notice_fallback": "in another language",
"mail_subscription_notice_subject": "New in our Trust Center",
```

- [ ] **Step 4: Extend the template union and the switch**

In `src/lib/server/mail/templates.ts`, add to `MAIL_TEMPLATES` after `'nda_record'`:

```ts
	'subscription_confirm',
	'subscription_notice',
	'subscription_already'
```

Beside the existing `const url = String(payload.url ?? '');` block, add:

```ts
	// Pre-rendered by the notify job rather than carried as a structured list
	// (P4.15): `MailPayload` admits no array of objects, and widening it would
	// be a port change for a plain-text mail.
	const items = String(payload.items ?? '');
	const count = String(payload.count ?? 0);
```

And the four cases, following the shape of the existing ones exactly:

```ts
		case 'subscription_confirm':
			return {
				subject: m.mail_subscription_confirm_subject({}, options),
				text: m.mail_subscription_confirm_body({ url }, options)
			};
		case 'subscription_notice':
			return {
				subject: m.mail_subscription_notice_subject({}, options),
				text: m.mail_subscription_notice_body({ url, items, count }, options)
			};
		case 'subscription_already':
			return {
				subject: m.mail_subscription_already_subject({}, options),
				text: m.mail_subscription_already_body({ url }, options)
			};
```

Match the exact argument shape the neighbouring cases use — if they call `m.foo(options)` for parameterless messages rather than `m.foo({}, options)`, follow that instead.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm check && pnpm test:unit tests/unit/mail-templates.test.ts`
Expected: `pnpm check` at 0 errors — a missing catalog key in either locale fails here rather than in production — and the unit suite PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/mail/templates.ts messages/ tests/unit/mail-templates.test.ts
git commit -m "feat(mail): three subscription templates"
```

**Gate C:** `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration`

---

### Task 6: The subscribe form

**Files:**
- Create: `src/routes/(portal)/subscribe/+page.server.ts`, `src/routes/(portal)/subscribe/+page.svelte`
- Modify: `messages/de.json`, `messages/en.json`
- Modify: the portal navigation component (find it with `grep -rl "nav_updates" src/lib/components/portal/`)

**Interfaces:**
- Consumes: `subscribe` (Task 2), `subscription_confirm` / `subscription_already` templates (Task 5).
- Produces: the route `/{locale}/subscribe`, POSTing to its default action and returning `{ submitted: true }` in every outcome.

- [ ] **Step 1: Add the page copy**

`messages/de.json`:

```json
"nav_subscribe": "Benachrichtigungen",
"subscribe_intro": "Erhalten Sie eine E-Mail, wenn sich etwas ändert. Wählen Sie die Themen, die Sie interessieren.",
"subscribe_error_email": "Bitte geben Sie eine gültige E-Mail-Adresse ein.",
"subscribe_error_throttled": "Zu viele Versuche. Bitte versuchen Sie es später erneut.",
"subscribe_error_topics": "Bitte wählen Sie mindestens ein Thema.",
"subscribe_submit": "Anmelden",
"subscribe_submitted_body": "Wenn diese Adresse verwendet werden kann, ist eine E-Mail unterwegs. Bitte bestätigen Sie darin Ihre Anmeldung.",
"subscribe_submitted_title": "Prüfen Sie Ihr Postfach",
"subscribe_title": "Benachrichtigungen abonnieren",
"subscribe_topics": "Themen",
```

`messages/en.json`:

```json
"nav_subscribe": "Notifications",
"subscribe_intro": "Get an email when something changes. Choose the topics you care about.",
"subscribe_error_email": "Please enter a valid email address.",
"subscribe_error_throttled": "Too many attempts. Please try again later.",
"subscribe_error_topics": "Please choose at least one topic.",
"subscribe_submit": "Subscribe",
"subscribe_submitted_body": "If that address can be used, an email is on its way. Please confirm your subscription in it.",
"subscribe_submitted_title": "Check your inbox",
"subscribe_title": "Subscribe to notifications",
"subscribe_topics": "Topics",
```

The submitted copy is deliberately conditional ("if that address can be used"). It is the same sentence for all three §4.3 outcomes, and a sentence that promised a mail unconditionally would be a lie in none of them but would invite a reader to infer state from wording.

- [ ] **Step 2: Write the route**

Create `src/routes/(portal)/subscribe/+page.server.ts`:

```ts
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { UPDATE_KINDS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { enqueueEmail } from '$lib/server/mail/queue';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import { subscribe } from '$lib/server/subscriptions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders }) => {
	// A public form, identical for everyone, so it stays cacheable exactly as
	// /request is. The confirm and manage pages are NOT — they carry a token,
	// and spec §10.3 is where that divergence is argued.
	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });
	return { topics: [...UPDATE_KINDS] };
};

type SubscribeFailure = { field: string };

const schema = z.object({
	email: z.string().trim().toLowerCase().email(),
	// Refused here rather than by a constraint: a subscription that matches
	// nothing is a row that exists to send no mail, and would read as a bug
	// from both ends (spec §5).
	topics: z.array(z.enum(UPDATE_KINDS)).min(1)
});

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const parsed = schema.safeParse({
			email: form.get('email'),
			topics: form.getAll('topics').map(String)
		});

		if (!parsed.success) {
			return fail<SubscribeFailure>(400, {
				field: String(parsed.error.issues[0]?.path[0] ?? 'email')
			});
		}

		const db = getDb();
		const config = getConfig();
		const ip = clientIp(event);

		// Two limiters, mirroring /request: the email limiter stops one address
		// being mail-bombed, the ip limiter stops one client enumerating many. A
		// null ip falls back to a shared bucket rather than skipping the check.
		for (const key of [
			rateLimitKey('subscribe:email', parsed.data.email),
			rateLimitKey('subscribe:ip', ip ?? 'unknown')
		]) {
			const limited = await consumeRateLimit(db, { key, limit: 5, windowSeconds: 3600 });
			if (!limited.allowed) return fail<SubscribeFailure>(429, { field: 'throttled' });
		}

		const result = await subscribe(db, {
			email: parsed.data.email,
			locale: event.locals.locale,
			topics: parsed.data.topics,
			ttlMinutes: config.magicLinkTtlMinutes
		});

		if (result.kind === 'already') {
			// Changes nothing and audits nothing (P4.4, P4.17): an unauthenticated
			// caller must not edit — or append audit rows against — a stranger's
			// subscription. The mail is the only trace, and outbound_email holds it.
			// It carries the manage link, which is the recovery path for someone
			// who has lost every mail we sent them.
			//
			// The token is read here rather than returned by `subscribe`, so a
			// stranger's credential never reaches a response body — only their
			// mailbox. A confirmed row always has one (the check constraint says
			// so), but a null must not become the string "null" in a mailed link.
			const token = await manageTokenFor(db, result.subscriptionId);
			if (token) {
				await enqueueEmail(db, {
					to: parsed.data.email,
					template: 'subscription_already',
					locale: event.locals.locale,
					payload: {
						url: `${config.baseUrl}${localizePath(
							`/subscribe/manage?token=${encodeURIComponent(token)}`,
							event.locals.locale
						)}`
					}
				});
			}
			return { submitted: true };
		}

		await enqueueEmail(db, {
			to: parsed.data.email,
			template: 'subscription_confirm',
			locale: event.locals.locale,
			payload: {
				url: `${config.baseUrl}${localizePath(
					`/subscribe/confirm?token=${encodeURIComponent(result.confirmToken)}`,
					event.locals.locale
				)}`
			}
		});

		await recordEvent(db, {
			// `system`, not `subscriber`: nobody has proven they control that
			// address yet, exactly as `access_request.submitted` reasons. The
			// `subscriber` actor starts at confirmation, which is the moment
			// consent becomes a fact worth attributing (spec §10.1).
			actor: { type: 'system', id: null },
			action: 'subscription.requested',
			subjectType: 'subscription',
			subjectId: result.subscriptionId,
			ip: ip ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined,
			// No address and no topic list: spec §10.2 confines subscriber personal
			// data to ip, ua and actor_id. The row itself holds the rest.
			meta: { topicCount: parsed.data.topics.length }
		});

		// Identical in all three cases. This is the enumeration resistance: known
		// address, unknown address and confirmed address all end here.
		return { submitted: true };
	}
};
```

`manageTokenFor` does not exist yet. `subscribe` deliberately does not return the token — handing a stranger's credential back from an unauthenticated call path is what P4.4 forbids at the browser boundary — so add a narrow reader to `src/lib/server/subscriptions/index.ts`, used only to address the mail:

```ts
/**
 * The manage link for a confirmed subscription, for the one caller that needs
 * it without holding the token: the `already` branch of §4.3, which mails it to
 * the address rather than returning it. Never surface this to a response body.
 */
export async function manageTokenFor(db: Db, id: string): Promise<string | null> {
	const [row] = await db
		.select({ token: subscription.manageToken })
		.from(subscription)
		.where(eq(subscription.id, id));
	return row?.token ?? null;
}
```

Import it beside `subscribe` in the route.

- [ ] **Step 3: Write the page**

Create `src/routes/(portal)/subscribe/+page.svelte`, following `request/+page.svelte`'s shape:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import Seo from '$lib/components/portal/Seo.svelte';
	import type { UpdateKind } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// A label per topic rather than one interpolated message: a kind is a
	// database value, and rendering it inside German copy would leave an
	// English word in the sentence.
	const TOPIC_LABEL: Record<UpdateKind, () => string> = {
		document: () => m.update_kind_document(),
		subprocessor: () => m.update_kind_subprocessor(),
		certification: () => m.update_kind_certification(),
		advisory: () => m.update_kind_advisory()
	};
</script>

<Seo
	baseUrl={data.baseUrl}
	title={m.subscribe_title()}
	description={m.subscribe_intro()}
	siteName={data.branding.organizationName}
	locale={data.locale}
	locales={data.locales}
	defaultLocale={data.defaultLocale}
	noindex
/>

{#if form?.submitted}
	<SectionHeading title={m.subscribe_submitted_title()} />
	<p data-testid="subscribe-submitted" class="max-w-prose text-neutral-700">
		{m.subscribe_submitted_body()}
	</p>
{:else}
	<SectionHeading title={m.subscribe_title()} description={m.subscribe_intro()} />

	<form method="POST" use:enhance class="max-w-xl space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.request_email()}</span>
			<input
				name="email"
				type="email"
				required
				autocomplete="email"
				data-testid="subscribe-email"
				class="w-full rounded border px-3 py-2"
			/>
			{#if form?.field === 'email'}
				<p class="mt-1 text-sm text-red-700">{m.subscribe_error_email()}</p>
			{/if}
		</label>

		<fieldset>
			<legend class="mb-1 block text-sm font-medium">{m.subscribe_topics()}</legend>
			{#each data.topics as topic (topic)}
				<label class="flex items-center gap-2 py-1">
					<input type="checkbox" name="topics" value={topic} data-testid="subscribe-topic-{topic}" />
					<span>{TOPIC_LABEL[topic]()}</span>
				</label>
			{/each}
			{#if form?.field === 'topics'}
				<p class="mt-1 text-sm text-red-700">{m.subscribe_error_topics()}</p>
			{/if}
		</fieldset>

		{#if form?.field === 'throttled'}
			<p data-testid="subscribe-throttled" class="text-sm text-red-700">
				{m.subscribe_error_throttled()}
			</p>
		{/if}

		<button
			data-testid="subscribe-submit"
			class="rounded bg-neutral-900 px-3 py-1.5 text-white">{m.subscribe_submit()}</button
		>
	</form>
{/if}
```

Check what `request/+page.svelte`'s `data` actually carries (`baseUrl`, `branding`, `locale`, `locales`, `defaultLocale` all come from the portal layout load) and match it — if the layout supplies them, the page load returns only `topics`.

- [ ] **Step 4: Add the nav link**

In the portal navigation component, add an entry pointing at `localizePath('/subscribe', locale)` labelled `m.nav_subscribe()`, following the existing entries exactly.

- [ ] **Step 5: Verify by hand**

Run: `pnpm dev`, then open `/de/subscribe`, submit with no topics (expect the topic error), then submit with an address and one topic (expect the submitted panel). Confirm a row landed:

```sh
psql "$DATABASE_URL" -c "select email, locale, confirmed_at from subscription order by created_at desc limit 3;"
psql "$DATABASE_URL" -c "select template, \"to\" from outbound_email order by created_at desc limit 3;"
```

Expected: one unconfirmed row, one `subscription_confirm` mail.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/routes/\(portal\)/subscribe src/lib/server/subscriptions/index.ts src/lib/components/portal messages/
git commit -m "feat(portal): the subscribe form"
```

---

### Task 7: The confirmation page — a rendered button, never a GET

**Files:**
- Create: `src/routes/(portal)/subscribe/confirm/+page.server.ts`, `.../+page.svelte`
- Modify: `messages/de.json`, `messages/en.json`

**Interfaces:**
- Consumes: `confirmSubscription` (Task 3).
- Produces: the route `/{locale}/subscribe/confirm`, GET rendering a button, POST confirming.

- [ ] **Step 1: Add the copy**

`messages/de.json`:

```json
"confirm_button": "Anmeldung bestätigen",
"confirm_done_body": "Sie erhalten ab jetzt Benachrichtigungen zu Ihren Themen. Jede E-Mail enthält einen Link zum Ändern oder Abbestellen.",
"confirm_done_title": "Anmeldung bestätigt",
"confirm_expired": "Dieser Link ist abgelaufen oder wurde bereits verwendet. Bitte melden Sie sich erneut an.",
"confirm_intro": "Bitte bestätigen Sie, dass Sie Benachrichtigungen erhalten möchten.",
"confirm_title": "Anmeldung bestätigen",
```

`messages/en.json`:

```json
"confirm_button": "Confirm subscription",
"confirm_done_body": "You will now receive notifications for your topics. Every email carries a link to change them or unsubscribe.",
"confirm_done_title": "Subscription confirmed",
"confirm_expired": "This link has expired or has already been used. Please subscribe again.",
"confirm_intro": "Please confirm that you would like to receive notifications.",
"confirm_title": "Confirm your subscription",
```

- [ ] **Step 2: Write the route**

Create `src/routes/(portal)/subscribe/confirm/+page.server.ts`:

```ts
import { fail } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { confirmSubscription } from '$lib/server/subscriptions';
import type { Actions, PageServerLoad } from './$types';

/**
 * The load deliberately does not look the token up, and above all does not
 * consume it. Corporate mail scanners and link previewers prefetch URLs in
 * inbound mail; a confirming GET would let a scanner forge the exact consent
 * that double opt-in exists to evidence (P4.3). The page renders a button and a
 * human presses it.
 */
export const load: PageServerLoad = async ({ setHeaders, url }) => {
	// Not cacheable, unlike every other portal page: the query string carries a
	// token, and a shared cache serving this page to the next visitor would hand
	// it over (spec §10.3). `no-referrer` keeps it out of a Referer header.
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
	return { token: url.searchParams.get('token') ?? '' };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const token = String(form.get('token') ?? '');

		const confirmed = await confirmSubscription(getDb(), token);
		// Unknown, spent and expired are one outcome on purpose: the page cannot
		// tell them apart and telling a caller which would be a probing oracle.
		if (!confirmed) return fail(410, { expired: true });

		await recordEvent(getDb(), {
			// The fourth actor (P4.11). `system` would make "who consented"
			// unanswerable in precisely the case where consent is the fact being
			// evidenced. The id is the subscription UUID; the address is nowhere.
			actor: { type: 'subscriber', id: confirmed.subscriptionId },
			action: 'subscription.confirmed',
			subjectType: 'subscription',
			subjectId: confirmed.subscriptionId,
			ip: clientIp(event) ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined
		});

		return { confirmed: true };
	}
};
```

Create `src/routes/(portal)/subscribe/confirm/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

{#if form?.confirmed}
	<SectionHeading title={m.confirm_done_title()} />
	<p data-testid="confirm-done" class="max-w-prose text-neutral-700">{m.confirm_done_body()}</p>
{:else}
	<SectionHeading title={m.confirm_title()} description={m.confirm_intro()} />

	{#if form?.expired}
		<p data-testid="confirm-expired" class="mb-4 text-sm text-red-700">{m.confirm_expired()}</p>
	{/if}

	<form method="POST" use:enhance>
		<input type="hidden" name="token" value={data.token} />
		<button
			data-testid="confirm-submit"
			class="rounded bg-neutral-900 px-3 py-1.5 text-white">{m.confirm_button()}</button
		>
	</form>
{/if}
```

The page has no `<Seo>` block and must not be indexed — check whether the portal layout emits a default `robots` directive; if it does not, add `noindex` the way `request/+page.svelte` does.

- [ ] **Step 3: Verify by hand**

Run `pnpm dev`, subscribe, take the token out of the queued mail, and open the confirm URL:

```sh
psql "$DATABASE_URL" -c "select payload->>'url' from outbound_email order by created_at desc limit 1;"
```

Open it. Assert the row is **still unconfirmed** after the GET, then press the button and assert it is confirmed:

```sh
psql "$DATABASE_URL" -c "select confirmed_at, manage_token is not null as has_manage from subscription order by created_at desc limit 1;"
```

- [ ] **Step 4: Commit**

```bash
pnpm format
git add src/routes/\(portal\)/subscribe/confirm messages/
git commit -m "feat(portal): confirmation behind a button, never a GET"
```

---

### Task 8: The manage page

**Files:**
- Create: `src/routes/(portal)/subscribe/manage/+page.server.ts`, `.../+page.svelte`
- Modify: `messages/de.json`, `messages/en.json`

**Interfaces:**
- Consumes: `subscriptionByManageToken`, `saveSubscription`, `unsubscribe` (Task 4).
- Produces: the route `/{locale}/subscribe/manage`, with `?/save` and `?/unsubscribe`.

- [ ] **Step 1: Add the copy**

`messages/de.json`:

```json
"manage_intro": "Ändern Sie Ihre Themen und Sprache, oder bestellen Sie ab.",
"manage_language": "Sprache",
"manage_gone_body": "Diese Adresse erhält keine Benachrichtigungen mehr.",
"manage_gone_title": "Abbestellt",
"manage_saved": "Gespeichert.",
"manage_save": "Speichern",
"manage_title": "Ihre Benachrichtigungen",
"manage_unsubscribe": "Abbestellen",
```

`messages/en.json`:

```json
"manage_intro": "Change your topics and language, or unsubscribe.",
"manage_language": "Language",
"manage_gone_body": "This address will no longer receive notifications.",
"manage_gone_title": "Unsubscribed",
"manage_saved": "Saved.",
"manage_save": "Save",
"manage_title": "Your notifications",
"manage_unsubscribe": "Unsubscribe",
```

- [ ] **Step 2: Write the route**

Create `src/routes/(portal)/subscribe/manage/+page.server.ts`:

```ts
import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { UPDATE_KINDS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import {
	saveSubscription,
	subscriptionByManageToken,
	unsubscribe
} from '$lib/server/subscriptions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ setHeaders, url }) => {
	// The manage token never expires, so a cached copy of this page is a
	// permanent credential sitting in a shared cache (spec §10.3, P4.21).
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });

	const token = url.searchParams.get('token') ?? '';
	const found = await subscriptionByManageToken(getDb(), token);
	// 404 rather than a message: an unknown token is indistinguishable from a
	// path that does not exist, and should look like one.
	if (!found) error(404, 'Not found');

	return {
		token,
		topics: found.topics,
		subscriptionLocale: found.locale,
		allTopics: [...UPDATE_KINDS],
		availableLocales: [...getConfig().locales]
	};
};

const saveSchema = z.object({
	// Same rule as the subscribe form (spec §5). Saving zero topics is NOT
	// quietly an unsubscribe: that button is right there, and a save that
	// silently deleted the record being edited would be a destructive action
	// behind a non-destructive control.
	topics: z.array(z.enum(UPDATE_KINDS)).min(1),
	locale: z.string()
});

export const actions: Actions = {
	save: async (event) => {
		const form = await event.request.formData();
		const found = await subscriptionByManageToken(getDb(), String(form.get('token') ?? ''));
		if (!found) error(404, 'Not found');

		const parsed = saveSchema.safeParse({
			topics: form.getAll('topics').map(String),
			locale: form.get('locale')
		});
		if (!parsed.success) return fail(400, { field: 'topics' });

		// A locale the operator has since disabled must not be storable, or the
		// notice job would have to fall back on every send (spec §6.4).
		const config = getConfig();
		const locale = config.locales.includes(parsed.data.locale)
			? parsed.data.locale
			: config.defaultLocale;

		await saveSubscription(getDb(), found.id, { locale, topics: parsed.data.topics });

		await recordEvent(getDb(), {
			actor: { type: 'subscriber', id: found.id },
			action: 'subscription.topics_changed',
			subjectType: 'subscription',
			subjectId: found.id,
			ip: clientIp(event) ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined,
			meta: { topicCount: parsed.data.topics.length, locale }
		});

		// The path prefix names the locale being left, so a locale change has to
		// land on the new one — otherwise the page redraws in the old language
		// and reads as a save that did not take.
		redirect(
			303,
			localizePath(`/subscribe/manage?token=${encodeURIComponent(found.manageToken)}`, locale)
		);
	},

	unsubscribe: async (event) => {
		const form = await event.request.formData();
		const found = await subscriptionByManageToken(getDb(), String(form.get('token') ?? ''));
		if (!found) error(404, 'Not found');

		await unsubscribe(getDb(), found.id);

		await recordEvent(getDb(), {
			// Written after the delete. The audit row's actor_id now points at a
			// row that is gone, and that is the design (spec §10.2): the link
			// between occurrence and person is broken while the occurrence
			// survives. We do NOT additionally clear actor_id — the triggers
			// would permit it, but it would destroy an auditor's ability to read
			// "confirmed on the 3rd, left on the 20th" as one story, for no
			// privacy gain now that the UUID points at nothing.
			actor: { type: 'subscriber', id: found.id },
			action: 'subscription.unsubscribed',
			subjectType: 'subscription',
			subjectId: found.id,
			ip: clientIp(event) ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined
		});

		return { gone: true };
	}
};
```

`found.manageToken` comes from Task 4's `ManagedSubscription`, so the redirect needs no `?? ''` — drop it.

- [ ] **Step 3: Write the page**

Create `src/routes/(portal)/subscribe/manage/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import type { UpdateKind } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const TOPIC_LABEL: Record<UpdateKind, () => string> = {
		document: () => m.update_kind_document(),
		subprocessor: () => m.update_kind_subprocessor(),
		certification: () => m.update_kind_certification(),
		advisory: () => m.update_kind_advisory()
	};
</script>

{#if form?.gone}
	<SectionHeading title={m.manage_gone_title()} />
	<p data-testid="manage-gone" class="max-w-prose text-neutral-700">{m.manage_gone_body()}</p>
{:else}
	<SectionHeading title={m.manage_title()} description={m.manage_intro()} />

	<form method="POST" action="?/save" use:enhance class="max-w-xl space-y-4">
		<input type="hidden" name="token" value={data.token} />

		<fieldset>
			<legend class="mb-1 block text-sm font-medium">{m.subscribe_topics()}</legend>
			{#each data.allTopics as topic (topic)}
				<label class="flex items-center gap-2 py-1">
					<input
						type="checkbox"
						name="topics"
						value={topic}
						data-testid="manage-topic-{topic}"
						checked={data.topics.includes(topic)}
					/>
					<span>{TOPIC_LABEL[topic]()}</span>
				</label>
			{/each}
			{#if form?.field === 'topics'}
				<p class="mt-1 text-sm text-red-700">{m.subscribe_error_topics()}</p>
			{/if}
		</fieldset>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.manage_language()}</span>
			<select name="locale" data-testid="manage-locale" class="rounded border px-2 py-1">
				{#each data.availableLocales as locale (locale)}
					<option value={locale} selected={locale === data.subscriptionLocale}>{locale}</option>
				{/each}
			</select>
		</label>

		<button data-testid="manage-save" class="rounded bg-neutral-900 px-3 py-1.5 text-white"
			>{m.manage_save()}</button
		>
	</form>

	<form method="POST" action="?/unsubscribe" use:enhance class="mt-8">
		<input type="hidden" name="token" value={data.token} />
		<button data-testid="manage-unsubscribe" class="rounded border px-3 py-1.5 text-red-700"
			>{m.manage_unsubscribe()}</button
		>
	</form>
{/if}
```

Two separate forms rather than two submit buttons in one, so unsubscribe cannot be reached by pressing Enter in the topic list.

- [ ] **Step 4: Verify by hand**

With the confirmed row from Task 7, read its token and open the manage page:

```sh
psql "$DATABASE_URL" -c "select manage_token from subscription order by created_at desc limit 1;"
```

Confirm: the GET changes nothing; unticking every topic and saving is refused; changing the locale redirects to the other prefix; unsubscribe deletes the row and its topics.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/routes/\(portal\)/subscribe/manage src/lib/server/subscriptions/index.ts messages/
git commit -m "feat(portal): the manage page behind the permanent token"
```

**Gate D:** `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e`

---

### Task 9: `planNotices` — the whole decision, as a pure function

**Files:**
- Create: `src/lib/server/subscriptions/notify.ts`
- Test: `tests/unit/subscription-notify.test.ts`

**Interfaces:**
- Produces:
  - `interface NoticePost { id: string; slug: string; publishedAt: Date; translations: readonly { locale: string; title: string; body: string }[] }`
  - `interface NoticeSubscription { id: string; email: string; locale: string; manageToken: string; posts: readonly NoticePost[] }`
  - `interface NoticePlan { subscriptionId: string; cursor: Date; mail: { to: string; locale: string; payload: { url: string; items: string; count: number } } | null }`
  - `planNotices(subscriptions, { baseUrl, enabledLocales, defaultLocale }): NoticePlan[]`

Everything that could be wrong about a notice is decided here, with no database in the way: which posts are included, what the cursor becomes, which locale is used, whether the mail is empty. Task 10 only fetches rows and writes the result.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/subscription-notify.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { planNotices } from '../../src/lib/server/subscriptions/notify';
import type { NoticePost, NoticeSubscription } from '../../src/lib/server/subscriptions/notify';

const OPTIONS = {
	baseUrl: 'https://trust.example',
	enabledLocales: ['de', 'en'],
	defaultLocale: 'de'
};

function post(partial: Partial<NoticePost> & { id: string; publishedAt: Date }): NoticePost {
	return {
		...partial,
		slug: partial.slug ?? partial.id,
		translations: partial.translations ?? [
			{ locale: 'de', title: `Titel ${partial.id}`, body: 'Rumpf' },
			{ locale: 'en', title: `Title ${partial.id}`, body: 'Body' }
		]
	};
}

function subscriber(posts: NoticePost[], locale = 'de'): NoticeSubscription {
	return { id: 'sub-1', email: 'a@example.test', locale, manageToken: 'tok', posts };
}

describe('planNotices', () => {
	it('builds one mail with a line per post and a count', () => {
		const [plan] = planNotices(
			[
				subscriber([
					post({ id: 'a', slug: 'alpha', publishedAt: new Date('2026-03-01T10:00:00Z') }),
					post({ id: 'b', slug: 'beta', publishedAt: new Date('2026-03-02T10:00:00Z') })
				])
			],
			OPTIONS
		);

		expect(plan.mail?.payload.count).toBe(2);
		expect(plan.mail?.payload.items).toContain('Titel a');
		expect(plan.mail?.payload.items).toContain('https://trust.example/de/updates#alpha');
		expect(plan.mail?.payload.url).toBe(
			'https://trust.example/de/subscribe/manage?token=tok'
		);
	});

	// P4.7: never now(). A post going live between the select and the update
	// would otherwise be stepped over and never sent.
	it('advances the cursor to the maximum publishedAt actually included', () => {
		const [plan] = planNotices(
			[
				subscriber([
					post({ id: 'a', publishedAt: new Date('2026-03-01T10:00:00Z') }),
					post({ id: 'b', publishedAt: new Date('2026-03-02T10:00:00Z') })
				])
			],
			OPTIONS
		);

		expect(plan.cursor.toISOString()).toBe('2026-03-02T10:00:00.000Z');
	});

	it('gives two subscribers with different posts different cursors', () => {
		const early = post({ id: 'a', publishedAt: new Date('2026-03-01T10:00:00Z') });
		const late = post({ id: 'b', publishedAt: new Date('2026-03-05T10:00:00Z') });

		const plans = planNotices(
			[
				{ ...subscriber([early]), id: 'sub-1' },
				{ ...subscriber([early, late]), id: 'sub-2' }
			],
			OPTIONS
		);

		expect(plans[0]!.cursor.toISOString()).toBe('2026-03-01T10:00:00.000Z');
		expect(plans[1]!.cursor.toISOString()).toBe('2026-03-05T10:00:00.000Z');
	});

	// §6.4: a post with no usable translation is skipped, and the cursor still
	// advances — reconsidering it every fifteen minutes forever would be a slow
	// loop that never terminates.
	it('skips a post with no title in the requested or default locale, and still advances', () => {
		const [plan] = planNotices(
			[
				subscriber([
					post({
						id: 'a',
						publishedAt: new Date('2026-03-01T10:00:00Z'),
						translations: [{ locale: 'fr', title: 'Titre', body: 'Corps' }]
					})
				])
			],
			OPTIONS
		);

		expect(plan.mail).toBeNull();
		expect(plan.cursor.toISOString()).toBe('2026-03-01T10:00:00.000Z');
	});

	it('labels a title that resolved by fallback', () => {
		const [plan] = planNotices(
			[
				subscriber(
					[
						post({
							id: 'a',
							publishedAt: new Date('2026-03-01T10:00:00Z'),
							translations: [{ locale: 'de', title: 'Nur Deutsch', body: 'Rumpf' }]
						})
					],
					'en'
				)
			],
			OPTIONS
		);

		expect(plan.mail?.payload.items).toContain('Nur Deutsch');
		// The reader asked for English and got German; saying so is the rule the
		// portal already applies, and a mail must not silently swap languages.
		expect(plan.mail?.payload.items).toMatch(/another language|anderen Sprache/);
	});

	// P4.20. `assertIsLocale` validates against the COMPILED catalogs, so a mail
	// in a disabled locale renders fine — and carries a manage link that 404s,
	// because classifyPath deliberately rejects a disabled prefix.
	it('falls back to the default locale when the subscriber locale was disabled', () => {
		const [plan] = planNotices(
			[subscriber([post({ id: 'a', publishedAt: new Date('2026-03-01T10:00:00Z') })], 'en')],
			{ ...OPTIONS, enabledLocales: ['de'] }
		);

		expect(plan.mail?.locale).toBe('de');
		expect(plan.mail?.payload.url).toBe('https://trust.example/de/subscribe/manage?token=tok');
	});

	it('returns no plan at all for a subscriber with no posts', () => {
		expect(planNotices([subscriber([])], OPTIONS)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:unit tests/unit/subscription-notify.test.ts`
Expected: FAIL — cannot resolve `notify`.

- [ ] **Step 3: Implement it**

Create `src/lib/server/subscriptions/notify.ts`:

```ts
import { localizePath, pickTranslation } from '../../i18n/locale';
import { m } from '../../paraglide/messages.js';
import { assertIsLocale } from '../../paraglide/runtime.js';

export interface NoticePost {
	id: string;
	slug: string;
	publishedAt: Date;
	translations: readonly { locale: string; title: string; body: string }[];
}

export interface NoticeSubscription {
	id: string;
	email: string;
	locale: string;
	manageToken: string;
	/** Already filtered by cursor and topics by the query; ordered oldest first. */
	posts: readonly NoticePost[];
}

export interface NoticePlan {
	subscriptionId: string;
	/** Always the maximum `publishedAt` included, never `now()` (P4.7). */
	cursor: Date;
	mail: {
		to: string;
		locale: string;
		payload: { url: string; items: string; count: number };
	} | null;
}

/**
 * Every decision a notice involves, with no database in the way: which posts
 * survive the translation rules, what the cursor becomes, which locale is used,
 * and whether there is anything left to send.
 *
 * A subscription with posts always yields a plan, even when the mail is null —
 * the cursor must advance either way, or unsendable posts would be reconsidered
 * every fifteen minutes forever (§6.4).
 */
export function planNotices(
	subscriptions: readonly NoticeSubscription[],
	options: {
		baseUrl: string;
		enabledLocales: readonly string[];
		defaultLocale: string;
	}
): NoticePlan[] {
	const plans: NoticePlan[] = [];

	for (const item of subscriptions) {
		if (item.posts.length === 0) continue;

		// The stored locale can name one the operator has since removed from
		// LOCALES. The mail would still render — `assertIsLocale` validates
		// against the compiled catalogs, not the enabled ones — but the manage
		// link it carries would 404, because `classifyPath` rejects a disabled
		// prefix. A dead unsubscribe link is the defect §4.2 is about (P4.20).
		const locale = options.enabledLocales.includes(item.locale)
			? item.locale
			: options.defaultLocale;
		const messageOptions = { locale: assertIsLocale(locale) };

		const lines: string[] = [];
		let cursor = item.posts[0]!.publishedAt;

		for (const post of item.posts) {
			// Per subscription, not per tick: two subscribers with different topic
			// sets legitimately end the same tick at different cursors.
			if (post.publishedAt > cursor) cursor = post.publishedAt;

			const title = pickTranslation(
				post.translations.map((row) => ({ locale: row.locale, value: row.title })),
				locale,
				options.defaultLocale
			);
			const body = pickTranslation(
				post.translations.map((row) => ({ locale: row.locale, value: row.body })),
				locale,
				options.defaultLocale
			);
			// The same two rules the portal applies, for the same reason.
			if (!title || !body) continue;

			const label = title.isFallback
				? ` (${m.mail_subscription_notice_fallback({}, messageOptions)})`
				: '';
			const url = `${options.baseUrl}${localizePath('/updates', locale)}#${post.slug}`;
			lines.push(`${title.value}${label}\n${url}`);
		}

		plans.push({
			subscriptionId: item.id,
			cursor,
			mail:
				lines.length === 0
					? null
					: {
							to: item.email,
							locale,
							payload: {
								// Pre-rendered rather than structured (P4.15): MailPayload admits
								// no array of objects, and widening it would be a port change.
								items: lines.join('\n\n'),
								count: lines.length,
								url: `${options.baseUrl}${localizePath(
									`/subscribe/manage?token=${encodeURIComponent(item.manageToken)}`,
									locale
								)}`
							}
						}
		});
	}

	return plans;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:unit tests/unit/subscription-notify.test.ts`
Expected: PASS, 7 cases.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/subscriptions/notify.ts tests/unit/subscription-notify.test.ts
git commit -m "feat(subscriptions): plan notices as a pure function"
```

---

### Task 10: The tick — one select, one transaction, bounded

**Files:**
- Modify: `src/lib/server/subscriptions/notify.ts`
- Test: `tests/integration/subscription-notify.test.ts`

**Interfaces:**
- Consumes: `planNotices` (Task 9), `enqueueEmail` (existing).
- Produces: `notifySubscribers(db, { baseUrl, enabledLocales, defaultLocale, limit? }): Promise<{ queued: number; advanced: number }>`.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/subscription-notify.test.ts`. Build fixtures through `subscribe` + `confirmSubscription` so the row shape is always one the check constraints accept.

```ts
import { desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	outboundEmail,
	subscription,
	updatePost,
	updatePostTranslation
} from '../../src/lib/server/db/schema';
import {
	confirmSubscription,
	saveSubscription,
	subscribe
} from '../../src/lib/server/subscriptions';
import { notifySubscribers } from '../../src/lib/server/subscriptions/notify';
import type { UpdateKind } from '../../src/lib/content-types';

let db: Db;
let close: () => Promise<void>;

const OPTIONS = {
	baseUrl: 'https://trust.example',
	enabledLocales: ['de', 'en'],
	defaultLocale: 'de'
};

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

async function makePost(kind: UpdateKind, publishedAt: Date | null): Promise<string> {
	const slug = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const [row] = await db
		.insert(updatePost)
		.values({ slug, kind, publishedAt })
		.returning({ id: updatePost.id });
	await db.insert(updatePostTranslation).values([
		{ postId: row!.id, locale: 'de', title: `Titel ${slug}`, body: 'Rumpf' },
		{ postId: row!.id, locale: 'en', title: `Title ${slug}`, body: 'Body' }
	]);
	return row!.id;
}

async function makeSubscriber(topics: UpdateKind[], cursor: Date): Promise<string> {
	const email = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
	const created = await subscribe(db, { email, locale: 'de', topics, ttlMinutes: 60 });
	const confirmed = await confirmSubscription(
		db,
		created.kind === 'already' ? '' : created.confirmToken
	);
	await db
		.update(subscription)
		.set({ lastNotifiedAt: cursor })
		.where(eq(subscription.id, confirmed!.subscriptionId));
	return confirmed!.subscriptionId;
}

async function mailsFor(id: string): Promise<{ template: string; payload: unknown }[]> {
	const [row] = await db
		.select({ email: subscription.email })
		.from(subscription)
		.where(eq(subscription.id, id));
	if (!row) return [];
	return db
		.select({ template: outboundEmail.template, payload: outboundEmail.payload })
		.from(outboundEmail)
		.where(eq(outboundEmail.to, row.email))
		.orderBy(desc(outboundEmail.createdAt));
}

async function cursorOf(id: string): Promise<Date> {
	const [row] = await db
		.select({ at: subscription.lastNotifiedAt })
		.from(subscription)
		.where(eq(subscription.id, id));
	return row!.at!;
}

describe('notifySubscribers', () => {
	it('queues one mail per due subscriber and advances the cursor to the post date', async () => {
		const publishedAt = new Date(Date.now() - 60_000);
		await makePost('advisory', publishedAt);
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);

		const mails = await mailsFor(id);
		expect(mails.filter((mail) => mail.template === 'subscription_notice')).toHaveLength(1);
		expect((await cursorOf(id)).getTime()).toBe(publishedAt.getTime());
	});

	it('sends nothing on a second tick with no new posts', async () => {
		await makePost('advisory', new Date(Date.now() - 60_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);
		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(1);
	});

	it('ignores a post outside the subscriber topics', async () => {
		await makePost('certification', new Date(Date.now() - 60_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
	});

	// P4.8. Back-dating means "this was already announced"; the alternative is
	// mailing people about a change they were told about last week.
	it('never notifies about a back-dated post', async () => {
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));
		await makePost('advisory', new Date(Date.now() - 86_400_000));

		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
	});

	// §6.3, the mirror case: the same predicate giving the same answer. Pinned
	// so both directions are known rather than discovered.
	it('notifies again when a live post is re-dated forward', async () => {
		const postId = await makePost('advisory', new Date(Date.now() - 60_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);
		await db
			.update(updatePost)
			.set({ publishedAt: new Date(Date.now() - 1_000) })
			.where(eq(updatePost.id, postId));
		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(2);
	});

	it('ignores a scheduled post until its date passes', async () => {
		await makePost('advisory', new Date(Date.now() + 3_600_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
	});

	it('advances the cursor but queues nothing when every post is unsendable', async () => {
		const publishedAt = new Date(Date.now() - 60_000);
		const slug = `untranslated-${Date.now()}`;
		await db.insert(updatePost).values({ slug, kind: 'advisory', publishedAt });
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000));

		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
		expect((await cursorOf(id)).getTime()).toBe(publishedAt.getTime());
	});

	// P4.18 end to end, and the regression test spec §14 asks for by name. The
	// unit test in Task 9 cannot reach this: it is the interaction between a
	// stale cursor, a save, and the next tick.
	it('sends nothing older than a save when a topic is added late', async () => {
		// A post the subscriber's topics did not match, so no tick ever moved
		// their cursor past it.
		await makePost('document', new Date(Date.now() - 86_400_000));
		const id = await makeSubscriber(['advisory'], new Date(Date.now() - 172_800_000));

		await notifySubscribers(db, OPTIONS);
		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);

		// They now add `document`. Without the cursor advance in saveSubscription
		// this delivers a day of back catalogue in one mail.
		await saveSubscription(db, id, { locale: 'de', topics: ['advisory', 'document'] });
		await notifySubscribers(db, OPTIONS);

		expect(
			(await mailsFor(id)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);
	});

	it('stops at its bound and leaves the rest for the next tick', async () => {
		await makePost('advisory', new Date(Date.now() - 60_000));
		const ids = [
			await makeSubscriber(['advisory'], new Date(Date.now() - 7_200_000)),
			await makeSubscriber(['advisory'], new Date(Date.now() - 3_600_000))
		];

		const first = await notifySubscribers(db, { ...OPTIONS, limit: 1 });
		expect(first.queued).toBe(1);
		// Ordered by last_notified_at ascending: the most overdue goes first.
		expect(
			(await mailsFor(ids[0]!)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(1);
		expect(
			(await mailsFor(ids[1]!)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(0);

		await notifySubscribers(db, { ...OPTIONS, limit: 1 });
		expect(
			(await mailsFor(ids[1]!)).filter((mail) => mail.template === 'subscription_notice')
		).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:integration tests/integration/subscription-notify.test.ts`
Expected: FAIL — `notifySubscribers is not a function`.

- [ ] **Step 3: Implement it**

Append to `src/lib/server/subscriptions/notify.ts` (adding the Drizzle and schema imports it needs):

```ts
/** The tick's bound. `drainOutbox` is bounded for the same reason: `runJob`
 * holds a transaction-scoped advisory lock for the whole run, so an unbounded
 * tick holds it for an unbounded time. */
const DEFAULT_LIMIT = 500;

/** The grouping builder's view of a post, before it is handed to planNotices
 * as readonly. */
type MutablePost = Omit<NoticePost, 'translations'> & {
	translations: { locale: string; title: string; body: string }[];
};

/**
 * One select, rendering in memory, then one transaction of two statements
 * (P4.19). Not one transaction per subscriber — that is the N+1 the select was
 * shaped to avoid, reintroduced on the write side.
 *
 * The transaction makes queueing and advancing atomic, which makes the job
 * at-least-once rather than at-most-once: a crash before the commit re-sends
 * rather than skips.
 */
export async function notifySubscribers(
	db: Db,
	options: {
		baseUrl: string;
		enabledLocales: readonly string[];
		defaultLocale: string;
		limit?: number;
	}
): Promise<{ queued: number; advanced: number }> {
	const limit = options.limit ?? DEFAULT_LIMIT;

	// One query, joining subscription → subscription_topic → update_post →
	// update_post_translation. The subscriptions are bounded and ordered by
	// last_notified_at ascending so the most overdue go first; the posts and
	// translations ride along, so the tick costs one round trip regardless of
	// how many subscribers it serves.
	const rows = (await db.execute(sql`
		WITH due AS (
			SELECT s.id, s.email, s.locale, s.manage_token, s.last_notified_at
			FROM subscription s
			WHERE s.confirmed_at IS NOT NULL
			  AND EXISTS (
				SELECT 1
				FROM subscription_topic t
				JOIN update_post p ON p.kind = t.topic
				WHERE t.subscription_id = s.id
				  AND p.published_at > s.last_notified_at
				  AND p.published_at <= now()
			  )
			ORDER BY s.last_notified_at ASC
			LIMIT ${limit}
		)
		SELECT
			due.id            AS subscription_id,
			due.email         AS email,
			due.locale        AS locale,
			due.manage_token  AS manage_token,
			p.id              AS post_id,
			p.slug            AS slug,
			p.published_at    AS published_at,
			tr.locale         AS translation_locale,
			tr.title          AS title,
			tr.body           AS body
		FROM due
		JOIN subscription_topic t ON t.subscription_id = due.id
		JOIN update_post p
			ON p.kind = t.topic
		 AND p.published_at > due.last_notified_at
		 AND p.published_at <= now()
		LEFT JOIN update_post_translation tr ON tr.post_id = p.id
		ORDER BY due.id, p.published_at ASC
	`)) as unknown as {
		subscription_id: string;
		email: string;
		locale: string;
		manage_token: string;
		post_id: string;
		slug: string;
		published_at: Date;
		translation_locale: string | null;
		title: string | null;
		body: string | null;
	}[];

	if (rows.length === 0) return { queued: 0, advanced: 0 };

	// Group the flat result back into the shape planNotices takes. Built in
	// mutable locals rather than casting the readonly arrays away: the readonly
	// on the interface is for planNotices' callers, and the builder is not one.
	type Building = Omit<NoticeSubscription, 'posts'> & { posts: MutablePost[] };
	const bySubscription = new Map<string, Building>();
	const byPost = new Map<string, MutablePost>();

	for (const row of rows) {
		let item = bySubscription.get(row.subscription_id);
		if (!item) {
			item = {
				id: row.subscription_id,
				email: row.email,
				locale: row.locale,
				manageToken: row.manage_token,
				posts: []
			};
			bySubscription.set(row.subscription_id, item);
		}

		const key = `${row.subscription_id}:${row.post_id}`;
		let post = byPost.get(key);
		if (!post) {
			post = {
				id: row.post_id,
				slug: row.slug,
				publishedAt: new Date(row.published_at),
				translations: []
			};
			byPost.set(key, post);
			item.posts.push(post);
		}

		// LEFT JOIN, so a post with no translation at all arrives with nulls and
		// is skipped by planNotices rather than vanishing from the cursor.
		if (row.translation_locale && row.title !== null && row.body !== null) {
			post.translations.push({
				locale: row.translation_locale,
				title: row.title,
				body: row.body
			});
		}
	}

	const plans = planNotices([...bySubscription.values()], options);
	if (plans.length === 0) return { queued: 0, advanced: 0 };

	const mails = plans.filter((plan) => plan.mail !== null);

	await db.transaction(async (tx) => {
		if (mails.length > 0) {
			await tx.insert(outboundEmail).values(
				mails.map((plan) => ({
					to: plan.mail!.to,
					template: 'subscription_notice',
					locale: plan.mail!.locale,
					payload: plan.mail!.payload
				}))
			);
		}

		// One UPDATE … FROM (VALUES …) for every cursor, including the ones whose
		// mail came back empty: those posts were considered and found unsendable,
		// and reconsidering them every fifteen minutes forever would be a slow
		// loop that never terminates (§6.4).
		const values = sql.join(
			plans.map((plan) => sql`(${plan.subscriptionId}::uuid, ${plan.cursor}::timestamptz)`),
			sql`, `
		);
		await tx.execute(sql`
			UPDATE subscription
			SET last_notified_at = v.cursor
			FROM (VALUES ${values}) AS v(id, cursor)
			WHERE subscription.id = v.id
		`);
	});

	return { queued: mails.length, advanced: plans.length };
}
```

The `p.kind = t.topic` join is what makes the topic filter a join rather than array containment (P4.5). Note the `EXISTS` subquery in the CTE: it exists so `LIMIT` counts *subscribers*, not subscriber-post pairs — a limit applied after the post join would cut a subscriber's post list in half and advance their cursor past posts they never received.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/subscription-notify.test.ts`
Expected: PASS, 8 cases.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/subscriptions/notify.ts tests/integration/subscription-notify.test.ts
git commit -m "feat(subscriptions): the bounded, batched notification tick"
```

---

### Task 11: Wire the job and the sweep

**Files:**
- Modify: `src/lib/server/jobs/index.ts`
- Test: `tests/integration/subscription-notify.test.ts` (extend), `tests/integration/jobs.test.ts` (read first — it may assert the job list)

**Interfaces:**
- Consumes: `notifySubscribers` (Task 10), `sweepUnconfirmedSubscriptions` (Task 4).
- Produces: a sixth entry in `JOBS` named `subscriptions:notify`; `retention:sweep` also calls the unconfirmed sweep.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/subscription-notify.test.ts`:

```ts
import { JOBS } from '../../src/lib/server/jobs';

describe('the notify job is registered', () => {
	it('runs every fifteen minutes', () => {
		const job = JOBS.find((entry) => entry.name === 'subscriptions:notify');
		// P4.14: a lone notice arrives promptly and a burst coalesces by itself,
		// so the interval IS the digest window and no cadence setting is needed.
		expect(job?.everyMs).toBe(15 * 60 * 1000);
	});
});
```

`JOBS` is typed as `readonly Job[]` with `Job` unexported — if `job?.everyMs` does not typecheck, export the `Job` interface from `src/lib/server/jobs/index.ts` rather than casting in the test.

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:integration tests/integration/subscription-notify.test.ts -t registered`
Expected: FAIL — `expected undefined to be 900000`.

- [ ] **Step 3: Register both**

In `src/lib/server/jobs/index.ts`, add the imports and a new entry after `retention:sweep`:

```ts
	{
		// Fifteen minutes rather than an hour or a day (P4.14): a lone post
		// reaches subscribers promptly enough that nobody asks for an immediate
		// mode, while a burst published together still coalesces into one mail by
		// itself. The interval IS the digest window, in one operator-visible
		// place rather than as a per-subscriber preference.
		name: 'subscriptions:notify',
		everyMs: 15 * 60 * 1000,
		run: async (db) => {
			const config = getConfig();
			await notifySubscribers(db, {
				baseUrl: config.baseUrl,
				enabledLocales: config.locales,
				defaultLocale: config.defaultLocale
			});
		}
	}
```

And extend the existing `retention:sweep` entry's body with a third call:

```ts
			// A row whose confirmation token has expired can never become
			// confirmed, so it holds an address nobody proved they control.
			// Folded in here rather than becoming a seventh timer (spec §8).
			await sweepUnconfirmedSubscriptions(db);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:integration`
Expected: PASS. If `tests/integration/jobs.test.ts` asserts a job count, update that number and read the surrounding comment before changing it.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/jobs/index.ts tests/integration/subscription-notify.test.ts tests/integration/jobs.test.ts
git commit -m "feat(jobs): subscriptions:notify, and the unconfirmed sweep"
```

**Gate E:** `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration`

---

### Task 12: Linking a post to the subprocessors it announces

**Files:**
- Modify: `src/lib/server/content/updates.ts`
- Modify: `src/routes/(admin)/admin/updates/[id]/+page.server.ts`, `.../+page.svelte`
- Modify: `messages/de.json`, `messages/en.json`
- Test: `tests/integration/content.test.ts` (extend — read its existing update-post cases first and follow their fixture style)

**Interfaces:**
- Consumes: `updatePostSubprocessor` (Task 1).
- Produces: `setUpdateSubprocessors(db, postId, subprocessorIds): Promise<void>`; `AdminUpdate` gains `subprocessorIds: string[]`.

Without this task the link table is never written, so Task 13's badge fires on every subprocessor forever — which is the failure P4.10 exists to prevent, shipped on day one.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/content.test.ts`:

```ts
describe('update post subprocessor links', () => {
	it('replaces the set wholesale and reads it back', async () => {
		const stamp = `${Date.now()}`;
		const postId = await createUpdate(db, { slug: `link-${stamp}`, kind: 'subprocessor' });
		const first = await createSubprocessor(db, {
			slug: `sub-a-${stamp}`,
			name: 'A',
			legalEntity: 'A GmbH',
			country: 'DE',
			region: 'EU'
		});
		const second = await createSubprocessor(db, {
			slug: `sub-b-${stamp}`,
			name: 'B',
			legalEntity: 'B GmbH',
			country: 'DE',
			region: 'EU'
		});

		await setUpdateSubprocessors(db, postId, [first, second]);
		expect((await getUpdateForAdmin(db, postId))?.subprocessorIds.sort()).toEqual(
			[first, second].sort()
		);

		// The form submits the complete set every time, so an empty selection
		// clears it — the same contract `setControlEvidence` already has.
		await setUpdateSubprocessors(db, postId, []);
		expect((await getUpdateForAdmin(db, postId))?.subprocessorIds).toEqual([]);

		await deleteUpdate(db, postId);
		await deleteSubprocessor(db, first);
		await deleteSubprocessor(db, second);
	});

	it('drops the link when the post is deleted', async () => {
		const stamp = `${Date.now()}-cascade`;
		const postId = await createUpdate(db, { slug: `link-${stamp}`, kind: 'subprocessor' });
		const subId = await createSubprocessor(db, {
			slug: `sub-${stamp}`,
			name: 'C',
			legalEntity: 'C GmbH',
			country: 'DE',
			region: 'EU'
		});
		await setUpdateSubprocessors(db, postId, [subId]);

		await deleteUpdate(db, postId);

		const rows = await db
			.select()
			.from(updatePostSubprocessor)
			.where(eq(updatePostSubprocessor.subprocessorId, subId));
		expect(rows).toHaveLength(0);

		await deleteSubprocessor(db, subId);
	});
});
```

Check `createSubprocessor`'s real `NewSubprocessor` shape in `src/lib/server/content/subprocessors.ts` and pass exactly its required fields — the literals above are a guess at the minimum and must be corrected to match.

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:integration tests/integration/content.test.ts -t "subprocessor links"`
Expected: FAIL — `setUpdateSubprocessors is not a function`.

- [ ] **Step 3: Implement the writer and widen `AdminUpdate`**

In `src/lib/server/content/updates.ts`, add `updatePostSubprocessor` to the schema import and:

```ts
/** Replaces the link set wholesale — the form submits the complete list, the
 * same contract `setControlEvidence` has. */
export async function setUpdateSubprocessors(
	db: Db,
	postId: string,
	subprocessorIds: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(updatePostSubprocessor).where(eq(updatePostSubprocessor.postId, postId));
		if (subprocessorIds.length > 0) {
			await tx
				.insert(updatePostSubprocessor)
				.values(subprocessorIds.map((subprocessorId) => ({ postId, subprocessorId })));
		}
	});
}
```

Add `subprocessorIds: string[];` to `AdminUpdate`, and in `listUpdatesForAdmin` fetch the links alongside the translations and map them in:

```ts
	const links = await db
		.select()
		.from(updatePostSubprocessor)
		.where(
			inArray(
				updatePostSubprocessor.postId,
				rows.map((row) => row.id)
			)
		);
```

then inside the `rows.map`:

```ts
			subprocessorIds: links
				.filter((item) => item.postId === row.id)
				.map((item) => item.subprocessorId),
```

- [ ] **Step 4: Wire it into the editor**

In `src/routes/(admin)/admin/updates/[id]/+page.server.ts`, extend the `saveMeta` schema, `read`, `update` and `meta`. Nothing else changes — no helper edit, no new audit action:

```ts
		schema: z.object({
			slug: z
				.string()
				.trim()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			kind: z.enum(UPDATE_KINDS),
			publishedAt: z
				.string()
				.trim()
				.transform((raw) => (raw ? new Date(raw) : null))
				.refine((date) => date === null || !Number.isNaN(date.getTime()), {
					message: 'invalid date'
				}),
			subprocessorIds: z.array(z.string().uuid())
		}),
		read: (form) => ({
			slug: form.get('slug'),
			kind: form.get('kind'),
			publishedAt: form.get('publishedAt') ?? '',
			subprocessorIds: form.getAll('subprocessorIds').map(String).filter(Boolean)
		}),
		update: async (db, id, data) => {
			const { subprocessorIds, ...meta } = data;
			await updateUpdate(db, id, meta);
			// A set-valued field beside scalar metadata, exactly as the control
			// editor's evidence set is. `update` receives `db` so a call site
			// needing two statements does both here rather than forking the helper.
			await setUpdateSubprocessors(db, id, subprocessorIds);
		},
		isPublished: (data) => data.publishedAt !== null && data.publishedAt.getTime() <= Date.now(),
		// Ids are references, not post metadata — the control editor made the same
		// call, and the audit log must not accumulate id lists it cannot query on.
		meta: ({ subprocessorIds, ...rest }) => ({
			slug: rest.slug,
			kind: rest.kind,
			publishedAt: rest.publishedAt?.toISOString() ?? null,
			subprocessorCount: subprocessorIds.length
		}),
```

Extend `load` to supply the pickable list:

```ts
export const load: PageServerLoad = async ({ params }) => {
	const item = await getUpdateForAdmin(getDb(), params.id);
	if (!item) error(404, 'Update not found');
	return { post: item, subprocessors: await listSubprocessorsForAdmin(getDb()) };
};
```

In `+page.svelte`, add inside the `?/saveMeta` form, after the `kind` field:

```svelte
	<FormField label={m.admin_announced_subprocessors()}>
		<div class="grid gap-1">
			{#each data.subprocessors as item (item.id)}
				<label class="flex items-center gap-2">
					<input
						type="checkbox"
						name="subprocessorIds"
						value={item.id}
						data-testid="update-subprocessor-{item.slug}"
						checked={data.post.subprocessorIds.includes(item.id)}
					/>
					<span>{item.name}</span>
				</label>
			{/each}
		</div>
	</FormField>
```

Copy — `messages/de.json`: `"admin_announced_subprocessors": "Angekündigte Unterauftragsverarbeiter",` and `messages/en.json`: `"admin_announced_subprocessors": "Announced subprocessors",`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm check && pnpm test:integration tests/integration/content.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/content/updates.ts src/routes/\(admin\)/admin/updates messages/ tests/integration/content.test.ts
git commit -m "feat(admin): link an update post to the subprocessors it announces"
```

---

### Task 13: `noticeCoverage` — both conditions, both anchored

**Files:**
- Modify: `src/lib/server/content/subprocessors.ts`
- Test: `tests/unit/subprocessor-coverage.test.ts`

**Interfaces:**
- Produces:
  - `type NoticeCoverage = 'addition-unannounced' | 'removal-unannounced' | null`
  - `noticeCoverage({ published, startedAt, endedAt, coveringPublishedAt }): NoticeCoverage`
  - `AdminSubprocessor` gains `coverage: NoticeCoverage`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/subprocessor-coverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { noticeCoverage } from '../../src/lib/server/content/subprocessors';

const JAN = new Date('2026-01-01T00:00:00Z');
const FEB = new Date('2026-02-01T00:00:00Z');
const MAR = new Date('2026-03-01T00:00:00Z');

describe('noticeCoverage', () => {
	it('warns when a published addition has no covering post', () => {
		expect(
			noticeCoverage({ published: true, startedAt: JAN, endedAt: null, coveringPublishedAt: [] })
		).toBe('addition-unannounced');
	});

	// The negative matters as much as the positive: a badge that also fires on
	// announced changes is noise, and noise is what P4.10 is about.
	it('does not warn when a covering post went live after the start date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: JAN, endedAt: null, coveringPublishedAt: [FEB] })
		).toBeNull();
	});

	// P4.22: the anchor. Unanchored, any linked post would clear this.
	it('warns when the only covering post predates the start date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: FEB, endedAt: null, coveringPublishedAt: [JAN] })
		).toBe('addition-unannounced');
	});

	it('falls back to "any covering post" when there is no start date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: null, endedAt: null, coveringPublishedAt: [JAN] })
		).toBeNull();
		expect(
			noticeCoverage({ published: true, startedAt: null, endedAt: null, coveringPublishedAt: [] })
		).toBe('addition-unannounced');
	});

	it('warns when an ended subprocessor has no post after its end date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: JAN, endedAt: MAR, coveringPublishedAt: [FEB] })
		).toBe('removal-unannounced');
	});

	it('does not warn when a post went live after the end date', () => {
		expect(
			noticeCoverage({ published: true, startedAt: JAN, endedAt: FEB, coveringPublishedAt: [MAR] })
		).toBeNull();
	});

	// The exact case P4.22 was written for: the addition was never announced,
	// and an unanchored condition would let the *removal* announcement clear it.
	it('still reports the unannounced addition when only the removal was announced', () => {
		expect(
			noticeCoverage({ published: true, startedAt: FEB, endedAt: null, coveringPublishedAt: [JAN] })
		).toBe('addition-unannounced');
	});

	it('says nothing about an unpublished subprocessor', () => {
		expect(
			noticeCoverage({ published: false, startedAt: JAN, endedAt: MAR, coveringPublishedAt: [] })
		).toBeNull();
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm test:unit tests/unit/subprocessor-coverage.test.ts`
Expected: FAIL — `noticeCoverage is not a function`.

- [ ] **Step 3: Implement the predicate**

Add to `src/lib/server/content/subprocessors.ts`:

```ts
export type NoticeCoverage = 'addition-unannounced' | 'removal-unannounced' | null;

/**
 * Whether a subprocessor change has an announcement behind it (spec §7).
 * Computed from `published`, `started_at`, `ended_at` and the live covering
 * posts — no new state and no new timestamps.
 *
 * Deliberately not driven by `updated_at`: that column bumps on any edit, so a
 * typo fix in a hosting provider's name would raise a notice warning, and a
 * warning that fires on noise is one nobody reads (P4.10).
 *
 * `coveringPublishedAt` must already be filtered to LIVE posts — published_at
 * not null and not in the future. A draft or scheduled post is not coverage:
 * nobody has been told yet, and a warning that cleared the moment an
 * announcement was *written* would clear before the obligation is discharged.
 *
 * Both conditions are anchored (P4.22). With the addition condition reading
 * "any live covering post", a subprocessor added silently and removed later
 * *with* an announcement would have its addition warning cleared retroactively
 * by a post announcing the opposite fact — the one case this exists for.
 */
export function noticeCoverage(input: {
	published: boolean;
	startedAt: Date | null;
	endedAt: Date | null;
	coveringPublishedAt: readonly Date[];
}): NoticeCoverage {
	// An unpublished subprocessor was never disclosed, so nothing about it needs
	// announcing — including its removal. The operator sees `published: false`
	// in the same row and needs no second signal.
	if (!input.published) return null;

	const covers = (since: Date | null): boolean =>
		since === null
			? input.coveringPublishedAt.length > 0
			: input.coveringPublishedAt.some((at) => at.getTime() >= since.getTime());

	// The removal first: it is the live obligation, and only one badge is shown.
	if (input.endedAt && !covers(input.endedAt)) return 'removal-unannounced';
	if (!covers(input.startedAt)) return 'addition-unannounced';
	return null;
}
```

- [ ] **Step 4: Feed it from the database**

In `listSubprocessorsForAdmin`, after the translations query, add the covering-post query and put `coverage` on each row. Add `coverage: NoticeCoverage;` to `AdminSubprocessor`:

```ts
	// "Live" is the same predicate `listPublicUpdates` uses, and for the same
	// reason: a draft or scheduled post has told nobody anything yet.
	const covering = await db
		.select({
			subprocessorId: updatePostSubprocessor.subprocessorId,
			publishedAt: updatePost.publishedAt
		})
		.from(updatePostSubprocessor)
		.innerJoin(updatePost, eq(updatePost.id, updatePostSubprocessor.postId))
		.where(and(isNotNull(updatePost.publishedAt), lte(updatePost.publishedAt, new Date())));
```

and in the `rows.map`:

```ts
		coverage: noticeCoverage({
			published: row.published,
			startedAt: row.startedAt,
			endedAt: row.endedAt,
			coveringPublishedAt: covering
				.filter((item) => item.subprocessorId === row.id)
				.map((item) => item.publishedAt!)
		}),
```

Add `and`, `isNotNull` and `lte` to the `drizzle-orm` import, and `updatePost` / `updatePostSubprocessor` to the schema import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm check && pnpm test:unit tests/unit/subprocessor-coverage.test.ts`
Expected: PASS, 8 cases.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/content/subprocessors.ts tests/unit/subprocessor-coverage.test.ts
git commit -m "feat(subprocessors): notice coverage, anchored in both directions"
```

---

### Task 14: The badge

**Files:**
- Modify: `src/routes/(admin)/admin/subprocessors/+page.svelte`
- Modify: `messages/de.json`, `messages/en.json`

**Interfaces:**
- Consumes: `AdminSubprocessor.coverage` (Task 13).

- [ ] **Step 1: Add the copy**

`messages/de.json`:

```json
"subprocessors_notice_addition": "Aufnahme nicht angekündigt",
"subprocessors_notice_column": "Ankündigung",
"subprocessors_notice_removal": "Entfernung nicht angekündigt",
```

`messages/en.json`:

```json
"subprocessors_notice_addition": "Addition not announced",
"subprocessors_notice_column": "Notice",
"subprocessors_notice_removal": "Removal not announced",
```

- [ ] **Step 2: Add the column**

In `src/routes/(admin)/admin/subprocessors/+page.svelte`, extend `columns`:

```ts
	let columns = $derived([
		{ key: 'name', header: m.admin_name() },
		{ key: 'country', header: m.subprocessors_country() },
		{ key: 'published', header: m.admin_published() },
		{ key: 'coverage', header: m.subprocessors_notice_column() }
	]);
```

and add a branch to the `cell` snippet:

```svelte
		{:else if key === 'coverage'}
			{#if item.coverage}
				<!-- Advisory only: it does not block publishing a subprocessor,
				     because the system does not know the contract and must not
				     pretend to (spec §7, P4.9). -->
				<span
					data-testid="subprocessor-notice-{item.slug}"
					class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
				>
					{item.coverage === 'removal-unannounced'
						? m.subprocessors_notice_removal()
						: m.subprocessors_notice_addition()}
				</span>
			{:else}—{/if}
```

The badge is shown on the list rather than the detail page because that is where the operator is standing at the moment they make the change.

- [ ] **Step 3: Verify by hand**

Run `pnpm dev`, sign in as staff, create a published subprocessor with a start date, and confirm the badge appears on `/de/admin/subprocessors`. Then create an update post, tick that subprocessor, set `publishedAt` to now, save, and confirm the badge clears. Set the post back to a draft and confirm the badge returns — a draft is not coverage.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add src/routes/\(admin\)/admin/subprocessors messages/
git commit -m "feat(admin): the subprocessor notice-coverage badge"
```

**Gate F:** `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e`

---

### Task 15: End to end, the security assertions, and the operator docs

**Files:**
- Create: `tests/e2e/subscribe.spec.ts`
- Modify: `tests/e2e/security.spec.ts:217-233`
- Modify: `docs/self-hosting.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the journey spec**

Create `tests/e2e/subscribe.spec.ts`. The token is read out of `outbound_email` rather than out of Mailpit, exactly as `access-journey.spec.ts` does — the mail is queued rather than sent inline, so going through a mail server would buy flakiness for nothing.

```ts
import { expect, test } from '@playwright/test';
import { and, desc, eq } from 'drizzle-orm';
import { createDb, type Db } from '../../src/lib/server/db';
import { outboundEmail, subscription } from '../../src/lib/server/db/schema';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set — see .env.example');

let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(() => {
	({ db, close: closeDb } = createDb(databaseUrl));
});

test.afterAll(async () => {
	await closeDb();
});

async function lastMailUrl(to: string, template: string): Promise<string> {
	// Filtered by template, not just by recipient: this spec queues several
	// kinds of mail to one address, and "the newest row" would silently follow
	// the wrong link the moment the order changes.
	const [row] = await db
		.select({ payload: outboundEmail.payload })
		.from(outboundEmail)
		.where(and(eq(outboundEmail.to, to), eq(outboundEmail.template, template)))
		.orderBy(desc(outboundEmail.createdAt));
	if (!row) throw new Error(`no ${template} mail queued for ${to}`);
	const payload = row.payload as { url?: string };
	if (!payload.url) throw new Error(`${template} mail carried no url`);
	return payload.url;
}

test('subscribe, confirm, manage, unsubscribe', async ({ page }) => {
	const email = `e2e-${Date.now()}@example.test`;

	await page.goto('/de/subscribe');
	await page.getByTestId('subscribe-email').fill(email);
	await page.getByTestId('subscribe-topic-advisory').check();
	await page.getByTestId('subscribe-submit').click();
	await expect(page.getByTestId('subscribe-submitted')).toBeVisible();

	const confirmUrl = await lastMailUrl(email, 'subscription_confirm');

	// P4.3, and the assertion that would catch a future refactor turning this
	// page back into a mutation: a mail scanner's GET must confirm nothing.
	await page.goto(confirmUrl);
	let [row] = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(row?.confirmedAt, 'a GET must not confirm').toBeNull();

	await page.getByTestId('confirm-submit').click();
	await expect(page.getByTestId('confirm-done')).toBeVisible();
	[row] = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(row?.confirmedAt).not.toBeNull();

	const manageUrl = `/de/subscribe/manage?token=${encodeURIComponent(row!.manageToken!)}`;
	await page.goto(manageUrl);
	await expect(page.getByTestId('manage-topic-advisory')).toBeChecked();

	await page.getByTestId('manage-topic-document').check();
	await page.getByTestId('manage-save').click();
	await expect(page.getByTestId('manage-topic-document')).toBeChecked();

	// The same rule as the subscribe form: a save with no topics is refused
	// rather than silently treated as an unsubscribe (spec §5).
	await page.getByTestId('manage-topic-advisory').uncheck();
	await page.getByTestId('manage-topic-document').uncheck();
	await page.getByTestId('manage-save').click();
	[row] = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(row, 'an empty save must not delete the row').toBeTruthy();

	await page.goto(manageUrl);
	// A GET on the manage page must not unsubscribe either.
	[row] = await db.select().from(subscription).where(eq(subscription.email, email));
	expect(row, 'a GET must not unsubscribe').toBeTruthy();

	await page.getByTestId('manage-unsubscribe').click();
	await expect(page.getByTestId('manage-gone')).toBeVisible();
	expect(await db.select().from(subscription).where(eq(subscription.email, email))).toHaveLength(0);
});

// The outcome-parity property, probed with a malformed body rather than the
// happy path. Task 6's review found a live enumeration oracle here: duplicate
// topic values passed validation, hit `subscription_topic`'s composite primary
// key, and 500'd — but ONLY on the created/resent paths, because the `already`
// branch returns before touching topics. A confirmed subscriber therefore
// answered 200 where every other address answered 500. The schema now dedupes;
// this is the test that would have caught it, and the one that stops it coming
// back.
test('a malformed topic set cannot distinguish one address from another', async ({
	request,
	baseURL
}) => {
	// Posted directly rather than through the form: a browser cannot produce a
	// duplicate checkbox value. SvelteKit's CSRF protection is origin-header
	// based and an APIRequestContext sends none, so it is set explicitly.
	const post = (email: string) =>
		request.post('/de/subscribe', {
			headers: { origin: baseURL!, 'content-type': 'application/x-www-form-urlencoded' },
			data: `email=${encodeURIComponent(email)}&topics=document&topics=document`
		});

	const response = await post(`e2e-dup-${Date.now()}@example.test`);
	// A crafted body must not crash the route. Before the fix this raised 23505
	// on the composite primary key and surfaced as a 500 — which is precisely
	// what made the confirmed case, which never reaches that insert, distinguishable.
	expect(response.status(), 'a duplicate topic value must not 500').toBeLessThan(500);
});

// P4.4 and P4.16 together: the confirmed case must look identical to the other
// two, and the mail it sends must carry a link that actually authenticates —
// which is exactly what a future move back to hashed storage would break, and
// break silently, since the mail would still be queued and still contain a URL.
test('re-subscribing a confirmed address changes nothing and mails a working manage link', async ({
	page
}) => {
	const email = `e2e-again-${Date.now()}@example.test`;

	await page.goto('/de/subscribe');
	await page.getByTestId('subscribe-email').fill(email);
	await page.getByTestId('subscribe-topic-advisory').check();
	await page.getByTestId('subscribe-submit').click();
	await page.goto(await lastMailUrl(email, 'subscription_confirm'));
	await page.getByTestId('confirm-submit').click();
	await expect(page.getByTestId('confirm-done')).toBeVisible();

	// Submit again, with different topics. The browser must not be able to tell
	// this case from the first, and the topics must not move.
	await page.goto('/de/subscribe');
	await page.getByTestId('subscribe-email').fill(email);
	await page.getByTestId('subscribe-topic-document').check();
	await page.getByTestId('subscribe-submit').click();
	await expect(page.getByTestId('subscribe-submitted')).toBeVisible();

	await page.goto(await lastMailUrl(email, 'subscription_already'));
	await expect(page.getByTestId('manage-topic-advisory')).toBeChecked();
	await expect(page.getByTestId('manage-topic-document')).not.toBeChecked();

	const [row] = await db.select().from(subscription).where(eq(subscription.email, email));
	await db.delete(subscription).where(eq(subscription.id, row!.id));
});
```

- [ ] **Step 2: Extend the security spec**

In `tests/e2e/security.spec.ts`, add the three paths to the no-cookie loop. `/de/subscribe/confirm` and `/de/subscribe/manage` both render without a valid token — confirm renders its button regardless, and manage 404s — so only the form goes in the loop that asserts a 200:

```ts
	for (const path of [
		'/de',
		'/de/documents',
		'/de/faq',
		'/de/request',
		'/de/subscribe',
		'/de/subscribe/confirm',
		'/de/access/verify'
	]) {
```

`/de/subscribe/manage` cannot join that loop — it 404s without a token, and the loop asserts a 200. Give it its own case, which is also where the caching guarantee is pinned:

```ts
// Spec §10.3: cookie-free and cacheable are not the same property, and this is
// the first place in the portal where they come apart. The manage token never
// expires, so a shared cache holding this page would hand over a credential
// with no expiry and no revocation.
test('the token-bearing pages are not cacheable, and the subscribe form still is', async ({
	request
}) => {
	for (const path of ['/de/subscribe/confirm?token=x', '/de/subscribe/manage?token=x']) {
		const response = await request.get(path);
		expect(response.headers()['cache-control'], `${path} must be no-store`).toContain('no-store');
		expect(response.headers()['referrer-policy'], `${path} must send no referrer`).toBe(
			'no-referrer'
		);
	}

	// The negative half, and the reason it is here: without it the fix for the
	// above is "make the whole subtree no-store", which quietly costs the portal
	// its cacheability — a property this product is partly about.
	const form = await request.get('/de/subscribe');
	expect(form.headers()['cache-control']).toContain('s-maxage=60');
});
```

`request.get('/de/subscribe/manage?token=x')` returns 404; assert the headers, not the status. If SvelteKit drops `setHeaders` from an `error()` response, move the `setHeaders` call above the `subscriptionByManageToken` lookup in the manage load — it is already written that way in Task 8, and this is the test that proves it.

- [ ] **Step 3: Document the two dating rules and the token in logs**

Add to `docs/self-hosting.md`, in the operations section:

```markdown
### Update notifications

Subscribers are mailed about update posts every 15 minutes. Two consequences of
how "published" is decided are worth knowing before they surprise you.

**A back-dated post notifies nobody.** Each subscription remembers when it was
last notified, and a post is sent if it went live after that. Setting
`published_at` to a date in the past means "this was already announced", so the
post appears on the updates page and no mail goes out. That is intended — the
alternative is mailing people about a change they were told about last week.

**Re-dating a live post forward notifies again.** The mirror of the above: moving
an already-published post's date to a later time steps it back over the cursors
that had passed it, so it is sent a second time. Edit the date of a post that has
already gone out only if you mean to.

**Management links do not expire, and they appear in URLs.** Every notification
carries a link that lets its recipient change topics or unsubscribe without
signing in. It is valid indefinitely, by design — a dead unsubscribe link is a
compliance problem. It follows that if your reverse proxy logs full request
lines, those logs accumulate working management tokens. Treat them accordingly:
either do not log query strings for `/*/subscribe/*`, or hold those logs to the
same retention and access rules as the database.
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
Expected: all green. `pnpm test:e2e` needs `pnpm dev:up` running.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add tests/e2e/ docs/self-hosting.md
git commit -m "test(e2e): the subscription journey, and the no-store guarantee"
```

**Gate G:** the full suite above, plus one manual pass: `env -u DATABASE_URL -u OIDC_CLIENT_SECRET -u SMTP_URL pnpm build` succeeds, and a deployment with no `SMTP_URL` queues notices without draining them (start the app with `SMTP_URL` unset, run the notify job, and confirm `outbound_email` fills while nothing throws).

---

## What this plan does not do

Recorded here so the carry-over does not have to rediscover it.

- **No admin surface lists subscribers.** Nothing in §3 asks for one, and a staff page listing every subscribed address is a new disclosure surface with no stated need. An operator who needs the count can query the table.
- **No `subscription.locale` check constraint** — §8 argues why: the enabled set is runtime configuration, and a constraint against it would make the database reject rows because a deployment changed an environment variable.
- **No notice for certifications, documents or subprocessors on their own.** They are announced *by* posts (§3).
- **The `subscriber` audit actor is never cleared on unsubscribe**, though the triggers would permit it (§10.2). Once the row is gone the UUID points at nothing; keeping it is what lets an auditor read "confirmed on the 3rd, left on the 20th" as one story.
