# Trust Center Phase 3a — Scope Is a Set — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two `all_request_tier` booleans and `access_rule.max_tier` with explicit sets of documents, tiers and groups, and introduce `access_group` — a named, reusable bundle of documents — so an approver grants a saved scope by name instead of ticking eleven checkboxes.

**Architecture:** Scope becomes three parallel sets that imply nothing about each other: explicit documents (already a join table), whole tiers, and whole groups. Grant resolution stays one query. The change is delivered expand → migrate → contract: an additive migration creates the join tables and backfills them from the booleans while those booleans stay authoritative, each consumer then moves to the sets, and a final migration drops the old columns. Every task in between leaves a green suite and a working application. **The NDA tier stays refused throughout** — this phase changes the shape of scope, not what may be in it.

**Tech Stack:** SvelteKit 2 (Svelte 5 runes), TypeScript strict, Postgres 18, Drizzle ORM + drizzle-kit, Tailwind CSS v4, Paraglide JS v2, Zod v4, Vitest, `@testcontainers/postgresql`, Playwright, `@sveltejs/adapter-node`.

**Spec:** `docs/superpowers/specs/2026-08-30-phase-3-nda-workflow-design.md` (§3, §4, §8), which supplements `docs/superpowers/specs/2026-08-28-trust-center-design.md`

**Predecessor:** `docs/superpowers/plans/2026-08-29-phase-2-access-governance.md` and `docs/superpowers/phase-3-carryover.md`

---

## Global Constraints

Every task's requirements implicitly include this section. Carried forward from Phase 2 unchanged unless marked **NEW**.

- **TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.** No `any` in committed code.
- **Svelte 5 runes syntax** (`$state`, `$derived`, `$props`, `$effect`). Never `export let` or Svelte 4 stores.
- **`audit_event` is append-only.** No DELETE, no TRUNCATE, and no UPDATE except the column-scoped pseudonymization in spec §10. No task in this phase touches that exception.
- **Requester personal data appears in `audit_event` only in `ip`, `ua`, and `actor_id`** — never in `meta`, never in `subject_id`. Staff identifiers may appear in `meta`.
- **Every admin mutation writes an audit event.** Create, update, delete, decide, grant, revoke each record actor, subject, and IP.
- **The public portal sets no cookies and loads no third-party resources.** The `/{locale}/access` subtree sets exactly one. `tests/e2e/security.spec.ts` asserts both halves and must not be weakened.
- **No public object URLs.** No file in storage is reachable except through the audited streaming endpoint.
- **Locales are two-layered** (spec §7): the compiled catalog set is a build input; `LOCALES` and `DEFAULT_LOCALE` select an enabled subset at runtime. Nothing outside message catalogs and test fixtures may hardcode `de` or `en`.
- **Every user-facing string is localized**, including admin labels and validation messages.
- **`getConfig()`, `getDb()`, `getStorage()`, and `getMailer()` are lazy and must never be called at module scope.** `pnpm build` must keep succeeding with no secrets and no database present.
- **Configuration is an argument, never a `getConfig()` call, below the route layer.** The integration suite provides `TEST_DATABASE_URL` and nothing else; any module reaching for a configured environment to answer a question about rows becomes untestable. The route or the job owns the lookup.
- **SvelteKit configuration is inline in `vite.config.ts`'s `sveltekit({...})` call.** There is deliberately no `svelte.config.js`.
- **`localeStorage.run(...)` must remain the outermost wrapper around `resolve` in `hooks.server.ts`.**
- **Use `pnpm db:migrate`, never bare `drizzle-kit`** — drizzle-kit reads no `.env`.
- **Migrations are renamed by hand.** `drizzle-kit generate` assigns a random name; this repo uses descriptive ones, so each migration needs both its file and its `drizzle/meta/_journal.json` tag renamed.
- **Local Postgres is on host port 5433** (`POSTGRES_PORT=5433` in `.env`); host port 5432 belongs to an unrelated project. Never stop, alter, or inspect a container you did not create.
- **TDD throughout:** write the failing test, run it and watch it fail, implement minimally, run it and watch it pass, commit.
- **Every e2e step that interacts with an admin page navigates through `gotoAdmin`,** which waits for hydration. The carry-over's lesson is that an e2e step interacting before hydration does not fail, it lies — the DOM value is overwritten by the server's on claim and the form posts the server's value as though the test never typed.
- **Commit after every task,** Conventional Commits. Commit signing goes through Secretive and may need unlocking — never pass `--no-gpg-sign` and never change `commit.gpgsign`.
- **Licence: AGPL-3.0-or-later.**

---

## Decisions this plan settles

1. **Expand → migrate → contract, not one big migration.** The booleans stay authoritative and in sync while consumers move one at a time, and Task 9 drops them. A single migration would have meant one task touching 20 files with no green state in between, and a reviewer who cannot reject half of it.

2. **The tier CHECK admits `('request','nda')`, and the application refuses `'nda'`.** `'public'` is meaningless in a grant scope — a public document needs no grant — so it is excluded at the database. `'nda'` is admitted because `access_rule.max_tier` already stores it today and the backfill must preserve what an operator wrote. The refusal stays exactly where Phase 2 put it, behind one named constant (`PHASE_TIERS`) that Phase 3b deletes.

3. **`access_request` gets tiers but not groups.** Spec §4.2: groups are a staff-side and document-organisation concept. The public form offers documents and per-tier blankets; offering groups would leak the operator's internal bundling to prospects.

4. **`term_days` arrives in this phase, nullable, and becomes NOT NULL in Task 9.** The design puts the acceptance-delayed clock in 3b, but `term_days` is the column the approval form writes, and moving the form from an absolute date to a term is a UX change with locale strings that belongs with the other grant-shape work rather than stranded in the NDA phase.

5. **`countGrantDocuments` gains the expiry and revocation predicates it never had.** `grants.ts:69-83` filters only on grant id, document status and tier. It is safe today because its one caller pre-filters, and the design's fail-closed claim is not true of it. Task 4 fixes it while it is being rewritten anyway.

## Deviations from the design, with rationale

6. **`document_group` membership is edited from the document, not from the group.** §8 specifies the table and not the surface. The document editor already has the tier and category controls, so membership belongs beside them; the group page shows its members read-only with a count. Editing the same relation from both sides doubles the surface and the tests for no gain.

7. **No public-facing surface for groups at all.** They are invisible to the portal in this phase. §4.2 says the public form does not offer them, and nothing else in the design gives them a public meaning.

---

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `drizzle/0016_access_groups.sql` | `access_group`, `access_group_translation`, `document_group` |
| `drizzle/0017_scope_sets.sql` | Four scope join tables, `access_grant.term_days` nullable, backfill |
| `drizzle/0018_drop_scope_flags.sql` | Drops `all_request_tier` ×2 and `access_rule.max_tier`; `term_days` NOT NULL |
| `src/lib/server/db/schema/groups.ts` | Drizzle schema for the three group tables |
| `src/lib/server/access/groups.ts` | Group CRUD, translations, membership reads |
| `src/lib/server/access/scope.ts` | One place that reads and writes a scope's tier and group sets |
| `src/routes/(admin)/admin/groups/+page.server.ts` | Group list and create |
| `src/routes/(admin)/admin/groups/+page.svelte` | Group list and create form |
| `src/routes/(admin)/admin/groups/[id]/+page.server.ts` | Group edit, translations, delete |
| `src/routes/(admin)/admin/groups/[id]/+page.svelte` | Group edit form and read-only member list |
| `tests/integration/groups.test.ts` | Group CRUD, translations, membership |
| `tests/integration/scope.test.ts` | Backfill correctness and set read/write |
| `tests/e2e/admin-groups.spec.ts` | Create, translate, assign, delete through a browser |

**Modified**

| Path | Change |
| --- | --- |
| `src/lib/server/db/schema/access.ts` | Add four join tables; `term_days`; remove booleans in Task 9 |
| `src/lib/server/db/schema/index.ts` | Export the new schema module |
| `src/lib/server/access/grants.ts` | `createGrant` takes sets; `grantCoversDocument` spans three sources; missing predicates added |
| `src/lib/server/access/requests.ts` | `submitRequest` and `decideRequest` take tier sets; admin rows carry them |
| `src/lib/server/access/rules.ts` | `max_tier` → tier set; `PHASE_TIERS` replaces `PHASE_CEILING` |
| `src/lib/server/access/verify.ts` | Passes the request's tier set into `createGrant` |
| `src/lib/server/identity/requester.ts` | Requester detail rows carry tier sets, not a boolean |
| `src/lib/admin/sections.ts` | `/admin/groups` nav entry |
| `src/routes/(portal)/request/+page.server.ts` + `.svelte` | Per-tier checkboxes instead of one |
| `src/routes/(admin)/admin/requests/[id]/+page.server.ts` + `.svelte` | Tier and group pickers; term in days |
| `src/routes/(admin)/admin/requests/+page.svelte` | Scope summary reads sets |
| `src/routes/(admin)/admin/grants/+page.svelte` | Scope summary reads sets |
| `src/routes/(admin)/admin/requesters/[id]/+page.svelte` | Scope summary reads sets |
| `src/routes/(admin)/admin/rules/**` | Tier set control replaces the `maxTier` select |
| `src/routes/(admin)/admin/documents/[id]/+page.server.ts` + `.svelte` | Group membership control |
| `messages/en.json`, `messages/de.json` | New admin and portal strings |
| `tests/integration/*.test.ts` (7 files) | Move off the booleans |
| `tests/e2e/*.spec.ts` (4 files) | Move off the booleans |

---

## Execution log

Each task appends its outcome here when complete: what shipped, what deviated, what the next task should know.

---

## Task 1: Access group schema and module

Groups are the fourth translatable content type. The carry-over says explicitly not to assume the Task 1 helper from Phase 2 generalises — *"The next content type is the test that matters, and there is not one yet."* This is that test. `saveTranslationAction` is a good fit here and `saveMetaAction` is not, because a group's slug and position are edited on the same page as its translations; Task 2 uses the plain-action shape that `/admin/documents/categories` already uses, and records the mismatch in the execution log either way.

**`access_group.nda_template_id` is deliberately absent.** It would reference `nda_template`, which does not exist until 3b — the same reason Phase 2 refused `access_grant.nda_acceptance_id`.

**Files:**
- Create: `src/lib/server/db/schema/groups.ts`
- Create: `src/lib/server/access/groups.ts`
- Create: `drizzle/0016_access_groups.sql` (generated, then renamed)
- Modify: `src/lib/server/db/schema/index.ts`
- Test: `tests/integration/groups.test.ts`

**Interfaces:**
- Consumes: `Db` from `../db`; `document` from `./documents`
- Produces:
  - `accessGroup`, `accessGroupTranslation`, `documentGroup` Drizzle tables
  - `interface AdminGroupRow { id: string; slug: string; position: number; names: Record<string, string>; documentCount: number }`
  - `interface AdminGroupDetail extends AdminGroupRow { descriptions: Record<string, string>; documentIds: string[] }`
  - `listGroups(db: Db): Promise<AdminGroupRow[]>`
  - `getGroup(db: Db, id: string): Promise<AdminGroupDetail | null>`
  - `createGroup(db: Db, input: { slug: string; position: number }): Promise<string>`
  - `updateGroup(db: Db, id: string, input: { slug: string; position: number }): Promise<void>`
  - `deleteGroup(db: Db, id: string): Promise<void>`
  - `setGroupTranslation(db: Db, id: string, locale: string, values: { name: string; description: string | null }): Promise<void>`
  - `setDocumentGroups(db: Db, documentId: string, groupIds: readonly string[]): Promise<void>`
  - `groupSchema` — Zod, `{ slug, position }`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/groups.test.ts`. Follow the existing suites' setup — copy the `beforeEach`/fixture shape from `tests/integration/content.test.ts`, which already seeds a document category and a document.

```ts
import { describe, expect, it } from 'vitest';
import {
	createGroup,
	deleteGroup,
	getGroup,
	listGroups,
	setDocumentGroups,
	setGroupTranslation,
	updateGroup
} from '$lib/server/access/groups';
import { withDb, seedDocument } from '../setup/db';

describe('access groups', () => {
	it('creates a group and lists it with a zero document count', async () => {
		await withDb(async (db) => {
			const id = await createGroup(db, { slug: 'customer-pack', position: 10 });

			const rows = await listGroups(db);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ id, slug: 'customer-pack', position: 10 });
			expect(rows[0]?.documentCount).toBe(0);
		});
	});

	it('stores one name and description per locale', async () => {
		await withDb(async (db) => {
			const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
			await setGroupTranslation(db, id, 'en', { name: 'Customer pack', description: 'For customers' });
			await setGroupTranslation(db, id, 'de', { name: 'Kundenpaket', description: null });

			const detail = await getGroup(db, id);
			expect(detail?.names).toEqual({ en: 'Customer pack', de: 'Kundenpaket' });
			expect(detail?.descriptions).toEqual({ en: 'For customers' });
		});
	});

	it('replaces a translation rather than duplicating it', async () => {
		await withDb(async (db) => {
			const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
			await setGroupTranslation(db, id, 'en', { name: 'First', description: null });
			await setGroupTranslation(db, id, 'en', { name: 'Second', description: null });

			const detail = await getGroup(db, id);
			expect(detail?.names).toEqual({ en: 'Second' });
		});
	});

	it('replaces membership wholesale, so removing means posting a shorter list', async () => {
		await withDb(async (db) => {
			const groupA = await createGroup(db, { slug: 'a', position: 0 });
			const groupB = await createGroup(db, { slug: 'b', position: 1 });
			const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });

			await setDocumentGroups(db, documentId, [groupA, groupB]);
			expect((await getGroup(db, groupA))?.documentIds).toEqual([documentId]);
			expect((await getGroup(db, groupB))?.documentIds).toEqual([documentId]);

			await setDocumentGroups(db, documentId, [groupB]);
			expect((await getGroup(db, groupA))?.documentIds).toEqual([]);
			expect((await getGroup(db, groupB))?.documentIds).toEqual([documentId]);
		});
	});

	it('counts members per group in the list', async () => {
		await withDb(async (db) => {
			const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
			const first = await seedDocument(db, { slug: 'soc2', tier: 'request' });
			const second = await seedDocument(db, { slug: 'pentest', tier: 'request' });
			await setDocumentGroups(db, first, [id]);
			await setDocumentGroups(db, second, [id]);

			const rows = await listGroups(db);
			expect(rows[0]?.documentCount).toBe(2);
		});
	});

	it('drops membership and translations when the group is deleted', async () => {
		await withDb(async (db) => {
			const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
			const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
			await setGroupTranslation(db, id, 'en', { name: 'Customer pack', description: null });
			await setDocumentGroups(db, documentId, [id]);

			await deleteGroup(db, id);

			expect(await getGroup(db, id)).toBeNull();
			expect(await listGroups(db)).toEqual([]);
		});
	});

	it('keeps the document when a group it belongs to is deleted', async () => {
		await withDb(async (db) => {
			const id = await createGroup(db, { slug: 'customer-pack', position: 0 });
			const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
			await setDocumentGroups(db, documentId, [id]);

			await deleteGroup(db, id);

			// The cascade runs from the group to the membership row, never onward
			// to the document. A group is an organisational convenience; deleting
			// one must not delete published content.
			const rows = await db.query.document.findMany();
			expect(rows.map((row) => row.id)).toContain(documentId);
		});
	});

	it('orders by position, then slug', async () => {
		await withDb(async (db) => {
			await createGroup(db, { slug: 'zulu', position: 0 });
			await createGroup(db, { slug: 'alpha', position: 0 });
			await createGroup(db, { slug: 'first', position: -1 });

			const rows = await listGroups(db);
			expect(rows.map((row) => row.slug)).toEqual(['first', 'alpha', 'zulu']);
		});
	});

	it('renames a group without disturbing its membership', async () => {
		await withDb(async (db) => {
			const id = await createGroup(db, { slug: 'old', position: 0 });
			const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
			await setDocumentGroups(db, documentId, [id]);

			await updateGroup(db, id, { slug: 'new', position: 5 });

			const detail = await getGroup(db, id);
			expect(detail?.slug).toBe('new');
			expect(detail?.position).toBe(5);
			expect(detail?.documentIds).toEqual([documentId]);
		});
	});
});
```

If `tests/setup/db.ts` has no `seedDocument` helper, add one there rather than inlining fixture SQL in this suite — `tests/integration/documents.test.ts` and `tests/integration/download.test.ts` both build a document by hand today, and a third copy is where they start to disagree:

```ts
export async function seedDocument(
	db: Db,
	input: { slug: string; tier: 'public' | 'request' | 'nda'; status?: 'draft' | 'published' }
): Promise<string> {
	const [category] = await db
		.insert(documentCategory)
		.values({ slug: `cat-${input.slug}`, position: 0 })
		.returning({ id: documentCategory.id });

	const [row] = await db
		.insert(document)
		.values({
			slug: input.slug,
			categoryId: category!.id,
			tier: input.tier,
			status: input.status ?? 'published'
		})
		.returning({ id: document.id });

	return row!.id;
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration groups`
Expected: FAIL — `Cannot find module '$lib/server/access/groups'`

- [ ] **Step 3: Write the schema**

Create `src/lib/server/db/schema/groups.ts`:

```ts
import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { document } from './documents';

/**
 * A named, reusable bundle of documents — a saved scope — not a cohort of
 * people (design §4.2). Conveyor attaches group membership to the visitor
 * because their flow is "invite a company, it sees its cohort's documents";
 * this product already has a grant carrying an explicit document list, so a
 * people axis would duplicate it.
 *
 * `nda_template_id` is deliberately absent. It would reference `nda_template`,
 * which arrives in Phase 3b — the same reason Phase 2 refused to ship
 * `access_grant.nda_acceptance_id` a phase early.
 */
export const accessGroup = pgTable('access_group', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const accessGroupTranslation = pgTable(
	'access_group_translation',
	{
		groupId: uuid('group_id')
			.notNull()
			.references(() => accessGroup.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		name: text('name').notNull(),
		description: text('description')
	},
	(table) => [primaryKey({ columns: [table.groupId, table.locale] })]
);

export const documentGroup = pgTable(
	'document_group',
	{
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' }),
		groupId: uuid('group_id')
			.notNull()
			.references(() => accessGroup.id, { onDelete: 'cascade' })
	},
	(table) => [
		primaryKey({ columns: [table.documentId, table.groupId] }),
		// Grant resolution asks "which documents are in these groups", which is
		// the reverse of the primary key's leading column.
		index('document_group_group_idx').on(table.groupId)
	]
);
```

Add to `src/lib/server/db/schema/index.ts`, alongside the existing re-exports:

```ts
export * from './groups';
```

- [ ] **Step 4: Write the module**

Create `src/lib/server/access/groups.ts`:

```ts
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accessGroup, accessGroupTranslation, documentGroup } from '../db/schema';
import type { Db } from '../db';

export interface AdminGroupRow {
	id: string;
	slug: string;
	position: number;
	/** Locale → name. A group with no translation in a locale is shown by slug. */
	names: Record<string, string>;
	documentCount: number;
}

export interface AdminGroupDetail extends AdminGroupRow {
	descriptions: Record<string, string>;
	documentIds: string[];
}

/**
 * The same slug shape every other content type uses. Rejected at the form
 * rather than discovered later, for the reason `RULE_PATTERN` is: a slug that
 * cannot be typed into a URL is a defect at entry, not at read time.
 */
export const groupSchema = z.object({
	slug: z
		.string()
		.trim()
		.min(1)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	position: z.coerce.number().int().min(-10_000).max(10_000)
});

export type GroupInput = z.output<typeof groupSchema>;

/** Ordered the way the admin list and every picker shows them. */
export async function listGroups(db: Db): Promise<AdminGroupRow[]> {
	const rows = await db
		.select()
		.from(accessGroup)
		.orderBy(asc(accessGroup.position), asc(accessGroup.slug));

	if (rows.length === 0) return [];

	const ids = rows.map((row) => row.id);

	const [names, counts] = await Promise.all([
		db
			.select()
			.from(accessGroupTranslation)
			.where(inArray(accessGroupTranslation.groupId, ids)),
		db
			.select({
				groupId: documentGroup.groupId,
				count: sql<number>`count(*)::int`
			})
			.from(documentGroup)
			.where(inArray(documentGroup.groupId, ids))
			.groupBy(documentGroup.groupId)
	]);

	const countByGroup = new Map(counts.map((row) => [row.groupId, row.count]));

	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		position: row.position,
		names: Object.fromEntries(
			names.filter((name) => name.groupId === row.id).map((name) => [name.locale, name.name])
		),
		documentCount: countByGroup.get(row.id) ?? 0
	}));
}

export async function getGroup(db: Db, id: string): Promise<AdminGroupDetail | null> {
	const [row] = await db.select().from(accessGroup).where(eq(accessGroup.id, id)).limit(1);
	if (!row) return null;

	const [translations, members] = await Promise.all([
		db.select().from(accessGroupTranslation).where(eq(accessGroupTranslation.groupId, id)),
		db.select().from(documentGroup).where(eq(documentGroup.groupId, id))
	]);

	return {
		id: row.id,
		slug: row.slug,
		position: row.position,
		names: Object.fromEntries(translations.map((t) => [t.locale, t.name])),
		// Only locales that actually have one: an empty description is absence,
		// not an empty string, and the form must not render `""` as content.
		descriptions: Object.fromEntries(
			translations.filter((t) => t.description).map((t) => [t.locale, t.description!])
		),
		documentIds: members.map((member) => member.documentId),
		documentCount: members.length
	};
}

export async function createGroup(db: Db, input: GroupInput): Promise<string> {
	const [row] = await db.insert(accessGroup).values(input).returning({ id: accessGroup.id });
	if (!row) throw new Error('failed to create access group');
	return row.id;
}

export async function updateGroup(db: Db, id: string, input: GroupInput): Promise<void> {
	await db.update(accessGroup).set(input).where(eq(accessGroup.id, id));
}

export async function deleteGroup(db: Db, id: string): Promise<void> {
	await db.delete(accessGroup).where(eq(accessGroup.id, id));
}

export async function setGroupTranslation(
	db: Db,
	id: string,
	locale: string,
	values: { name: string; description: string | null }
): Promise<void> {
	await db
		.insert(accessGroupTranslation)
		.values({ groupId: id, locale, ...values })
		.onConflictDoUpdate({
			target: [accessGroupTranslation.groupId, accessGroupTranslation.locale],
			set: values
		});
}

/**
 * Membership is replaced wholesale rather than diffed, so removing a document
 * from a group means posting a shorter list. One transaction, because a
 * half-applied replacement would leave a document in neither the old set nor
 * the new one.
 */
export async function setDocumentGroups(
	db: Db,
	documentId: string,
	groupIds: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(documentGroup).where(eq(documentGroup.documentId, documentId));

		const unique = [...new Set(groupIds)];
		if (unique.length === 0) return;

		await tx.insert(documentGroup).values(unique.map((groupId) => ({ documentId, groupId })));
	});
}
```

- [ ] **Step 5: Generate and rename the migration**

```bash
pnpm db:generate
```

drizzle-kit writes `drizzle/00NN_<random-words>.sql`. Rename **both** the file and its `tag` in `drizzle/meta/_journal.json` to `0016_access_groups`. The carry-over records this as a manual step; skipping the journal rename leaves the two disagreeing and the next `db:migrate` confused.

Verify the generated SQL creates exactly three tables, the unique index on `access_group.slug`, both composite primary keys, and `document_group_group_idx`. It must contain no `ALTER TABLE ... DROP` — nothing is being removed in this task.

- [ ] **Step 6: Apply the migration**

Run: `pnpm db:migrate`
Expected: applies `0016_access_groups`, exits 0.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test:integration groups`
Expected: PASS, 8 tests.

- [ ] **Step 8: Typecheck and lint**

Run: `pnpm check && pnpm lint`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add src/lib/server/db/schema/groups.ts src/lib/server/db/schema/index.ts \
        src/lib/server/access/groups.ts drizzle/ tests/integration/groups.test.ts tests/setup/db.ts
git commit -m "feat(access): add access groups as named document bundles"
```

- [ ] **Step 10: Append to the execution log**

Record whether `saveTranslationAction` fitted this content type or not. The carry-over asks this question directly and Task 2 is where it gets answered.

---

## Task 2: The access group admin surface

Two pages, unlike `/admin/documents/categories` which is one: a group carries a description per locale and a member list, which is more than fits inline in a list row. The list page creates and lists; the detail page edits, translates, shows members read-only, and deletes.

`data.locales` and `data.locale` come from the admin layout's load — the categories page relies on the same thing and its own `load` returns only its rows.

**Files:**
- Create: `src/routes/(admin)/admin/groups/+page.server.ts`
- Create: `src/routes/(admin)/admin/groups/+page.svelte`
- Create: `src/routes/(admin)/admin/groups/[id]/+page.server.ts`
- Create: `src/routes/(admin)/admin/groups/[id]/+page.svelte`
- Modify: `src/lib/admin/sections.ts`
- Modify: `messages/en.json`, `messages/de.json`
- Test: `tests/e2e/admin-groups.spec.ts`

**Interfaces:**
- Consumes: `listGroups`, `getGroup`, `createGroup`, `updateGroup`, `deleteGroup`, `setGroupTranslation`, `groupSchema` from Task 1; `saveTranslationsFromForm` from `$lib/server/content/translations`; `gotoAdmin` from the e2e helpers
- Produces: audit actions `access_group.created`, `access_group.updated`, `access_group.translation.updated`, `access_group.deleted`; `data-testid` hooks `group-slug`, `group-create`, `group-row-<slug>`, `group-name-<locale>`, `group-description-<locale>`, `group-save`, `group-delete`, `group-member-count`

- [ ] **Step 1: Write the failing e2e test**

Create `tests/e2e/admin-groups.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { gotoAdmin, signInAsAdmin } from './helpers';

test.describe('admin access groups', () => {
	test('creates, translates, and deletes a group', async ({ page }, testInfo) => {
		await signInAsAdmin(page, testInfo);

		await gotoAdmin(page, '/admin/groups');
		await page.getByTestId('group-slug').fill('customer-pack');
		await page.getByTestId('group-create').click();

		const row = page.getByTestId('group-row-customer-pack');
		await expect(row).toBeVisible();
		// A group with no translation is shown by slug rather than blank.
		await expect(row).toContainText('customer-pack');

		await row.getByRole('link').click();
		await page.getByTestId('group-name-en').fill('Customer pack');
		await page.getByTestId('group-description-en').fill('Everything a customer may request');
		await page.getByTestId('group-save').click();
		await expect(page.getByTestId('group-name-en')).toHaveValue('Customer pack');

		await gotoAdmin(page, '/admin/groups');
		await expect(page.getByTestId('group-row-customer-pack')).toContainText('Customer pack');

		await page.getByTestId('group-row-customer-pack').getByRole('link').click();
		await page.getByTestId('group-delete').click();
		await expect(page.getByTestId('group-row-customer-pack')).toHaveCount(0);
	});

	test('rejects a slug that is not url-safe', async ({ page }, testInfo) => {
		await signInAsAdmin(page, testInfo);

		await gotoAdmin(page, '/admin/groups');
		await page.getByTestId('group-slug').fill('Customer Pack!');
		await page.getByTestId('group-create').click();

		await expect(page.getByTestId('error-slug')).toBeVisible();
		await expect(page.getByTestId('group-row-Customer Pack!')).toHaveCount(0);
	});
});
```

Use whatever the existing specs import for sign-in — Phase 2 replaced per-spec helpers with a shared one after `admin-documents.spec.ts` raced `auth.spec.ts` for the same identity. Do not add a private one.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:e2e admin-groups`
Expected: FAIL — the route 404s.

- [ ] **Step 3: Add the nav entry and messages**

`src/lib/admin/sections.ts`, immediately after the `/admin/rules` entry, because groups are read alongside rules and grants rather than alongside content:

```ts
{ path: '/admin/groups', label: () => m.nav_groups() },
```

Add to `messages/en.json`:

```json
"nav_groups": "Groups",
"admin_groups": "Access groups",
"admin_group": "Access group",
"admin_group_new": "New group",
"admin_group_description": "Description",
"admin_group_members": "Documents in this group",
"admin_group_members_count": "{count} documents",
"admin_group_members_hint": "Membership is edited on each document.",
"admin_group_delete_confirm": "Delete this group? Documents in it are not deleted."
```

And `messages/de.json`:

```json
"nav_groups": "Gruppen",
"admin_groups": "Zugriffsgruppen",
"admin_group": "Zugriffsgruppe",
"admin_group_new": "Neue Gruppe",
"admin_group_description": "Beschreibung",
"admin_group_members": "Dokumente in dieser Gruppe",
"admin_group_members_count": "{count} Dokumente",
"admin_group_members_hint": "Die Zugehörigkeit wird am jeweiligen Dokument bearbeitet.",
"admin_group_delete_confirm": "Diese Gruppe löschen? Dokumente darin werden nicht gelöscht."
```

Run `pnpm paraglide:compile` after editing, or `pnpm check` will fail on the missing message functions.

- [ ] **Step 4: Write the list route**

Create `src/routes/(admin)/admin/groups/+page.server.ts`:

```ts
import { fail } from '@sveltejs/kit';
import { createGroup, groupSchema, listGroups } from '$lib/server/access/groups';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ groups: await listGroups(getDb()) });

export const actions: Actions = {
	create: async (event) => {
		const form = await event.request.formData();
		const parsed = groupSchema.safeParse({
			slug: form.get('slug'),
			position: form.get('position') ?? 0
		});

		if (!parsed.success) {
			return fail(400, { field: String(parsed.error.issues[0]?.path[0] ?? 'slug') });
		}

		const db = getDb();
		const id = await createGroup(db, parsed.data);

		await recordEvent(db, {
			action: 'access_group.created',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_group',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			// Operator configuration, not requester data, so the whole thing belongs
			// in meta — the same reasoning `access_rule.created` records.
			meta: { ...parsed.data }
		});

		return { saved: true };
	}
};
```

Create `src/routes/(admin)/admin/groups/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import { localizePath } from '$lib/i18n/locale';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_groups()}</h1>

<form method="POST" action="?/create" use:enhance class="mb-8 grid gap-3 rounded border bg-white p-4">
	<FormField label={m.admin_slug()}>
		<input data-testid="group-slug" name="slug" required class="rounded border px-2 py-1" />
	</FormField>

	<FormField label={m.admin_position()}>
		<input name="position" type="number" value="0" class="rounded border px-2 py-1" />
	</FormField>

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button
		data-testid="group-create"
		class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white"
	>
		{m.admin_new()}
	</button>
</form>

<ul class="divide-y rounded border bg-white">
	{#each data.groups as group (group.id)}
		<li class="flex flex-wrap items-center gap-3 p-4" data-testid="group-row-{group.slug}">
			<a
				href={localizePath(`/admin/groups/${group.id}`, data.locale)}
				class="font-medium underline"
			>
				{group.names[data.locale] ?? group.slug}
			</a>
			<span class="font-mono text-sm text-neutral-500">{group.slug}</span>
			<span data-testid="group-member-count" class="text-sm text-neutral-500">
				{m.admin_group_members_count({ count: group.documentCount })}
			</span>
		</li>
	{:else}
		<li class="p-4 text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>
```

If `admin_position` and `admin_error_slug` are not already in the catalogs, add them the same way as Step 3.

- [ ] **Step 5: Write the detail route**

Create `src/routes/(admin)/admin/groups/[id]/+page.server.ts`:

```ts
import { error, redirect } from '@sveltejs/kit';
import { localizePath } from '$lib/i18n/locale';
import {
	deleteGroup,
	getGroup,
	groupSchema,
	setGroupTranslation,
	updateGroup
} from '$lib/server/access/groups';
import { saveMetaAction } from '$lib/server/admin/actions';
import { saveTranslationsFromForm } from '$lib/server/content/translations';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { clientIp } from '$lib/server/http/client-ip';
import { translationAction } from '$lib/server/admin/actions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const group = await getGroup(getDb(), params.id);
	if (!group) error(404, 'Group not found');
	return { group };
};

export const actions: Actions = {
	// The meta half is `saveMetaAction` at its plainest — slug and position, no
	// published state — exactly as `/admin/rules/[id]` uses it.
	saveMeta: saveMetaAction({
		type: 'access_group',
		schema: groupSchema,
		read: (form) => ({ slug: form.get('slug'), position: form.get('position') ?? 0 }),
		update: (db, id, data) => updateGroup(db, id, data),
		fallbackField: 'slug'
	}),

	// Not `saveTranslationAction`: that helper writes one locale per POST, and
	// this form submits every locale at once the way the categories page does.
	// Forcing one POST per locale here would be the helper dictating the form.
	saveTranslations: async (event) => {
		const form = await event.request.formData();
		const db = getDb();
		const id = event.params.id;
		const written: string[] = [];

		await saveTranslationsFromForm(
			form,
			(values, locale) => {
				const name = String(values.get(`name.${locale}`) ?? '').trim();
				if (!name) return null;
				return {
					name,
					description: String(values.get(`description.${locale}`) ?? '').trim() || null
				};
			},
			async (locale, values) => {
				await setGroupTranslation(db, id, locale, values);
				written.push(locale);
			}
		);

		await recordEvent(db, {
			action: translationAction('access_group'),
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_group',
			subjectId: id,
			ip: clientIp(event) ?? undefined,
			meta: { locales: written }
		});

		return { saved: true };
	},

	remove: async (event) => {
		const db = getDb();
		// Read before the delete: the audit row is the only place a deleted group
		// survives, and "what was in that group" is asked afterwards.
		const group = await getGroup(db, event.params.id);
		if (!group) error(404, 'Group not found');

		await deleteGroup(db, event.params.id);

		await recordEvent(db, {
			action: 'access_group.deleted',
			actor: { type: 'staff', id: event.locals.staff!.id },
			subjectType: 'access_group',
			subjectId: event.params.id,
			ip: clientIp(event) ?? undefined,
			meta: { slug: group.slug, documentCount: group.documentCount }
		});

		redirect(303, localizePath('/admin/groups', event.locals.locale));
	}
};
```

Create `src/routes/(admin)/admin/groups/[id]/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import FormField from '$lib/components/admin/FormField.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">
	{data.group.names[data.locale] ?? data.group.slug}
</h1>

<form method="POST" action="?/saveMeta" use:enhance class="mb-8 grid gap-3 rounded border bg-white p-4">
	<FormField label={m.admin_slug()}>
		<input name="slug" value={data.group.slug} required class="rounded border px-2 py-1" />
	</FormField>
	<FormField label={m.admin_position()}>
		<input name="position" type="number" value={data.group.position} class="rounded border px-2 py-1" />
	</FormField>
	<button class="justify-self-start rounded border px-3 py-1.5 text-sm">{m.admin_save()}</button>
</form>

<form
	method="POST"
	action="?/saveTranslations"
	use:enhance
	class="mb-8 grid gap-3 rounded border bg-white p-4"
>
	{#each data.locales as locale (locale)}
		<FormField label={`${m.admin_name()} (${locale})`}>
			<input
				data-testid="group-name-{locale}"
				name="name.{locale}"
				value={data.group.names[locale] ?? ''}
				placeholder={m.admin_not_translated()}
				class="rounded border px-2 py-1"
			/>
		</FormField>
		<FormField label={`${m.admin_group_description()} (${locale})`}>
			<textarea
				data-testid="group-description-{locale}"
				name="description.{locale}"
				rows="2"
				class="rounded border px-2 py-1">{data.group.descriptions[locale] ?? ''}</textarea
			>
		</FormField>
	{/each}
	<button data-testid="group-save" class="justify-self-start rounded border px-3 py-1.5 text-sm">
		{m.admin_save()}
	</button>
</form>

<section class="mb-8 rounded border bg-white p-4">
	<h2 class="mb-2 font-medium">{m.admin_group_members()}</h2>
	<p class="text-sm text-neutral-500">
		{m.admin_group_members_count({ count: data.group.documentCount })} ·
		{m.admin_group_members_hint()}
	</p>
</section>

<form method="POST" action="?/remove" use:enhance>
	<button
		data-testid="group-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
	>
		{m.admin_delete()}
	</button>
</form>
```

The delete button posts directly rather than opening a confirm dialog: a browser `confirm()` blocks Playwright, and Phase 2 established that pattern for every other destructive admin action.

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `pnpm test:e2e admin-groups`
Expected: PASS, 2 tests.

- [ ] **Step 7: Run the full check**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/routes/\(admin\)/admin/groups src/lib/admin/sections.ts messages/ \
        src/lib/paraglide tests/e2e/admin-groups.spec.ts
git commit -m "feat(admin): add the access group admin surface"
```

- [ ] **Step 9: Append to the execution log**

Answer the carry-over's open question: `saveMetaAction` fitted the slug-and-position half; `saveTranslationAction` did **not**, because it writes one locale per POST and this form submits all of them together. Record whether that is a gap in the helper or a correct boundary, because Phase 3b adds a fifth content type and will ask again.

---

## Task 3: Document group membership

Membership is edited from the document, beside the tier and category controls it belongs with. The group page shows a count and says so.

**Files:**
- Modify: `src/routes/(admin)/admin/documents/[id]/+page.server.ts`
- Modify: `src/routes/(admin)/admin/documents/[id]/+page.svelte`
- Modify: `messages/en.json`, `messages/de.json`
- Test: `tests/e2e/admin-groups.spec.ts` (extend)

**Interfaces:**
- Consumes: `listGroups`, `setDocumentGroups` from Task 1
- Produces: the document editor's `saveMeta` action also replaces group membership; `data-testid` hook `document-group-<slug>`

- [ ] **Step 1: Write the failing e2e test**

Append to `tests/e2e/admin-groups.spec.ts`:

```ts
test('assigns a document to a group and shows the count', async ({ page }, testInfo) => {
	await signInAsAdmin(page, testInfo);

	await gotoAdmin(page, '/admin/groups');
	await page.getByTestId('group-slug').fill('pentest-pack');
	await page.getByTestId('group-create').click();
	await expect(page.getByTestId('group-row-pentest-pack')).toBeVisible();

	// Use whichever seeded document the other admin specs rely on; the fixture
	// set is shared and adding a second one here would drift from it.
	await gotoAdmin(page, '/admin/documents');
	await page.getByRole('link', { name: /soc/i }).first().click();

	await page.getByTestId('document-group-pentest-pack').check();
	await page.getByTestId('document-save').click();

	await gotoAdmin(page, '/admin/groups');
	await expect(page.getByTestId('group-row-pentest-pack')).toContainText('1');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:e2e admin-groups`
Expected: FAIL — no `document-group-pentest-pack` checkbox exists.

- [ ] **Step 3: Extend the document load**

In `src/routes/(admin)/admin/documents/[id]/+page.server.ts`, add the group list and the document's current membership to `load`:

```ts
import { getGroup, listGroups, setDocumentGroups } from '$lib/server/access/groups';
import { documentGroup } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
```

Inside `load`, alongside the existing document lookup:

```ts
const db = getDb();
const [groups, memberships] = await Promise.all([
	listGroups(db),
	db.select().from(documentGroup).where(eq(documentGroup.documentId, params.id))
]);

return {
	// ...whatever load already returns
	groups,
	groupIds: memberships.map((row) => row.groupId)
};
```

- [ ] **Step 4: Replace membership in the save action**

The document editor's meta action already uses `saveMetaAction`, whose `update` callback receives `db` precisely so a call site needing more than one statement does both there — the controls editor already replaces its evidence set this way. Extend the existing `update`:

```ts
update: async (db, id, data) => {
	await updateDocument(db, id, data);
	await setDocumentGroups(db, id, data.groupIds);
},
```

Add `groupIds` to the document's Zod schema and to `read`:

```ts
// In the schema:
groupIds: z.array(z.string().uuid()).default([]),

// In read:
read: (form) => ({
	// ...existing fields
	groupIds: form.getAll('groupIds').map(String).filter(Boolean)
}),
```

`form.getAll` returns `[]` when nothing is checked, which is what unchecking every box must mean — `setDocumentGroups` treats an empty list as "belongs to no group" and deletes every row.

- [ ] **Step 5: Add the control to the document form**

In `src/routes/(admin)/admin/documents/[id]/+page.svelte`, beside the tier select:

```svelte
<fieldset class="grid gap-1">
	<legend class="text-sm font-medium">{m.admin_document_groups()}</legend>
	{#each data.groups as group (group.id)}
		<label class="flex items-center gap-2 text-sm">
			<input
				data-testid="document-group-{group.slug}"
				type="checkbox"
				name="groupIds"
				value={group.id}
				checked={data.groupIds.includes(group.id)}
			/>
			{group.names[data.locale] ?? group.slug}
		</label>
	{/each}
	{#if data.groups.length === 0}
		<p class="text-sm text-neutral-500">{m.admin_no_entries()}</p>
	{/if}
</fieldset>
```

Add `admin_document_groups` to both catalogs (`"Groups"` / `"Gruppen"`) and run `pnpm paraglide:compile`.

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `pnpm test:e2e admin-groups`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full check**

Run: `pnpm check && pnpm lint && pnpm test:integration && pnpm test:e2e`
Expected: all clean. The document editor is covered by `admin-content.spec.ts`, which must still pass — a new `groupIds` field with a default must not change what saving a document without it does.

- [ ] **Step 8: Commit**

```bash
git add src/routes/\(admin\)/admin/documents messages/ src/lib/paraglide \
        tests/e2e/admin-groups.spec.ts
git commit -m "feat(admin): assign documents to access groups"
```

---

## Task 4: Scope sets — expand migration and helpers

The additive half of expand → migrate → contract. Four join tables and `term_days` arrive and are backfilled from the existing booleans; **the booleans stay and stay authoritative**. Nothing reads the new tables yet. Task 9 drops the old columns.

`term_days` is nullable here and becomes NOT NULL in Task 9, because a nullable column can be added to a populated table without a default and backfilled in the same migration, while a NOT NULL one cannot without inventing a value for rows the backfill has not reached yet.

**Files:**
- Modify: `src/lib/server/db/schema/access.ts`
- Create: `src/lib/server/access/scope.ts`
- Create: `drizzle/0017_scope_sets.sql` (generated, then hand-edited and renamed)
- Modify: `src/routes/(admin)/admin/groups/[id]/+page.server.ts`
- Test: `tests/integration/scope.test.ts`

**Interfaces:**
- Consumes: `accessRequest`, `accessGrant`, `accessRule` from the access schema; `accessGroup` from Task 1
- Produces:
  - `accessRequestTier`, `accessGrantTier`, `accessGrantGroup`, `accessRuleTier` tables; `accessGrant.termDays`
  - `const SCOPE_TIERS = ['request', 'nda'] as const`; `type ScopeTier`
  - `const PHASE_TIERS: readonly ScopeTier[]` — what this phase honours
  - `honouredTiers(tiers: readonly string[]): ScopeTier[]`
  - `setRequestTiers(db, requestId, tiers): Promise<void>` / `requestTiers(db, requestId): Promise<ScopeTier[]>`
  - `setGrantTiers(db, grantId, tiers)` / `grantTiers(db, grantId)`
  - `setGrantGroups(db, grantId, groupIds)` / `grantGroups(db, grantId)`
  - `setRuleTiers(db, ruleId, tiers)` / `ruleTiers(db, ruleId)`
  - `class ScopeGroupInUse extends Error`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/scope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createGroup } from '$lib/server/access/groups';
import {
	grantGroups,
	grantTiers,
	honouredTiers,
	requestTiers,
	ruleTiers,
	setGrantGroups,
	setGrantTiers,
	setRequestTiers,
	setRuleTiers
} from '$lib/server/access/scope';
import { withDb, seedGrant, seedRequest, seedRule } from '../setup/db';

describe('scope sets', () => {
	it('round-trips a grant tier set', async () => {
		await withDb(async (db) => {
			const grantId = await seedGrant(db);
			await setGrantTiers(db, grantId, ['request']);
			expect(await grantTiers(db, grantId)).toEqual(['request']);
		});
	});

	it('replaces a tier set wholesale rather than adding to it', async () => {
		await withDb(async (db) => {
			const grantId = await seedGrant(db);
			await setGrantTiers(db, grantId, ['request', 'nda']);
			await setGrantTiers(db, grantId, ['nda']);
			expect(await grantTiers(db, grantId)).toEqual(['nda']);
		});
	});

	it('treats an empty set as "explicit documents only"', async () => {
		await withDb(async (db) => {
			const grantId = await seedGrant(db);
			await setGrantTiers(db, grantId, ['request']);
			await setGrantTiers(db, grantId, []);
			expect(await grantTiers(db, grantId)).toEqual([]);
		});
	});

	it('refuses a tier the database does not admit', async () => {
		await withDb(async (db) => {
			const grantId = await seedGrant(db);
			// 'public' is meaningless in a grant scope: a public document needs no
			// grant, so admitting it would be a scope entry that grants nothing.
			await expect(setGrantTiers(db, grantId, ['public' as never])).rejects.toThrow();
		});
	});

	it('round-trips a grant group set', async () => {
		await withDb(async (db) => {
			const grantId = await seedGrant(db);
			const groupId = await createGroup(db, { slug: 'customer', position: 0 });
			await setGrantGroups(db, grantId, [groupId]);
			expect(await grantGroups(db, grantId)).toEqual([groupId]);
		});
	});

	it('round-trips request and rule tier sets', async () => {
		await withDb(async (db) => {
			const requestId = await seedRequest(db);
			const ruleId = await seedRule(db, { pattern: 'acme.example' });

			await setRequestTiers(db, requestId, ['request']);
			await setRuleTiers(db, ruleId, ['request', 'nda']);

			expect(await requestTiers(db, requestId)).toEqual(['request']);
			expect(await ruleTiers(db, ruleId)).toEqual(['nda', 'request']);
		});
	});

	it('honours only the tiers this phase implements', () => {
		// The NDA tier is storable and not yet honoured. Phase 3b deletes this
		// filter; until then a rule naming it must not widen anything.
		expect(honouredTiers(['request', 'nda'])).toEqual(['request']);
		expect(honouredTiers(['nda'])).toEqual([]);
		expect(honouredTiers([])).toEqual([]);
	});
});

describe('scope backfill', () => {
	it('gives every pre-existing all-request-tier grant a request tier row', async () => {
		await withDb(async (db) => {
			// The migration has already run against this database, so the assertion
			// is that no live grant lost its blanket in translation.
			const rows = await db.execute<{ mismatched: number }>(
				`SELECT count(*)::int AS mismatched
				 FROM access_grant g
				 WHERE g.all_request_tier
				   AND NOT EXISTS (
				     SELECT 1 FROM access_grant_tier t
				     WHERE t.grant_id = g.id AND t.tier = 'request'
				   )`
			);
			expect(rows[0]?.mismatched).toBe(0);
		});
	});

	it('gives every pre-existing grant a positive term', async () => {
		await withDb(async (db) => {
			const rows = await db.execute<{ bad: number }>(
				`SELECT count(*)::int AS bad FROM access_grant
				 WHERE term_days IS NULL OR term_days < 1`
			);
			expect(rows[0]?.bad).toBe(0);
		});
	});
});
```

Add `seedGrant`, `seedRequest`, and `seedRule` to `tests/setup/db.ts` if they are not there. `seedGrant` needs a requester and an `expires_at`; copy the fixture shape from `tests/integration/expiry.test.ts`, which already builds one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration scope`
Expected: FAIL — `Cannot find module '$lib/server/access/scope'`

- [ ] **Step 3: Add the schema**

In `src/lib/server/db/schema/access.ts`, add `termDays` to `accessGrant`'s column list:

```ts
// Nullable until Task 9's contract migration backfills every row and tightens
// it. The clock a grant runs on once it starts, in days, recorded because the
// approver chose it — re-deriving it from `defaultGrantDays()` later would
// silently substitute whatever the setting says then, and
// /admin/settings/access exists precisely so operators change it.
termDays: integer('term_days'),
```

And append the four join tables:

```ts
import { accessGroup } from './groups';

/**
 * A scope's blanket tiers: "everything at this tier, including documents
 * published later". Three parallel sets — documents, tiers, groups — and
 * nothing implies anything else.
 *
 * A ranked ceiling was rejected because it recomputes: inserting a tier below
 * an existing one would retroactively widen every live grant above it, which
 * is the failure spec §9's domain-drift rule forbids.
 *
 * `public` is not admitted: a public document needs no grant, so a public
 * entry would be a scope row that grants nothing. `nda` is admitted because
 * `access_rule.max_tier` already stores it and the backfill must preserve what
 * an operator wrote; the application refuses to honour it until Phase 3b.
 */
const scopeTierCheck = sql`tier IN ('request', 'nda')`;

export const accessRequestTier = pgTable(
	'access_request_tier',
	{
		requestId: uuid('request_id')
			.notNull()
			.references(() => accessRequest.id, { onDelete: 'cascade' }),
		tier: text('tier').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.requestId, table.tier] }),
		check('access_request_tier_check', scopeTierCheck)
	]
);

export const accessGrantTier = pgTable(
	'access_grant_tier',
	{
		grantId: uuid('grant_id')
			.notNull()
			.references(() => accessGrant.id, { onDelete: 'cascade' }),
		tier: text('tier').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.grantId, table.tier] }),
		check('access_grant_tier_check', scopeTierCheck)
	]
);

/**
 * `restrict` on the group, deliberately unlike every other join here. A cascade
 * would silently narrow a live grant when an operator deleted a group, and the
 * requester would lose documents with nothing recording why. Restricting makes
 * the operator revoke or re-scope first.
 */
export const accessGrantGroup = pgTable(
	'access_grant_group',
	{
		grantId: uuid('grant_id')
			.notNull()
			.references(() => accessGrant.id, { onDelete: 'cascade' }),
		groupId: uuid('group_id')
			.notNull()
			.references(() => accessGroup.id, { onDelete: 'restrict' })
	},
	(table) => [primaryKey({ columns: [table.grantId, table.groupId] })]
);

export const accessRuleTier = pgTable(
	'access_rule_tier',
	{
		ruleId: uuid('rule_id')
			.notNull()
			.references(() => accessRule.id, { onDelete: 'cascade' }),
		tier: text('tier').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.ruleId, table.tier] }),
		check('access_rule_tier_check', scopeTierCheck)
	]
);
```

- [ ] **Step 4: Write the scope module**

Create `src/lib/server/access/scope.ts`:

```ts
import { asc, eq } from 'drizzle-orm';
import {
	accessGrantGroup,
	accessGrantTier,
	accessRequestTier,
	accessRuleTier
} from '../db/schema';
import type { Db } from '../db';

/** The tiers a scope may name. `public` needs no grant and is not one of them. */
export const SCOPE_TIERS = ['request', 'nda'] as const;
export type ScopeTier = (typeof SCOPE_TIERS)[number];

/**
 * What this phase actually honours. `nda` is storable — the backfill preserves
 * a rule that named it — and is not yet granted, because nothing can record an
 * acceptance until Phase 3b. This constant is the single place that refusal
 * lives, replacing Phase 2's `PHASE_CEILING`, and 3b deletes it.
 */
export const PHASE_TIERS: readonly ScopeTier[] = ['request'];

export function honouredTiers(tiers: readonly string[]): ScopeTier[] {
	return SCOPE_TIERS.filter((tier) => tiers.includes(tier) && PHASE_TIERS.includes(tier));
}

/** Raised when a group cannot be deleted because a grant still names it. */
export class ScopeGroupInUse extends Error {}

function assertTiers(tiers: readonly string[]): ScopeTier[] {
	return tiers.filter((tier): tier is ScopeTier =>
		(SCOPE_TIERS as readonly string[]).includes(tier)
	);
}

/**
 * Every setter replaces wholesale rather than diffing, in one transaction, for
 * the reason `setDocumentGroups` does: a half-applied replacement would leave a
 * scope that is neither what it was nor what was asked for.
 *
 * The setters deliberately do NOT filter through `honouredTiers`. What an
 * operator chose is what gets stored; what this phase grants is decided at read
 * time. Storing the filtered set would lose the operator's intent permanently
 * and silently rewrite it when 3b widened the filter.
 */
export async function setRequestTiers(
	db: Db,
	requestId: string,
	tiers: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(accessRequestTier).where(eq(accessRequestTier.requestId, requestId));
		const values = [...new Set(tiers)];
		if (values.length === 0) return;
		await tx.insert(accessRequestTier).values(values.map((tier) => ({ requestId, tier })));
	});
}

export async function requestTiers(db: Db, requestId: string): Promise<ScopeTier[]> {
	const rows = await db
		.select({ tier: accessRequestTier.tier })
		.from(accessRequestTier)
		.where(eq(accessRequestTier.requestId, requestId))
		.orderBy(asc(accessRequestTier.tier));

	return assertTiers(rows.map((row) => row.tier));
}

export async function setGrantTiers(
	db: Db,
	grantId: string,
	tiers: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(accessGrantTier).where(eq(accessGrantTier.grantId, grantId));
		const values = [...new Set(tiers)];
		if (values.length === 0) return;
		await tx.insert(accessGrantTier).values(values.map((tier) => ({ grantId, tier })));
	});
}

export async function grantTiers(db: Db, grantId: string): Promise<ScopeTier[]> {
	const rows = await db
		.select({ tier: accessGrantTier.tier })
		.from(accessGrantTier)
		.where(eq(accessGrantTier.grantId, grantId))
		.orderBy(asc(accessGrantTier.tier));

	return assertTiers(rows.map((row) => row.tier));
}

export async function setGrantGroups(
	db: Db,
	grantId: string,
	groupIds: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(accessGrantGroup).where(eq(accessGrantGroup.grantId, grantId));
		const values = [...new Set(groupIds)];
		if (values.length === 0) return;
		await tx.insert(accessGrantGroup).values(values.map((groupId) => ({ grantId, groupId })));
	});
}

export async function grantGroups(db: Db, grantId: string): Promise<string[]> {
	const rows = await db
		.select({ groupId: accessGrantGroup.groupId })
		.from(accessGrantGroup)
		.where(eq(accessGrantGroup.grantId, grantId));

	return rows.map((row) => row.groupId);
}

export async function setRuleTiers(db: Db, ruleId: string, tiers: readonly string[]): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(accessRuleTier).where(eq(accessRuleTier.ruleId, ruleId));
		const values = [...new Set(tiers)];
		if (values.length === 0) return;
		await tx.insert(accessRuleTier).values(values.map((tier) => ({ ruleId, tier })));
	});
}

export async function ruleTiers(db: Db, ruleId: string): Promise<ScopeTier[]> {
	const rows = await db
		.select({ tier: accessRuleTier.tier })
		.from(accessRuleTier)
		.where(eq(accessRuleTier.ruleId, ruleId))
		.orderBy(asc(accessRuleTier.tier));

	return assertTiers(rows.map((row) => row.tier));
}
```

- [ ] **Step 5: Generate the migration and add the backfill by hand**

```bash
pnpm db:generate
```

Rename the file and its journal tag to `0017_scope_sets`. drizzle-kit writes the DDL and **not** the backfill — append these statements to the generated SQL, each separated by `--> statement-breakpoint`:

```sql
--> statement-breakpoint
INSERT INTO access_grant_tier (grant_id, tier)
SELECT id, 'request' FROM access_grant WHERE all_request_tier;
--> statement-breakpoint
INSERT INTO access_request_tier (request_id, tier)
SELECT id, 'request' FROM access_request WHERE all_request_tier;
--> statement-breakpoint
-- max_tier is a ceiling, so 'nda' meant "request and nda". Preserving both is
-- what keeps the operator's intent; the application still refuses to honour
-- 'nda' until Phase 3b.
INSERT INTO access_rule_tier (rule_id, tier)
SELECT id, 'request' FROM access_rule WHERE max_tier IN ('request', 'nda');
--> statement-breakpoint
INSERT INTO access_rule_tier (rule_id, tier)
SELECT id, 'nda' FROM access_rule WHERE max_tier = 'nda';
--> statement-breakpoint
-- The term those grants were actually issued under. GREATEST(1, ...) because a
-- grant issued and expiring inside one day would otherwise backfill to zero,
-- and term_days becomes a positive NOT NULL column in Task 9.
UPDATE access_grant
SET term_days = GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - granted_at)) / 86400)::int)
WHERE term_days IS NULL;
```

A rule whose `max_tier` is `'public'` gets no rows, which is correct: it may auto-approve explicit documents and no blanket.

- [ ] **Step 6: Apply and verify the backfill**

```bash
pnpm db:migrate
```

Then confirm against the dev database that no grant lost its blanket and none has a null term:

```bash
psql "$DATABASE_URL" -c "
  SELECT
    (SELECT count(*) FROM access_grant WHERE all_request_tier) AS flagged,
    (SELECT count(*) FROM access_grant_tier WHERE tier = 'request') AS migrated,
    (SELECT count(*) FROM access_grant WHERE term_days IS NULL) AS untermed;"
```

Expected: `flagged` equals `migrated`, and `untermed` is 0.

- [ ] **Step 7: Handle the group-in-use case in the admin delete**

`access_grant_group.group_id` is `ON DELETE RESTRICT`, so `deleteGroup` now throws when a grant names the group. In `src/routes/(admin)/admin/groups/[id]/+page.server.ts`, catch it and report it rather than letting a 500 reach the operator:

```ts
import { ScopeGroupInUse } from '$lib/server/access/scope';

// inside the `remove` action, replacing the bare `await deleteGroup(...)`:
try {
	await deleteGroup(db, event.params.id);
} catch (cause) {
	// Postgres foreign-key violation. A grant still names this group, and
	// deleting it would silently narrow that grant.
	if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23503') {
		return fail(409, { field: 'group', message: 'in_use' });
	}
	throw cause;
}
```

Add `admin_group_in_use` to both catalogs (`"This group cannot be deleted while a grant still includes it."` / `"Diese Gruppe kann nicht gelöscht werden, solange eine Freigabe sie enthält."`) and render it in the detail page when `form?.message === 'in_use'`.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test:integration scope`
Expected: PASS, 9 tests.

- [ ] **Step 9: Run the whole suite**

Run: `pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
Expected: all clean. Nothing reads the new tables yet, so every existing test must still pass unchanged. **If any existing test changed behaviour in this task, something read the new tables early — find it before continuing.**

- [ ] **Step 10: Commit**

```bash
git add src/lib/server/db/schema/access.ts src/lib/server/access/scope.ts drizzle/ \
        src/routes/\(admin\)/admin/groups messages/ src/lib/paraglide \
        tests/integration/scope.test.ts tests/setup/db.ts
git commit -m "feat(access): add scope join tables and backfill them from the tier flags"
```

---

## Task 5: Grant resolution over sets

`grantCoversDocument()` becomes three sources instead of two. It is the definition of scope and is named once precisely because two copies could disagree about what somebody was granted.

`createGrant` writes both the sets and the old boolean while the contract migration is still pending. Writing only the sets would leave every not-yet-migrated reader — Tasks 6 through 8 — seeing an empty scope.

**Files:**
- Modify: `src/lib/server/access/grants.ts`
- Test: `tests/integration/grants-scope.test.ts` (new), `tests/integration/download.test.ts`, `tests/integration/expiry.test.ts`

**Interfaces:**
- Consumes: `PHASE_TIERS`, `setGrantTiers`, `setGrantGroups`, `grantTiers`, `grantGroups` from Task 4; `documentGroup` from Task 1
- Produces:
  - `createGrant(db, { requesterId, requestId, documentIds, tiers, groupIds, expiresAt, termDays })` — `allRequestTier` is gone
  - `AdminGrantRow` gains `tiers: ScopeTier[]` and `groupIds: string[]`, loses `allRequestTier`
  - `grantedDocuments`, `mayDownload`, `countGrantDocuments` unchanged in signature

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/grants-scope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createGroup, setDocumentGroups } from '$lib/server/access/groups';
import { countGrantDocuments, createGrant, grantedDocuments, mayDownload } from '$lib/server/access/grants';
import { withDb, seedDocument, seedRequester } from '../setup/db';

const inNinetyDays = () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

describe('grant resolution over sets', () => {
	it('covers a document named explicitly', async () => {
		await withDb(async (db) => {
			const requesterId = await seedRequester(db);
			const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });

			await createGrant(db, {
				requesterId,
				requestId: null,
				documentIds: [documentId],
				tiers: [],
				groupIds: [],
				expiresAt: inNinetyDays(),
				termDays: 90
			});

			expect(await mayDownload(db, requesterId, documentId)).toBe(true);
		});
	});

	it('covers a whole tier, including a document published later', async () => {
		await withDb(async (db) => {
			const requesterId = await seedRequester(db);

			await createGrant(db, {
				requesterId,
				requestId: null,
				documentIds: [],
				tiers: ['request'],
				groupIds: [],
				expiresAt: inNinetyDays(),
				termDays: 90
			});

			// Published after the grant was made. "Including documents published
			// later" is what a blanket means.
			const documentId = await seedDocument(db, { slug: 'later', tier: 'request' });
			expect(await mayDownload(db, requesterId, documentId)).toBe(true);
		});
	});

	it('covers a whole group, including a document added to it later', async () => {
		await withDb(async (db) => {
			const requesterId = await seedRequester(db);
			const groupId = await createGroup(db, { slug: 'customer', position: 0 });

			await createGrant(db, {
				requesterId,
				requestId: null,
				documentIds: [],
				tiers: [],
				groupIds: [groupId],
				expiresAt: inNinetyDays(),
				termDays: 90
			});

			const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
			expect(await mayDownload(db, requesterId, documentId)).toBe(false);

			await setDocumentGroups(db, documentId, [groupId]);
			expect(await mayDownload(db, requesterId, documentId)).toBe(true);
		});
	});

	it('grants nothing from an empty scope', async () => {
		await withDb(async (db) => {
			const requesterId = await seedRequester(db);
			await seedDocument(db, { slug: 'soc2', tier: 'request' });

			await createGrant(db, {
				requesterId,
				requestId: null,
				documentIds: [],
				tiers: [],
				groupIds: [],
				expiresAt: inNinetyDays(),
				termDays: 90
			});

			expect(await grantedDocuments(db, requesterId)).toEqual([]);
		});
	});

	it('does not honour an nda tier entry in this phase', async () => {
		await withDb(async (db) => {
			const requesterId = await seedRequester(db);
			const documentId = await seedDocument(db, { slug: 'pentest', tier: 'nda' });

			await createGrant(db, {
				requesterId,
				requestId: null,
				documentIds: [documentId],
				tiers: ['nda'],
				groupIds: [],
				expiresAt: inNinetyDays(),
				termDays: 90
			});

			// Storable, not yet honoured. Phase 3b is what makes this true, and
			// this assertion is what stops it becoming true by accident.
			expect(await mayDownload(db, requesterId, documentId)).toBe(false);
		});
	});

	it('counts only live, unrevoked scope', async () => {
		await withDb(async (db) => {
			const requesterId = await seedRequester(db);
			await seedDocument(db, { slug: 'soc2', tier: 'request' });

			const { grantId } = await createGrant(db, {
				requesterId,
				requestId: null,
				documentIds: [],
				tiers: ['request'],
				groupIds: [],
				expiresAt: new Date(Date.now() - 1000),
				termDays: 90
			});

			// countGrantDocuments never filtered expiry or revocation. Its one
			// caller pre-filtered, so it was safe by accident; the expiry reminder
			// would otherwise tell somebody how many documents an expired grant
			// covers.
			expect(await countGrantDocuments(db, grantId)).toBe(0);
		});
	});

	it('deduplicates a document covered by two sources', async () => {
		await withDb(async (db) => {
			const requesterId = await seedRequester(db);
			const groupId = await createGroup(db, { slug: 'customer', position: 0 });
			const documentId = await seedDocument(db, { slug: 'soc2', tier: 'request' });
			await setDocumentGroups(db, documentId, [groupId]);

			await createGrant(db, {
				requesterId,
				requestId: null,
				documentIds: [documentId],
				tiers: ['request'],
				groupIds: [groupId],
				expiresAt: inNinetyDays(),
				termDays: 90
			});

			const granted = await grantedDocuments(db, requesterId);
			expect(granted).toHaveLength(1);
		});
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:integration grants-scope`
Expected: FAIL — `createGrant` has no `tiers` parameter.

- [ ] **Step 3: Rewrite `grantCoversDocument`**

In `src/lib/server/access/grants.ts`:

```ts
import { accessGrantGroup, accessGrantTier, documentGroup } from '../db/schema';
import { PHASE_TIERS, setGrantGroups, setGrantTiers } from './scope';
import type { ScopeTier } from './scope';

/**
 * Whether a grant row covers a document row. Named once because it is the
 * definition of scope: three parallel sources, none implying any other. An
 * explicit document, a whole tier, or a whole group — the latter two both
 * meaning "including documents that join later".
 */
function grantCoversDocument() {
	return or(
		sql`EXISTS (
			SELECT 1 FROM ${accessGrantDocument}
			WHERE ${accessGrantDocument.grantId} = ${accessGrant.id}
			  AND ${accessGrantDocument.documentId} = ${document.id}
		)`,
		sql`EXISTS (
			SELECT 1 FROM ${accessGrantTier}
			WHERE ${accessGrantTier.grantId} = ${accessGrant.id}
			  AND ${accessGrantTier.tier} = ${document.tier}
		)`,
		sql`EXISTS (
			SELECT 1 FROM ${accessGrantGroup}
			JOIN ${documentGroup}
			  ON ${documentGroup.groupId} = ${accessGrantGroup.groupId}
			WHERE ${accessGrantGroup.grantId} = ${accessGrant.id}
			  AND ${documentGroup.documentId} = ${document.id}
		)`
	)!;
}
```

- [ ] **Step 4: Widen the tier filter behind one constant**

`grants.ts` has three `eq(document.tier, 'request')` today, at lines 55, 78 and 109. Line 55 is inside `grantCoversDocument` and disappears with Step 3's rewrite — a tier set now says which tiers a grant covers, so the blanket no longer hardcodes one. The remaining two, in `countGrantDocuments` and `grantedDocuments`, each become `inArray(document.tier, [...PHASE_TIERS])`.

Verify with `grep -n "document.tier" src/lib/server/access/grants.ts` — **two** matches after this step, both `inArray`. A third means Step 3's rewrite left the old blanket behind.

The comment above the filter in `grantedDocuments` stays and stays true:

```ts
// The tier filter is applied here rather than at grant time on purpose. A
// document moved out of a granted tier must stop being downloadable
// immediately, without anybody remembering to revisit existing grants.
```

- [ ] **Step 5: Add the missing predicates to `countGrantDocuments`**

```ts
export async function countGrantDocuments(db: Db, grantId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(accessGrant)
		.innerJoin(document, grantCoversDocument())
		.where(
			and(
				eq(accessGrant.id, grantId),
				// Neither predicate was here. The single caller pre-filtered, so it
				// was safe by accident rather than by construction — and a second
				// caller is exactly what this phase adds.
				isNull(accessGrant.revokedAt),
				gt(accessGrant.expiresAt, sql`now()`),
				eq(document.status, 'published'),
				inArray(document.tier, [...PHASE_TIERS])
			)
		);

	return row?.count ?? 0;
}
```

- [ ] **Step 6: Change `createGrant`**

```ts
export async function createGrant(
	db: Db,
	input: {
		requesterId: string;
		requestId: string | null;
		documentIds: readonly string[];
		tiers: readonly ScopeTier[];
		groupIds: readonly string[];
		expiresAt: Date;
		termDays: number;
	}
): Promise<{ grantId: string; expiresAt: Date }> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(accessGrant)
			.values({
				requesterId: input.requesterId,
				requestId: input.requestId,
				// Written alongside the sets until Task 9 drops the column. Writing
				// only the sets would leave every consumer this phase has not moved
				// yet seeing an empty scope.
				allRequestTier: input.tiers.includes('request'),
				termDays: input.termDays,
				expiresAt: input.expiresAt
			})
			.returning({ id: accessGrant.id });

		if (!row) throw new Error('failed to create grant');

		if (input.documentIds.length > 0) {
			await tx
				.insert(accessGrantDocument)
				.values(
					[...new Set(input.documentIds)].map((documentId) => ({ grantId: row.id, documentId }))
				);
		}

		await setGrantTiers(tx, row.id, input.tiers);
		await setGrantGroups(tx, row.id, input.groupIds);

		return { grantId: row.id, expiresAt: input.expiresAt };
	});
}
```

`setGrantTiers` and `setGrantGroups` open their own transactions; Postgres nests these as savepoints through Drizzle, so passing `tx` is correct and the whole grant stays atomic.

- [ ] **Step 7: Carry the sets into `AdminGrantRow`**

Replace `allRequestTier: boolean` with `tiers: ScopeTier[]` and `groupIds: string[]` on the interface, and load them in `listGrantsForAdmin` with two batched queries alongside the existing `scopes` query — one `inArray` over `accessGrantTier`, one over `accessGrantGroup`, both grouped into maps by grant id, exactly as `counts` already is. Do not query per row.

- [ ] **Step 8: Update the callers the compiler finds**

`pnpm check` now fails in `src/lib/server/access/verify.ts` and `src/lib/server/access/requests.ts`, which both call `createGrant`. Give each `tiers: request.allRequestTier ? ['request'] : []`, `groupIds: []`, and `termDays` derived from the expiry they already compute:

```ts
const termDays = Math.max(
	1,
	Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
);
```

This is a temporary bridge: Task 6 replaces it in `requests.ts` and Task 7 in `verify.ts` with the request's own tier set.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm test:integration grants-scope && pnpm test:integration`
Expected: PASS. `download.test.ts` and `expiry.test.ts` will need their `createGrant` calls updated to the new shape — that is expected and is part of this task.

- [ ] **Step 10: Commit**

```bash
git add src/lib/server/access/grants.ts src/lib/server/access/verify.ts \
        src/lib/server/access/requests.ts tests/integration/
git commit -m "feat(access): resolve grants over document, tier, and group sets"
```

---

## Task 6: Requests over sets

**Files:**
- Modify: `src/lib/server/access/requests.ts`, `src/lib/server/access/verify.ts`
- Test: `tests/integration/access-requests.test.ts`, `tests/integration/access-decisions.test.ts`, `tests/integration/access-verify.test.ts`

**Interfaces:**
- Consumes: `setRequestTiers`, `requestTiers`, `honouredTiers`, `PHASE_TIERS` from Task 4; `createGrant` from Task 5
- Produces:
  - `submitRequest(db, { ..., tiers })` — `allRequestTier` gone
  - `decideRequest(db, { ..., tiers, groupIds, termDays })` — `allRequestTier` and `expiresAt` gone (see Task 8 for the form)
  - `AdminRequestRow.tiers: ScopeTier[]`, `AdminRequestDetail.requestedTiers: ScopeTier[]`
  - `requestableDocuments(db, locale)` returns documents at `PHASE_TIERS`, unchanged in signature

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/access-requests.test.ts`:

```ts
it('stores a submitted tier blanket as a set', async () => {
	await withDb(async (db) => {
		const { requestId } = await submitRequest(db, {
			email: 'buyer@acme.example',
			name: 'Buyer',
			company: 'Acme',
			justification: null,
			documentIds: [],
			tiers: ['request'],
			locale: 'en',
			linkTtlMinutes: 30
		});

		expect(await requestTiers(db, requestId)).toEqual(['request']);
	});
});

it('refuses a submission that names neither a document nor a tier', async () => {
	await withDb(async (db) => {
		await expect(
			submitRequest(db, {
				email: 'buyer@acme.example',
				name: 'Buyer',
				company: 'Acme',
				justification: null,
				documentIds: [],
				tiers: [],
				locale: 'en',
				linkTtlMinutes: 30
			})
		).rejects.toThrow(RequestRejected);
	});
});

it('refuses a submitted nda tier in this phase', async () => {
	await withDb(async (db) => {
		// The public form does not offer it; this is the server refusing a posted
		// one, which is where Phase 2 put the same guarantee.
		await expect(
			submitRequest(db, {
				email: 'buyer@acme.example',
				name: 'Buyer',
				company: 'Acme',
				justification: null,
				documentIds: [],
				tiers: ['nda'],
				locale: 'en',
				linkTtlMinutes: 30
			})
		).rejects.toThrow(RequestRejected);
	});
});
```

And to `tests/integration/access-decisions.test.ts`:

```ts
it('grants the staff-chosen scope, not the requested one', async () => {
	await withDb(async (db) => {
		const { requestId, requesterId } = await seedVerifiedRequest(db, { tiers: ['request'] });
		const groupId = await createGroup(db, { slug: 'customer', position: 0 });

		const { grantId } = await decideRequest(db, {
			requestId,
			staffUserId: await seedStaff(db),
			decision: 'approve',
			documentIds: [],
			// The approver narrowed a tier blanket to one group.
			tiers: [],
			groupIds: [groupId],
			termDays: 30,
			reason: null
		});

		expect(await grantTiers(db, grantId!)).toEqual([]);
		expect(await grantGroups(db, grantId!)).toEqual([groupId]);
	});
});

it('refuses an approval that grants nothing at all', async () => {
	await withDb(async (db) => {
		const { requestId } = await seedVerifiedRequest(db, { tiers: ['request'] });

		await expect(
			decideRequest(db, {
				requestId,
				staffUserId: await seedStaff(db),
				decision: 'approve',
				documentIds: [],
				tiers: [],
				groupIds: [],
				termDays: 30,
				reason: null
			})
		).rejects.toThrow(DecisionRejected);
	});
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:integration access-requests access-decisions`
Expected: FAIL — `tiers` is not a parameter.

- [ ] **Step 3: Change `requestableDocuments`**

```ts
/**
 * The only documents a prospect may put in a scope: published, and at a tier
 * this phase honours. NDA-tier is Phase 3b, and a public document needs no
 * request.
 */
export async function requestableDocuments(db: Db, locale: string): Promise<RequestableDocument[]> {
	// ...unchanged, except:
	.where(and(inArray(document.tier, [...PHASE_TIERS]), eq(document.status, 'published')))
}
```

- [ ] **Step 4: Change `submitRequest`**

Replace `allRequestTier: boolean` with `tiers: readonly string[]` on `SubmitRequestInput`, and inside:

```ts
const tiers = honouredTiers(input.tiers);

// An empty scope is a submission that asks for nothing. A posted `nda` tier
// reduces to nothing here, which is the same refusal Phase 2 gave a posted
// NDA-tier document id.
if (tiers.length === 0 && input.documentIds.length === 0) {
	throw new RequestRejected('empty scope: name at least one document or tier');
}
```

The document allow-list check inside the transaction changes its tier predicate to `inArray(document.tier, [...PHASE_TIERS])`. After inserting the request row, write the set and the bridge boolean:

```ts
await tx
	.insert(accessRequest)
	.values({
		// ...unchanged fields
		allRequestTier: tiers.includes('request')
	})
	.returning({ id: accessRequest.id });

await setRequestTiers(tx, row.id, tiers);
```

- [ ] **Step 5: Change `decideRequest`**

`DecideRequestInput` loses `allRequestTier`, `expiresAt` and `defaultTtlDays`, and gains:

```ts
tiers: readonly string[];
groupIds: readonly string[];
/** The approver's chosen term. The route resolves the default; see Task 8. */
termDays: number;
```

Inside the approve branch:

```ts
const documentIds = [...new Set(input.documentIds)];
const tiers = honouredTiers(input.tiers);
const groupIds = [...new Set(input.groupIds)];

if (documentIds.length === 0 && tiers.length === 0 && groupIds.length === 0) {
	throw new DecisionRejected('empty scope: an approval must grant something');
}

if (documentIds.length > 0) {
	// Inside the transaction, and re-checked against the tier rather than
	// trusted from the form: a document at a tier this phase does not honour
	// cannot be approved in a phase that cannot gate it.
	const allowed = await tx
		.select({ id: document.id })
		.from(document)
		.where(
			and(
				inArray(document.id, documentIds),
				inArray(document.tier, [...PHASE_TIERS]),
				eq(document.status, 'published')
			)
		);

	if (allowed.length !== documentIds.length) {
		throw new DecisionRejected('not requestable: one or more documents are out of scope');
	}
}

const { grantId } = await createGrant(tx, {
	requesterId: request.requesterId,
	requestId: request.id,
	documentIds,
	tiers,
	groupIds,
	termDays: input.termDays,
	expiresAt: new Date(Date.now() + input.termDays * 24 * 60 * 60 * 1000)
});
```

`groupIds` is deliberately **not** validated against the document tiers it contains. A group is an operator's own object and its membership is already constrained by what they put in it; re-deriving that at decision time would be the recompute the design rejects.

- [ ] **Step 6: Carry the sets into the admin row types**

`AdminRequestRow` loses `allRequestTier` and gains `tiers: ScopeTier[]`; `AdminRequestDetail` gains `requestedTiers: ScopeTier[]` beside `requestedDocumentIds`. Batch the tier lookup in `listRequestsForAdmin` the same way `counts` is batched — one `inArray` over `accessRequestTier`, never one query per row.

- [ ] **Step 7: Change `verify.ts`**

The auto-approval path calls `createGrant` with the request's own scope. Replace the bridge from Task 5:

```ts
const tiers = await requestTiers(tx, request.id);

({ grantId } = await createGrant(tx, {
	requesterId: requester.id,
	requestId: request.id,
	documentIds: scoped.map((row) => row.documentId),
	tiers: honouredTiers(tiers),
	groupIds: [],
	termDays: input.grantTtlDays,
	expiresAt: new Date(Date.now() + input.grantTtlDays * 24 * 60 * 60 * 1000)
}));
```

An auto-approved decision grants no groups: the design's §10.1 guard says a pattern match may not hand out a blanket, and in this phase the simplest correct form of that is that rules grant tiers and explicit documents only.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test:integration`
Expected: PASS. Several existing decision and verify tests need their call shapes updated; that is part of this task.

- [ ] **Step 9: Commit**

```bash
git add src/lib/server/access/requests.ts src/lib/server/access/verify.ts tests/integration/
git commit -m "feat(access): carry request and decision scope as sets"
```

---

## Task 7: Rules over sets

**Files:**
- Modify: `src/lib/server/access/rules.ts`
- Modify: `src/routes/(admin)/admin/rules/new/+page.server.ts`, `src/routes/(admin)/admin/rules/[id]/+page.server.ts`, and both `+page.svelte`
- Modify: `messages/en.json`, `messages/de.json`
- Test: `tests/unit/access-rules.test.ts`, `tests/e2e/admin-access.spec.ts`

**Interfaces:**
- Consumes: `setRuleTiers`, `ruleTiers`, `honouredTiers`, `SCOPE_TIERS` from Task 4
- Produces:
  - `RuleDecision { action, tiers: ScopeTier[], ruleId }` — `maxTier` gone
  - `decideFromRules(rules, domain): RuleDecision`
  - `RuleForMatching` gains `tiers: ScopeTier[]`, loses `maxTier`
  - `ruleSchema` takes `tiers: ScopeTier[]`
  - `AdminRuleRow.tiers: ScopeTier[]`

- [ ] **Step 1: Write the failing unit test**

In `tests/unit/access-rules.test.ts`:

```ts
describe('decideFromRules', () => {
	const rule = (over: Partial<RuleForMatching> = {}): RuleForMatching => ({
		id: 'r1',
		pattern: 'acme.example',
		action: 'auto_approve',
		tiers: ['request'],
		priority: 100,
		...over
	});

	it('returns the matched rule’s tier set', () => {
		expect(decideFromRules([rule()], 'acme.example')).toEqual({
			action: 'auto_approve',
			tiers: ['request'],
			ruleId: 'r1'
		});
	});

	it('sends an unmatched domain to review with no blanket', () => {
		// No rule is not an error and not an approval. Phase 2 returned a
		// `request` ceiling here; a set makes "review, granting nothing by
		// pattern" expressible, which is what an unknown domain deserves.
		expect(decideFromRules([rule()], 'stranger.example')).toEqual({
			action: 'review',
			tiers: [],
			ruleId: null
		});
	});

	it('drops a tier this phase does not honour', () => {
		expect(decideFromRules([rule({ tiers: ['request', 'nda'] })], 'acme.example').tiers).toEqual([
			'request'
		]);
	});

	it('drops the whole blanket when a rule names only nda', () => {
		expect(decideFromRules([rule({ tiers: ['nda'] })], 'acme.example').tiers).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:unit access-rules`
Expected: FAIL — `RuleForMatching` has `maxTier`, not `tiers`.

- [ ] **Step 3: Rewrite the decision**

In `src/lib/server/access/rules.ts`, delete `PHASE_CEILING` and the `maxTier` clamp, and replace with:

```ts
export interface RuleDecision {
	action: AccessRuleAction;
	/** The blanket tiers this decision may grant. Empty means explicit documents only. */
	tiers: ScopeTier[];
	ruleId: string | null;
}

export function decideFromRules(rules: readonly RuleForMatching[], domain: string): RuleDecision {
	const matched = matchRule(rules, domain);

	// No rule is not an error and not an approval. An unknown domain reaches a
	// human, which is spec §9.3's "everything else becomes pending" — and it
	// carries no blanket, because nothing decided one.
	if (!matched) return { action: 'review', tiers: [], ruleId: null };

	return {
		action: matched.action,
		// A rule may name `nda` — the table admits it and the backfill preserved
		// it. `honouredTiers` is the one place this phase refuses to grant it,
		// and Phase 3b deletes that filter rather than hunting for clamps.
		tiers: honouredTiers(matched.tiers),
		ruleId: matched.id
	};
}
```

`matchRule` and `patternMatches` are untouched — the tie-break is about specificity, not about tiers.

- [ ] **Step 4: Change the schema and the row loaders**

```ts
export const ruleSchema = z.object({
	pattern: z.string().trim().toLowerCase().regex(RULE_PATTERN),
	action: z.enum(ACCESS_RULE_ACTIONS),
	tiers: z.array(z.enum(SCOPE_TIERS)).default([]),
	priority: z.coerce.number().int().min(0).max(10_000),
	note: z.string().trim().max(500).transform((value) => value || null).nullable()
});
```

`listRules` and `getRule` batch the tier sets in, the same way `listGroups` batches names — one `inArray` over `accessRuleTier`, not one query per rule. `createRule` and `updateRule` write the rule row and then call `setRuleTiers`, and keep writing `maxTier` as a bridge until Task 9:

```ts
export async function createRule(db: Db, input: RuleInput): Promise<string> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(accessRule)
			.values({
				pattern: input.pattern,
				action: input.action,
				priority: input.priority,
				note: input.note,
				// Bridge: the highest tier the set names, in the old ceiling's terms.
				maxTier: input.tiers.includes('nda') ? 'nda' : input.tiers.includes('request') ? 'request' : 'public'
			})
			.returning({ id: accessRule.id });

		if (!row) throw new Error('failed to create rule');
		await setRuleTiers(tx, row.id, input.tiers);
		return row.id;
	});
}
```

`updateRule` follows the same shape.

- [ ] **Step 5: Replace the form control**

In both rule pages, the `maxTier` select becomes a checkbox per tier:

```svelte
<fieldset class="grid gap-1">
	<legend class="text-sm font-medium">{m.admin_rule_tiers()}</legend>
	{#each SCOPE_TIERS as tier (tier)}
		<label class="flex items-center gap-2 text-sm">
			<input
				data-testid="rule-tier-{tier}"
				type="checkbox"
				name="tiers"
				value={tier}
				checked={data.rule?.tiers.includes(tier) ?? false}
			/>
			{tier}
			{#if tier === 'nda'}
				<span class="text-neutral-500">{m.admin_rule_tier_nda_pending()}</span>
			{/if}
		</label>
	{/each}
</fieldset>
```

Both `+page.server.ts` files change their `read`/`safeParse` input from `maxTier: form.get('maxTier')` to `tiers: form.getAll('tiers').map(String)`.

Add to both catalogs: `admin_rule_tiers` (`"Tiers this rule may approve"` / `"Stufen, die diese Regel freigeben darf"`) and `admin_rule_tier_nda_pending` (`"stored, not yet granted"` / `"gespeichert, noch nicht freigegeben"`). The NDA hint is honest labelling rather than decoration: an operator ticking it must not believe it does something today.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test:unit access-rules && pnpm test:e2e admin-access`
Expected: PASS. `admin-access.spec.ts` selects a `maxTier` option today and needs updating to the checkboxes — part of this task.

- [ ] **Step 7: Commit**

```bash
git add src/lib/server/access/rules.ts src/routes/\(admin\)/admin/rules messages/ \
        src/lib/paraglide tests/unit/access-rules.test.ts tests/e2e/admin-access.spec.ts
git commit -m "feat(access): let a rule name a set of tiers instead of a ceiling"
```

---

## Task 8: The portal and admin surfaces

The last consumers. The approval form also moves from an absolute expiry date to a term in days — the design's decision 4, and the reason is that a date cannot survive a clock that starts later than the approval. In 3b a grant waits for an acceptance before its clock starts, so an approver who chose "until 31 December" would get "N days from whenever they click", landing past the date they picked. Days is the native unit already: `ACCESS_GRANT_DEFAULT_DAYS` and the stored `access.grant_default_days` setting are both in days.

**Files:**
- Modify: `src/routes/(portal)/request/+page.server.ts`, `+page.svelte`
- Modify: `src/routes/(admin)/admin/requests/[id]/+page.server.ts`, `+page.svelte`
- Modify: `src/routes/(admin)/admin/requests/+page.svelte`, `src/routes/(admin)/admin/grants/+page.svelte`
- Modify: `src/routes/(admin)/admin/requesters/[id]/+page.svelte`, `src/lib/server/identity/requester.ts`
- Modify: `messages/en.json`, `messages/de.json`
- Test: `tests/e2e/request.spec.ts`, `tests/e2e/admin-requests.spec.ts`, `tests/e2e/access-portal.spec.ts`, `tests/e2e/access-journey.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–7; `listGroups` from Task 1; `defaultGrantDays` from `grants.ts`
- Produces: form field `tiers` (repeated checkbox) on both forms; `groupIds` on the decision form; `termDays` replacing `expiresAt`

- [ ] **Step 1: Write the failing e2e assertions**

In `tests/e2e/admin-requests.spec.ts`, replace the expiry-date step with a term, and add a group:

```ts
test('approves with a narrowed scope and a term in days', async ({ page }, testInfo) => {
	await signInAsAdmin(page, testInfo);

	// The carry-over's hardest-won lesson: navigate through gotoAdmin, which
	// waits for hydration. Filling a field before Svelte claims the tree posts
	// the server's value while the test's own "saved" assertion still passes.
	await gotoAdmin(page, '/admin/requests');
	await page.getByTestId('request-row').first().getByRole('link').click();

	await page.getByTestId('decision-tier-request').uncheck();
	await page.getByTestId('decision-group-customer').check();
	await page.getByTestId('decision-term-days').fill('30');
	await page.getByTestId('decision-approve').click();

	await expect(page.getByTestId('request-status')).toContainText(/approved/i);

	await gotoAdmin(page, '/admin/grants');
	await expect(page.getByTestId('grant-scope').first()).toContainText('customer');
});
```

In `tests/e2e/request.spec.ts`, the public form's single "everything at the request tier" checkbox becomes a per-tier one:

```ts
await page.getByTestId('request-tier-request').check();
```

And assert the NDA tier is not offered at all:

```ts
await expect(page.getByTestId('request-tier-nda')).toHaveCount(0);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm test:e2e admin-requests request`
Expected: FAIL — no such test ids.

- [ ] **Step 3: Change the public request form**

`src/routes/(portal)/request/+page.server.ts` — the Zod schema drops `allRequestTier` and the action reads the repeated field:

```ts
const schema = z.object({
	email: z.string().trim().toLowerCase().email(),
	name: z.string().trim().min(1),
	company: z.string().trim().min(1),
	justification: z.string().trim().max(2000).optional()
});

// in the action, after parsing:
const tiers = form.getAll('tiers').map(String);
```

Pass `tiers` to `submitRequest` in place of `allRequestTier`, and change the audit meta:

```ts
meta: {
	documentCount: documentIds.length,
	// No email, name, or company: spec §10 confines requester personal data to
	// ip, ua, and actor_id.
	tiers
}
```

The `load` also returns the tiers a prospect may ask for, so the template never hardcodes them:

```ts
return {
	documents: await requestableDocuments(getDb(), locals.locale),
	tiers: [...PHASE_TIERS]
};
```

`+page.svelte` replaces the single checkbox:

```svelte
{#each data.tiers as tier (tier)}
	<label class="flex items-center gap-2">
		<input data-testid="request-tier-{tier}" type="checkbox" name="tiers" value={tier} />
		{m.request_tier_all({ tier })}
	</label>
{/each}
```

Because `load` returns only `PHASE_TIERS`, the NDA tier is not rendered at all — the assertion in Step 1 holds by construction rather than by a conditional somebody could delete.

- [ ] **Step 4: Change the decision route**

`src/routes/(admin)/admin/requests/[id]/+page.server.ts`:

```ts
import { listGroups } from '$lib/server/access/groups';
import { PHASE_TIERS } from '$lib/server/access/scope';

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const request = await getRequestForAdmin(db, params.id);
	if (!request) error(404, 'Not found');

	return {
		request,
		groups: await listGroups(db),
		tiers: [...PHASE_TIERS],
		defaultTermDays: await defaultGrantDays(db, getConfig().accessGrantDefaultDays)
	};
};
```

In `decide()`, replace the date parse with a term parse:

```ts
const termRaw = String(form.get('termDays') ?? '').trim();
const termDays = termRaw
	? Number(termRaw)
	: await defaultGrantDays(db, config.accessGrantDefaultDays);

if (!Number.isInteger(termDays) || termDays < 1 || termDays > 3650) {
	return fail<DecisionFailure>(400, { failed: true });
}

const documentIds = form.getAll('documentIds').map(String).filter(Boolean);
const tiers = form.getAll('tiers').map(String);
const groupIds = form.getAll('groupIds').map(String).filter(Boolean);
```

and pass `tiers`, `groupIds`, `termDays` to `decideRequest`, dropping `allRequestTier`, `expiresAt` and `defaultTtlDays`.

- [ ] **Step 5: Change the decision form**

`+page.svelte` — the expiry date input becomes:

```svelte
<FormField label={m.admin_decision_term_days()}>
	<input
		data-testid="decision-term-days"
		name="termDays"
		type="number"
		min="1"
		max="3650"
		value={data.defaultTermDays}
		class="rounded border px-2 py-1"
	/>
</FormField>
```

and the single `allRequestTier` checkbox becomes two fieldsets:

```svelte
<fieldset class="grid gap-1">
	<legend class="text-sm font-medium">{m.admin_decision_tiers()}</legend>
	{#each data.tiers as tier (tier)}
		<label class="flex items-center gap-2 text-sm">
			<input
				data-testid="decision-tier-{tier}"
				type="checkbox"
				name="tiers"
				value={tier}
				checked={data.request.requestedTiers.includes(tier)}
			/>
			{m.request_tier_all({ tier })}
		</label>
	{/each}
</fieldset>

<fieldset class="grid gap-1">
	<legend class="text-sm font-medium">{m.admin_decision_groups()}</legend>
	{#each data.groups as group (group.id)}
		<label class="flex items-center gap-2 text-sm">
			<input
				data-testid="decision-group-{group.slug}"
				type="checkbox"
				name="groupIds"
				value={group.id}
			/>
			{group.names[data.locale] ?? group.slug}
		</label>
	{/each}
</fieldset>
```

Tier checkboxes are pre-checked from what the prospect asked for; group checkboxes are not, because nobody asked for a group — they are the approver's own instrument.

- [ ] **Step 6: Change the three read-only scope summaries**

`admin/requests/+page.svelte`, `admin/grants/+page.svelte`, and `admin/requesters/[id]/+page.svelte` each render a scope summary from `allRequestTier` plus a count today. Give each a `data-testid="grant-scope"` (or `request-scope`) span reading:

```svelte
<span data-testid="grant-scope" class="text-sm text-neutral-600">
	{#if row.tiers.length > 0}{row.tiers.join(', ')}{/if}
	{#if row.groupIds.length > 0}
		{groupNames(row.groupIds)}
	{/if}
	{#if row.documentCount > 0}
		{m.admin_scope_documents({ count: row.documentCount })}
	{/if}
	{#if row.tiers.length === 0 && row.groupIds.length === 0 && row.documentCount === 0}
		{m.admin_scope_empty()}
	{/if}
</span>
```

`src/lib/server/identity/requester.ts` carries `tiers` in place of `allRequestTier` on both its `requests` and `grants` arrays; batch them in as elsewhere. Pass the group names down from each page's `load` — the pages should not query.

Add `admin_scope_documents`, `admin_scope_empty`, `admin_decision_term_days`, `admin_decision_tiers`, `admin_decision_groups`, and `request_tier_all` to both catalogs, then `pnpm paraglide:compile`.

- [ ] **Step 7: Run every suite**

Run: `pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
Expected: all clean. `access-journey.spec.ts` and `access-portal.spec.ts` both drive the request form and will need their tier checkbox updated.

- [ ] **Step 8: Commit**

```bash
git add src/routes messages/ src/lib/paraglide src/lib/server/identity/requester.ts tests/e2e/
git commit -m "feat(admin): choose scope as tiers and groups, and a term in days"
```

---

## Task 9: Contract — drop the flags

Nothing reads `all_request_tier` or `max_tier` any more; the bridges written in Tasks 5–7 are the only writers left. This removes them and tightens `term_days`.

**Files:**
- Modify: `src/lib/server/db/schema/access.ts`
- Modify: `src/lib/server/access/grants.ts`, `requests.ts`, `rules.ts`
- Create: `drizzle/0018_drop_scope_flags.sql`
- Test: `tests/integration/scope.test.ts`

- [ ] **Step 1: Prove nothing reads them**

```bash
grep -rn "all_request_tier\|allRequestTier\|max_tier\|maxTier" --include="*.ts" --include="*.svelte" src/ tests/
```

Expected: only the three bridge writes — in `createGrant`, in `submitRequest`, and in `createRule`/`updateRule`. **If anything else appears, it is a consumer an earlier task missed; go back and move it rather than dropping the column underneath it.**

- [ ] **Step 2: Write the failing test**

Add to `tests/integration/scope.test.ts`:

```ts
it('has no scope flag columns left', async () => {
	await withDb(async (db) => {
		const rows = await db.execute<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns
			 WHERE table_name IN ('access_grant', 'access_request', 'access_rule')
			   AND column_name IN ('all_request_tier', 'max_tier')`
		);
		expect(rows).toEqual([]);
	});
});

it('requires a positive term on every grant', async () => {
	await withDb(async (db) => {
		const requesterId = await seedRequester(db);
		await expect(
			db.execute(
				`INSERT INTO access_grant (requester_id, expires_at)
				 VALUES ('${requesterId}', now() + interval '30 days')`
			)
		).rejects.toThrow();
	});
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm test:integration scope`
Expected: FAIL — the columns are still there.

- [ ] **Step 4: Remove the bridges**

Delete `allRequestTier` from the `values({...})` in `createGrant` and `submitRequest`, and `maxTier` from `createRule` and `updateRule`. Delete the `allRequestTier` and `maxTier` columns from `src/lib/server/db/schema/access.ts`, and delete `access_rule_max_tier_check`.

- [ ] **Step 5: Generate and rename the migration**

```bash
pnpm db:generate
```

Rename to `0018_drop_scope_flags`. The generated SQL drops three columns and one check constraint. Add the NOT NULL tightening by hand, after the drops:

```sql
--> statement-breakpoint
ALTER TABLE access_grant ALTER COLUMN term_days SET NOT NULL;
--> statement-breakpoint
ALTER TABLE access_grant ADD CONSTRAINT access_grant_term_days_check CHECK (term_days >= 1);
```

- [ ] **Step 6: Apply and verify**

Run: `pnpm db:migrate && pnpm test:integration scope`
Expected: PASS.

- [ ] **Step 7: Run everything**

Run: `pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/server/db/schema/access.ts src/lib/server/access/ drizzle/ tests/integration/
git commit -m "refactor(access): drop the tier flags now that scope is a set"
```

---

## Task 10: Documentation and phase close

**Files:**
- Modify: `docs/self-hosting.md`, `README.md`
- Create: `docs/superpowers/phase-3b-carryover.md`
- Modify: this plan's execution log

- [ ] **Step 1: Document access groups for operators**

Add a section to `docs/self-hosting.md` covering what a group is (a named bundle of documents, granted by name), that membership is edited on each document, and that a group cannot be deleted while a grant still includes it. No new environment variables ship in this phase — say so explicitly, because a reader scanning for configuration should not have to infer it.

- [ ] **Step 2: Update the README feature list**

The "Access governance" bullet currently says domain rules auto-approve, deny, or route to staff triage. Add that an approval's scope is a set of documents, whole tiers, and named groups.

- [ ] **Step 3: Write the carry-over**

Create `docs/superpowers/phase-3b-carryover.md` in the same shape as `phase-3-carryover.md`: decisions, measurements, and defects this phase saw and deliberately did not fold in. It must answer three questions:

1. **Did the two-axis model hold?** Groups were the fourth content type and the first real test of whether the Phase 2 admin helpers generalise. Record what fitted and what did not (Task 2, Step 9).
2. **Did expand → migrate → contract pay for itself?** Three migrations and three bridge writes against one big-bang migration. Record whether any task actually benefited from the green state in between, or whether it was ceremony.
3. **What does 3b inherit?** Specifically: `PHASE_TIERS` is the single constant 3b deletes; `honouredTiers` is where the NDA refusal lives; `access_group.nda_template_id` is the first column 3b adds; and `access_grant_group`'s `restrict` is the pattern 3b should copy for `access_grant_nda`.

- [ ] **Step 4: Run the full suite one final time**

Run: `pnpm check && pnpm lint && pnpm build && pnpm test:unit && pnpm test:integration && pnpm test:e2e`

`pnpm build` is in this list deliberately: it must succeed with no secrets and no database present, and a module that started calling `getConfig()` at import scope would only fail here.

- [ ] **Step 5: Commit**

```bash
git add docs/ README.md
git commit -m "docs: close phase 3a"
```

---

## Phase 3a completion criteria

- [ ] `access_group` exists as a content type with per-locale name and description, admin CRUD, and document membership edited from the document.
- [ ] Scope is three parallel sets on grants — documents, tiers, groups — and two on requests and rules. Nothing implies anything else.
- [ ] `all_request_tier` and `access_rule.max_tier` are gone from the schema and from every file.
- [ ] `access_grant.term_days` is NOT NULL, positive, and set from the approver's chosen term.
- [ ] A grant covering a whole group covers a document added to that group afterwards; a grant covering a whole tier covers a document published at that tier afterwards.
- [ ] `countGrantDocuments` filters expiry and revocation.
- [ ] The NDA tier is storable everywhere and honoured nowhere, with the refusal in exactly one constant.
- [ ] Deleting a group referenced by a grant is refused with a message an operator can act on.
- [ ] The public portal still sets no cookies; `tests/e2e/security.spec.ts` unchanged and passing.
- [ ] Every suite green, `pnpm build` succeeds with no secrets and no database.

---

## Self-review

Run before handing this plan to an executor.

**Spec coverage.** Design §3's 3a paragraph names: access groups as a content type (Tasks 1–3), scope as sets on requests, grants and rules (Tasks 4–7), the `all_request_tier` migration (Tasks 4 and 9), and `term_days` (Tasks 4, 6, 8, 9). §4.2's "the public form does not offer groups" is Task 8, Step 3 — the form renders `PHASE_TIERS` and never groups. §4.3's three parallel sets are Task 5, Step 3. §8's `access_grant_group` restrict-on-group is Task 4, Step 3, and its operator-facing consequence is Task 4, Step 7. **Not covered, and deliberately: `access_group.nda_template_id`**, which references a table 3b creates — recorded in Task 1 and in the carry-over.

**Type consistency.** `ScopeTier` is defined once in Task 4 and used in Tasks 5, 6, 7 and 8. `tiers` is the field name on every form, every input type, and every row type — never `tierSet` or `scopeTiers`. `groupIds` likewise. `createGrant` takes `termDays` from Task 5 onward and every caller passes it. `honouredTiers` is called at read time in `decideFromRules`, `submitRequest` and `decideRequest`, and never in a setter — Task 4, Step 4 states the reason.

**Known soft spots for the executor.**

- Task 4, Step 6's `psql` check assumes the dev database has grants in it. On an empty database `flagged` and `migrated` are both 0, which passes trivially and proves nothing. Seed one flagged grant first if you want the check to mean anything.
- Task 5, Step 6 nests `setGrantTiers` inside `createGrant`'s transaction. Confirm Drizzle maps a nested `transaction()` to a savepoint on the `postgres` driver before relying on it; if it does not, inline the inserts.
- Task 8 touches four e2e specs at once. The carry-over records four hydration-race sightings across three phases — if one of these goes intermittent, the fault is almost certainly an interaction before hydration, not the scope change.
