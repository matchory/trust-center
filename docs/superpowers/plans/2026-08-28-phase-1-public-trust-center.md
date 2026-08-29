# Trust Center Phase 1 — Public Trust Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the public Trust Center — certifications, controls, subprocessors, versioned public documents, FAQ, and an updates feed, all authored in DE/EN through an admin UI, presented on an SEO-complete portal that sets no cookies and loads nothing third-party, deployable from one production container.

**Architecture:** Content lives in Postgres as an entity table plus a `*_translations` side table keyed `(entity_id, locale)`. Documents come first and controls second; only then are the generic admin primitives extracted from the two, because a form scaffold cannot be designed before two real forms exist. Files never have a public URL: uploads go through a `StorageAdapter` port and downloads through one audited streaming endpoint. The portal is a `(portal)` route group with locale-prefixed URLs; the admin is the existing guarded `(admin)` group.

**Tech Stack:** SvelteKit 2 (Svelte 5 runes), TypeScript strict, Postgres 16, Drizzle ORM + drizzle-kit, Tailwind CSS v4, Paraglide JS v2, Zod v4, Vitest, `@testcontainers/postgresql`, Playwright, `@sveltejs/adapter-node`, distroless Node 22.

**Spec:** `docs/superpowers/specs/2026-08-28-trust-center-design.md`

**Predecessor:** `docs/superpowers/plans/2026-08-28-phase-0-foundation.md` and `docs/superpowers/phase-1-carryover.md`

---

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript `strict: true`, `noUncheckedIndexedAccess: true`.** No `any` in committed code.
- **Svelte 5 runes syntax** (`$state`, `$derived`, `$props`, `$effect`). Never `export let` or Svelte 4 stores.
- **`audit_event` is append-only.** No DELETE, no TRUNCATE, and no UPDATE except the column-scoped pseudonymization defined in spec §10 — which Phase 1 only *enforces*; the purge path itself is Phase 2.
- **Requester personal data appears in `audit_event` only in `ip`, `ua`, and `actor_id`** — never in `meta`, never in `subject_id`. Staff identifiers are outside the requester purge and may appear in `meta`.
- **Every admin mutation writes an audit event.** Create, update, publish, archive, delete, and file upload each record actor, subject, and IP.
- **The public portal sets no cookies and loads no third-party resources.** No CDN fonts, no analytics, no external CSS, no remote images. Both halves carry permanent tests by the end of this phase.
- **No public object URLs.** No file in storage is reachable except through the audited streaming endpoint.
- **Locales are two-layered** (spec §7): the compiled catalog set is a build input; `LOCALES` and `DEFAULT_LOCALE` select an enabled subset at runtime and are validated against the compiled set at startup. Nothing outside message catalogs and test fixtures may hardcode `de` or `en`.
- **Every user-facing string is localized.** Interface strings go in `messages/{locale}.json` via Paraglide; authored content goes in `*_translations` rows. A hardcoded German or English string in a `.svelte` file is a defect.
- **`getConfig()` and `getDb()` are lazy and must never be called at module scope.** `pnpm build` must keep succeeding with no secrets and no database present; CI checks exactly that.
- **SvelteKit configuration is inline in `vite.config.ts`'s `sveltekit({...})` call.** There is deliberately no `svelte.config.js`; creating one makes SvelteKit warn and silently ignore the inline config.
- **`localeStorage.run(...)` must remain the outermost wrapper around `resolve` in `hooks.server.ts`,** or server-rendered translations break silently.
- **Use `pnpm db:migrate`, never bare `drizzle-kit`** — drizzle-kit reads no `.env`.
- **Local Postgres is on host port 5433** (`POSTGRES_PORT=5433` in `.env`); host port 5432 belongs to an unrelated project. Never stop, alter, or inspect a container you did not create.
- **TDD throughout:** write the failing test, run it and watch it fail, implement minimally, run it and watch it pass, commit.
- **Commit after every task,** Conventional Commits format. Commit signing goes through Secretive and may need unlocking — never pass `--no-gpg-sign` and never change `commit.gpgsign`.
- **Licence: AGPL-3.0-or-later.**

---

## Decisions this plan settles

Three spec contradictions are resolved here. The first two were approved before planning and are already amended into the spec; the third was found while writing this plan and is a proposed deviation.

1. **The locale contract is two-layered.** Spec §7 now states it: compiled catalogs are a build input (a locale without a message catalog is not a locale — adding one means translating interface strings, which no environment variable can substitute for), while `LOCALES`/`DEFAULT_LOCALE` select an enabled subset at runtime and are validated against the compiled set at startup. Task 1 implements it, and renames `PUBLIC_LOCALES`/`PUBLIC_DEFAULT_LOCALE`/`PUBLIC_BASE_URL` to `LOCALES`/`DEFAULT_LOCALE`/`BASE_URL` — after this task nothing is imported from `$env/static/public`, so a `PUBLIC_` prefix would falsely advertise these values as client-exposed.

2. **The audit log is append-only with exactly one exception.** Spec §10 now defines it. Task 2 enforces it at the database while the table is still nearly empty.

3. **PROPOSED — locale-prefixed URLs everywhere, with a negotiating redirect at `/`.** Phase 0 serves the default locale unprefixed and negotiates `Accept-Language` at the root, so `/` returns different content per visitor. Spec §7 writes "`/de/...` and `/en/...`", and spec §6.2 calls the portal "aggressively cacheable" — a content-negotiated root is neither, and it makes `rel=canonical` and `hreflang` (Task 17) unanswerable. Task 1 changes `/` to a `302` to `/{locale}/` chosen by `Accept-Language`, carrying `Vary: Accept-Language` on the redirect alone so every content URL stays a stable, cacheable, indexable, locale-specific URL. This rewrites two Phase 0 e2e tests: the guarantees they assert (Accept-Language is honoured; client-side navigation re-renders messages) are preserved, their shape changes. **This deviation needs explicit sign-off before Task 1 runs.**

## Other deviations from the spec, with rationale

4. **Admin primitives are extracted, not designed.** Spec §6.6 wants "each new content type is a schema plus a configuration object". Task 11 extracts what two real content types justify — a filterable table, locale tabs, and form field components — and a `upsertTranslations` server helper. It deliberately stops short of a generic CRUD framework: a configuration-object-driven repository cannot be typed well over Drizzle, and Tasks 12–15 are the evidence for whether more abstraction is warranted. Whatever they show goes to the Phase 2 carry-over.

5. **`document_file.page_count` is not implemented.** Spec §8 lists it; it exists for watermarking, which is Phase 2. Adding `pdf-lib` now to populate a column nothing reads is speculative. It arrives with the watermarker.

6. **`document.owner_staff_id` and `review_interval` are not implemented.** They serve content ownership and the staleness dashboard, which are Phase 5.

7. **`page` (arbitrary markdown pages) is not implemented.** Spec §11's Phase 1 list does not include it, and every Phase 1 portal surface is a typed content type rather than free copy.

8. **`answer` carries only `category` and `visibility` alongside its translations.** Owners, review intervals, tags, usage counters, and per-locale full-text indexes are Phase 6's answer library. Phase 1 needs a public FAQ.

9. **Migrations run at server start by default.** Distroless has no shell, so the conventional "exec into the container and migrate" does not exist. `RUN_MIGRATIONS` (default `true`) makes the server apply pending migrations in its `init` hook. Operators running more than one replica set it to `false` and run a one-off migration job; `docs/self-hosting.md` documents both.

## Carry-over items folded into this phase

Taken from `docs/superpowers/phase-1-carryover.md`, each in the task that touches that code anyway. Everything not listed here stays on the carry-over list.

| Carry-over item | Task |
|---|---|
| Project `handleError` hook (SvelteKit's default logs the OIDC `cause`, which carries the authorization code) | 1 |
| Auth redirects are locale-blind | 1 |
| Paraglide `strategy` declared twice and honoured in neither place | 1 |
| Scaffold residue: `src/lib/index.ts`, `.vscode/extensions.json` | 1 |
| `BEFORE TRUNCATE` trigger on `audit_event` | 2 |
| `seq` typed nullable in the application | 2 |
| `CHECK` constraints on `staff_user.role` and `audit_event.actor_type` | 2 |
| Scope the e2e audit-event query to its own actor | 2 |
| `drizzle.config.ts` error text names a script that does not apply to `generate` | 2 |
| `vitePreprocess()` before a `.svelte` file needs generics or `satisfies` | 3 |
| Unreferenced `src/lib/assets/favicon.svg` | 3 |
| `kit.csp` config | 16 |
| An e2e assertion that the public portal loads no third-party resources | 16 |
| `robots.txt` grants blanket crawl permission; admin has no `noindex` | 17 |
| CI builds twice | 18 |
| The stale trailing clause in `playwright.config.ts`'s comment | 18 |

---

## File Structure

Files created or modified by this phase. Files that change together live together: each content
type owns one schema module, one repository module, one portal route directory, and one admin
route directory.

```
Dockerfile                                  production image, multi-stage, distroless runtime
docker-compose.yml                          production example: app + postgres
docs/self-hosting.md                        deployment guide, every environment variable
vite.config.ts                              MODIFIED: adapter-node, vitePreprocess, kit.csp
.env.example / .env                         MODIFIED: renamed vars, STORAGE_DIR, MAX_UPLOAD_MB
.github/workflows/ci.yml                    MODIFIED: no PUBLIC_* env, single build, image build
playwright.config.ts                        MODIFIED: webServer skips a redundant build in CI

drizzle/0004_audit_append_only_update.sql   UPDATE + TRUNCATE triggers, CHECK constraints
drizzle/0005_documents.sql                  document_category, document, translations, files
drizzle/0006_controls.sql                   control_group, control, translations
drizzle/0007_certifications.sql             certification + translations
drizzle/0008_subprocessors.sql              subprocessor + translations
drizzle/0009_answers.sql                    answer + translations
drizzle/0010_updates.sql                    update_post + translations

src/lib/i18n/
  compiled.ts                               COMPILED_LOCALES — the build-time catalog set
  locale.ts                                 MODIFIED: adds localizePath()
  locales.ts                                DELETED — replaced by compiled.ts + getConfig()

src/lib/server/config/parse.ts              MODIFIED: locales, defaultLocale, storage, uploads
src/lib/server/storage/
  index.ts                                  StorageAdapter interface, newStorageKey(), getStorage()
  local.ts                                  filesystem implementation

src/lib/server/db/schema/
  documents.ts  controls.ts  certifications.ts  subprocessors.ts  answers.ts  updates.ts
  audit.ts                                  MODIFIED: seq .notNull()
  index.ts                                  MODIFIED: re-exports the new modules

src/lib/server/content/
  translations.ts                           pickTranslated(), upsertTranslations() (Task 11)
  documents.ts  controls.ts  certifications.ts  subprocessors.ts  answers.ts  updates.ts
  branding.ts                               branding setting read/write with Zod defaults

src/lib/components/
  portal/Badge.svelte  FallbackNotice.svelte  SectionHeading.svelte
  admin/DataTable.svelte  LocaleTabs.svelte  FormField.svelte  FormActions.svelte  (Task 11)

src/routes/(portal)/
  +layout.svelte  +layout.server.ts         portal shell: nav, locale switcher, footer
  +page.svelte                              landing page: badges + section links
  documents/+page.svelte  +page.server.ts
  controls/+page.svelte   +page.server.ts
  subprocessors/+page.svelte  +page.server.ts
  faq/+page.svelte        +page.server.ts
  updates/+page.svelte    +page.server.ts

src/routes/api/documents/[fileId]/+server.ts    the one audited download endpoint
src/routes/api/branding/logo/+server.ts         branding logo, streamed from storage
src/routes/branding.css/+server.ts              branding CSS custom properties (keeps CSP strict)
src/routes/sitemap.xml/+server.ts
src/routes/robots.txt/+server.ts                replaces static/robots.txt

src/routes/(admin)/admin/
  documents/       controls/       certifications/
  subprocessors/   faq/            updates/        settings/branding/

src/hooks.ts                                MODIFIED: reroute over COMPILED_LOCALES
src/hooks.server.ts                         MODIFIED: init, locale gate, handleError

tests/unit/          locale.test.ts, config.test.ts, storage.test.ts, translations.test.ts
tests/integration/   documents.test.ts, controls.test.ts, content.test.ts, audit.test.ts
tests/e2e/           portal.spec.ts, admin-documents.spec.ts, admin-content.spec.ts,
                     security.spec.ts, seo.spec.ts, locale.spec.ts, auth.spec.ts
```

---

### Task 1: The locale contract — compiled catalogs, enabled subset, prefixed URLs

**Files:**
- Create: `src/lib/i18n/compiled.ts`
- Delete: `src/lib/i18n/locales.ts`, `src/lib/index.ts`, `.vscode/extensions.json`
- Modify: `src/lib/server/config/parse.ts`, `src/lib/server/config/index.ts`, `src/lib/i18n/locale.ts`, `src/hooks.ts`, `src/hooks.server.ts`, `src/app.d.ts`, `src/routes/+layout.server.ts`, `src/routes/auth/callback/+server.ts`, `src/routes/auth/logout/+server.ts`, `vite.config.ts`, `package.json`, `.env.example`, `.env`, `.github/workflows/ci.yml`, `README.md`
- Test: `tests/unit/config.test.ts`, `tests/unit/locale.test.ts`, `tests/e2e/locale.spec.ts`

**Interfaces:**
- Consumes: `parseConfig()` and `stripLocale()`/`resolveLocale()` from Phase 0.
- Produces, and every later task depends on these exact names:
  - `COMPILED_LOCALES: readonly string[]` from `$lib/i18n/compiled`
  - `getConfig(): AppConfig` gaining `locales: readonly string[]`, `defaultLocale: string`, `baseUrl: string`, `storageDir: string`, `maxUploadBytes: number`
  - `localizePath(path: string, locale: string): string`
  - `classifyPath(pathname, compiled, enabled): LocaleRoute`
  - `App.Locals` gaining `pathLocale: string | null`
  - Every page URL is `/{locale}{path}`; `/` redirects.

**Before starting:** this task implements proposed deviation 3 in the header. Confirm it is signed off.

- [x] **Step 1: Write the failing config tests**

Replace the whole of `tests/unit/config.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/server/config/parse';

const COMPILED = ['de', 'en'] as const;

const valid = {
	DATABASE_URL: 'postgres://tc:tc@localhost:5432/tc',
	BASE_URL: 'https://trust.example.com',
	LOCALES: 'de,en',
	DEFAULT_LOCALE: 'de',
	OIDC_ISSUER: 'https://idp.example.com',
	OIDC_CLIENT_ID: 'trust-center',
	OIDC_CLIENT_SECRET: 'secret',
	OIDC_ADMIN_GROUP: 'trust-center-admins'
};

describe('parseConfig', () => {
	it('parses a valid environment', () => {
		const config = parseConfig(valid, COMPILED);
		expect(config.databaseUrl).toBe('postgres://tc:tc@localhost:5432/tc');
		expect(config.baseUrl).toBe('https://trust.example.com');
		expect(config.oidc.adminGroup).toBe('trust-center-admins');
	});

	it('parses the enabled locale set, trimming whitespace', () => {
		expect(parseConfig({ ...valid, LOCALES: ' de , en ' }, COMPILED).locales).toEqual(['de', 'en']);
	});

	it('accepts a proper subset of the compiled locales', () => {
		const config = parseConfig({ ...valid, LOCALES: 'de', DEFAULT_LOCALE: 'de' }, COMPILED);
		expect(config.locales).toEqual(['de']);
		expect(config.defaultLocale).toBe('de');
	});

	it('rejects a locale with no compiled catalog, naming it and the compiled set', () => {
		expect(() => parseConfig({ ...valid, LOCALES: 'de,fr' }, COMPILED)).toThrowError(
			/LOCALES[\s\S]*fr[\s\S]*de, en/
		);
	});

	it('rejects a default locale that is not enabled', () => {
		expect(() => parseConfig({ ...valid, LOCALES: 'de', DEFAULT_LOCALE: 'en' }, COMPILED)).toThrowError(
			/DEFAULT_LOCALE/
		);
	});

	it('defaults the groups claim to "groups"', () => {
		expect(parseConfig(valid, COMPILED).oidc.groupsClaim).toBe('groups');
	});

	it('defaults the session TTL to 12 hours', () => {
		expect(parseConfig(valid, COMPILED).sessionTtlHours).toBe(12);
	});

	it('defaults the storage directory and the upload limit', () => {
		const config = parseConfig(valid, COMPILED);
		expect(config.storageDir).toBe('./data/storage');
		expect(config.maxUploadBytes).toBe(25 * 1024 * 1024);
	});

	it('converts MAX_UPLOAD_MB to bytes', () => {
		expect(parseConfig({ ...valid, MAX_UPLOAD_MB: '4' }, COMPILED).maxUploadBytes).toBe(4194304);
	});

	it('leaves the approver group undefined when unset', () => {
		expect(parseConfig(valid, COMPILED).oidc.approverGroup).toBeUndefined();
	});

	it('names every missing variable in one error', () => {
		expect(() => parseConfig({}, COMPILED)).toThrowError(
			/DATABASE_URL[\s\S]*LOCALES[\s\S]*OIDC_CLIENT_ID/
		);
	});

	it('rejects a non-URL issuer', () => {
		expect(() => parseConfig({ ...valid, OIDC_ISSUER: 'not-a-url' }, COMPILED)).toThrowError(
			/OIDC_ISSUER/
		);
	});
});
```

- [x] **Step 2: Run the config tests and watch them fail**

Run: `pnpm test:unit -- tests/unit/config.test.ts`
Expected: FAIL — `parseConfig` takes one argument and knows nothing of `LOCALES`, `BASE_URL`, or `STORAGE_DIR`.

- [x] **Step 3: Rewrite the config parser**

Replace `src/lib/server/config/parse.ts` with:

```ts
import { z } from 'zod';

const localeList = z
	.string()
	.min(1)
	.transform((value) =>
		value
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
	);

export interface AppConfig {
	databaseUrl: string;
	baseUrl: string;
	/** The locales this deployment serves. Always a subset of the compiled catalogs. */
	locales: readonly string[];
	defaultLocale: string;
	storageDir: string;
	maxUploadBytes: number;
	sessionTtlHours: number;
	oidc: {
		issuer: string;
		clientId: string;
		clientSecret: string;
		groupsClaim: string;
		adminGroup: string;
		approverGroup: string | undefined;
	};
}

/**
 * `compiledLocales` is a parameter rather than an import so this module stays
 * free of `$lib` aliases and Paraglide's generated runtime, and therefore
 * testable under plain Vitest. `src/lib/server/config/index.ts` supplies the
 * real value.
 */
function buildSchema(compiledLocales: readonly string[]) {
	return z
		.object({
			DATABASE_URL: z.string().min(1),
			BASE_URL: z.string().url(),
			LOCALES: localeList,
			DEFAULT_LOCALE: z.string().min(1),
			STORAGE_DIR: z.string().min(1).default('./data/storage'),
			MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),
			OIDC_ISSUER: z.string().url(),
			OIDC_CLIENT_ID: z.string().min(1),
			OIDC_CLIENT_SECRET: z.string().min(1),
			OIDC_ADMIN_GROUP: z.string().min(1),
			OIDC_APPROVER_GROUP: z.string().min(1).optional(),
			OIDC_GROUPS_CLAIM: z.string().min(1).default('groups'),
			SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12)
		})
		.superRefine((value, ctx) => {
			const unsupported = value.LOCALES.filter((locale) => !compiledLocales.includes(locale));

			if (unsupported.length > 0) {
				ctx.addIssue({
					code: 'custom',
					path: ['LOCALES'],
					message:
						`no message catalog is compiled for ${unsupported.join(', ')}. ` +
						`This image was built with: ${compiledLocales.join(', ')}. ` +
						`Enabling a new locale is a rebuild: add messages/<locale>.json, list it in ` +
						`project.inlang/settings.json, and build the image again.`
				});
			}

			if (!value.LOCALES.includes(value.DEFAULT_LOCALE)) {
				ctx.addIssue({
					code: 'custom',
					path: ['DEFAULT_LOCALE'],
					message: `"${value.DEFAULT_LOCALE}" is not one of LOCALES (${value.LOCALES.join(', ')})`
				});
			}
		});
}

export function parseConfig(
	env: Record<string, string | undefined>,
	compiledLocales: readonly string[]
): AppConfig {
	const result = buildSchema(compiledLocales).safeParse(env);

	if (!result.success) {
		const problems = result.error.issues
			.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
			.sort()
			.join('\n');
		throw new Error(`Invalid environment configuration:\n${problems}`);
	}

	const parsed = result.data;

	return {
		databaseUrl: parsed.DATABASE_URL,
		baseUrl: parsed.BASE_URL,
		locales: parsed.LOCALES,
		defaultLocale: parsed.DEFAULT_LOCALE,
		storageDir: parsed.STORAGE_DIR,
		maxUploadBytes: parsed.MAX_UPLOAD_MB * 1024 * 1024,
		sessionTtlHours: parsed.SESSION_TTL_HOURS,
		oidc: {
			issuer: parsed.OIDC_ISSUER,
			clientId: parsed.OIDC_CLIENT_ID,
			clientSecret: parsed.OIDC_CLIENT_SECRET,
			groupsClaim: parsed.OIDC_GROUPS_CLAIM,
			adminGroup: parsed.OIDC_ADMIN_GROUP,
			approverGroup: parsed.OIDC_APPROVER_GROUP
		}
	};
}
```

Create `src/lib/i18n/compiled.ts`:

```ts
// Relative rather than `$lib/...` on purpose: this module is pulled in by the
// config singleton, which unit tests import without SvelteKit's aliases.
import { locales } from '../paraglide/runtime.js';

/**
 * The locales Paraglide compiled a catalog for. A build input, fixed for the
 * life of an image — a locale with no catalog is not a locale.
 *
 * `getConfig().locales` is the subset an operator enabled at runtime and is
 * always a subset of this. URL prefix routing is structural and uses THIS
 * list: `/en/x` is a locale-prefixed path whether or not English is enabled,
 * so a disabled locale 404s rather than being mistaken for a content slug.
 */
export const COMPILED_LOCALES: readonly string[] = locales;
```

Replace `src/lib/server/config/index.ts` with:

```ts
import { COMPILED_LOCALES } from '$lib/i18n/compiled';
import { parseConfig, type AppConfig } from './parse';

let cached: AppConfig | undefined;

/**
 * Parsed lazily so importing this module never requires a configured
 * environment — `vite build` must not need runtime secrets.
 */
export function getConfig(): AppConfig {
	return (cached ??= parseConfig(process.env, COMPILED_LOCALES));
}

export type { AppConfig } from './parse';
```

Delete `src/lib/i18n/locales.ts`.

- [x] **Step 4: Run the config tests and watch them pass**

Run: `pnpm test:unit -- tests/unit/config.test.ts`
Expected: PASS, 12 tests.

- [x] **Step 5: Write the failing locale-routing tests**

Append to `tests/unit/locale.test.ts`. Keep the existing `stripLocale`, `resolveLocale`, and
`pickTranslation` describes — they all still apply. **Delete the `assertLocaleSubset` describe and,
in Step 7, the `assertLocaleSubset` function itself:** the subset check now lives in `parseConfig`'s
`superRefine`, where it is covered by Step 1's "rejects a locale with no compiled catalog" test, and
leaving a second implementation of the same rule invites the two to drift.

```ts
import { classifyPath, localizePath } from '../../src/lib/i18n/locale';

const COMPILED = ['de', 'en'] as const;

describe('localizePath', () => {
	it('prefixes the root without leaving a trailing slash pair', () => {
		expect(localizePath('/', 'de')).toBe('/de');
	});

	it('prefixes a nested path', () => {
		expect(localizePath('/documents/avv', 'en')).toBe('/en/documents/avv');
	});

	it('is idempotent in composition with stripLocale', () => {
		expect(localizePath(stripLocale('/en/documents', COMPILED).path, 'de')).toBe('/de/documents');
	});
});

describe('classifyPath', () => {
	it('accepts a prefix that is compiled and enabled', () => {
		expect(classifyPath('/en/documents', COMPILED, ['de', 'en'])).toEqual({
			kind: 'localized',
			locale: 'en',
			path: '/documents'
		});
	});

	it('reports a compiled but disabled locale as unknown, so it can 404', () => {
		expect(classifyPath('/en/documents', COMPILED, ['de'])).toEqual({
			kind: 'unknown-locale',
			locale: 'en'
		});
	});

	it('treats a prefix with no compiled catalog as an ordinary path', () => {
		expect(classifyPath('/fr/documents', COMPILED, ['de', 'en'])).toEqual({
			kind: 'unprefixed',
			path: '/fr/documents'
		});
	});

	it('reports the bare root as unprefixed', () => {
		expect(classifyPath('/', COMPILED, ['de', 'en'])).toEqual({ kind: 'unprefixed', path: '/' });
	});

	it('accepts a bare locale prefix as that locale at the root', () => {
		expect(classifyPath('/de', COMPILED, ['de', 'en'])).toEqual({
			kind: 'localized',
			locale: 'de',
			path: '/'
		});
	});
});
```

- [x] **Step 6: Run the locale tests and watch them fail**

Run: `pnpm test:unit -- tests/unit/locale.test.ts`
Expected: FAIL — `classifyPath` and `localizePath` are not exported.

- [x] **Step 7: Add the two routing helpers**

Append to `src/lib/i18n/locale.ts`:

```ts
/** Builds the canonical, always-prefixed URL path for a locale. */
export function localizePath(path: string, locale: string): string {
	return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

export type LocaleRoute =
	| { kind: 'localized'; locale: string; path: string }
	| { kind: 'unprefixed'; path: string }
	| { kind: 'unknown-locale'; locale: string };

/**
 * The whole locale routing decision as a pure function, so `hooks.server.ts`
 * stays a switch over three cases and the interesting part is unit-testable.
 *
 * The distinction that matters: a prefix Paraglide compiled a catalog for is
 * *structurally* a locale prefix even when the operator has disabled it, so it
 * must 404 rather than fall through to content lookup — otherwise disabling a
 * locale would turn `/en/avv` into a search for a document slugged `en`.
 */
export function classifyPath(
	pathname: string,
	compiled: readonly string[],
	enabled: readonly string[]
): LocaleRoute {
	const { locale, path } = stripLocale(pathname, compiled);

	if (locale === null) return { kind: 'unprefixed', path };
	if (!enabled.includes(locale)) return { kind: 'unknown-locale', locale };
	return { kind: 'localized', locale, path };
}
```

- [x] **Step 8: Run the locale tests and watch them pass**

Run: `pnpm test:unit -- tests/unit/locale.test.ts`
Expected: PASS.

- [x] **Step 9: Rewire the hooks**

Replace `src/hooks.ts` with:

```ts
import type { Reroute } from '@sveltejs/kit';
import { COMPILED_LOCALES } from '$lib/i18n/compiled';
import { stripLocale } from '$lib/i18n/locale';

// Structural, and deliberately over the COMPILED set rather than the enabled
// one: this hook is universal (it runs in the browser too) and must not depend
// on server configuration. `hooks.server.ts` decides whether the locale is
// enabled.
export const reroute: Reroute = ({ url }) => stripLocale(url.pathname, COMPILED_LOCALES).path;
```

Replace `src/hooks.server.ts` with:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { error, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
import { SESSION_COOKIE, validateStaffSession } from '$lib/server/auth/session';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { COMPILED_LOCALES } from '$lib/i18n/compiled';
import { classifyPath, resolveLocale } from '$lib/i18n/locale';
import { assertIsLocale, overwriteServerAsyncLocalStorage } from '$lib/paraglide/runtime.js';

type Locale = ReturnType<typeof assertIsLocale>;

// Paraglide's `m.*()` message functions resolve their locale through this
// AsyncLocalStorage in an SSR context (see runtime.js `getLocale`). We own
// locale resolution ourselves, so rather than using `paraglideMiddleware` —
// which applies its own URL-strategy redirects — we populate the same storage
// directly, per request, so Paraglide's lookups agree with `locals.locale`.
const localeStorage = new AsyncLocalStorage<{ locale?: Locale }>();
overwriteServerAsyncLocalStorage(localeStorage);

/**
 * Fails the process on invalid configuration rather than letting every request
 * 500 with the same parse error. `getConfig()` is memoised, so this also warms
 * it before the first request.
 */
export const init: ServerInit = () => {
	try {
		getConfig();
	} catch (cause) {
		console.error(cause instanceof Error ? cause.message : cause);
		process.exit(1);
	}
};

export const handle: Handle = async ({ event, resolve }) => {
	const { locales, defaultLocale } = getConfig();
	const route = classifyPath(event.url.pathname, COMPILED_LOCALES, locales);

	// A compiled-but-disabled locale is not a content path. Refusing it here
	// keeps `/en/avv` from degrading into a lookup for a document slugged "en"
	// the day an operator narrows LOCALES.
	if (route.kind === 'unknown-locale') {
		error(404, `Locale "${route.locale}" is not enabled on this deployment.`);
	}

	event.locals.pathLocale = route.kind === 'localized' ? route.locale : null;
	event.locals.locale =
		route.kind === 'localized'
			? route.locale
			: resolveLocale(
					{
						pathLocale: null,
						acceptLanguage: event.request.headers.get('accept-language') ?? undefined
					},
					locales,
					defaultLocale
				);

	event.locals.staff = null;
	const token = event.cookies.get(SESSION_COOKIE);

	if (token) {
		const session = await validateStaffSession(getDb(), token);
		const role = session?.user.role;

		if (session && (role === 'admin' || role === 'approver')) {
			event.locals.staff = {
				id: session.user.id,
				email: session.user.email,
				name: session.user.name,
				role
			};
		} else {
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
		}
	}

	// localeStorage.run MUST remain the outermost wrapper around resolve, or
	// server-rendered translations silently fall back to the base locale.
	return localeStorage.run({ locale: assertIsLocale(event.locals.locale) }, async () => {
		const response = await resolve(event, {
			transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.locale)
		});

		// Only the unprefixed responses vary by Accept-Language — and those are
		// all redirects issued by the root layout. Every content URL carries its
		// locale in the path and stays unconditionally cacheable.
		if (route.kind === 'unprefixed') response.headers.append('Vary', 'Accept-Language');

		return response;
	});
};

/**
 * Deliberately does not log `error.cause`. `openid-client` attaches the
 * callback request — including the authorization code, and on some flows the
 * client secret — as the cause of its errors, and SvelteKit's default handler
 * `console.error`s the whole chain, writing credentials into the operator's
 * logs. Message, route, and a correlation id are enough to investigate.
 */
export const handleError: HandleServerError = ({ error: caught, event, status, message }) => {
	const id = crypto.randomUUID();

	console.error(
		JSON.stringify({
			level: 'error',
			id,
			status,
			method: event.request.method,
			route: event.route.id,
			message: caught instanceof Error ? caught.message : String(caught)
		})
	);

	return { message, id };
};
```

Extend `src/app.d.ts`:

```ts
declare global {
	namespace App {
		interface Error {
			message: string;
			id?: string;
		}
		interface Locals {
			locale: string;
			/** The locale taken from the URL prefix, or null on an unprefixed path. */
			pathLocale: string | null;
			staff: { id: string; email: string; name: string; role: 'admin' | 'approver' } | null;
		}
	}
}

export {};
```

- [x] **Step 10: Move the negotiating redirect into the root layout load**

This is where the redirect belongs rather than in `handle`: layout loads run for pages and only
for pages, so endpoints (`/api/*`, `/sitemap.xml`, `/robots.txt`, `/branding.css`), static assets,
and SvelteKit's own `/_app/*` are never redirected and need no exception list.

Replace `src/routes/+layout.server.ts` with:

```ts
import { redirect } from '@sveltejs/kit';
import { getConfig } from '$lib/server/config';
import { localizePath } from '$lib/i18n/locale';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals, url }) => {
	// Every page lives at a locale-prefixed URL, so an unprefixed request is
	// negotiated once and redirected. That keeps every content URL stable and
	// cacheable, and makes canonical/hreflang answerable (Task 17).
	if (locals.pathLocale === null) {
		redirect(302, `${localizePath(url.pathname, locals.locale)}${url.search}`);
	}

	const { locales, defaultLocale } = getConfig();
	return { locale: locals.locale, locales, defaultLocale };
};
```

- [x] **Step 11: Make the auth redirects locale-aware**

In `src/routes/auth/callback/+server.ts`, add the imports and change the final redirect:

```ts
import { localizePath } from '$lib/i18n/locale';
// ...
	redirect(303, localizePath('/admin', locals.locale));
```

The handler signature gains `locals`: `async ({ url, cookies, locals, getClientAddress, request })`.

In `src/routes/auth/logout/+server.ts`, change the final redirect the same way:

```ts
	redirect(303, localizePath('/', locals.locale));
```

`locals` is already destructured there.

- [x] **Step 12: Remove the dead Paraglide strategy declarations and the scaffold residue**

Paraglide's `strategy` is declared in two places and honoured in neither, because both entry
points overwrite the locale resolver (`hooks.server.ts` via the async storage, `hooks.client.ts`
via `overwriteGetLocale`). Leaving it in place suggests a knob that does nothing.

In `package.json`, drop the flag from the compile script:

```json
"paraglide:compile": "paraglide-js compile --project ./project.inlang --outdir ./src/lib/paraglide",
```

In `vite.config.ts`, replace the `strategy` key with the reason it is absent:

```ts
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide'
			// No `strategy`: hooks.server.ts and hooks.client.ts both overwrite
			// Paraglide's locale resolver, so any strategy configured here is
			// dead configuration. See src/lib/i18n/compiled.ts.
		}),
```

Delete the unused scaffold residue: `src/lib/index.ts` and `.vscode/extensions.json`.

- [x] **Step 13: Rename the environment variables everywhere**

Replace `.env.example` with:

```sh
# --- Database ---------------------------------------------------------------
DATABASE_URL=postgres://trustcenter:trustcenter@localhost:5432/trustcenter

# Host port docker-compose.dev.yml publishes Postgres on. If you change this
# because 5432 is taken, you must also update the port in DATABASE_URL above
# to match, or the app will fail to connect.
POSTGRES_PORT=5432

# --- Site -------------------------------------------------------------------
# The public origin this deployment is reached at. Used for the OIDC redirect
# URI, canonical URLs, and the sitemap.
BASE_URL=http://localhost:5173

# Locales this deployment serves. Must be a subset of the locales compiled into
# the image (see project.inlang/settings.json) — the app refuses to start
# otherwise. Adding a NEW language is a rebuild, not a setting: it needs a
# message catalog that a human has translated.
LOCALES=de,en
DEFAULT_LOCALE=de

# --- File storage -----------------------------------------------------------
# Where uploaded documents and branding assets are written. Must be a persistent
# volume in production. Nothing here is ever served directly; every read goes
# through the audited download endpoint.
STORAGE_DIR=./data/storage
MAX_UPLOAD_MB=25

# --- Staff authentication (OIDC) --------------------------------------------
OIDC_ISSUER=http://localhost:5556
# Host port docker-compose.dev.yml publishes the dev OIDC provider on. If you
# change this, you must also update the port in OIDC_ISSUER above to match.
DEV_IDP_PORT=5556
OIDC_CLIENT_ID=trust-center
OIDC_CLIENT_SECRET=dev-secret
OIDC_ADMIN_GROUP=trust-center-admins
OIDC_APPROVER_GROUP=trust-center-approvers
# Claim your IdP returns the caller's group memberships under. Defaults to
# "groups"; set this if your IdP uses a different claim name (e.g. Entra ID's
# "roles" for app roles).
OIDC_GROUPS_CLAIM=groups

# Hours a staff session stays valid before requiring a fresh login. Defaults
# to 12.
SESSION_TTL_HOURS=12
```

Apply the same renames to the developer's local `.env` — it is gitignored, so it must be edited
by hand rather than copied over. **Keep its existing `POSTGRES_PORT=5433` and the matching `:5433`
in `DATABASE_URL`:** host port 5432 belongs to an unrelated project on this machine. Add
`STORAGE_DIR=./data/storage` and `MAX_UPLOAD_MB=25`. Add `data/` to `.gitignore`.

In `.github/workflows/ci.yml`, delete both `env:` blocks — the `PUBLIC_*` values existed only to
satisfy the `$env/static/public` import that this task removed. Update the comments:

```yaml
      - run: pnpm lint
      # No .env present: svelte-check now needs no environment at all, because
      # nothing is imported from $env/static/public any more.
      - run: pnpm check
      # No .env present: proves `pnpm build` needs neither runtime secrets nor a
      # reachable database. Configuration is read at boot, not at build.
      - run: pnpm build
```

In `README.md`, add a short "Configuration" section pointing at `.env.example` and stating the
locale rule in one sentence: *the locales a deployment can serve are compiled into the build;
`LOCALES` selects which of them are enabled.*

- [x] **Step 14: Rewrite the locale e2e spec for prefixed URLs**

Replace `tests/e2e/locale.spec.ts` with:

```ts
import { expect, test } from '@playwright/test';

test('redirects the unprefixed root to the negotiated locale', async ({ browser }) => {
	// Two contexts with different preferred languages requesting the same URL
	// must land on different locale prefixes. This is the only test exercising
	// the Accept-Language wiring end to end: the suite pins `use.locale` to
	// de-DE for determinism, so every other test would still pass if the
	// negotiation branch were deleted outright.
	const deContext = await browser.newContext({ locale: 'de-DE' });
	const enContext = await browser.newContext({ locale: 'en-GB' });

	try {
		const dePage = await deContext.newPage();
		const enPage = await enContext.newPage();

		await dePage.goto('/');
		await enPage.goto('/');

		await expect(dePage).toHaveURL(/\/de$/);
		await expect(enPage).toHaveURL(/\/en$/);
	} finally {
		await deContext.close();
		await enContext.close();
	}
});

test('marks the negotiated redirect as varying by Accept-Language', async ({ request }) => {
	// Without this header a cache in front of the app would serve one visitor's
	// negotiated redirect to every other visitor.
	const response = await request.get('/', { maxRedirects: 0 });
	expect(response.status()).toBe(302);
	expect(response.headers()['vary']).toMatch(/accept-language/i);
});

test('serves German under /de and English under /en', async ({ page }) => {
	await page.goto('/de');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Verwaltung');
	await expect(page.locator('html')).toHaveAttribute('lang', 'de');

	await page.goto('/en');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Administration');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('sets no cookies on the public portal', async ({ page, context }) => {
	await page.goto('/de');
	expect(await context.cookies()).toHaveLength(0);
});

test('404s a locale prefix with no compiled catalog', async ({ page }) => {
	const response = await page.goto('/fr');
	expect(response?.status()).toBe(404);
});

test('updates rendered messages on client-side navigation between locales', async ({ page }) => {
	await page.goto('/de');
	await expect(page.getByTestId('admin-link-label')).toHaveText('Verwaltung');

	// Plant a marker on `window` and a real in-app link before navigating. A
	// full document reload resets `window`, so the marker surviving the click
	// proves SvelteKit's client router handled the navigation.
	await page.evaluate(() => {
		(window as unknown as { __navMarker?: boolean }).__navMarker = true;

		const anchorPoint = document.querySelector('[data-testid="admin-link-label"]');
		const link = document.createElement('a');
		link.href = '/en';
		link.textContent = 'switch to English';
		anchorPoint?.after(link);
	});

	await page.getByRole('link', { name: 'switch to English' }).click();

	await expect(page.getByTestId('admin-link-label')).toHaveText('Administration');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');

	const markerSurvived = await page.evaluate(
		() => (window as unknown as { __navMarker?: boolean }).__navMarker
	);
	expect(markerSurvived).toBe(true);
});
```

In `tests/e2e/auth.spec.ts`, update the two URL assertions that assumed unprefixed paths:
`await expect(page).toHaveURL(/\/admin$/)` still holds (the path now ends `/de/admin`), and
`await expect(page).toHaveURL('/')` after sign-out becomes `await expect(page).toHaveURL(/\/de$/)`.

- [x] **Step 15: Run the whole suite**

```bash
docker compose -f docker-compose.dev.yml up -d --wait
pnpm db:migrate
pnpm lint && pnpm check && pnpm build
pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green. If `pnpm check` complains that `$env/static/public` types are missing, that
is stale generated output — delete `.svelte-kit/` and re-run.

- [x] **Step 16: Commit**

```bash
git add -A
git commit -m "feat(i18n): compiled catalogs, enabled subset, locale-prefixed URLs

Implements the two-layer locale contract from spec section 7. The compiled
catalog set is a build input; LOCALES and DEFAULT_LOCALE select an enabled
subset and are validated against it at startup, so a misconfiguration exits
the process instead of 500-ing every request.

Nothing is imported from \$env/static/public any more, so the PUBLIC_ prefix
would falsely advertise these values as client-exposed: PUBLIC_LOCALES,
PUBLIC_DEFAULT_LOCALE and PUBLIC_BASE_URL become LOCALES, DEFAULT_LOCALE and
BASE_URL. CI's check and build steps need no environment at all now.

Every page URL is locale-prefixed and the unprefixed root negotiates once and
redirects, carrying Vary: Accept-Language on the redirect alone. Content URLs
are therefore stable and cacheable, which spec section 6.2 assumes and which
canonical and hreflang need.

Also from the Phase 0 carry-over: a handleError hook that does not log the
OIDC error cause (it carries the authorization code), locale-aware auth
redirects, and removal of the dead Paraglide strategy declarations."
```

---

### Task 2: Enforce the append-only audit contract at the database

Spec §10 now permits exactly one mutation of `audit_event`: clearing `ip`, `ua`, and `actor_id`
when a requester is purged. Phase 0 enforced the `DELETE` half and left `UPDATE` alone because the
policy did not exist yet. It exists now, and the table holds a few dozen dev rows — this is the
cheapest moment in the product's life to constrain it.

The purge path itself is Phase 2. This task ships only the constraint it will have to satisfy.

**Files:**
- Create: `drizzle/0004_audit_append_only.sql`
- Modify: `src/lib/server/db/schema/audit.ts`, `src/lib/server/db/schema/staff.ts`, `drizzle.config.ts`, `package.json`
- Test: `tests/integration/audit.test.ts`, `tests/e2e/auth.spec.ts`

**Interfaces:**
- Consumes: `recordEvent()`, `queryEvents()`, the `auditEvent` and `staffUser` tables from Phase 0.
- Produces: no new application API. Every later task inherits the constraint — an audit event, once
  written, can never be corrected, so `recordEvent` call sites must get their `meta` right the
  first time.

- [x] **Step 1: Write the failing constraint tests**

Append to `tests/integration/audit.test.ts`, inside the existing `describe('audit log', ...)`:

```ts
	it('permits clearing ip, ua and actor_id — the one pseudonymization exception', async () => {
		await recordEvent(db, {
			action: 'test.pseudonymize',
			actor: { type: 'requester', id: 'req-purge-me' },
			subjectType: 'test',
			subjectId: 'pseudonymize-allowed',
			ip: '198.51.100.7',
			ua: 'Mozilla/5.0'
		});

		await db
			.update(auditEvent)
			.set({ ip: null, ua: null, actorId: null })
			.where(eq(auditEvent.subjectId, 'pseudonymize-allowed'));

		const [row] = await queryEvents(db, {
			subjectType: 'test',
			subjectId: 'pseudonymize-allowed'
		});

		expect(row?.ip).toBeNull();
		expect(row?.ua).toBeNull();
		expect(row?.actorId).toBeNull();
		// The occurrence itself survives the purge — that is the whole point of
		// pseudonymizing rather than deleting.
		expect(row?.action).toBe('test.pseudonymize');
	});

	it('rejects rewriting ip to a different value rather than clearing it', async () => {
		await recordEvent(db, {
			action: 'test.pseudonymize',
			actor: { type: 'requester', id: 'req-2' },
			subjectType: 'test',
			subjectId: 'pseudonymize-rewrite',
			ip: '198.51.100.7'
		});

		await expect(
			db
				.update(auditEvent)
				.set({ ip: '203.0.113.9' })
				.where(eq(auditEvent.subjectId, 'pseudonymize-rewrite'))
		).rejects.toThrow(/never rewrite/);
	});

	it('rejects changing any column outside the pseudonymization set', async () => {
		await recordEvent(db, {
			action: 'test.immutable',
			actor: { type: 'system', id: null },
			subjectType: 'test',
			subjectId: 'immutable-action'
		});

		await expect(
			db
				.update(auditEvent)
				.set({ action: 'test.rewritten' })
				.where(eq(auditEvent.subjectId, 'immutable-action'))
		).rejects.toThrow(/append-only/);
	});

	it('rejects redacting meta, which must never hold requester personal data', async () => {
		await recordEvent(db, {
			action: 'test.meta-immutable',
			actor: { type: 'system', id: null },
			subjectType: 'test',
			subjectId: 'meta-immutable',
			meta: { documentId: 'doc-1' }
		});

		await expect(
			db.update(auditEvent).set({ meta: {} }).where(eq(auditEvent.subjectId, 'meta-immutable'))
		).rejects.toThrow(/append-only/);
	});

	it('rejects truncation, which row-level delete triggers do not catch', async () => {
		await expect(db.execute(sql`TRUNCATE TABLE "audit_event"`)).rejects.toThrow(/cannot be truncated/);
	});

	it('rejects an actor_type outside the four the application defines', async () => {
		await expect(
			db.execute(
				sql`INSERT INTO "audit_event" ("actor_type", "action") VALUES ('anonymous', 'test.bad-actor')`
			)
		).rejects.toThrow(/actor_type/);
	});
```

Add `sql` to the drizzle-orm import at the top of the file: `import { eq, sql } from 'drizzle-orm';`

- [x] **Step 2: Run the tests and watch them fail**

Run: `pnpm test:integration -- tests/integration/audit.test.ts`
Expected: FAIL. The `UPDATE` and `TRUNCATE` cases fail because they *succeed* — nothing stops
them yet — and the `actor_type` case fails because the insert is accepted.

- [x] **Step 3: Write the migration**

Create `drizzle/0004_audit_append_only.sql`:

```sql
-- Drizzle's bigserial with mode 'bigint' sets hasDefault but not notNull, so
-- the snapshot disagreed with Postgres, which has always had NOT NULL here.
-- Harmless under `migrate`; a `push` would have tried to DROP NOT NULL.
ALTER TABLE "audit_event" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint

-- Spec section 10: audit_event is append-only, with exactly one exception —
-- pseudonymization on requester purge, which may only CLEAR ip, ua and
-- actor_id. Phase 0 enforced the DELETE half (drizzle/0003) and deliberately
-- left UPDATE alone because the policy did not exist yet.
--
-- Expressing "only toward less identifiability" is only this simple because of
-- the companion invariant: requester personal data appears in audit_event ONLY
-- in these three columns, never in meta and never in subject_id. That is why
-- meta is immutable below rather than redactable.
CREATE FUNCTION "audit_event_forbid_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."seq" IS DISTINCT FROM OLD."seq"
		OR NEW."at" IS DISTINCT FROM OLD."at"
		OR NEW."actor_type" IS DISTINCT FROM OLD."actor_type"
		OR NEW."action" IS DISTINCT FROM OLD."action"
		OR NEW."subject_type" IS DISTINCT FROM OLD."subject_type"
		OR NEW."subject_id" IS DISTINCT FROM OLD."subject_id"
		OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
		OR NEW."meta" IS DISTINCT FROM OLD."meta"
	THEN
		RAISE EXCEPTION 'audit_event is append-only: only ip, ua and actor_id may change';
	END IF;

	IF (NEW."ip" IS NOT NULL AND NEW."ip" IS DISTINCT FROM OLD."ip")
		OR (NEW."ua" IS NOT NULL AND NEW."ua" IS DISTINCT FROM OLD."ua")
		OR (NEW."actor_id" IS NOT NULL AND NEW."actor_id" IS DISTINCT FROM OLD."actor_id")
	THEN
		RAISE EXCEPTION 'audit_event pseudonymization may only clear ip, ua and actor_id, never rewrite them';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_event_forbid_rewrite"
	BEFORE UPDATE ON "audit_event"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_event_forbid_rewrite"();--> statement-breakpoint

-- Row-level DELETE triggers do not fire on TRUNCATE, and the application role
-- owns this table. Phase 0's trigger stops the realistic accident; this closes
-- the hole an auditor would look for.
CREATE FUNCTION "audit_event_forbid_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_event is append-only: the table cannot be truncated';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_event_forbid_truncate"
	BEFORE TRUNCATE ON "audit_event"
	FOR EACH STATEMENT
	EXECUTE FUNCTION "audit_event_forbid_truncate"();--> statement-breakpoint

-- Defence in depth while both tables are still effectively empty. The
-- application already fails closed on an unknown role; this stops a bad value
-- reaching the table at all.
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_type_check"
	CHECK ("actor_type" IN ('staff', 'staff-unresolved', 'requester', 'system'));--> statement-breakpoint

ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_role_check"
	CHECK ("role" IN ('admin', 'approver'));
```

Register it in `drizzle/meta/_journal.json` with `"idx": 4`, `"tag": "0004_audit_append_only"`,
`"version": "7"`, `"breakpoints": true`, and a `when` value of `Date.now()` at the time you write
it. Copy `drizzle/meta/0003_snapshot.json` to `drizzle/meta/0004_snapshot.json` and apply the
`seq` NOT NULL and the two check constraints to it, so a later `drizzle-kit generate` does not
try to re-add them.

- [x] **Step 4: Bring the Drizzle schema back into agreement**

In `src/lib/server/db/schema/audit.ts`, make `seq` non-null and declare the check:

```ts
import { bigserial, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const auditEvent = pgTable(
	'audit_event',
	{
		// ... unchanged columns ...
		seq: bigserial('seq', { mode: 'bigint' }).notNull().unique(),
		// ... unchanged columns ...
	},
	(table) => [
		index('audit_event_subject_idx').on(table.subjectType, table.subjectId),
		index('audit_event_at_idx').on(table.at),
		index('audit_event_actor_idx').on(table.actorType, table.actorId),
		check(
			'audit_event_actor_type_check',
			sql`${table.actorType} IN ('staff', 'staff-unresolved', 'requester', 'system')`
		)
	]
);
```

In `src/lib/server/db/schema/staff.ts`, add the role check to `staffUser`. The table currently has
no second argument; give it one:

```ts
export const staffUser = pgTable(
	'staff_user',
	{
		// ... unchanged columns ...
	},
	(table) => [check('staff_user_role_check', sql`${table.role} IN ('admin', 'approver')`)]
);
```

Import `check` from `drizzle-orm/pg-core` and `sql` from `drizzle-orm` in both files.

- [x] **Step 5: Run the migration and the tests**

```bash
pnpm db:migrate
pnpm test:integration -- tests/integration/audit.test.ts
```

Expected: PASS. The integration suite starts a fresh Testcontainers Postgres and migrates it from
zero on every run, so no manual cleanup is needed — which is just as well, since `DELETE` and now
`TRUNCATE` are both refused.

- [x] **Step 6: Fix the two carry-over nits in this area**

`drizzle.config.ts`'s error text names `pnpm db:migrate`, but the config also loads for
`drizzle-kit generate`, which needs no database and had no script. Add the missing script to
`package.json`:

```json
"db:generate": "node --env-file-if-exists=.env node_modules/drizzle-kit/bin.cjs generate",
```

and widen the message in `drizzle.config.ts`:

```ts
	throw new Error(
		'DATABASE_URL is not set. drizzle-kit reads no .env file itself — run via ' +
			'`pnpm db:migrate` or `pnpm db:generate` (both load .env), or export ' +
			'DATABASE_URL yourself.'
	);
```

In `tests/e2e/auth.spec.ts`, scope the audit assertion to the actor it created. As written it
proves *some* login happened during the window, not that *these* events came from *this* login:

```ts
	const recent = await db
		.select({ action: auditEvent.action, actorType: auditEvent.actorType })
		.from(auditEvent)
		.where(and(gte(auditEvent.at, from), eq(auditEvent.actorType, 'staff')))
		.orderBy(desc(auditEvent.seq));
	const actions = recent.map((row) => row.action);

	expect(actions).toContain('staff.login.succeeded');
	expect(actions).toContain('staff.logout');

	// The denied login resolves to no staff_user row, so it is recorded under
	// the staff-unresolved actor type — asserting on it separately proves the
	// two actor spaces stay distinct.
	const denied = await db
		.select({ action: auditEvent.action })
		.from(auditEvent)
		.where(and(gte(auditEvent.at, from), eq(auditEvent.actorType, 'staff-unresolved')));

	expect(denied.map((row) => row.action)).toContain('staff.login.denied');
```

Import `and` and `eq` from `drizzle-orm` alongside the existing `desc` and `gte`.

- [x] **Step 7: Run the whole suite**

Run: `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
Expected: all green.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(audit): enforce the append-only contract at the database

Spec section 10 permits exactly one mutation of audit_event: clearing ip, ua
and actor_id when a requester is purged. A BEFORE UPDATE trigger now allows
that and nothing else — no column outside the set may change, and the three
that may change may only move toward NULL, never to a different value.

meta is immutable rather than redactable, which is only tenable because of the
companion invariant the spec now states: requester personal data lives in
those three columns and nowhere else in the table.

Also adds the BEFORE TRUNCATE trigger row-level delete triggers do not cover,
CHECK constraints on audit_event.actor_type and staff_user.role while both
tables are still empty, and the seq NOT NULL the Drizzle snapshot was missing.

The purge path that will use this exception is Phase 2; this is the constraint
it has to satisfy."
```

---

### Task 3: The portal route group, shell, and locale switcher

Everything public renders inside this shell, so it comes before the first content type. The nav is
driven by a registry each later task appends one line to, which keeps "add a section" from meaning
"edit four files".

Styling is deliberately token-based: colours come from CSS custom properties with sensible
fallbacks, so Task 16 supplies branding values without touching any component.

**Files:**
- Create: `src/lib/portal/sections.ts`, `src/routes/(portal)/+layout.svelte`, `src/routes/(portal)/+page.svelte`, `src/lib/components/portal/SectionHeading.svelte`, `src/lib/components/portal/Badge.svelte`, `src/lib/components/portal/FallbackNotice.svelte`, `src/lib/components/portal/LocaleSwitcher.svelte`
- Delete: `src/routes/+page.svelte`, `src/lib/assets/favicon.svg`
- Modify: `src/app.css`, `vite.config.ts`, `messages/de.json`, `messages/en.json`
- Test: `tests/e2e/portal.spec.ts`

**Interfaces:**
- Consumes: `data.locale`, `data.locales`, `data.defaultLocale` from the root layout load (Task 1);
  `localizePath()`, `stripLocale()`, `COMPILED_LOCALES`.
- Produces:
  - `PORTAL_SECTIONS: PortalSection[]` in `$lib/portal/sections` — `{ path: string; label: () => string }`
  - `<Badge tone="ok" | "warn" | "danger" | "neutral">`
  - `<FallbackNotice locale={string} />`
  - `<SectionHeading title={string} description={string | null} />`

- [x] **Step 1: Write the failing portal e2e spec**

Create `tests/e2e/portal.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('renders the portal shell with a skip link and a footer', async ({ page }) => {
	await page.goto('/de');
	await expect(page.getByTestId('skip-to-content')).toBeAttached();
	await expect(page.getByTestId('portal-footer')).toBeVisible();
});

test('the locale switcher preserves the current path', async ({ page }) => {
	await page.goto('/de');
	await page.getByTestId('locale-switch-en').click();
	await expect(page).toHaveURL(/\/en$/);
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('offers one locale switch link per enabled locale, naming each in its own language', async ({
	page
}) => {
	await page.goto('/de');
	await expect(page.getByTestId('locale-switch-de')).toHaveText('Deutsch');
	await expect(page.getByTestId('locale-switch-en')).toHaveText('English');
});

test('marks the active locale so it is not announced as a link to elsewhere', async ({ page }) => {
	await page.goto('/de');
	await expect(page.getByTestId('locale-switch-de')).toHaveAttribute('aria-current', 'true');
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm test:e2e -- tests/e2e/portal.spec.ts`
Expected: FAIL — no shell, no switcher.

- [x] **Step 3: Add the messages**

Add to `messages/de.json`:

```json
	"portal_tagline": "Sicherheit, Datenschutz und Compliance — nachvollziehbar dokumentiert.",
	"portal_skip_to_content": "Zum Inhalt springen",
	"portal_language": "Sprache",
	"portal_imprint": "Impressum",
	"portal_privacy": "Datenschutz",
	"portal_no_sections": "Für dieses Trust Center wurden noch keine Inhalte veröffentlicht.",
	"content_fallback_notice": "Nur auf {language} verfügbar."
```

Add to `messages/en.json`:

```json
	"portal_tagline": "Security, privacy, and compliance — documented and verifiable.",
	"portal_skip_to_content": "Skip to content",
	"portal_language": "Language",
	"portal_imprint": "Imprint",
	"portal_privacy": "Privacy",
	"portal_no_sections": "No content has been published on this trust center yet.",
	"content_fallback_notice": "Only available in {language}."
```

- [x] **Step 4: Create the section registry**

Create `src/lib/portal/sections.ts`:

```ts
import { m } from '$lib/paraglide/messages.js';

export interface PortalSection {
	/** Locale-free path, e.g. `/documents`. `localizePath` adds the prefix. */
	path: string;
	/** A Paraglide message accessor, called at render time so it resolves per request. */
	label: () => string;
}

/**
 * The portal's navigation, in display order. Each content type appends its own
 * entry here as it lands, so adding a section is one line rather than an edit
 * to the layout, the landing page, and the sitemap.
 */
export const PORTAL_SECTIONS: PortalSection[] = [];

void m;
```

The trailing `void m;` keeps the import live while the list is empty; delete it in Task 6, which
adds the first real entry.

- [x] **Step 5: Build the shell components**

Create `src/lib/components/portal/LocaleSwitcher.svelte`:

```svelte
<script lang="ts">
	import { page } from '$app/state';
	import { COMPILED_LOCALES } from '$lib/i18n/compiled';
	import { localizePath, stripLocale } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';

	let { locales, current }: { locales: readonly string[]; current: string } = $props();

	// The locale-free path, so switching language keeps the visitor on the page
	// they were reading rather than sending them back to the root.
	let basePath = $derived(stripLocale(page.url.pathname, COMPILED_LOCALES).path);

	// Intl.DisplayNames rather than a hand-maintained map: it names any locale
	// the deployment compiles, in that locale's own language, and it is built
	// into the platform — the portal loads nothing third-party.
	function endonym(locale: string): string {
		return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
	}
</script>

<nav aria-label={m.portal_language()} class="flex items-center gap-3 text-sm">
	{#each locales as locale (locale)}
		{#if locale === current}
			<span data-testid="locale-switch-{locale}" aria-current="true" class="font-semibold"
				>{endonym(locale)}</span
			>
		{:else}
			<a
				data-testid="locale-switch-{locale}"
				href={localizePath(basePath, locale)}
				hreflang={locale}
				class="underline underline-offset-4 hover:no-underline">{endonym(locale)}</a
			>
		{/if}
	{/each}
</nav>
```

Create `src/lib/components/portal/Badge.svelte`:

```svelte
<script lang="ts">
	type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

	let { tone = 'neutral', children }: { tone?: Tone; children: import('svelte').Snippet } =
		$props();

	const classes: Record<Tone, string> = {
		ok: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
		warn: 'bg-amber-50 text-amber-900 ring-amber-200',
		danger: 'bg-red-50 text-red-900 ring-red-200',
		neutral: 'bg-neutral-100 text-neutral-700 ring-neutral-200'
	};
</script>

<span
	class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset {classes[
		tone
	]}"
>
	{@render children()}
</span>
```

Create `src/lib/components/portal/FallbackNotice.svelte`. Spec §7 makes this a requirement, not a
nicety: serving German-speaking counsel an English AVV without saying so is worse than saying it is
the only version available.

```svelte
<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	let { locale }: { locale: string } = $props();

	let language = $derived(
		new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
	);
</script>

<span
	data-testid="fallback-notice"
	lang={locale}
	class="text-xs text-neutral-500 italic"
	title={m.content_fallback_notice({ language })}
>
	{m.content_fallback_notice({ language })}
</span>
```

Create `src/lib/components/portal/SectionHeading.svelte`:

```svelte
<script lang="ts">
	let { title, description = null }: { title: string; description?: string | null } = $props();
</script>

<header class="mb-8">
	<h1 class="text-3xl font-semibold tracking-tight text-[var(--tc-ink,#171717)]">{title}</h1>
	{#if description}
		<p class="mt-2 max-w-2xl text-neutral-600">{description}</p>
	{/if}
</header>
```

- [x] **Step 6: Build the portal layout and landing page**

Create `src/routes/(portal)/+layout.svelte`:

```svelte
<script lang="ts">
	import LocaleSwitcher from '$lib/components/portal/LocaleSwitcher.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { PORTAL_SECTIONS } from '$lib/portal/sections';
	import { m } from '$lib/paraglide/messages.js';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<a
	data-testid="skip-to-content"
	href="#content"
	class="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:rounded focus:bg-white focus:px-3 focus:py-2 focus:shadow"
>
	{m.portal_skip_to_content()}
</a>

<div class="min-h-screen bg-[var(--tc-surface,#fafafa)] text-[var(--tc-ink,#171717)]">
	<header class="border-b border-neutral-200 bg-white">
		<div class="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-4">
			<a href={localizePath('/', data.locale)} class="text-lg font-semibold tracking-tight">
				{m.site_title()}
			</a>

			<nav class="flex flex-wrap items-center gap-4 text-sm" aria-label={m.site_title()}>
				{#each PORTAL_SECTIONS as section (section.path)}
					<a
						href={localizePath(section.path, data.locale)}
						data-testid="nav-{section.path.slice(1)}"
						class="hover:underline hover:underline-offset-4">{section.label()}</a
					>
				{/each}
			</nav>

			<div class="ml-auto">
				<LocaleSwitcher locales={data.locales} current={data.locale} />
			</div>
		</div>
	</header>

	<main id="content" class="mx-auto max-w-5xl px-6 py-12">
		{@render children()}
	</main>

	<footer
		data-testid="portal-footer"
		class="mt-16 border-t border-neutral-200 bg-white px-6 py-8 text-sm text-neutral-500"
	>
		<div class="mx-auto flex max-w-5xl flex-wrap items-center gap-4">
			<span>{m.site_title()}</span>
		</div>
	</footer>
</div>
```

Create `src/routes/(portal)/+page.svelte` and delete `src/routes/+page.svelte`:

```svelte
<script lang="ts">
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import { localizePath } from '$lib/i18n/locale';
	import { PORTAL_SECTIONS } from '$lib/portal/sections';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<SectionHeading title={m.site_title()} description={m.portal_tagline()} />

{#if PORTAL_SECTIONS.length === 0}
	<p data-testid="no-sections" class="text-neutral-600">{m.portal_no_sections()}</p>
{:else}
	<ul class="grid gap-4 sm:grid-cols-2">
		{#each PORTAL_SECTIONS as section (section.path)}
			<li>
				<a
					href={localizePath(section.path, data.locale)}
					class="block rounded-lg border border-neutral-200 bg-white p-5 hover:border-neutral-400"
				>
					<span class="font-medium">{section.label()}</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
```

The old root `+page.svelte` carried `data-testid="site-title"`, `data-testid="admin-link-label"`,
and `data-testid="sign-in"`, which `tests/e2e/locale.spec.ts` and `auth.spec.ts` still use. Keep
`admin-link-label` alive by adding to the footer of `(portal)/+layout.svelte`, after the site title
span:

```svelte
			<a data-testid="admin-link-label" href={localizePath('/admin', data.locale)}>
				{m.nav_admin()}
			</a>
			<a data-testid="sign-in" href="/auth/login" class="underline">{m.admin_sign_in()}</a>
```

`/auth/login` stays unprefixed: it is an endpoint, not a page, and the OIDC redirect URI is fixed.

- [x] **Step 7: Add `vitePreprocess` and clean up the scaffold favicon**

Content tasks from here on write `.svelte` files with typed script blocks that use `satisfies` and
generics; without a preprocessor those fail to compile. In `vite.config.ts`:

```ts
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
// ...
		sveltekit({
			preprocess: vitePreprocess(),
			compilerOptions: { /* unchanged */ },
			adapter: adapter()
		})
```

Delete the unreferenced `src/lib/assets/favicon.svg`. A real favicon arrives with branding in
Task 16.

- [x] **Step 8: Run the tests and watch them pass**

Run: `pnpm test:e2e -- tests/e2e/portal.spec.ts tests/e2e/locale.spec.ts`
Expected: PASS.

- [x] **Step 9: Run the whole suite and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(portal): route group, shell, and locale switcher

Adds the (portal) group every public page renders inside: a header with the
section nav and a language switcher, a skip link, and a footer. Navigation is
driven by a registry each content type appends one line to, so adding a
section does not mean editing the layout, the landing page, and the sitemap
separately.

Language names come from Intl.DisplayNames rather than a hand-maintained map:
it names any locale the deployment compiles, in that locale's own language,
and it is built into the platform, so the portal still loads nothing
third-party.

FallbackNotice implements the visible-label half of the spec's locale fallback
rule, which is a requirement for legal documents rather than a nicety.

Colours are CSS custom properties with fallbacks throughout, so Task 16's
branding configuration supplies values without touching a component."
```

---

### Task 4: The `StorageAdapter` port and its filesystem implementation

Spec §6.4 makes storage one of the four boundaries where the application touches the outside world,
and §6.5 forbids any publicly reachable URL to a stored object. Both are structural commitments, so
the port arrives before the first upload rather than being retrofitted around one.

Keys are generated, never derived from a filename. That is what makes traversal impossible by
construction rather than by sanitising: a key that did not come from `newStorageKey()` fails the
shape check before any path is joined.

**Files:**
- Create: `src/lib/server/storage/index.ts`, `src/lib/server/storage/local.ts`
- Test: `tests/unit/storage.test.ts`

**Interfaces:**
- Consumes: `getConfig().storageDir`.
- Produces:
  - `newStorageKey(): string` — `"ab/cd/<uuid>"`
  - `interface StoredObject { key: string; size: number; sha256: string }`
  - `interface StorageAdapter { put(key, data): Promise<StoredObject>; stream(key): Promise<ReadableStream<Uint8Array>>; stat(key): Promise<{ size: number } | null>; delete(key): Promise<void> }`
  - `createLocalStorage(rootDir: string): StorageAdapter`
  - `getStorage(): StorageAdapter` — the lazy process singleton

- [x] **Step 1: Write the failing storage tests**

Create `tests/unit/storage.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalStorage, newStorageKey } from '../../src/lib/server/storage/local';
import type { StorageAdapter } from '../../src/lib/server/storage';

let root: string;
let storage: StorageAdapter;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), 'tc-storage-'));
	storage = createLocalStorage(root);
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
	return Buffer.concat(chunks);
}

describe('newStorageKey', () => {
	it('produces a sharded, opaque key', () => {
		expect(newStorageKey()).toMatch(
			/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
	});

	it('never repeats', () => {
		const keys = new Set(Array.from({ length: 500 }, () => newStorageKey()));
		expect(keys.size).toBe(500);
	});
});

describe('local storage', () => {
	it('round-trips bytes and reports size and digest', async () => {
		const key = newStorageKey();
		const data = new TextEncoder().encode('%PDF-1.7 pretend document');

		const stored = await storage.put(key, data);

		expect(stored.key).toBe(key);
		expect(stored.size).toBe(data.byteLength);
		// sha256 of the same bytes, computed independently of the implementation.
		expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);

		expect(await collect(await storage.stream(key))).toEqual(Buffer.from(data));
	});

	it('reports the size of a stored object and null for an absent one', async () => {
		const key = newStorageKey();
		await storage.put(key, new Uint8Array([1, 2, 3]));

		expect(await storage.stat(key)).toEqual({ size: 3 });
		expect(await storage.stat(newStorageKey())).toBeNull();
	});

	it('deletes an object and tolerates deleting an absent one', async () => {
		const key = newStorageKey();
		await storage.put(key, new Uint8Array([1]));

		await storage.delete(key);
		expect(await storage.stat(key)).toBeNull();
		await expect(storage.delete(key)).resolves.toBeUndefined();
	});

	it('refuses a key that did not come from newStorageKey', async () => {
		// Traversal is impossible by construction rather than by sanitising:
		// the shape check runs before any path is joined.
		for (const key of ['../../etc/passwd', 'ab/cd/../../../etc/passwd', 'plain.pdf', '/abs/path']) {
			await expect(storage.stat(key)).rejects.toThrow(/storage key/i);
			await expect(storage.stream(key)).rejects.toThrow(/storage key/i);
			await expect(storage.put(key, new Uint8Array([1]))).rejects.toThrow(/storage key/i);
			await expect(storage.delete(key)).rejects.toThrow(/storage key/i);
		}
	});

	it('reports a missing object as a typed error rather than an ENOENT', async () => {
		await expect(storage.stream(newStorageKey())).rejects.toThrow(/not found/i);
	});
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit -- tests/unit/storage.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Define the port**

Create `src/lib/server/storage/index.ts`:

```ts
import { getConfig } from '../config';
import { createLocalStorage } from './local';

export interface StoredObject {
	key: string;
	size: number;
	/** Lowercase hex. Used as the download ETag and as tamper evidence. */
	sha256: string;
}

/**
 * The storage boundary (spec §6.4). Keys are opaque and generated; no method
 * accepts a caller-supplied filename, and no implementation may expose a
 * publicly reachable URL to an object (spec §6.5) — reads happen through the
 * audited download endpoint and nowhere else.
 */
export interface StorageAdapter {
	put(key: string, data: Uint8Array): Promise<StoredObject>;
	stream(key: string): Promise<ReadableStream<Uint8Array>>;
	stat(key: string): Promise<{ size: number } | null>;
	delete(key: string): Promise<void>;
}

export class StorageObjectNotFound extends Error {
	constructor(key: string) {
		super(`Stored object not found: ${key}`);
		this.name = 'StorageObjectNotFound';
	}
}

let cached: StorageAdapter | undefined;

/** Lazy, like getConfig() and getDb(): importing this must not require config. */
export function getStorage(): StorageAdapter {
	return (cached ??= createLocalStorage(getConfig().storageDir));
}

export { createLocalStorage, newStorageKey } from './local';
```

- [x] **Step 4: Implement it over the filesystem**

Create `src/lib/server/storage/local.ts`:

```ts
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { StorageObjectNotFound, type StorageAdapter, type StoredObject } from './index';

const KEY_PATTERN =
	/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Opaque and sharded two levels deep, so a directory never accumulates more
 * entries than a filesystem enjoys. Derived from a UUID rather than from the
 * uploaded filename: a key carries no information about its contents, and
 * nothing an operator or a visitor supplies ever reaches a path.
 */
export function newStorageKey(): string {
	const id = randomUUID();
	return `${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
}

function assertKey(key: string): void {
	if (!KEY_PATTERN.test(key)) {
		throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
	}
}

export function createLocalStorage(rootDir: string): StorageAdapter {
	const root = resolve(rootDir);
	const pathFor = (key: string) => join(root, key);

	return {
		async put(key: string, data: Uint8Array): Promise<StoredObject> {
			assertKey(key);
			const path = pathFor(key);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, data);

			return {
				key,
				size: data.byteLength,
				sha256: createHash('sha256').update(data).digest('hex')
			};
		},

		async stream(key: string): Promise<ReadableStream<Uint8Array>> {
			assertKey(key);
			if ((await this.stat(key)) === null) throw new StorageObjectNotFound(key);

			return Readable.toWeb(
				createReadStream(pathFor(key))
			) as unknown as ReadableStream<Uint8Array>;
		},

		async stat(key: string): Promise<{ size: number } | null> {
			assertKey(key);
			try {
				return { size: (await stat(pathFor(key))).size };
			} catch {
				return null;
			}
		},

		async delete(key: string): Promise<void> {
			assertKey(key);
			await rm(pathFor(key), { force: true });
		}
	};
}
```

- [x] **Step 5: Run the tests and watch them pass**

Run: `pnpm test:unit -- tests/unit/storage.test.ts`
Expected: PASS, 7 tests.

- [x] **Step 6: Commit**

```bash
pnpm lint && pnpm check && pnpm test:unit
git add -A
git commit -m "feat(storage): add the StorageAdapter port and a filesystem implementation

Spec section 6.4 makes storage one of the four boundaries where the
application touches the outside world, and 6.5 forbids any publicly reachable
URL to a stored object. Both are structural, so the port lands before the
first upload rather than being retrofitted around one.

Keys are generated from a UUID and sharded, never derived from an uploaded
filename, and every method shape-checks its key before joining a path. That
makes traversal impossible by construction rather than by sanitising, which is
what the tests assert."
```

---

### Task 5: Document schema and repository

The first content type, and the one every later one copies: an entity table, a `*_translations`
side table keyed `(entity_id, locale)`, and a repository that resolves the locale fallback and
reports whether it fell back.

Documents are also the only Phase 1 type with files, versions, and expiry, which is why the spec's
build order puts them first: everything harder shows up here.

**Files:**
- Create: `src/lib/server/db/schema/documents.ts`, `src/lib/server/content/documents.ts`, `drizzle/0005_documents.sql`
- Modify: `src/lib/server/db/schema/index.ts`
- Test: `tests/integration/documents.test.ts`

**Interfaces:**
- Consumes: `pickTranslation()` from `$lib/i18n/locale`, `newStorageKey()`, `Db`.
- Produces (later tasks import these exact names from `$lib/server/content/documents`):
  - `listPublicDocuments(db, { locale, defaultLocale }): Promise<PublicDocumentCategory[]>`
  - `listDocumentsForAdmin(db): Promise<AdminDocumentRow[]>`
  - `getDocumentForAdmin(db, id): Promise<AdminDocument | null>`
  - `createDocument(db, input): Promise<string>` / `updateDocument` / `deleteDocument`
  - `setDocumentTranslation(db, documentId, locale, { title, summary })`
  - `addDocumentFile(db, input): Promise<string>` / `deleteDocumentFile(db, fileId)`
  - `listCategories(db)` / `createCategory(db, input)` / `setCategoryTranslation` / `deleteCategory`
  - `DOCUMENT_TIERS`, `DOCUMENT_STATUSES` and the `DocumentTier` / `DocumentStatus` types

- [x] **Step 1: Write the failing repository tests**

Create `tests/integration/documents.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
	documentCategory,
	document as documentTable
} from '../../src/lib/server/db/schema';
import {
	addDocumentFile,
	createCategory,
	createDocument,
	getDocumentForAdmin,
	listPublicDocuments,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';

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

beforeEach(async () => {
	// Content tables, unlike audit_event, are ordinary state and may be cleared
	// between tests. Deleting the category cascades to its documents.
	await db.delete(documentTable);
	await db.delete(documentCategory);
});

async function seedPublishedDocument(overrides: { tier?: 'public' | 'request' } = {}) {
	const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
	await setCategoryTranslation(db, categoryId, 'de', { name: 'Rechtliches' });
	await setCategoryTranslation(db, categoryId, 'en', { name: 'Legal' });

	const documentId = await createDocument(db, {
		slug: 'avv',
		categoryId,
		tier: overrides.tier ?? 'public',
		position: 0
	});
	await setDocumentTranslation(db, documentId, 'de', {
		title: 'Auftragsverarbeitungsvertrag',
		summary: 'AVV nach Art. 28 DSGVO'
	});
	await updateDocument(db, documentId, { status: 'published' });

	return { categoryId, documentId };
}

describe('document repository', () => {
	it('lists a published public document under its category', async () => {
		await seedPublishedDocument();

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });

		expect(categories).toHaveLength(1);
		expect(categories[0]?.name).toBe('Rechtliches');
		expect(categories[0]?.documents[0]?.title).toBe('Auftragsverarbeitungsvertrag');
		expect(categories[0]?.documents[0]?.isTranslationFallback).toBe(false);
	});

	it('hides a draft document from the portal', async () => {
		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		await setCategoryTranslation(db, categoryId, 'de', { name: 'Rechtliches' });
		const documentId = await createDocument(db, { slug: 'draft', categoryId, position: 0 });
		await setDocumentTranslation(db, documentId, 'de', { title: 'Entwurf', summary: null });

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });

		expect(categories.flatMap((category) => category.documents)).toHaveLength(0);
	});

	it('hides a published document whose tier is not public', async () => {
		// The gate itself is Phase 2. The filter is here from the start so the
		// security regression test in Task 6 can be permanent rather than
		// waiting for the machinery it guards.
		await seedPublishedDocument({ tier: 'request' });

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });

		expect(categories.flatMap((category) => category.documents)).toHaveLength(0);
	});

	it('falls back to the default locale and says so', async () => {
		await seedPublishedDocument();

		const categories = await listPublicDocuments(db, { locale: 'en', defaultLocale: 'de' });
		const doc = categories[0]?.documents[0];

		expect(doc?.title).toBe('Auftragsverarbeitungsvertrag');
		expect(doc?.isTranslationFallback).toBe(true);
		expect(doc?.translationLocale).toBe('de');
	});

	it('omits an entity with no translation in any served locale', async () => {
		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		await setCategoryTranslation(db, categoryId, 'de', { name: 'Rechtliches' });
		const documentId = await createDocument(db, { slug: 'untitled', categoryId, position: 0 });
		await updateDocument(db, documentId, { status: 'published' });

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });

		expect(categories.flatMap((category) => category.documents)).toHaveLength(0);
	});

	it('attaches the current file for the requested locale', async () => {
		const { documentId } = await seedPublishedDocument();
		await addDocumentFile(db, {
			documentId,
			locale: 'de',
			storageKey: 'ab/cd/11111111-1111-4111-8111-111111111111',
			sha256: 'a'.repeat(64),
			sizeBytes: 1024,
			filename: 'avv-de.pdf',
			contentType: 'application/pdf',
			validFrom: new Date('2026-01-01T00:00:00Z'),
			validUntil: new Date('2027-01-01T00:00:00Z'),
			uploadedByStaffId: null
		});

		const categories = await listPublicDocuments(db, { locale: 'de', defaultLocale: 'de' });
		const doc = categories[0]?.documents[0];

		expect(doc?.file?.filename).toBe('avv-de.pdf');
		expect(doc?.file?.version).toBe(1);
		expect(doc?.isFileFallback).toBe(false);
	});

	it('falls back to the default locale file and says so', async () => {
		const { documentId } = await seedPublishedDocument();
		await addDocumentFile(db, {
			documentId,
			locale: 'de',
			storageKey: 'ab/cd/11111111-1111-4111-8111-111111111111',
			sha256: 'a'.repeat(64),
			sizeBytes: 1024,
			filename: 'avv-de.pdf',
			contentType: 'application/pdf',
			validFrom: null,
			validUntil: null,
			uploadedByStaffId: null
		});

		const categories = await listPublicDocuments(db, { locale: 'en', defaultLocale: 'de' });

		expect(categories[0]?.documents[0]?.isFileFallback).toBe(true);
	});

	it('supersedes the previous version, leaving exactly one current file per locale', async () => {
		const { documentId } = await seedPublishedDocument();
		const common = {
			documentId,
			locale: 'de' as const,
			sha256: 'a'.repeat(64),
			sizeBytes: 10,
			contentType: 'application/pdf',
			validFrom: null,
			validUntil: null,
			uploadedByStaffId: null
		};

		await addDocumentFile(db, {
			...common,
			storageKey: 'ab/cd/11111111-1111-4111-8111-111111111111',
			filename: 'v1.pdf'
		});
		await addDocumentFile(db, {
			...common,
			storageKey: 'ab/cd/22222222-2222-4222-8222-222222222222',
			filename: 'v2.pdf'
		});

		const admin = await getDocumentForAdmin(db, documentId);
		const current = admin?.files.filter((file) => file.isCurrent) ?? [];

		expect(current).toHaveLength(1);
		expect(current[0]?.filename).toBe('v2.pdf');
		expect(current[0]?.version).toBe(2);
		// Superseded versions are retained: spec section 9 records which file
		// version was actually retrieved, so the row must outlive the upload.
		expect(admin?.files).toHaveLength(2);
	});

	it('rejects a duplicate slug', async () => {
		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		await createDocument(db, { slug: 'avv', categoryId, position: 0 });

		await expect(createDocument(db, { slug: 'avv', categoryId, position: 1 })).rejects.toThrow();
	});
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `pnpm test:integration -- tests/integration/documents.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Write the schema**

First create `src/lib/content-types.ts`. The tier and status vocabularies are needed by admin
Svelte components as well as by the schema, and a component importing anything under
`$lib/server/` is a build error in SvelteKit — so they live outside the server tree from the start:

```ts
export const DOCUMENT_TIERS = ['public', 'request', 'nda'] as const;
export const DOCUMENT_STATUSES = ['draft', 'published', 'archived'] as const;
export type DocumentTier = (typeof DOCUMENT_TIERS)[number];
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
```

Then create `src/lib/server/db/schema/documents.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { DocumentStatus, DocumentTier } from '../../../content-types';
import { staffUser } from './staff';

// Re-exported so schema consumers need only one import; the values themselves
// live in src/lib/content-types.ts because components need them too.
export type { DocumentStatus, DocumentTier };

export const documentCategory = pgTable('document_category', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const documentCategoryTranslation = pgTable(
	'document_category_translation',
	{
		categoryId: uuid('category_id')
			.notNull()
			.references(() => documentCategory.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		name: text('name').notNull()
	},
	(table) => [primaryKey({ columns: [table.categoryId, table.locale] })]
);

export const document = pgTable(
	'document',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		slug: text('slug').notNull().unique(),
		categoryId: uuid('category_id')
			.notNull()
			.references(() => documentCategory.id, { onDelete: 'cascade' }),
		// The gate is Phase 2; the column is here from the start so the portal
		// filters on it from the first query and the security test guarding that
		// filter is permanent rather than retrofitted.
		tier: text('tier').notNull().default('public'),
		status: text('status').notNull().default('draft'),
		position: integer('position').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('document_category_idx').on(table.categoryId),
		check('document_tier_check', sql`${table.tier} IN ('public', 'request', 'nda')`),
		check('document_status_check', sql`${table.status} IN ('draft', 'published', 'archived')`)
	]
);

export const documentTranslation = pgTable(
	'document_translation',
	{
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		title: text('title').notNull(),
		summary: text('summary')
	},
	(table) => [primaryKey({ columns: [table.documentId, table.locale] })]
);

export const documentFile = pgTable(
	'document_file',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		version: integer('version').notNull(),
		storageKey: text('storage_key').notNull(),
		sha256: text('sha256').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		validFrom: timestamp('valid_from', { withTimezone: true }),
		validUntil: timestamp('valid_until', { withTimezone: true }),
		isCurrent: boolean('is_current').notNull().default(false),
		uploadedByStaffId: uuid('uploaded_by_staff_id').references(() => staffUser.id, {
			onDelete: 'set null'
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		uniqueIndex('document_file_version_idx').on(table.documentId, table.locale, table.version),
		// Exactly one current file per (document, locale), enforced by the
		// database rather than by the code that swaps them.
		uniqueIndex('document_file_current_idx')
			.on(table.documentId, table.locale)
			.where(sql`${table.isCurrent}`)
	]
);
```

Add `export * from './documents';` to `src/lib/server/db/schema/index.ts`.

- [x] **Step 4: Generate and apply the migration**

```bash
pnpm db:generate --name documents
pnpm db:migrate
```

Confirm the generated `drizzle/0005_documents.sql` contains the two check constraints and the
partial unique index (`WHERE "is_current"`). If drizzle-kit emitted the partial index without its
`WHERE` clause, add it by hand — the "one current file per locale" guarantee lives there.

- [x] **Step 5: Write the repository**

Note the import style: server modules use relative paths, not `$lib`, so the integration suite can
import them under plain Vitest without SvelteKit's aliases. This matches Phase 0 (`src/lib/server/
audit/index.ts`, `auth/session.ts`). `$lib` is for components and routes.

Create `src/lib/server/content/documents.ts`:

```ts
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DocumentStatus, DocumentTier } from '../../content-types';
import { pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import {
	document,
	documentCategory,
	documentCategoryTranslation,
	documentFile,
	documentTranslation
} from '../db/schema';

export type { DocumentStatus, DocumentTier } from '../../content-types';

export interface PublicDocumentFile {
	id: string;
	locale: string;
	version: number;
	filename: string;
	sizeBytes: number;
	sha256: string;
	validFrom: Date | null;
	validUntil: Date | null;
}

export interface PublicDocument {
	id: string;
	slug: string;
	title: string;
	summary: string | null;
	/** The locale the title and summary were actually taken from. */
	translationLocale: string;
	isTranslationFallback: boolean;
	file: PublicDocumentFile | null;
	isFileFallback: boolean;
}

export interface PublicDocumentCategory {
	id: string;
	slug: string;
	name: string;
	/** The locale the name was actually taken from — the portal labels fallbacks. */
	nameLocale: string;
	isNameFallback: boolean;
	documents: PublicDocument[];
}

function groupByKey<T, K extends string>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
	const map = new Map<K, T[]>();
	for (const row of rows) {
		const bucket = map.get(key(row));
		if (bucket) bucket.push(row);
		else map.set(key(row), [row]);
	}
	return map;
}

/**
 * The portal read model. Filters to published, public-tier documents in the
 * query rather than in the caller — the "gated documents never appear in
 * public HTML, JSON, or the sitemap" guarantee (spec §12) is only as good as
 * the narrowest place it is enforced.
 *
 * An entity with no translation in the requested locale and none in the
 * default locale is omitted rather than rendered untitled.
 */
export async function listPublicDocuments(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicDocumentCategory[]> {
	const rows = await db
		.select({
			categoryId: documentCategory.id,
			categorySlug: documentCategory.slug,
			documentId: document.id,
			documentSlug: document.slug
		})
		.from(document)
		.innerJoin(documentCategory, eq(document.categoryId, documentCategory.id))
		.where(and(eq(document.status, 'published'), eq(document.tier, 'public')))
		.orderBy(
			asc(documentCategory.position),
			asc(documentCategory.slug),
			asc(document.position),
			asc(document.slug)
		);

	if (rows.length === 0) return [];

	const documentIds = rows.map((row) => row.documentId);
	const categoryIds = [...new Set(rows.map((row) => row.categoryId))];

	const [categoryNames, titles, files] = await Promise.all([
		db
			.select()
			.from(documentCategoryTranslation)
			.where(inArray(documentCategoryTranslation.categoryId, categoryIds)),
		db.select().from(documentTranslation).where(inArray(documentTranslation.documentId, documentIds)),
		db
			.select()
			.from(documentFile)
			.where(and(inArray(documentFile.documentId, documentIds), eq(documentFile.isCurrent, true)))
	]);

	const namesByCategory = groupByKey(categoryNames, (row) => row.categoryId);
	const titlesByDocument = groupByKey(titles, (row) => row.documentId);
	const filesByDocument = groupByKey(files, (row) => row.documentId);

	const result: PublicDocumentCategory[] = [];

	for (const categoryId of categoryIds) {
		const pickedName = pickTranslation(
			(namesByCategory.get(categoryId) ?? []).map((row) => ({ locale: row.locale, value: row.name })),
			opts.locale,
			opts.defaultLocale
		);
		if (!pickedName) continue;

		const documents: PublicDocument[] = [];

		for (const row of rows.filter((candidate) => candidate.categoryId === categoryId)) {
			const pickedTitle = pickTranslation(
				(titlesByDocument.get(row.documentId) ?? []).map((translation) => ({
					locale: translation.locale,
					value: translation
				})),
				opts.locale,
				opts.defaultLocale
			);
			if (!pickedTitle) continue;

			const pickedFile = pickTranslation(
				(filesByDocument.get(row.documentId) ?? []).map((file) => ({
					locale: file.locale,
					value: file
				})),
				opts.locale,
				opts.defaultLocale
			);

			documents.push({
				id: row.documentId,
				slug: row.documentSlug,
				title: pickedTitle.value.title,
				summary: pickedTitle.value.summary,
				translationLocale: pickedTitle.locale,
				isTranslationFallback: pickedTitle.isFallback,
				file: pickedFile
					? {
							id: pickedFile.value.id,
							locale: pickedFile.value.locale,
							version: pickedFile.value.version,
							filename: pickedFile.value.filename,
							sizeBytes: pickedFile.value.sizeBytes,
							sha256: pickedFile.value.sha256,
							validFrom: pickedFile.value.validFrom,
							validUntil: pickedFile.value.validUntil
						}
					: null,
				isFileFallback: pickedFile?.isFallback ?? false
			});
		}

		if (documents.length === 0) continue;

		const category = rows.find((row) => row.categoryId === categoryId);
		result.push({
			id: categoryId,
			slug: category?.categorySlug ?? '',
			name: pickedName.value,
			nameLocale: pickedName.locale,
			isNameFallback: pickedName.isFallback,
			documents
		});
	}

	return result;
}

/** One published, public-tier document by slug, or null. */
export async function getPublicDocument(
	db: Db,
	slug: string,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicDocument | null> {
	const categories = await listPublicDocuments(db, opts);
	return categories.flatMap((category) => category.documents).find((doc) => doc.slug === slug) ?? null;
}

export interface AdminDocumentRow {
	id: string;
	slug: string;
	categoryId: string;
	tier: DocumentTier;
	status: DocumentStatus;
	position: number;
	titles: Record<string, string>;
	updatedAt: Date;
}

export interface AdminDocumentFile {
	id: string;
	locale: string;
	version: number;
	filename: string;
	contentType: string;
	sizeBytes: number;
	sha256: string;
	storageKey: string;
	validFrom: Date | null;
	validUntil: Date | null;
	isCurrent: boolean;
	createdAt: Date;
}

export interface AdminDocument extends AdminDocumentRow {
	translations: { locale: string; title: string; summary: string | null }[];
	files: AdminDocumentFile[];
}

export async function listDocumentsForAdmin(db: Db): Promise<AdminDocumentRow[]> {
	const rows = await db.select().from(document).orderBy(asc(document.position), asc(document.slug));
	if (rows.length === 0) return [];

	const titles = await db
		.select()
		.from(documentTranslation)
		.where(
			inArray(
				documentTranslation.documentId,
				rows.map((row) => row.id)
			)
		);
	const byDocument = groupByKey(titles, (row) => row.documentId);

	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		categoryId: row.categoryId,
		tier: row.tier as DocumentTier,
		status: row.status as DocumentStatus,
		position: row.position,
		updatedAt: row.updatedAt,
		titles: Object.fromEntries(
			(byDocument.get(row.id) ?? []).map((translation) => [translation.locale, translation.title])
		)
	}));
}

export async function getDocumentForAdmin(db: Db, id: string): Promise<AdminDocument | null> {
	const [row] = await db.select().from(document).where(eq(document.id, id)).limit(1);
	if (!row) return null;

	const [translations, files] = await Promise.all([
		db.select().from(documentTranslation).where(eq(documentTranslation.documentId, id)),
		db
			.select()
			.from(documentFile)
			.where(eq(documentFile.documentId, id))
			.orderBy(asc(documentFile.locale), asc(documentFile.version))
	]);

	return {
		id: row.id,
		slug: row.slug,
		categoryId: row.categoryId,
		tier: row.tier as DocumentTier,
		status: row.status as DocumentStatus,
		position: row.position,
		updatedAt: row.updatedAt,
		titles: Object.fromEntries(translations.map((t) => [t.locale, t.title])),
		translations: translations.map((t) => ({
			locale: t.locale,
			title: t.title,
			summary: t.summary
		})),
		files
	};
}

export async function createDocument(
	db: Db,
	input: { slug: string; categoryId: string; tier?: DocumentTier; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(document)
		.values({
			slug: input.slug,
			categoryId: input.categoryId,
			tier: input.tier ?? 'public',
			position: input.position ?? 0
		})
		.returning({ id: document.id });

	if (!row) throw new Error('failed to insert document');
	return row.id;
}

export async function updateDocument(
	db: Db,
	id: string,
	input: Partial<{
		slug: string;
		categoryId: string;
		tier: DocumentTier;
		status: DocumentStatus;
		position: number;
	}>
): Promise<void> {
	await db
		.update(document)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(document.id, id));
}

export async function deleteDocument(db: Db, id: string): Promise<string[]> {
	// Returns the storage keys of the files that went with it, so the caller
	// can clean up the objects the cascade cannot reach.
	const files = await db
		.select({ storageKey: documentFile.storageKey })
		.from(documentFile)
		.where(eq(documentFile.documentId, id));

	await db.delete(document).where(eq(document.id, id));
	return files.map((file) => file.storageKey);
}

export async function setDocumentTranslation(
	db: Db,
	documentId: string,
	locale: string,
	values: { title: string; summary: string | null }
): Promise<void> {
	await db
		.insert(documentTranslation)
		.values({ documentId, locale, ...values })
		.onConflictDoUpdate({
			target: [documentTranslation.documentId, documentTranslation.locale],
			set: values
		});
}

export async function deleteDocumentTranslation(
	db: Db,
	documentId: string,
	locale: string
): Promise<void> {
	await db
		.delete(documentTranslation)
		.where(
			and(eq(documentTranslation.documentId, documentId), eq(documentTranslation.locale, locale))
		);
}

export interface NewDocumentFile {
	documentId: string;
	locale: string;
	storageKey: string;
	sha256: string;
	sizeBytes: number;
	filename: string;
	contentType: string;
	validFrom: Date | null;
	validUntil: Date | null;
	uploadedByStaffId: string | null;
}

/**
 * Adds the next version for a (document, locale) and makes it current.
 *
 * The order inside the transaction matters: the previous current row is
 * cleared *before* the new one is inserted, because the partial unique index
 * permits only one current file per (document, locale) at any instant. Two
 * concurrent uploads for the same pair race on the version unique index and
 * the loser is rejected — the right outcome for an operation a human performs.
 */
export async function addDocumentFile(db: Db, input: NewDocumentFile): Promise<string> {
	return db.transaction(async (tx) => {
		const [highest] = await tx
			.select({ version: sql<number>`coalesce(max(${documentFile.version}), 0)` })
			.from(documentFile)
			.where(and(eq(documentFile.documentId, input.documentId), eq(documentFile.locale, input.locale)));

		await tx
			.update(documentFile)
			.set({ isCurrent: false })
			.where(
				and(
					eq(documentFile.documentId, input.documentId),
					eq(documentFile.locale, input.locale),
					eq(documentFile.isCurrent, true)
				)
			);

		const [row] = await tx
			.insert(documentFile)
			.values({ ...input, version: Number(highest?.version ?? 0) + 1, isCurrent: true })
			.returning({ id: documentFile.id });

		if (!row) throw new Error('failed to insert document file');
		return row.id;
	});
}

/** Removes a file row and returns its storage key so the object can be deleted. */
export async function deleteDocumentFile(db: Db, fileId: string): Promise<string | null> {
	const [row] = await db
		.delete(documentFile)
		.where(eq(documentFile.id, fileId))
		.returning({ storageKey: documentFile.storageKey });

	return row?.storageKey ?? null;
}

export interface AdminCategory {
	id: string;
	slug: string;
	position: number;
	names: Record<string, string>;
}

export async function listCategories(db: Db): Promise<AdminCategory[]> {
	const rows = await db
		.select()
		.from(documentCategory)
		.orderBy(asc(documentCategory.position), asc(documentCategory.slug));
	if (rows.length === 0) return [];

	const names = await db.select().from(documentCategoryTranslation);
	const byCategory = groupByKey(names, (row) => row.categoryId);

	return rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		position: row.position,
		names: Object.fromEntries((byCategory.get(row.id) ?? []).map((n) => [n.locale, n.name]))
	}));
}

export async function createCategory(
	db: Db,
	input: { slug: string; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(documentCategory)
		.values({ slug: input.slug, position: input.position ?? 0 })
		.returning({ id: documentCategory.id });

	if (!row) throw new Error('failed to insert document category');
	return row.id;
}

export async function updateCategory(
	db: Db,
	id: string,
	input: Partial<{ slug: string; position: number }>
): Promise<void> {
	await db.update(documentCategory).set(input).where(eq(documentCategory.id, id));
}

export async function setCategoryTranslation(
	db: Db,
	categoryId: string,
	locale: string,
	values: { name: string }
): Promise<void> {
	await db
		.insert(documentCategoryTranslation)
		.values({ categoryId, locale, ...values })
		.onConflictDoUpdate({
			target: [documentCategoryTranslation.categoryId, documentCategoryTranslation.locale],
			set: values
		});
}

export async function deleteCategory(db: Db, id: string): Promise<void> {
	await db.delete(documentCategory).where(eq(documentCategory.id, id));
}
```

- [x] **Step 6: Run the tests and watch them pass**

Run: `pnpm test:integration -- tests/integration/documents.test.ts`
Expected: PASS, 9 tests.

- [x] **Step 7: Commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration
git add -A
git commit -m "feat(content): document schema and repository

The first content type, and the shape every later one copies: an entity table,
a translations side table keyed (entity_id, locale), and a repository that
resolves the locale fallback and reports whether it fell back — the portal has
to label fallback content, so a silent pick would be a defect.

Documents carry the parts no other Phase 1 type has: per-locale files, version
supersession, and validity dates. Exactly one current file per (document,
locale) is enforced by a partial unique index rather than by the code that
swaps them, and superseded rows are retained because spec section 9 records
which version was actually retrieved.

The tier column and the public-tier filter are here from the first query even
though gating is Phase 2, so the security regression test that gated documents
never appear in public output can be permanent rather than retrofitted."
```

---

### Task 6: The public documents page

**Files:**
- Create: `src/routes/(portal)/documents/+page.server.ts`, `src/routes/(portal)/documents/+page.svelte`, `src/lib/format.ts`
- Modify: `src/lib/portal/sections.ts`, `messages/de.json`, `messages/en.json`
- Test: `tests/e2e/security.spec.ts`, `tests/integration/documents.test.ts` (no change — the filter is already covered), `tests/unit/format.test.ts`

**Interfaces:**
- Consumes: `listPublicDocuments()`, `<Badge>`, `<FallbackNotice>`, `<SectionHeading>`.
- Produces: `formatBytes(bytes, locale)`, `formatDate(date, locale)`, `fileValidity(file, now)` in `$lib/format`; the `/documents` entry in `PORTAL_SECTIONS`.

- [x] **Step 1: Write the failing formatting tests**

`fileValidity` is the interesting part — it decides the badge — so it is a pure function with its
own tests rather than an expression inside markup.

Create `tests/unit/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fileValidity, formatBytes, formatDate } from '../../src/lib/format';

const now = new Date('2026-06-01T12:00:00Z');

describe('fileValidity', () => {
	it('is current when there are no dates at all', () => {
		expect(fileValidity({ validFrom: null, validUntil: null }, now)).toBe('current');
	});

	it('is current inside the validity window', () => {
		expect(
			fileValidity(
				{ validFrom: new Date('2026-01-01T00:00:00Z'), validUntil: new Date('2027-01-01T00:00:00Z') },
				now
			)
		).toBe('current');
	});

	it('is expiring within 60 days of validUntil', () => {
		expect(
			fileValidity({ validFrom: null, validUntil: new Date('2026-07-01T00:00:00Z') }, now)
		).toBe('expiring');
	});

	it('is expired after validUntil', () => {
		expect(
			fileValidity({ validFrom: null, validUntil: new Date('2026-05-31T00:00:00Z') }, now)
		).toBe('expired');
	});

	it('is not-yet-valid before validFrom', () => {
		expect(
			fileValidity({ validFrom: new Date('2026-09-01T00:00:00Z'), validUntil: null }, now)
		).toBe('not-yet-valid');
	});
});

describe('formatBytes', () => {
	it('formats with the locale’s decimal separator', () => {
		expect(formatBytes(1_500_000, 'de')).toMatch(/1,5\s?MB/);
		expect(formatBytes(1_500_000, 'en')).toMatch(/1\.5\s?MB/);
	});

	it('formats small files in kilobytes', () => {
		expect(formatBytes(2048, 'en')).toMatch(/2(\.0)?\s?kB/);
	});
});

describe('formatDate', () => {
	it('formats in the requested locale', () => {
		expect(formatDate(new Date('2026-03-09T00:00:00Z'), 'de')).toBe('09.03.2026');
	});
});
```

- [x] **Step 2: Run and watch it fail**

Run: `pnpm test:unit -- tests/unit/format.test.ts` → FAIL, module not found.

- [x] **Step 3: Implement the formatters**

Create `src/lib/format.ts`:

```ts
export type FileValidity = 'not-yet-valid' | 'current' | 'expiring' | 'expired';

/** Documents inside this window of their expiry are flagged, not hidden. */
const EXPIRING_SOON_DAYS = 60;

export function fileValidity(
	file: { validFrom: Date | null; validUntil: Date | null },
	now: Date = new Date()
): FileValidity {
	if (file.validFrom && file.validFrom.getTime() > now.getTime()) return 'not-yet-valid';
	if (!file.validUntil) return 'current';

	const remainingDays = (file.validUntil.getTime() - now.getTime()) / 86_400_000;
	if (remainingDays < 0) return 'expired';
	if (remainingDays <= EXPIRING_SOON_DAYS) return 'expiring';
	return 'current';
}

export function formatBytes(bytes: number, locale: string): string {
	// Intl handles the separators; the unit step is ours. Byte units are SI
	// here (kB, MB) rather than binary, matching what a file manager shows.
	const units = ['B', 'kB', 'MB', 'GB'] as const;
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}

	return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

export function formatDate(date: Date, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: 'UTC'
	}).format(date);
}
```

- [x] **Step 4: Run and watch it pass**

Run: `pnpm test:unit -- tests/unit/format.test.ts` → PASS.

- [x] **Step 5: Add the messages**

`messages/de.json`:

```json
	"nav_documents": "Dokumente",
	"documents_intro": "Alle öffentlich verfügbaren Nachweise, Verträge und Richtlinien.",
	"documents_empty": "Es wurden noch keine Dokumente veröffentlicht.",
	"documents_download": "Herunterladen",
	"documents_version": "Version {version}",
	"documents_valid_until": "Gültig bis {date}",
	"documents_status_current": "Aktuell",
	"documents_status_expiring": "Läuft bald ab",
	"documents_status_expired": "Abgelaufen",
	"documents_status_not_yet_valid": "Noch nicht gültig",
	"documents_no_file": "Keine Datei hinterlegt"
```

`messages/en.json`:

```json
	"nav_documents": "Documents",
	"documents_intro": "Every publicly available attestation, agreement, and policy.",
	"documents_empty": "No documents have been published yet.",
	"documents_download": "Download",
	"documents_version": "Version {version}",
	"documents_valid_until": "Valid until {date}",
	"documents_status_current": "Current",
	"documents_status_expiring": "Expiring soon",
	"documents_status_expired": "Expired",
	"documents_status_not_yet_valid": "Not yet valid",
	"documents_no_file": "No file attached"
```

- [x] **Step 6: Register the section**

In `src/lib/portal/sections.ts`, replace the empty array and drop the `void m;` line:

```ts
export const PORTAL_SECTIONS: PortalSection[] = [{ path: '/documents', label: () => m.nav_documents() }];
```

- [x] **Step 7: Write the page**

Create `src/routes/(portal)/documents/+page.server.ts`:

```ts
import { getConfig } from '$lib/server/config';
import { listPublicDocuments } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const { defaultLocale } = getConfig();
	const categories = await listPublicDocuments(getDb(), {
		locale: locals.locale,
		defaultLocale
	});

	// Locale lives in the path, so this response varies by nothing a cache
	// cannot see. Short and revalidatable rather than long: an operator
	// publishing a new AVV expects it visible in seconds.
	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });

	return { categories };
};
```

Create `src/routes/(portal)/documents/+page.svelte`:

```svelte
<script lang="ts">
	import Badge from '$lib/components/portal/Badge.svelte';
	import FallbackNotice from '$lib/components/portal/FallbackNotice.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import { fileValidity, formatBytes, formatDate, type FileValidity } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const TONE: Record<FileValidity, 'ok' | 'warn' | 'danger' | 'neutral'> = {
		current: 'ok',
		expiring: 'warn',
		expired: 'danger',
		'not-yet-valid': 'neutral'
	};

	const LABEL: Record<FileValidity, () => string> = {
		current: () => m.documents_status_current(),
		expiring: () => m.documents_status_expiring(),
		expired: () => m.documents_status_expired(),
		'not-yet-valid': () => m.documents_status_not_yet_valid()
	};
</script>

<SectionHeading title={m.nav_documents()} description={m.documents_intro()} />

{#if data.categories.length === 0}
	<p data-testid="documents-empty" class="text-neutral-600">{m.documents_empty()}</p>
{:else}
	{#each data.categories as category (category.id)}
		<section class="mb-10" data-testid="category-{category.slug}">
			<h2 class="mb-3 flex items-baseline gap-2 text-xl font-medium">
				{category.name}
				{#if category.isNameFallback}<FallbackNotice locale={category.nameLocale} />{/if}
			</h2>

			<ul class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
				{#each category.documents as doc (doc.id)}
					{@const validity = doc.file ? fileValidity(doc.file) : null}
					<li class="flex flex-wrap items-center gap-x-4 gap-y-2 p-4" data-testid="document-{doc.slug}">
						<div class="min-w-0 flex-1">
							<p class="font-medium">
								{doc.title}
								{#if doc.isTranslationFallback}
									<FallbackNotice locale={doc.translationLocale} />
								{/if}
							</p>
							{#if doc.summary}<p class="mt-1 text-sm text-neutral-600">{doc.summary}</p>{/if}
						</div>

						{#if doc.file && validity}
							<Badge tone={TONE[validity]}>{LABEL[validity]()}</Badge>
							<span class="text-sm text-neutral-500">
								{m.documents_version({ version: doc.file.version })} ·
								{formatBytes(doc.file.sizeBytes, data.locale)}
								{#if doc.file.validUntil}
									· {m.documents_valid_until({ date: formatDate(doc.file.validUntil, data.locale) })}
								{/if}
							</span>
							{#if doc.isFileFallback}<FallbackNotice locale={doc.file.locale} />{/if}
							<a
								data-testid="download-{doc.slug}"
								href="/api/documents/{doc.file.id}"
								class="rounded bg-[var(--tc-primary,#171717)] px-3 py-1.5 text-sm font-medium text-white"
							>
								{m.documents_download()}
							</a>
						{:else}
							<span class="text-sm text-neutral-400">{m.documents_no_file()}</span>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/each}
{/if}
```

Give each document `<li>` an `id={doc.slug}` as well: Task 9's evidence links point at these
anchors.

- [x] **Step 8: Write the permanent security test**

Create `tests/e2e/security.spec.ts`. This file grows through the phase; it holds the assertions
spec §12 calls out as the ones that would be specifically embarrassing to get wrong.

```ts
import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../../src/lib/server/db';
import { documentCategory, document } from '../../src/lib/server/db/schema';
import {
	createCategory,
	createDocument,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set — see .env.example');

let db: Db;
let closeDb: () => Promise<void>;

test.beforeAll(async () => {
	({ db, close: closeDb } = createDb(databaseUrl));

	const categoryId = await createCategory(db, { slug: 'security-fixture', position: 99 });
	await setCategoryTranslation(db, categoryId, 'de', { name: 'Sicherheits-Fixture' });
	await setCategoryTranslation(db, categoryId, 'en', { name: 'Security fixture' });

	for (const [slug, tier] of [
		['public-fixture', 'public'],
		['gated-fixture', 'request']
	] as const) {
		const id = await createDocument(db, { slug, categoryId, tier, position: 0 });
		await setDocumentTranslation(db, id, 'de', { title: `Fixture ${slug}`, summary: null });
		await setDocumentTranslation(db, id, 'en', { title: `Fixture ${slug}`, summary: null });
		await updateDocument(db, id, { status: 'published' });
	}
});

test.afterAll(async () => {
	await db.delete(document).where(eq(document.slug, 'public-fixture'));
	await db.delete(document).where(eq(document.slug, 'gated-fixture'));
	await db.delete(documentCategory).where(eq(documentCategory.slug, 'security-fixture'));
	await closeDb();
});

test('a gated document never appears in public HTML', async ({ page }) => {
	await page.goto('/de/documents');

	await expect(page.getByTestId('document-public-fixture')).toBeVisible();
	await expect(page.getByTestId('document-gated-fixture')).toHaveCount(0);
	expect(await page.content()).not.toContain('gated-fixture');
});
```

- [x] **Step 9: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(portal): publish the documents page

Documents grouped by category, each showing its current file for the visitor's
locale with size, version, validity window, and a validity badge. Expired
documents are flagged rather than hidden: a buyer needs to know a certificate
lapsed, and hiding it reads as concealment.

Fallback content carries a visible label wherever it appears — category name,
title, or the file itself — which spec section 7 makes a requirement rather
than a nicety for legal documents.

Adds tests/e2e/security.spec.ts with the first of the assertions spec section
12 calls permanent: a request-tier document never appears in public HTML. The
gate arrives in Phase 2; the test guarding it does not wait for it."
```

---

### Task 7: The audited download endpoint

Spec §6.5: files are never served from storage directly, no publicly reachable URL to a stored
object ever exists, and every download passes through one endpoint that resolves access, writes an
audit event, and streams. Watermarking joins this endpoint in Phase 2, when there is a recipient to
watermark for.

**Files:**
- Create: `src/routes/api/documents/[fileId]/+server.ts`
- Modify: `tests/e2e/security.spec.ts`
- Test: `tests/e2e/security.spec.ts`

**Interfaces:**
- Consumes: `getStorage()`, `recordEvent()`, the `documentFile`/`document` tables.
- Produces: `GET /api/documents/{fileId}` — the only path by which any stored object leaves the
  process.

- [x] **Step 1: Write the failing tests**

Append to `tests/e2e/security.spec.ts`:

```ts
test('serves a public document file and records exactly one audit event', async ({ request }) => {
	const [file] = await db
		.select({ id: documentFile.id, sha256: documentFile.sha256 })
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(eq(document.slug, 'public-fixture'));
	if (!file) throw new Error('fixture file missing — check beforeAll');

	const before = new Date(Date.now() - 2_000);
	const response = await request.get(`/api/documents/${file.id}`);

	expect(response.status()).toBe(200);
	expect(response.headers()['content-disposition']).toMatch(/attachment/);
	// Downloads are audited, so they must not be served from a cache.
	expect(response.headers()['cache-control']).toMatch(/no-store/);

	const events = await db
		.select({ action: auditEvent.action, subjectId: auditEvent.subjectId })
		.from(auditEvent)
		.where(and(gte(auditEvent.at, before), eq(auditEvent.action, 'document.downloaded')));

	expect(events.map((event) => event.subjectId)).toContain(file.id);
});

test('refuses to serve a gated document file', async ({ request }) => {
	const [file] = await db
		.select({ id: documentFile.id })
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(eq(document.slug, 'gated-fixture'));
	if (!file) throw new Error('fixture file missing — check beforeAll');

	const response = await request.get(`/api/documents/${file.id}`);
	expect(response.status()).toBe(404);
});

test('exposes no route that serves a storage key directly', async ({ request }) => {
	const [file] = await db
		.select({ storageKey: documentFile.storageKey })
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(eq(document.slug, 'public-fixture'));
	if (!file) throw new Error('fixture file missing — check beforeAll');

	for (const path of [
		`/${file.storageKey}`,
		`/storage/${file.storageKey}`,
		`/api/documents/${file.storageKey}`
	]) {
		expect((await request.get(path)).status()).toBeGreaterThanOrEqual(400);
	}
});
```

Extend the `beforeAll` fixture to attach a real file to `public-fixture` and to `gated-fixture`,
writing the bytes through the storage adapter so the endpoint has something to stream:

```ts
	const storage = createLocalStorage(process.env.STORAGE_DIR ?? './data/storage');

	for (const slug of ['public-fixture', 'gated-fixture']) {
		const [row] = await db.select({ id: document.id }).from(document).where(eq(document.slug, slug));
		if (!row) throw new Error(`fixture document ${slug} missing`);

		const key = newStorageKey();
		const stored = await storage.put(key, new TextEncoder().encode(`%PDF-1.7 ${slug}`));

		await addDocumentFile(db, {
			documentId: row.id,
			locale: 'de',
			storageKey: stored.key,
			sha256: stored.sha256,
			sizeBytes: stored.size,
			filename: `${slug}.pdf`,
			contentType: 'application/pdf',
			validFrom: null,
			validUntil: null,
			uploadedByStaffId: null
		});
	}
```

Add the imports these need: `addDocumentFile` and `documentFile`, `auditEvent`, `and`, `gte`,
`createLocalStorage`, `newStorageKey`.

- [x] **Step 2: Run and watch it fail**

Run: `pnpm test:e2e -- tests/e2e/security.spec.ts` → FAIL, the endpoint 404s everything.

- [x] **Step 3: Implement the endpoint**

Create `src/routes/api/documents/[fileId]/+server.ts`:

```ts
import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { recordEvent } from '$lib/server/audit';
import { getDb } from '$lib/server/db/instance';
import { document, documentFile } from '$lib/server/db/schema';
import { getStorage, StorageObjectNotFound } from '$lib/server/storage';
import type { RequestHandler } from './$types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The single mediated path out of storage (spec §6.5). Everything a caller can
 * influence is a file id; the storage key never appears in a URL, a response
 * header, or the HTML.
 *
 * Phase 2 inserts grant resolution and per-recipient watermarking between the
 * lookup and the stream. The tier check below is the Phase 1 stand-in and is
 * deliberately written as an allowlist of one, so adding a tier cannot widen
 * access by omission.
 */
export const GET: RequestHandler = async ({ params, getClientAddress, request }) => {
	// A malformed id must 404 like an unknown one rather than surfacing a
	// database type error — the two must be indistinguishable to a caller.
	if (!UUID.test(params.fileId)) error(404, 'Not found');

	const db = getDb();

	const [row] = await db
		.select({
			fileId: documentFile.id,
			documentId: documentFile.documentId,
			storageKey: documentFile.storageKey,
			filename: documentFile.filename,
			contentType: documentFile.contentType,
			sizeBytes: documentFile.sizeBytes,
			sha256: documentFile.sha256,
			locale: documentFile.locale,
			version: documentFile.version
		})
		.from(documentFile)
		.innerJoin(document, eq(documentFile.documentId, document.id))
		.where(
			and(
				eq(documentFile.id, params.fileId),
				eq(document.tier, 'public'),
				eq(document.status, 'published')
			)
		)
		.limit(1);

	if (!row) error(404, 'Not found');

	let body: ReadableStream<Uint8Array>;
	try {
		body = await getStorage().stream(row.storageKey);
	} catch (cause) {
		// A row without its object is an operator problem, not a visitor one.
		if (cause instanceof StorageObjectNotFound) error(404, 'Not found');
		throw cause;
	}

	// Written before the stream is returned so a download cannot complete
	// unrecorded. `meta` carries no personal data: spec §10 confines that to
	// ip, ua, and actor_id.
	await recordEvent(db, {
		action: 'document.downloaded',
		actor: { type: 'requester', id: null },
		subjectType: 'document_file',
		subjectId: row.fileId,
		ip: getClientAddress(),
		ua: request.headers.get('user-agent') ?? undefined,
		meta: {
			documentId: row.documentId,
			locale: row.locale,
			version: row.version,
			sha256: row.sha256
		}
	});

	return new Response(body, {
		headers: {
			'content-type': row.contentType,
			'content-length': String(row.sizeBytes),
			// `filename*` in RFC 5987 form so non-ASCII titles survive.
			'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
			// Every download is an audited occurrence, so no cache may satisfy
			// one on our behalf. This costs bandwidth and buys the audit trail
			// the product exists to provide.
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
```

- [x] **Step 4: Run and watch it pass**

Run: `pnpm test:e2e -- tests/e2e/security.spec.ts` → PASS.

- [x] **Step 5: Commit**

```bash
pnpm lint && pnpm check && pnpm test:e2e
git add -A
git commit -m "feat(delivery): stream document files through one audited endpoint

Spec section 6.5: no publicly reachable URL to a stored object exists, and
every download passes through one endpoint that resolves access, records an
audit event, and streams. Storage keys never appear in a URL, a header, or the
HTML — a caller can only ever name a file id.

The audit event is written before the body is returned, so a download cannot
complete unrecorded, and the response is no-store for the same reason: a cache
satisfying a download on our behalf would silently remove it from the trail.

The tier check is an allowlist of one, so adding a tier later cannot widen
access by omission. Phase 2 inserts grant resolution and per-recipient
watermarking between the lookup and the stream."
```

---

### Task 8: Admin CRUD for documents

The first real admin surface. It is written plainly and specifically here, on purpose — Task 11
extracts the primitives once controls give a second example to generalize from. Resist extracting
anything during this task.

**Files:**
- Create: `src/lib/admin/sections.ts`, `src/lib/server/upload.ts`, `src/routes/(admin)/admin/documents/+page.server.ts`, `+page.svelte`, `src/routes/(admin)/admin/documents/new/+page.server.ts`, `+page.svelte`, `src/routes/(admin)/admin/documents/[id]/+page.server.ts`, `+page.svelte`, `src/routes/(admin)/admin/documents/categories/+page.server.ts`, `+page.svelte`
- Modify: `src/routes/(admin)/admin/+layout.svelte`, `src/routes/(admin)/admin/+layout.server.ts`, `messages/*.json`
- Test: `tests/unit/upload.test.ts`, `tests/e2e/admin-documents.spec.ts`

**Interfaces:**
- Consumes: everything from Task 5's repository, `getStorage()`, `recordEvent()`.
- Produces:
  - `ADMIN_SECTIONS` in `$lib/admin/sections` — `{ path, label }[]`, one entry per content type
  - `readUpload(formData, field, opts): Promise<UploadedFile>` in `$lib/server/upload`
  - The admin routes above, and the audit actions `document.created`, `document.updated`,
    `document.published`, `document.archived`, `document.deleted`, `document_file.uploaded`,
    `document_file.deleted`, `document_category.created`, `document_category.updated`,
    `document_category.deleted`

- [x] **Step 1: Write the failing upload tests**

Create `tests/unit/upload.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readUpload } from '../../src/lib/server/upload';

function formWith(file: File): FormData {
	const data = new FormData();
	data.set('file', file);
	return data;
}

const opts = { maxBytes: 1024, allowedTypes: ['application/pdf'] };

describe('readUpload', () => {
	it('accepts an allowed type within the size limit', async () => {
		const file = new File([new Uint8Array(10)], 'avv.pdf', { type: 'application/pdf' });

		const upload = await readUpload(formWith(file), 'file', opts);

		expect(upload.filename).toBe('avv.pdf');
		expect(upload.contentType).toBe('application/pdf');
		expect(upload.bytes.byteLength).toBe(10);
	});

	it('rejects a file over the limit', async () => {
		const file = new File([new Uint8Array(2048)], 'big.pdf', { type: 'application/pdf' });

		await expect(readUpload(formWith(file), 'file', opts)).rejects.toThrow(/too large/i);
	});

	it('rejects a disallowed content type', async () => {
		const file = new File([new Uint8Array(10)], 'x.html', { type: 'text/html' });

		await expect(readUpload(formWith(file), 'file', opts)).rejects.toThrow(/type/i);
	});

	it('rejects an empty field', async () => {
		await expect(readUpload(new FormData(), 'file', opts)).rejects.toThrow(/no file/i);
	});

	it('strips any path from the reported filename', async () => {
		// The filename is display metadata and a Content-Disposition value; it
		// never reaches a filesystem path, but a browser-supplied "../" in it
		// has no business surviving either.
		const file = new File([new Uint8Array(4)], '../../etc/passwd.pdf', {
			type: 'application/pdf'
		});

		expect((await readUpload(formWith(file), 'file', opts)).filename).toBe('passwd.pdf');
	});
});
```

- [x] **Step 2: Run and watch it fail** — `pnpm test:unit -- tests/unit/upload.test.ts`

- [x] **Step 3: Implement the upload reader**

Create `src/lib/server/upload.ts`:

```ts
export interface UploadedFile {
	filename: string;
	contentType: string;
	bytes: Uint8Array;
}

export class UploadRejected extends Error {}

export interface UploadLimits {
	maxBytes: number;
	allowedTypes: readonly string[];
}

/**
 * Validates one multipart field into bytes. Type and size are checked before
 * anything is read into memory beyond what the platform already buffered, and
 * the filename is reduced to its basename — it is display metadata and a
 * Content-Disposition value, never a path.
 */
export async function readUpload(
	form: FormData,
	field: string,
	limits: UploadLimits
): Promise<UploadedFile> {
	const value = form.get(field);

	if (!(value instanceof File) || value.size === 0) {
		throw new UploadRejected('No file was uploaded.');
	}

	if (value.size > limits.maxBytes) {
		throw new UploadRejected(
			`File is too large: ${value.size} bytes, limit ${limits.maxBytes} bytes.`
		);
	}

	if (!limits.allowedTypes.includes(value.type)) {
		throw new UploadRejected(
			`Unsupported file type "${value.type}". Allowed: ${limits.allowedTypes.join(', ')}.`
		);
	}

	return {
		filename: value.name.split(/[\\/]/).pop() || 'file',
		contentType: value.type,
		bytes: new Uint8Array(await value.arrayBuffer())
	};
}
```

- [x] **Step 4: Run and watch it pass**

- [x] **Step 5: Add the admin nav registry and messages**

Create `src/lib/admin/sections.ts`:

```ts
import { m } from '$lib/paraglide/messages.js';

export interface AdminSection {
	path: string;
	label: () => string;
}

/** One entry per content type, in the order the admin nav shows them. */
export const ADMIN_SECTIONS: AdminSection[] = [
	{ path: '/admin/documents', label: () => m.nav_documents() }
];
```

Add to `messages/de.json`:

```json
	"admin_new": "Neu anlegen",
	"admin_save": "Speichern",
	"admin_delete": "Löschen",
	"admin_cancel": "Abbrechen",
	"admin_publish": "Veröffentlichen",
	"admin_archive": "Archivieren",
	"admin_search": "Suchen",
	"admin_no_entries": "Keine Einträge vorhanden.",
	"admin_not_translated": "Nicht übersetzt",
	"admin_slug": "Kurzname (URL)",
	"admin_category": "Kategorie",
	"admin_tier": "Zugriffsstufe",
	"admin_status": "Status",
	"admin_position": "Reihenfolge",
	"admin_title": "Titel",
	"admin_summary": "Kurzbeschreibung",
	"admin_name": "Name",
	"admin_file": "Datei",
	"admin_upload": "Hochladen",
	"admin_valid_from": "Gültig ab",
	"admin_valid_until": "Gültig bis",
	"admin_categories": "Kategorien",
	"admin_confirm_delete": "Wirklich löschen? Dies kann nicht rückgängig gemacht werden.",
	"admin_saved": "Gespeichert.",
	"admin_error_required": "Dieses Feld ist erforderlich.",
	"admin_error_slug": "Nur Kleinbuchstaben, Ziffern und Bindestriche."
```

Add the English equivalents to `messages/en.json`: "Create", "Save", "Delete", "Cancel",
"Publish", "Archive", "Search", "No entries yet.", "Not translated", "Slug (URL)", "Category",
"Access tier", "Status", "Order", "Title", "Summary", "Name", "File", "Upload", "Valid from",
"Valid until", "Categories", "Really delete? This cannot be undone.", "Saved.",
"This field is required.", "Lowercase letters, digits, and hyphens only."

- [x] **Step 6: Give the admin shell a nav**

In `src/routes/(admin)/admin/+layout.server.ts`, add the enabled locales so every admin form can
render one tab per locale:

```ts
import { getConfig } from '$lib/server/config';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.staff) redirect(303, '/');
	const { locales, defaultLocale } = getConfig();
	return { staff: locals.staff, locale: locals.locale, locales, defaultLocale };
};
```

In `src/routes/(admin)/admin/+layout.svelte`, add a nav between the header and `<main>`:

```svelte
	<nav class="border-b border-neutral-200 bg-white px-6" aria-label={m.nav_admin()}>
		<ul class="mx-auto flex max-w-5xl gap-4 py-2 text-sm">
			{#each ADMIN_SECTIONS as section (section.path)}
				<li>
					<a
						href={localizePath(section.path, data.locale)}
						data-testid="admin-nav-{section.path.split('/').pop()}"
						class="hover:underline">{section.label()}</a
					>
				</li>
			{/each}
		</ul>
	</nav>
```

Import `ADMIN_SECTIONS` and `localizePath`. Every admin link must go through `localizePath` — the
admin is locale-prefixed like everything else.

- [x] **Step 7: Write the failing admin e2e spec**

Create `tests/e2e/admin-documents.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test';

async function signInAsAdmin(page: Page) {
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill('admin');
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) await consent.click();

	await expect(page).toHaveURL(/\/admin$/);
}

// Unique per run so repeated local runs against the shared dev database do not
// collide on the slug unique constraint.
const suffix = Date.now().toString(36);

test('an admin can create a category, a document, and publish it', async ({ page }) => {
	await signInAsAdmin(page);

	await page.goto('/de/admin/documents/categories');
	await page.getByTestId('category-slug').fill(`cat-${suffix}`);
	await page.getByTestId('category-name-de').fill('Zertifikate');
	await page.getByTestId('category-name-en').fill('Certificates');
	await page.getByTestId('category-create').click();
	await expect(page.getByText('Zertifikate')).toBeVisible();

	await page.goto('/de/admin/documents/new');
	await page.getByTestId('document-slug').fill(`doc-${suffix}`);
	await page.getByTestId('document-category').selectOption({ label: 'Zertifikate' });
	await page.getByTestId('document-create').click();

	await expect(page).toHaveURL(/\/admin\/documents\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-title-de').fill('ISO 27001 Zertifikat');
	await page.getByTestId('translation-save-de').click();
	await expect(page.getByTestId('translation-title-de')).toHaveValue('ISO 27001 Zertifikat');

	await page.getByTestId('document-publish').click();
	await expect(page.getByTestId('document-status')).toHaveText('published');

	// Published, public tier, and translated — so it is now on the portal.
	await page.goto('/de/documents');
	await expect(page.getByTestId(`document-doc-${suffix}`)).toBeVisible();
});

test('a document with no translation in any served locale stays off the portal', async ({
	page
}) => {
	await signInAsAdmin(page);

	await page.goto('/de/admin/documents/new');
	await page.getByTestId('document-slug').fill(`untitled-${suffix}`);
	await page.getByTestId('document-category').selectOption({ index: 1 });
	await page.getByTestId('document-create').click();
	await page.getByTestId('document-publish').click();

	await page.goto('/de/documents');
	await expect(page.getByTestId(`document-untitled-${suffix}`)).toHaveCount(0);
});

test('rejects a slug that is not URL-safe', async ({ page }) => {
	await signInAsAdmin(page);

	await page.goto('/de/admin/documents/new');
	await page.getByTestId('document-slug').fill('Not A Slug');
	await page.getByTestId('document-category').selectOption({ index: 1 });
	await page.getByTestId('document-create').click();

	await expect(page.getByTestId('error-slug')).toBeVisible();
});
```

- [x] **Step 8: Run and watch it fail** — `pnpm test:e2e -- tests/e2e/admin-documents.spec.ts`

- [x] **Step 9: Build the categories route**

Create `src/routes/(admin)/admin/documents/categories/+page.server.ts`:

```ts
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	createCategory,
	deleteCategory,
	listCategories,
	setCategoryTranslation,
	updateCategory
} from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

const slug = z
	.string()
	.trim()
	.min(1)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug');

export const load: PageServerLoad = async () => ({ categories: await listCategories(getDb()) });

export const actions: Actions = {
	create: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = slug.safeParse(form.get('slug'));
		if (!parsed.success) return fail(400, { field: 'slug' });

		const db = getDb();
		const id = await createCategory(db, {
			slug: parsed.data,
			position: Number(form.get('position') ?? 0)
		});

		for (const locale of getConfig().locales) {
			const name = String(form.get(`name.${locale}`) ?? '').trim();
			if (name) await setCategoryTranslation(db, id, locale, { name });
		}

		await recordEvent(db, {
			action: 'document_category.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: getClientAddress(),
			meta: { slug: parsed.data }
		});

		return { saved: true };
	},

	update: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await updateCategory(db, id, { position: Number(form.get('position') ?? 0) });

		for (const locale of getConfig().locales) {
			const name = String(form.get(`name.${locale}`) ?? '').trim();
			if (name) await setCategoryTranslation(db, id, locale, { name });
		}

		await recordEvent(db, {
			action: 'document_category.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: getClientAddress()
		});

		return { saved: true };
	},

	remove: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await deleteCategory(db, id);
		await recordEvent(db, {
			action: 'document_category.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_category',
			subjectId: id,
			ip: getClientAddress()
		});

		return { saved: true };
	}
};
```

`locals.staff!` is safe in every admin action: `(admin)/admin/+layout.server.ts` redirects an
anonymous visitor before any action runs. Use the non-null assertion consistently rather than
inventing a per-action guard.

Create `src/routes/(admin)/admin/documents/categories/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_categories()}</h1>

<form method="POST" action="?/create" use:enhance class="mb-8 grid gap-3 rounded border bg-white p-4">
	<label class="grid gap-1 text-sm">
		{m.admin_slug()}
		<input data-testid="category-slug" name="slug" required class="rounded border px-2 py-1" />
	</label>

	{#each data.locales as locale (locale)}
		<label class="grid gap-1 text-sm">
			{m.admin_name()} ({locale})
			<input
				data-testid="category-name-{locale}"
				name="name.{locale}"
				class="rounded border px-2 py-1"
			/>
		</label>
	{/each}

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button data-testid="category-create" class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white">
		{m.admin_new()}
	</button>
</form>

<ul class="divide-y rounded border bg-white">
	{#each data.categories as category (category.id)}
		<li class="p-4">
			<form method="POST" action="?/update" use:enhance class="flex flex-wrap items-end gap-3">
				<input type="hidden" name="id" value={category.id} />
				<span class="font-mono text-sm text-neutral-500">{category.slug}</span>

				{#each data.locales as locale (locale)}
					<label class="grid gap-1 text-sm">
						{locale}
						<input
							name="name.{locale}"
							value={category.names[locale] ?? ''}
							placeholder={m.admin_not_translated()}
							class="rounded border px-2 py-1"
						/>
					</label>
				{/each}

				<button class="rounded border px-3 py-1.5 text-sm">{m.admin_save()}</button>
			</form>
		</li>
	{:else}
		<li class="p-4 text-neutral-500">{m.admin_no_entries()}</li>
	{/each}
</ul>
```

`data.locales` comes from the admin layout load — child pages inherit parent layout data in
SvelteKit, so no per-page load is needed for it.

- [x] **Step 10: Build the document list and create routes**

Create `src/routes/(admin)/admin/documents/+page.server.ts`:

```ts
import { listCategories, listDocumentsForAdmin } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const db = getDb();
	const [documents, categories] = await Promise.all([listDocumentsForAdmin(db), listCategories(db)]);
	return { documents, categories };
};
```

Create `src/routes/(admin)/admin/documents/+page.svelte`:

```svelte
<script lang="ts">
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let query = $state('');

	// Filtering client-side is right at this scale: a trust center has tens of
	// documents, not thousands, and the whole list is already in the payload.
	let visible = $derived(
		data.documents.filter((doc) => {
			const haystack = [doc.slug, ...Object.values(doc.titles)].join(' ').toLowerCase();
			return haystack.includes(query.trim().toLowerCase());
		})
	);

	const categoryName = (id: string) =>
		data.categories.find((category) => category.id === id)?.slug ?? '';
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{m.nav_documents()}</h1>
	<input
		data-testid="documents-search"
		bind:value={query}
		placeholder={m.admin_search()}
		class="ml-auto rounded border px-2 py-1 text-sm"
	/>
	<a
		href={localizePath('/admin/documents/categories', data.locale)}
		class="rounded border px-3 py-1.5 text-sm">{m.admin_categories()}</a
	>
	<a
		href={localizePath('/admin/documents/new', data.locale)}
		data-testid="documents-new"
		class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">{m.admin_new()}</a
	>
</div>

<table class="w-full rounded border bg-white text-sm">
	<thead class="border-b bg-neutral-50 text-left">
		<tr>
			<th class="p-3">{m.admin_title()}</th>
			<th class="p-3">{m.admin_category()}</th>
			<th class="p-3">{m.admin_tier()}</th>
			<th class="p-3">{m.admin_status()}</th>
		</tr>
	</thead>
	<tbody class="divide-y">
		{#each visible as doc (doc.id)}
			<tr data-testid="row-{doc.slug}">
				<td class="p-3">
					<a
						href={localizePath(`/admin/documents/${doc.id}`, data.locale)}
						class="font-medium underline underline-offset-4"
					>
						{doc.titles[data.locale] ?? doc.titles[data.defaultLocale] ?? doc.slug}
					</a>
					<span class="ml-2 font-mono text-xs text-neutral-400">{doc.slug}</span>
				</td>
				<td class="p-3">{categoryName(doc.categoryId)}</td>
				<td class="p-3">{doc.tier}</td>
				<td class="p-3">{doc.status}</td>
			</tr>
		{:else}
			<tr><td colspan="4" class="p-4 text-neutral-500">{m.admin_no_entries()}</td></tr>
		{/each}
	</tbody>
</table>
```

Create `src/routes/(admin)/admin/documents/new/+page.server.ts`:

```ts
import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { DOCUMENT_TIERS } from '$lib/content-types';
import { recordEvent } from '$lib/server/audit';
import { createDocument, listCategories } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import { localizePath } from '$lib/i18n/locale';
import type { Actions, PageServerLoad } from './$types';

const schema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	categoryId: z.string().uuid(),
	tier: z.enum(DOCUMENT_TIERS)
});

export const load: PageServerLoad = async () => ({ categories: await listCategories(getDb()) });

export const actions: Actions = {
	default: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = schema.safeParse({
			slug: form.get('slug'),
			categoryId: form.get('categoryId'),
			tier: form.get('tier') ?? 'public'
		});

		if (!parsed.success) {
			return fail(400, { field: parsed.error.issues[0]?.path[0] ?? 'slug' });
		}

		const db = getDb();
		const id = await createDocument(db, parsed.data);

		await recordEvent(db, {
			action: 'document.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: id,
			ip: getClientAddress(),
			meta: { slug: parsed.data.slug, tier: parsed.data.tier }
		});

		redirect(303, localizePath(`/admin/documents/${id}`, locals.locale));
	}
};
```

Create `src/routes/(admin)/admin/documents/new/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import { DOCUMENT_TIERS } from '$lib/content-types';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1 class="mb-6 text-2xl font-semibold">{m.admin_new()}</h1>

<form method="POST" use:enhance class="grid max-w-lg gap-4 rounded border bg-white p-4">
	<label class="grid gap-1 text-sm">
		{m.admin_slug()}
		<input data-testid="document-slug" name="slug" required class="rounded border px-2 py-1" />
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_category()}
		<select data-testid="document-category" name="categoryId" required class="rounded border px-2 py-1">
			{#each data.categories as category (category.id)}
				<option value={category.id}>{category.names[data.locale] ?? category.slug}</option>
			{/each}
		</select>
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_tier()}
		<select data-testid="document-tier" name="tier" class="rounded border px-2 py-1">
			{#each DOCUMENT_TIERS as tier (tier)}
				<option value={tier}>{tier}</option>
			{/each}
		</select>
	</label>

	{#if form?.field === 'slug'}
		<p data-testid="error-slug" class="text-sm text-red-700">{m.admin_error_slug()}</p>
	{/if}

	<button data-testid="document-create" class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white">
		{m.admin_new()}
	</button>
</form>
```

- [x] **Step 11: Build the document edit route**

Create `src/routes/(admin)/admin/documents/[id]/+page.server.ts`:

```ts
import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { DOCUMENT_STATUSES, DOCUMENT_TIERS } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	addDocumentFile,
	deleteDocument,
	deleteDocumentFile,
	getDocumentForAdmin,
	listCategories,
	setDocumentTranslation,
	updateDocument
} from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import { getStorage, newStorageKey } from '$lib/server/storage';
import { readUpload, UploadRejected } from '$lib/server/upload';
import type { Actions, PageServerLoad } from './$types';

const ALLOWED_UPLOAD_TYPES = ['application/pdf'] as const;

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const doc = await getDocumentForAdmin(db, params.id);
	if (!doc) error(404, 'Document not found');

	return { document: doc, categories: await listCategories(db) };
};

function optionalDate(value: FormDataEntryValue | null): Date | null {
	const text = String(value ?? '').trim();
	return text ? new Date(text) : null;
}

export const actions: Actions = {
	saveMeta: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z
			.object({
				slug: z
					.string()
					.trim()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				categoryId: z.string().uuid(),
				tier: z.enum(DOCUMENT_TIERS),
				position: z.coerce.number().int()
			})
			.safeParse({
				slug: form.get('slug'),
				categoryId: form.get('categoryId'),
				tier: form.get('tier'),
				position: form.get('position') ?? 0
			});

		if (!parsed.success) return fail(400, { field: parsed.error.issues[0]?.path[0] ?? 'slug' });

		const db = getDb();
		await updateDocument(db, params.id, parsed.data);
		await recordEvent(db, {
			action: 'document.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { ...parsed.data }
		});

		return { saved: true };
	},

	saveTranslation: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale'));
		if (!getConfig().locales.includes(locale)) return fail(400, { field: 'locale' });

		const title = String(form.get('title') ?? '').trim();
		if (!title) return fail(400, { field: 'title', locale });

		const summary = String(form.get('summary') ?? '').trim() || null;

		const db = getDb();
		await setDocumentTranslation(db, params.id, locale, { title, summary });
		await recordEvent(db, {
			action: 'document.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { translation: locale }
		});

		return { saved: true };
	},

	setStatus: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z.enum(DOCUMENT_STATUSES).safeParse(form.get('status'));
		if (!parsed.success) return fail(400, { field: 'status' });

		const db = getDb();
		await updateDocument(db, params.id, { status: parsed.data });

		// Publication and archival get their own audit actions rather than
		// hiding inside document.updated: they are the events an auditor asks
		// about, and "when did this become public" must be answerable without
		// reading a meta blob.
		await recordEvent(db, {
			action: parsed.data === 'published' ? 'document.published' : 'document.archived',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { status: parsed.data }
		});

		return { saved: true };
	},

	uploadFile: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale'));
		if (!getConfig().locales.includes(locale)) return fail(400, { field: 'locale' });

		let upload;
		try {
			upload = await readUpload(form, 'file', {
				maxBytes: getConfig().maxUploadBytes,
				allowedTypes: ALLOWED_UPLOAD_TYPES
			});
		} catch (cause) {
			if (cause instanceof UploadRejected) return fail(400, { field: 'file', message: cause.message });
			throw cause;
		}

		const stored = await getStorage().put(newStorageKey(), upload.bytes);
		const db = getDb();

		const fileId = await addDocumentFile(db, {
			documentId: params.id,
			locale,
			storageKey: stored.key,
			sha256: stored.sha256,
			sizeBytes: stored.size,
			filename: upload.filename,
			contentType: upload.contentType,
			validFrom: optionalDate(form.get('validFrom')),
			validUntil: optionalDate(form.get('validUntil')),
			uploadedByStaffId: locals.staff!.id
		});

		await recordEvent(db, {
			action: 'document_file.uploaded',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_file',
			subjectId: fileId,
			ip: getClientAddress(),
			meta: { documentId: params.id, locale, sha256: stored.sha256, filename: upload.filename }
		});

		return { saved: true };
	},

	deleteFile: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const fileId = String(form.get('fileId'));

		const db = getDb();
		const storageKey = await deleteDocumentFile(db, fileId);
		if (storageKey) await getStorage().delete(storageKey);

		await recordEvent(db, {
			action: 'document_file.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document_file',
			subjectId: fileId,
			ip: getClientAddress(),
			meta: { documentId: params.id }
		});

		return { saved: true };
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const db = getDb();
		const storageKeys = await deleteDocument(db, params.id);
		const storage = getStorage();
		for (const key of storageKeys) await storage.delete(key);

		await recordEvent(db, {
			action: 'document.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'document',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { files: storageKeys.length }
		});

		redirect(303, localizePath('/admin/documents', locals.locale));
	}
};
```

Create `src/routes/(admin)/admin/documents/[id]/+page.svelte`:

```svelte
<script lang="ts">
	import { enhance } from '$app/forms';
	import { DOCUMENT_TIERS } from '$lib/content-types';
	import { formatBytes, formatDate } from '$lib/format';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// One tab per enabled locale — the "not translated" state has to be visible,
	// not inferred from an empty field.
	let activeLocale = $state(data.locale);

	const translationFor = (locale: string) =>
		data.document.translations.find((translation) => translation.locale === locale) ?? null;

	const filesFor = (locale: string) =>
		data.document.files.filter((file) => file.locale === locale);
</script>

<div class="mb-6 flex flex-wrap items-center gap-3">
	<h1 class="text-2xl font-semibold">{data.document.slug}</h1>
	<span data-testid="document-status" class="rounded bg-neutral-100 px-2 py-0.5 text-sm"
		>{data.document.status}</span
	>

	<form method="POST" action="?/setStatus" use:enhance class="ml-auto flex gap-2">
		<input type="hidden" name="status" value="published" />
		<button data-testid="document-publish" class="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">
			{m.admin_publish()}
		</button>
	</form>

	<form method="POST" action="?/setStatus" use:enhance>
		<input type="hidden" name="status" value="archived" />
		<button data-testid="document-archive" class="rounded border px-3 py-1.5 text-sm">
			{m.admin_archive()}
		</button>
	</form>
</div>

<form method="POST" action="?/saveMeta" use:enhance class="mb-8 grid max-w-lg gap-3 rounded border bg-white p-4">
	<label class="grid gap-1 text-sm">
		{m.admin_slug()}
		<input name="slug" value={data.document.slug} class="rounded border px-2 py-1" />
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_category()}
		<select name="categoryId" class="rounded border px-2 py-1">
			{#each data.categories as category (category.id)}
				<option value={category.id} selected={category.id === data.document.categoryId}>
					{category.names[data.locale] ?? category.slug}
				</option>
			{/each}
		</select>
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_tier()}
		<select name="tier" class="rounded border px-2 py-1">
			{#each DOCUMENT_TIERS as tier (tier)}
				<option value={tier} selected={tier === data.document.tier}>{tier}</option>
			{/each}
		</select>
	</label>

	<label class="grid gap-1 text-sm">
		{m.admin_position()}
		<input name="position" type="number" value={data.document.position} class="rounded border px-2 py-1" />
	</label>

	<button class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white">{m.admin_save()}</button>
</form>

<div class="mb-3 flex gap-2 border-b">
	{#each data.locales as locale (locale)}
		<button
			type="button"
			data-testid="locale-tab-{locale}"
			onclick={() => (activeLocale = locale)}
			class="border-b-2 px-3 py-2 text-sm {activeLocale === locale
				? 'border-neutral-900 font-medium'
				: 'border-transparent text-neutral-500'}"
		>
			{locale}
			{#if !translationFor(locale)}
				<span class="ml-1 text-xs text-amber-700">•</span>
			{/if}
		</button>
	{/each}
</div>

{#each data.locales as locale (locale)}
	{#if locale === activeLocale}
		<form method="POST" action="?/saveTranslation" use:enhance class="mb-8 grid gap-3 rounded border bg-white p-4">
			<input type="hidden" name="locale" value={locale} />

			<label class="grid gap-1 text-sm">
				{m.admin_title()}
				<input
					data-testid="translation-title-{locale}"
					name="title"
					value={translationFor(locale)?.title ?? ''}
					class="rounded border px-2 py-1"
				/>
			</label>

			<label class="grid gap-1 text-sm">
				{m.admin_summary()}
				<textarea
					data-testid="translation-summary-{locale}"
					name="summary"
					rows="3"
					class="rounded border px-2 py-1">{translationFor(locale)?.summary ?? ''}</textarea
				>
			</label>

			{#if form?.field === 'title' && form?.locale === locale}
				<p class="text-sm text-red-700">{m.admin_error_required()}</p>
			{/if}

			<button data-testid="translation-save-{locale}" class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white">
				{m.admin_save()}
			</button>
		</form>

		<section class="rounded border bg-white p-4">
			<h2 class="mb-3 font-medium">{m.admin_file()} ({locale})</h2>

			<ul class="mb-4 divide-y text-sm">
				{#each filesFor(locale) as file (file.id)}
					<li class="flex flex-wrap items-center gap-3 py-2">
						<span class="font-mono">{file.filename}</span>
						<span class="text-neutral-500">v{file.version} · {formatBytes(file.sizeBytes, data.locale)}</span>
						{#if file.validUntil}
							<span class="text-neutral-500">{formatDate(file.validUntil, data.locale)}</span>
						{/if}
						{#if file.isCurrent}<span class="rounded bg-emerald-50 px-2 text-emerald-800">current</span>{/if}

						<form method="POST" action="?/deleteFile" use:enhance class="ml-auto">
							<input type="hidden" name="fileId" value={file.id} />
							<button class="text-red-700 underline">{m.admin_delete()}</button>
						</form>
					</li>
				{:else}
					<li class="py-2 text-neutral-500">{m.admin_no_entries()}</li>
				{/each}
			</ul>

			<form
				method="POST"
				action="?/uploadFile"
				enctype="multipart/form-data"
				use:enhance
				class="grid gap-3 sm:grid-cols-4 sm:items-end"
			>
				<input type="hidden" name="locale" value={locale} />

				<label class="grid gap-1 text-sm sm:col-span-2">
					{m.admin_file()}
					<input data-testid="file-input-{locale}" type="file" name="file" accept="application/pdf" required />
				</label>

				<label class="grid gap-1 text-sm">
					{m.admin_valid_from()}
					<input type="date" name="validFrom" class="rounded border px-2 py-1" />
				</label>

				<label class="grid gap-1 text-sm">
					{m.admin_valid_until()}
					<input type="date" name="validUntil" class="rounded border px-2 py-1" />
				</label>

				{#if form?.field === 'file'}
					<p class="text-sm text-red-700 sm:col-span-4">{form.message}</p>
				{/if}

				<button data-testid="file-upload-{locale}" class="justify-self-start rounded bg-neutral-900 px-3 py-1.5 text-white">
					{m.admin_upload()}
				</button>
			</form>
		</section>
	{/if}
{/each}

<form method="POST" action="?/remove" use:enhance class="mt-10">
	<button
		data-testid="document-delete"
		class="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700"
		onclick={(event) => {
			if (!confirm(m.admin_confirm_delete())) event.preventDefault();
		}}
	>
		{m.admin_delete()}
	</button>
</form>
```

- [x] **Step 12: Run the admin e2e spec and watch it pass**

Run: `pnpm test:e2e -- tests/e2e/admin-documents.spec.ts`
Expected: PASS. If the create redirect lands on `/admin/documents/<id>` without a locale prefix,
`localizePath` was missed in the `new` action — the root layout would then bounce it through a
redirect and the URL assertion fails.

- [x] **Step 13: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(admin): CRUD for documents, categories, translations, and files

The first real admin surface: a filterable list, a create form, and an edit
page with one tab per enabled locale that shows the not-translated state
explicitly rather than as an empty field. File upload allocates the next
version for its (document, locale) and supersedes the previous current file.

Publication and archival get their own audit actions rather than hiding inside
document.updated — 'when did this become public' is a question an auditor
asks, and it should not require reading a meta blob to answer.

Uploads are validated for type and size before anything is stored, and the
reported filename is reduced to its basename: it is display metadata and a
Content-Disposition value, never a path.

Written plainly and specifically on purpose. Task 11 extracts the primitives
once controls provide a second example to generalize from."
```

---

### Task 9: Controls — schema, repository, and the public catalog

The second content type. Build it in the same shape as documents rather than reaching for shared
code: Task 11 needs two independent examples to generalize from, and the differences between them
are what tell it where the seams are.

Controls have no files and no versions, but they do have `evidence_document_ids` (spec §8) — a
control pointing at the document that proves it. That is what makes a controls catalog credible
rather than a list of claims, so it is in scope.

**Files:**
- Create: `src/lib/server/db/schema/controls.ts`, `src/lib/server/content/controls.ts`, `src/routes/(portal)/controls/+page.server.ts`, `+page.svelte`
- Modify: `src/lib/content-types.ts`, `src/lib/server/db/schema/index.ts`, `src/lib/portal/sections.ts`, `messages/*.json`
- Test: `tests/integration/controls.test.ts`

**Interfaces:**
- Produces: `listPublicControlGroups(db, { locale, defaultLocale })`, `listControlsForAdmin(db)`,
  `getControlForAdmin(db, id)`, `createControl`, `updateControl`, `deleteControl`,
  `setControlTranslation`, `setControlEvidence(db, controlId, documentIds)`, plus
  `listControlGroups`, `createControlGroup`, `updateControlGroup`, `setControlGroupTranslation`,
  `deleteControlGroup`. `CONTROL_STATUSES` in `$lib/content-types`.

- [x] **Step 1: Write the failing repository tests**

Create `tests/integration/controls.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { controlGroup } from '../../src/lib/server/db/schema';
import {
	createControl,
	createControlGroup,
	getControlForAdmin,
	listPublicControlGroups,
	setControlEvidence,
	setControlGroupTranslation,
	setControlTranslation,
	updateControl
} from '../../src/lib/server/content/controls';
import {
	createCategory,
	createDocument,
	setCategoryTranslation,
	setDocumentTranslation,
	updateDocument
} from '../../src/lib/server/content/documents';
import { documentCategory } from '../../src/lib/server/db/schema';

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

beforeEach(async () => {
	await db.delete(controlGroup);
	await db.delete(documentCategory);
});

async function seedGroup() {
	const groupId = await createControlGroup(db, { slug: 'access', position: 0 });
	await setControlGroupTranslation(db, groupId, 'de', {
		name: 'Zugriffskontrolle',
		description: 'Wer worauf zugreifen darf.'
	});
	return groupId;
}

describe('control repository', () => {
	it('lists published controls under their group', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'mfa', groupId, status: 'implemented' });
		await setControlTranslation(db, controlId, 'de', {
			title: 'Mehr-Faktor-Authentifizierung',
			description: 'Für alle Mitarbeitendenkonten verpflichtend.'
		});
		await updateControl(db, controlId, { status: 'implemented', published: true });

		const groups = await listPublicControlGroups(db, { locale: 'de', defaultLocale: 'de' });

		expect(groups).toHaveLength(1);
		expect(groups[0]?.name).toBe('Zugriffskontrolle');
		expect(groups[0]?.controls[0]?.title).toBe('Mehr-Faktor-Authentifizierung');
		expect(groups[0]?.controls[0]?.status).toBe('implemented');
	});

	it('hides an unpublished control', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'draft', groupId, status: 'planned' });
		await setControlTranslation(db, controlId, 'de', { title: 'Entwurf', description: null });

		const groups = await listPublicControlGroups(db, { locale: 'de', defaultLocale: 'de' });
		expect(groups.flatMap((group) => group.controls)).toHaveLength(0);
	});

	it('falls back to the default locale and says so', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'mfa', groupId, status: 'implemented' });
		await setControlTranslation(db, controlId, 'de', { title: 'MFA', description: null });
		await updateControl(db, controlId, { published: true });

		const groups = await listPublicControlGroups(db, { locale: 'en', defaultLocale: 'de' });

		expect(groups[0]?.controls[0]?.isTranslationFallback).toBe(true);
	});

	it('links evidence documents and shows only the publicly visible ones', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'mfa', groupId, status: 'implemented' });
		await setControlTranslation(db, controlId, 'de', { title: 'MFA', description: null });
		await updateControl(db, controlId, { published: true });

		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		await setCategoryTranslation(db, categoryId, 'de', { name: 'Rechtliches' });

		const publicDoc = await createDocument(db, { slug: 'soa', categoryId, tier: 'public' });
		await setDocumentTranslation(db, publicDoc, 'de', { title: 'Erklärung zur Anwendbarkeit', summary: null });
		await updateDocument(db, publicDoc, { status: 'published' });

		const gatedDoc = await createDocument(db, { slug: 'pentest', categoryId, tier: 'request' });
		await setDocumentTranslation(db, gatedDoc, 'de', { title: 'Pentest-Bericht', summary: null });
		await updateDocument(db, gatedDoc, { status: 'published' });

		await setControlEvidence(db, controlId, [publicDoc, gatedDoc]);

		const groups = await listPublicControlGroups(db, { locale: 'de', defaultLocale: 'de' });
		const evidence = groups[0]?.controls[0]?.evidence ?? [];

		// A control may cite a gated document internally, but the portal must
		// not name one: it would leak both its existence and its title.
		expect(evidence.map((item) => item.slug)).toEqual(['soa']);
	});

	it('replaces the evidence set rather than appending to it', async () => {
		const groupId = await seedGroup();
		const controlId = await createControl(db, { slug: 'mfa', groupId, status: 'implemented' });
		const categoryId = await createCategory(db, { slug: 'legal', position: 0 });
		const first = await createDocument(db, { slug: 'one', categoryId });
		const second = await createDocument(db, { slug: 'two', categoryId });

		await setControlEvidence(db, controlId, [first]);
		await setControlEvidence(db, controlId, [second]);

		const admin = await getControlForAdmin(db, controlId);
		expect(admin?.evidenceDocumentIds).toEqual([second]);
	});
});
```

- [x] **Step 2: Run and watch it fail**

- [x] **Step 3: Write the schema**

Append to `src/lib/content-types.ts` (created in Task 5):

```ts
export const CONTROL_STATUSES = ['implemented', 'in_progress', 'planned', 'not_applicable'] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];
```

Create `src/lib/server/db/schema/controls.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import { document } from './documents';

export const controlGroup = pgTable('control_group', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const controlGroupTranslation = pgTable(
	'control_group_translation',
	{
		groupId: uuid('group_id')
			.notNull()
			.references(() => controlGroup.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		name: text('name').notNull(),
		description: text('description')
	},
	(table) => [primaryKey({ columns: [table.groupId, table.locale] })]
);

export const control = pgTable(
	'control',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		slug: text('slug').notNull().unique(),
		groupId: uuid('group_id')
			.notNull()
			.references(() => controlGroup.id, { onDelete: 'cascade' }),
		status: text('status').notNull().default('planned'),
		// Controls have no draft/archived lifecycle the way documents do — a
		// control is either on the portal or it is not — so a boolean says what
		// is true instead of a three-state enum with one unused state.
		published: boolean('published').notNull().default(false),
		position: integer('position').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('control_group_idx').on(table.groupId),
		check(
			'control_status_check',
			sql`${table.status} IN ('implemented', 'in_progress', 'planned', 'not_applicable')`
		)
	]
);

export const controlTranslation = pgTable(
	'control_translation',
	{
		controlId: uuid('control_id')
			.notNull()
			.references(() => control.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		title: text('title').notNull(),
		description: text('description')
	},
	(table) => [primaryKey({ columns: [table.controlId, table.locale] })]
);

/**
 * Spec §8's `evidence_document_ids`, as a join table rather than an array
 * column: a foreign key means a deleted document cannot leave a dangling
 * reference behind, which an array of ids cannot promise.
 */
export const controlEvidence = pgTable(
	'control_evidence',
	{
		controlId: uuid('control_id')
			.notNull()
			.references(() => control.id, { onDelete: 'cascade' }),
		documentId: uuid('document_id')
			.notNull()
			.references(() => document.id, { onDelete: 'cascade' })
	},
	(table) => [primaryKey({ columns: [table.controlId, table.documentId] })]
);
```

Add `export * from './controls';` to `src/lib/server/db/schema/index.ts`, then:

```bash
pnpm db:generate --name controls
pnpm db:migrate
```

- [x] **Step 4: Write the repository**

Create `src/lib/server/content/controls.ts`. It mirrors `documents.ts` — the same three-query
assemble, the same `pickTranslation` fallback reporting — with two differences: no files, and an
evidence join that is filtered to publicly visible documents.

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { ControlStatus } from '../../content-types';
import { pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import {
	control,
	controlEvidence,
	controlGroup,
	controlGroupTranslation,
	controlTranslation,
	document,
	documentTranslation
} from '../db/schema';

export interface PublicControlEvidence {
	id: string;
	slug: string;
	title: string;
}

export interface PublicControl {
	id: string;
	slug: string;
	status: ControlStatus;
	title: string;
	description: string | null;
	translationLocale: string;
	isTranslationFallback: boolean;
	evidence: PublicControlEvidence[];
}

export interface PublicControlGroup {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	nameLocale: string;
	isNameFallback: boolean;
	controls: PublicControl[];
}

export async function listPublicControlGroups(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicControlGroup[]> {
	const rows = await db
		.select({
			groupId: controlGroup.id,
			groupSlug: controlGroup.slug,
			controlId: control.id,
			controlSlug: control.slug,
			status: control.status
		})
		.from(control)
		.innerJoin(controlGroup, eq(control.groupId, controlGroup.id))
		.where(eq(control.published, true))
		.orderBy(
			asc(controlGroup.position),
			asc(controlGroup.slug),
			asc(control.position),
			asc(control.slug)
		);

	if (rows.length === 0) return [];

	const controlIds = rows.map((row) => row.controlId);
	const groupIds = [...new Set(rows.map((row) => row.groupId))];

	const [groupNames, titles, evidence] = await Promise.all([
		db
			.select()
			.from(controlGroupTranslation)
			.where(inArray(controlGroupTranslation.groupId, groupIds)),
		db.select().from(controlTranslation).where(inArray(controlTranslation.controlId, controlIds)),
		// Evidence is filtered to publicly visible documents here, in the query.
		// A control may cite a gated document internally; naming one on the
		// portal would leak both its existence and its title.
		db
			.select({
				controlId: controlEvidence.controlId,
				documentId: document.id,
				slug: document.slug,
				locale: documentTranslation.locale,
				title: documentTranslation.title
			})
			.from(controlEvidence)
			.innerJoin(document, eq(controlEvidence.documentId, document.id))
			.innerJoin(documentTranslation, eq(documentTranslation.documentId, document.id))
			.where(
				and(
					inArray(controlEvidence.controlId, controlIds),
					eq(document.tier, 'public'),
					eq(document.status, 'published')
				)
			)
	]);

	const result: PublicControlGroup[] = [];

	for (const groupId of groupIds) {
		const picked = pickTranslation(
			groupNames
				.filter((row) => row.groupId === groupId)
				.map((row) => ({ locale: row.locale, value: row })),
			opts.locale,
			opts.defaultLocale
		);
		if (!picked) continue;

		const controls: PublicControl[] = [];

		for (const row of rows.filter((candidate) => candidate.groupId === groupId)) {
			const pickedTitle = pickTranslation(
				titles
					.filter((translation) => translation.controlId === row.controlId)
					.map((translation) => ({ locale: translation.locale, value: translation })),
				opts.locale,
				opts.defaultLocale
			);
			if (!pickedTitle) continue;

			const seen = new Set<string>();
			const linked: PublicControlEvidence[] = [];

			for (const item of evidence.filter((candidate) => candidate.controlId === row.controlId)) {
				if (seen.has(item.documentId)) continue;
				const pickedDocTitle = pickTranslation(
					evidence
						.filter((candidate) => candidate.documentId === item.documentId)
						.map((candidate) => ({ locale: candidate.locale, value: candidate.title })),
					opts.locale,
					opts.defaultLocale
				);
				if (!pickedDocTitle) continue;

				seen.add(item.documentId);
				linked.push({ id: item.documentId, slug: item.slug, title: pickedDocTitle.value });
			}

			controls.push({
				id: row.controlId,
				slug: row.controlSlug,
				status: row.status as ControlStatus,
				title: pickedTitle.value.title,
				description: pickedTitle.value.description,
				translationLocale: pickedTitle.locale,
				isTranslationFallback: pickedTitle.isFallback,
				evidence: linked
			});
		}

		if (controls.length === 0) continue;

		result.push({
			id: groupId,
			slug: rows.find((row) => row.groupId === groupId)?.groupSlug ?? '',
			name: picked.value.name,
			description: picked.value.description,
			nameLocale: picked.locale,
			isNameFallback: picked.isFallback,
			controls
		});
	}

	return result;
}

export interface AdminControl {
	id: string;
	slug: string;
	groupId: string;
	status: ControlStatus;
	published: boolean;
	position: number;
	translations: { locale: string; title: string; description: string | null }[];
	titles: Record<string, string>;
	evidenceDocumentIds: string[];
}

export async function listControlsForAdmin(db: Db): Promise<AdminControl[]> {
	const rows = await db.select().from(control).orderBy(asc(control.position), asc(control.slug));
	if (rows.length === 0) return [];

	const ids = rows.map((row) => row.id);
	const [translations, evidence] = await Promise.all([
		db.select().from(controlTranslation).where(inArray(controlTranslation.controlId, ids)),
		db.select().from(controlEvidence).where(inArray(controlEvidence.controlId, ids))
	]);

	return rows.map((row) => {
		const mine = translations.filter((translation) => translation.controlId === row.id);
		return {
			id: row.id,
			slug: row.slug,
			groupId: row.groupId,
			status: row.status as ControlStatus,
			published: row.published,
			position: row.position,
			translations: mine.map((t) => ({
				locale: t.locale,
				title: t.title,
				description: t.description
			})),
			titles: Object.fromEntries(mine.map((t) => [t.locale, t.title])),
			evidenceDocumentIds: evidence
				.filter((item) => item.controlId === row.id)
				.map((item) => item.documentId)
		};
	});
}

export async function getControlForAdmin(db: Db, id: string): Promise<AdminControl | null> {
	return (await listControlsForAdmin(db)).find((row) => row.id === id) ?? null;
}

export async function createControl(
	db: Db,
	input: { slug: string; groupId: string; status?: ControlStatus; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(control)
		.values({
			slug: input.slug,
			groupId: input.groupId,
			status: input.status ?? 'planned',
			position: input.position ?? 0
		})
		.returning({ id: control.id });

	if (!row) throw new Error('failed to insert control');
	return row.id;
}

export async function updateControl(
	db: Db,
	id: string,
	input: Partial<{
		slug: string;
		groupId: string;
		status: ControlStatus;
		published: boolean;
		position: number;
	}>
): Promise<void> {
	await db
		.update(control)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(control.id, id));
}

export async function deleteControl(db: Db, id: string): Promise<void> {
	await db.delete(control).where(eq(control.id, id));
}

export async function setControlTranslation(
	db: Db,
	controlId: string,
	locale: string,
	values: { title: string; description: string | null }
): Promise<void> {
	await db
		.insert(controlTranslation)
		.values({ controlId, locale, ...values })
		.onConflictDoUpdate({
			target: [controlTranslation.controlId, controlTranslation.locale],
			set: values
		});
}

/** Replaces the evidence set wholesale — the form submits the complete list. */
export async function setControlEvidence(
	db: Db,
	controlId: string,
	documentIds: readonly string[]
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.delete(controlEvidence).where(eq(controlEvidence.controlId, controlId));
		if (documentIds.length > 0) {
			await tx
				.insert(controlEvidence)
				.values(documentIds.map((documentId) => ({ controlId, documentId })));
		}
	});
}

export interface AdminControlGroup {
	id: string;
	slug: string;
	position: number;
	names: Record<string, string>;
	translations: { locale: string; name: string; description: string | null }[];
}

export async function listControlGroups(db: Db): Promise<AdminControlGroup[]> {
	const rows = await db
		.select()
		.from(controlGroup)
		.orderBy(asc(controlGroup.position), asc(controlGroup.slug));
	if (rows.length === 0) return [];

	const names = await db.select().from(controlGroupTranslation);

	return rows.map((row) => {
		const mine = names.filter((name) => name.groupId === row.id);
		return {
			id: row.id,
			slug: row.slug,
			position: row.position,
			names: Object.fromEntries(mine.map((name) => [name.locale, name.name])),
			translations: mine.map((name) => ({
				locale: name.locale,
				name: name.name,
				description: name.description
			}))
		};
	});
}

export async function createControlGroup(
	db: Db,
	input: { slug: string; position?: number }
): Promise<string> {
	const [row] = await db
		.insert(controlGroup)
		.values({ slug: input.slug, position: input.position ?? 0 })
		.returning({ id: controlGroup.id });

	if (!row) throw new Error('failed to insert control group');
	return row.id;
}

export async function updateControlGroup(
	db: Db,
	id: string,
	input: Partial<{ slug: string; position: number }>
): Promise<void> {
	await db.update(controlGroup).set(input).where(eq(controlGroup.id, id));
}

export async function setControlGroupTranslation(
	db: Db,
	groupId: string,
	locale: string,
	values: { name: string; description: string | null }
): Promise<void> {
	await db
		.insert(controlGroupTranslation)
		.values({ groupId, locale, ...values })
		.onConflictDoUpdate({
			target: [controlGroupTranslation.groupId, controlGroupTranslation.locale],
			set: values
		});
}

export async function deleteControlGroup(db: Db, id: string): Promise<void> {
	await db.delete(controlGroup).where(eq(controlGroup.id, id));
}
```

The test calls `setControlGroupTranslation(db, id, 'de', { name, description })` — pass
`description: null` where the test omits it, or make `description` optional in the signature. Pick
the explicit one: require it, and update the test's first `seedGroup` call to pass a description
(it already does).

- [x] **Step 5: Run and watch the repository tests pass**

- [x] **Step 6: Add the messages and publish the portal page**

`messages/de.json`: `"nav_controls": "Maßnahmen"`, `"controls_intro": "Technische und organisatorische Maßnahmen, nach Bereichen gegliedert."`, `"controls_empty": "Es wurden noch keine Maßnahmen veröffentlicht."`, `"controls_evidence": "Nachweis"`, `"control_status_implemented": "Umgesetzt"`, `"control_status_in_progress": "In Umsetzung"`, `"control_status_planned": "Geplant"`, `"control_status_not_applicable": "Nicht zutreffend"`.

`messages/en.json`: "Controls", "Technical and organisational measures, grouped by area.", "No controls have been published yet.", "Evidence", "Implemented", "In progress", "Planned", "Not applicable".

Append to `PORTAL_SECTIONS` in `src/lib/portal/sections.ts`:

```ts
	{ path: '/controls', label: () => m.nav_controls() }
```

Create `src/routes/(portal)/controls/+page.server.ts` — identical in shape to the documents one,
calling `listPublicControlGroups` and setting the same cache headers:

```ts
import { getConfig } from '$lib/server/config';
import { listPublicControlGroups } from '$lib/server/content/controls';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const groups = await listPublicControlGroups(getDb(), {
		locale: locals.locale,
		defaultLocale: getConfig().defaultLocale
	});

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });
	return { groups };
};
```

Create `src/routes/(portal)/controls/+page.svelte`:

```svelte
<script lang="ts">
	import Badge from '$lib/components/portal/Badge.svelte';
	import FallbackNotice from '$lib/components/portal/FallbackNotice.svelte';
	import SectionHeading from '$lib/components/portal/SectionHeading.svelte';
	import type { ControlStatus } from '$lib/content-types';
	import { localizePath } from '$lib/i18n/locale';
	import { m } from '$lib/paraglide/messages.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const TONE: Record<ControlStatus, 'ok' | 'warn' | 'neutral'> = {
		implemented: 'ok',
		in_progress: 'warn',
		planned: 'neutral',
		not_applicable: 'neutral'
	};

	const LABEL: Record<ControlStatus, () => string> = {
		implemented: () => m.control_status_implemented(),
		in_progress: () => m.control_status_in_progress(),
		planned: () => m.control_status_planned(),
		not_applicable: () => m.control_status_not_applicable()
	};
</script>

<SectionHeading title={m.nav_controls()} description={m.controls_intro()} />

{#if data.groups.length === 0}
	<p data-testid="controls-empty" class="text-neutral-600">{m.controls_empty()}</p>
{:else}
	{#each data.groups as group (group.id)}
		<section class="mb-10" data-testid="control-group-{group.slug}">
			<h2 class="mb-1 flex items-baseline gap-2 text-xl font-medium">
				{group.name}
				{#if group.isNameFallback}<FallbackNotice locale={group.nameLocale} />{/if}
			</h2>
			{#if group.description}<p class="mb-3 text-neutral-600">{group.description}</p>{/if}

			<ul class="divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white">
				{#each group.controls as item (item.id)}
					<li class="p-4" data-testid="control-{item.slug}">
						<div class="flex flex-wrap items-baseline gap-3">
							<span class="font-medium">{item.title}</span>
							<Badge tone={TONE[item.status]}>{LABEL[item.status]()}</Badge>
							{#if item.isTranslationFallback}
								<FallbackNotice locale={item.translationLocale} />
							{/if}
						</div>

						{#if item.description}
							<p class="mt-1 text-sm text-neutral-600">{item.description}</p>
						{/if}

						{#if item.evidence.length > 0}
							<p class="mt-2 text-sm">
								<span class="text-neutral-500">{m.controls_evidence()}:</span>
								{#each item.evidence as evidence, index (evidence.id)}
									{#if index > 0}<span>, </span>{/if}
									<a
										href="{localizePath('/documents', data.locale)}#{evidence.slug}"
										class="underline underline-offset-4">{evidence.title}</a
									>
								{/each}
							</p>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/each}
{/if}
```

The evidence links point at anchors on the documents page, so give each document `<li>` there an
`id={doc.slug}` in `src/routes/(portal)/documents/+page.svelte`.

- [x] **Step 7: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(content): controls catalog, grouped, with evidence links

The second content type, deliberately built in the same shape as documents
rather than sharing code with it — Task 11 needs two independent examples to
generalize from, and the differences are what show where the seams are.

Controls carry spec section 8's evidence_document_ids as a join table rather
than an array column, so a deleted document cannot leave a dangling reference.
The portal's evidence list is filtered to published public-tier documents in
the query: a control may cite a gated document internally, but naming one on
the portal would leak its existence and its title.

Published is a boolean rather than documents' three-state status, because a
control is either on the portal or it is not; a status enum with one unused
state would be documenting a lifecycle that does not exist."
```

---

### Task 10: Admin CRUD for controls

The second admin surface. Its Svelte markup starts as a copy of the documents admin, on purpose:
the pair of near-identical files is the raw material Task 11 extracts from, and copying them makes
the duplication visible rather than hiding it behind a premature abstraction.

**Files:**
- Create: `src/routes/(admin)/admin/controls/+page.server.ts`, `+page.svelte`, `new/+page.server.ts`, `new/+page.svelte`, `[id]/+page.server.ts`, `[id]/+page.svelte`, `groups/+page.server.ts`, `groups/+page.svelte`
- Modify: `src/lib/admin/sections.ts`, `messages/*.json`
- Test: `tests/e2e/admin-content.spec.ts`

- [x] **Step 1: Write the failing e2e test**

Create `tests/e2e/admin-content.spec.ts`. This file accumulates one test per content type through
Tasks 10 and 12–15; each proves the same round trip — create in the admin, translate, publish, see
it on the portal.

```ts
import { expect, test, type Page } from '@playwright/test';

export async function signInAsAdmin(page: Page) {
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill('admin');
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) await consent.click();

	await expect(page).toHaveURL(/\/admin$/);
}

const suffix = Date.now().toString(36);

test('an admin can publish a control and see it on the portal', async ({ page }) => {
	await signInAsAdmin(page);

	await page.goto('/de/admin/controls/groups');
	await page.getByTestId('group-slug').fill(`grp-${suffix}`);
	await page.getByTestId('group-name-de').fill('Zugriffskontrolle');
	await page.getByTestId('group-create').click();
	await expect(page.getByDisplayValue('Zugriffskontrolle')).toBeVisible();

	await page.goto('/de/admin/controls/new');
	await page.getByTestId('control-slug').fill(`ctl-${suffix}`);
	await page.getByTestId('control-group').selectOption({ label: 'Zugriffskontrolle' });
	await page.getByTestId('control-create').click();
	await expect(page).toHaveURL(/\/admin\/controls\/[0-9a-f-]{36}$/);

	await page.getByTestId('translation-title-de').fill('Mehr-Faktor-Authentifizierung');
	await page.getByTestId('translation-save-de').click();

	await page.getByTestId('control-status').selectOption('implemented');
	await page.getByTestId('control-published').check();
	await page.getByTestId('control-save-meta').click();

	await page.goto('/de/controls');
	await expect(page.getByTestId(`control-ctl-${suffix}`)).toBeVisible();
	await expect(page.getByTestId(`control-ctl-${suffix}`)).toContainText('Umgesetzt');
});
```

- [x] **Step 2: Run and watch it fail**

- [x] **Step 3: Write the server routes**

`src/routes/(admin)/admin/controls/+page.server.ts`:

```ts
import { listControlGroups, listControlsForAdmin } from '$lib/server/content/controls';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const db = getDb();
	const [controls, groups] = await Promise.all([listControlsForAdmin(db), listControlGroups(db)]);
	return { controls, groups };
};
```

`src/routes/(admin)/admin/controls/new/+page.server.ts`:

```ts
import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { CONTROL_STATUSES } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { createControl, listControlGroups } from '$lib/server/content/controls';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

const schema = z.object({
	slug: z
		.string()
		.trim()
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	groupId: z.string().uuid(),
	status: z.enum(CONTROL_STATUSES)
});

export const load: PageServerLoad = async () => ({ groups: await listControlGroups(getDb()) });

export const actions: Actions = {
	default: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = schema.safeParse({
			slug: form.get('slug'),
			groupId: form.get('groupId'),
			status: form.get('status') ?? 'planned'
		});
		if (!parsed.success) return fail(400, { field: parsed.error.issues[0]?.path[0] ?? 'slug' });

		const db = getDb();
		const id = await createControl(db, parsed.data);

		await recordEvent(db, {
			action: 'control.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control',
			subjectId: id,
			ip: getClientAddress(),
			meta: { slug: parsed.data.slug }
		});

		redirect(303, localizePath(`/admin/controls/${id}`, locals.locale));
	}
};
```

`src/routes/(admin)/admin/controls/[id]/+page.server.ts`:

```ts
import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { CONTROL_STATUSES } from '$lib/content-types';
import { localizePath } from '$lib/i18n/locale';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	deleteControl,
	getControlForAdmin,
	listControlGroups,
	setControlEvidence,
	setControlTranslation,
	updateControl
} from '$lib/server/content/controls';
import { listDocumentsForAdmin } from '$lib/server/content/documents';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const db = getDb();
	const item = await getControlForAdmin(db, params.id);
	if (!item) error(404, 'Control not found');

	const [groups, documents] = await Promise.all([listControlGroups(db), listDocumentsForAdmin(db)]);
	return { control: item, groups, documents };
};

export const actions: Actions = {
	saveMeta: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = z
			.object({
				slug: z
					.string()
					.trim()
					.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				groupId: z.string().uuid(),
				status: z.enum(CONTROL_STATUSES),
				position: z.coerce.number().int()
			})
			.safeParse({
				slug: form.get('slug'),
				groupId: form.get('groupId'),
				status: form.get('status'),
				position: form.get('position') ?? 0
			});
		if (!parsed.success) return fail(400, { field: parsed.error.issues[0]?.path[0] ?? 'slug' });

		const published = form.get('published') === 'on';
		const db = getDb();

		await updateControl(db, params.id, { ...parsed.data, published });
		// Evidence is submitted as the complete set every time, so an empty
		// selection clears it — `getAll` returns [] and setControlEvidence
		// deletes the rows.
		await setControlEvidence(db, params.id, form.getAll('evidence').map(String));

		await recordEvent(db, {
			action: published ? 'control.published' : 'control.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { ...parsed.data, published }
		});

		return { saved: true };
	},

	saveTranslation: async ({ request, params, locals, getClientAddress }) => {
		const form = await request.formData();
		const locale = String(form.get('locale'));
		if (!getConfig().locales.includes(locale)) return fail(400, { field: 'locale' });

		const title = String(form.get('title') ?? '').trim();
		if (!title) return fail(400, { field: 'title', locale });

		const db = getDb();
		await setControlTranslation(db, params.id, locale, {
			title,
			description: String(form.get('description') ?? '').trim() || null
		});

		await recordEvent(db, {
			action: 'control.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control',
			subjectId: params.id,
			ip: getClientAddress(),
			meta: { translation: locale }
		});

		return { saved: true };
	},

	remove: async ({ params, locals, getClientAddress }) => {
		const db = getDb();
		await deleteControl(db, params.id);
		await recordEvent(db, {
			action: 'control.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control',
			subjectId: params.id,
			ip: getClientAddress()
		});

		redirect(303, localizePath('/admin/controls', locals.locale));
	}
};
```

`src/routes/(admin)/admin/controls/groups/+page.server.ts` is the categories route from Task 8 with
`createControlGroup` / `updateControlGroup` / `setControlGroupTranslation` / `deleteControlGroup`
substituted, the audit actions renamed to `control_group.*`, and a `description.<locale>` field
carried alongside `name.<locale>`:

```ts
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import {
	createControlGroup,
	deleteControlGroup,
	listControlGroups,
	setControlGroupTranslation,
	updateControlGroup
} from '$lib/server/content/controls';
import { getDb } from '$lib/server/db/instance';
import type { Actions, PageServerLoad } from './$types';

const slug = z
	.string()
	.trim()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const load: PageServerLoad = async () => ({ groups: await listControlGroups(getDb()) });

async function saveTranslations(db: ReturnType<typeof getDb>, groupId: string, form: FormData) {
	for (const locale of getConfig().locales) {
		const name = String(form.get(`name.${locale}`) ?? '').trim();
		if (!name) continue;
		await setControlGroupTranslation(db, groupId, locale, {
			name,
			description: String(form.get(`description.${locale}`) ?? '').trim() || null
		});
	}
}

export const actions: Actions = {
	create: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const parsed = slug.safeParse(form.get('slug'));
		if (!parsed.success) return fail(400, { field: 'slug' });

		const db = getDb();
		const id = await createControlGroup(db, {
			slug: parsed.data,
			position: Number(form.get('position') ?? 0)
		});
		await saveTranslations(db, id, form);

		await recordEvent(db, {
			action: 'control_group.created',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
			subjectId: id,
			ip: getClientAddress(),
			meta: { slug: parsed.data }
		});

		return { saved: true };
	},

	update: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await updateControlGroup(db, id, { position: Number(form.get('position') ?? 0) });
		await saveTranslations(db, id, form);

		await recordEvent(db, {
			action: 'control_group.updated',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
			subjectId: id,
			ip: getClientAddress()
		});

		return { saved: true };
	},

	remove: async ({ request, locals, getClientAddress }) => {
		const form = await request.formData();
		const id = String(form.get('id'));
		const db = getDb();

		await deleteControlGroup(db, id);
		await recordEvent(db, {
			action: 'control_group.deleted',
			actor: { type: 'staff', id: locals.staff!.id },
			subjectType: 'control_group',
			subjectId: id,
			ip: getClientAddress()
		});

		return { saved: true };
	}
};
```

- [x] **Step 4: Write the Svelte pages by copying and transforming the documents admin**

Copy each documents admin page to its controls counterpart and apply the listed changes. Copying
is the point: Task 11 extracts from the resulting pair.

```bash
cp "src/routes/(admin)/admin/documents/+page.svelte"           "src/routes/(admin)/admin/controls/+page.svelte"
cp "src/routes/(admin)/admin/documents/new/+page.svelte"       "src/routes/(admin)/admin/controls/new/+page.svelte"
cp "src/routes/(admin)/admin/documents/[id]/+page.svelte"      "src/routes/(admin)/admin/controls/[id]/+page.svelte"
cp "src/routes/(admin)/admin/documents/categories/+page.svelte" "src/routes/(admin)/admin/controls/groups/+page.svelte"
```

In the **list** page: `data.documents` → `data.controls`, `data.categories` → `data.groups`,
`m.nav_documents()` → `m.nav_controls()`, the tier column → a published column rendering
`item.published ? '✓' : '—'`, the status column → `item.status`, links to
`/admin/controls/${item.id}`, `/admin/controls/groups`, `/admin/controls/new`, and the test ids
`documents-search`/`documents-new` → `controls-search`/`controls-new`.

In the **new** page: `document-slug` → `control-slug`, `document-category` → `control-group`
(bound to `name="groupId"`, iterating `data.groups`), the tier select → a status select over
`CONTROL_STATUSES` named `status` with test id `control-status`, `document-create` →
`control-create`.

In the **edit** page: drop the entire file-upload section and the publish/archive header forms;
`data.document` → `data.control`; the meta form gains
`<input type="checkbox" name="published" data-testid="control-published" checked={data.control.published} />`,
a status select with test id `control-status`, a submit button with test id `control-save-meta`,
and an evidence multi-select:

```svelte
	<label class="grid gap-1 text-sm">
		{m.admin_evidence()}
		<select name="evidence" multiple size="5" data-testid="control-evidence" class="rounded border px-2 py-1">
			{#each data.documents as doc (doc.id)}
				<option value={doc.id} selected={data.control.evidenceDocumentIds.includes(doc.id)}>
					{doc.titles[data.locale] ?? doc.slug}
				</option>
			{/each}
		</select>
	</label>
```

The translation form keeps its `translation-title-{locale}` and `translation-save-{locale}` test
ids and renames the summary field to `description`.

In the **groups** page: `category-*` test ids → `group-*`, `data.categories` → `data.groups`, and a
`description.{locale}` textarea beside each name input.

- [x] **Step 5: Register the section and add the messages**

`src/lib/admin/sections.ts` gains `{ path: '/admin/controls', label: () => m.nav_controls() }`.
Add `"admin_evidence"` to both catalogs: `"Nachweise"` / `"Evidence"`.

- [x] **Step 6: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(admin): CRUD for controls, groups, and evidence links

The second admin surface, written as a copy of the documents one so the
duplication is visible rather than hidden behind an abstraction invented from
a single example. Task 11 extracts from this pair.

Evidence is submitted as the complete set on every save, so clearing the
selection clears the links — an append-only multi-select would make removing a
citation impossible from the UI."
```

---

### Task 11: Extract the admin primitives from the pair

Two real content types now exist with near-identical admin surfaces. Extract what they actually
share and nothing more.

Extract: the filterable table, the locale tab strip, the labelled form field, and the translation
upsert helper. Do **not** extract: a generic CRUD framework, a schema-driven form generator, or a
configuration-object repository. Spec §6.6 wants "a schema plus a configuration object"; two
examples justify the four pieces below and no more, and Tasks 12–15 are the evidence for whether
further abstraction is warranted. Whatever they show goes to the Phase 2 carry-over.

The safety net for this task is that no test changes. If a test needs editing to accommodate the
refactor, the extraction changed behaviour and is wrong.

**Files:**
- Create: `src/lib/components/admin/DataTable.svelte`, `LocaleTabs.svelte`, `FormField.svelte`, `src/lib/server/content/translations.ts`
- Modify: all eight admin route pages from Tasks 8 and 10
- Test: unchanged — that is the point

- [x] **Step 1: Confirm the baseline is green**

Run: `pnpm test:unit && pnpm test:integration && pnpm test:e2e`
Expected: all green. Do not start the refactor from a red suite.

- [x] **Step 2: Write `DataTable.svelte`**

```svelte
<script lang="ts" generics="Row extends { id: string }">
	import { m } from '$lib/paraglide/messages.js';

	interface Column {
		key: string;
		header: string;
	}

	let {
		rows,
		columns,
		searchText,
		cell,
		testIdPrefix = 'row'
	}: {
		rows: readonly Row[];
		columns: readonly Column[];
		/** The searchable text for a row. Filtering is client-side: a trust
		 * center has tens of entries, and the whole list is already in the
		 * payload. */
		searchText: (row: Row) => string;
		cell: import('svelte').Snippet<[Row, string]>;
		testIdPrefix?: string;
	} = $props();

	let query = $state('');

	let visible = $derived(
		rows.filter((row) => searchText(row).toLowerCase().includes(query.trim().toLowerCase()))
	);
</script>

<input
	data-testid="{testIdPrefix}-search"
	bind:value={query}
	placeholder={m.admin_search()}
	class="mb-3 rounded border px-2 py-1 text-sm"
/>

<table class="w-full rounded border bg-white text-sm">
	<thead class="border-b bg-neutral-50 text-left">
		<tr>
			{#each columns as column (column.key)}<th class="p-3">{column.header}</th>{/each}
		</tr>
	</thead>
	<tbody class="divide-y">
		{#each visible as row (row.id)}
			<tr data-testid="{testIdPrefix}-{row.id}">
				{#each columns as column (column.key)}
					<td class="p-3">{@render cell(row, column.key)}</td>
				{/each}
			</tr>
		{:else}
			<tr><td colspan={columns.length} class="p-4 text-neutral-500">{m.admin_no_entries()}</td></tr>
		{/each}
	</tbody>
</table>
```

The `generics` attribute is why Task 3 added `vitePreprocess()`.

- [x] **Step 3: Write `LocaleTabs.svelte`**

```svelte
<script lang="ts">
	let {
		locales,
		active = $bindable(),
		translated,
		children
	}: {
		locales: readonly string[];
		active: string;
		/** Whether a locale has a translation — drives the visible
		 * "not translated" marker the spec's fallback rule requires. */
		translated: (locale: string) => boolean;
		children: import('svelte').Snippet<[string]>;
	} = $props();
</script>

<div class="mb-3 flex gap-2 border-b">
	{#each locales as locale (locale)}
		<button
			type="button"
			data-testid="locale-tab-{locale}"
			onclick={() => (active = locale)}
			class="border-b-2 px-3 py-2 text-sm {active === locale
				? 'border-neutral-900 font-medium'
				: 'border-transparent text-neutral-500'}"
		>
			{locale}
			{#if !translated(locale)}<span class="ml-1 text-xs text-amber-700">•</span>{/if}
		</button>
	{/each}
</div>

{#each locales as locale (locale)}
	{#if locale === active}{@render children(locale)}{/if}
{/each}
```

- [x] **Step 4: Write `FormField.svelte`**

```svelte
<script lang="ts">
	let {
		label,
		error = null,
		children
	}: {
		label: string;
		error?: string | null;
		children: import('svelte').Snippet;
	} = $props();
</script>

<label class="grid gap-1 text-sm">
	<span>{label}</span>
	{@render children()}
	{#if error}<span class="text-sm text-red-700">{error}</span>{/if}
</label>
```

- [x] **Step 5: Write the translation upsert helper**

Create `src/lib/server/content/translations.ts`. This is the one server-side duplication worth
removing: every content type loops the enabled locales and upserts a row.

```ts
import { getConfig } from '../config';

/**
 * Reads `field.<locale>` values out of a form and hands each non-empty locale
 * to `save`. Deliberately not generic over Drizzle tables: an upsert typed
 * over an arbitrary translations table costs more in type gymnastics than the
 * four lines it would save per call site.
 */
export async function saveTranslationsFromForm<T>(
	form: FormData,
	read: (form: FormData, locale: string) => T | null,
	save: (locale: string, values: T) => Promise<void>
): Promise<void> {
	for (const locale of getConfig().locales) {
		const values = read(form, locale);
		if (values !== null) await save(locale, values);
	}
}
```

- [x] **Step 6: Refactor the eight admin pages onto the primitives**

Replace the hand-rolled table in both list pages with `<DataTable>`, the hand-rolled tab strip in
both edit pages with `<LocaleTabs bind:active={activeLocale}>`, and every `<label class="grid…">`
wrapper with `<FormField>`. Replace the per-locale loops in the two group/category routes with
`saveTranslationsFromForm`.

- [x] **Step 7: Prove the refactor changed nothing**

Run: `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e`
Expected: all green, **with no test file modified**. Run `git status` and confirm nothing under
`tests/` appears. If a test needed changing, revert and redo the extraction — the primitives must
preserve the DOM contract the tests assert, including every `data-testid`.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(admin): extract the primitives from documents and controls

Two real content types now exist with near-identical admin surfaces, so the
shared shape can be extracted from evidence rather than guessed: a filterable
table, a locale tab strip that shows the not-translated state, a labelled form
field, and a helper for reading per-locale form values.

Deliberately stops short of the schema-driven form generator spec section 6.6
gestures at. Two examples justify these four pieces; whether more abstraction
pays comes out of Tasks 12 to 15, and the answer goes to the Phase 2
carry-over.

No test file changed, which is the whole safety net for a refactor of this
shape."
```

---

### Task 12: Certifications and badges

Certifications are the first thing a buyer looks for, so they render as badges on the landing page
rather than behind a nav click. Each carries its framework, issuer, scope, and validity window, and
may link the certificate itself as a document.

**Files:**
- Create: `src/lib/server/db/schema/certifications.ts`, `src/lib/server/content/certifications.ts`, `src/routes/(admin)/admin/certifications/{+page.server.ts,+page.svelte,new/+page.server.ts,new/+page.svelte,[id]/+page.server.ts,[id]/+page.svelte}`
- Modify: `src/lib/server/db/schema/index.ts`, `src/routes/(portal)/+page.server.ts` (new file), `src/routes/(portal)/+page.svelte`, `src/lib/admin/sections.ts`, `messages/*.json`
- Test: `tests/integration/content.test.ts`, `tests/e2e/admin-content.spec.ts`

- [x] **Step 1: Write the failing tests**

Create `tests/integration/content.test.ts` — the shared file for Tasks 12–15, opened with the same
`beforeAll`/`afterAll` connection block as `tests/integration/documents.test.ts`:

```ts
describe('certifications', () => {
	beforeEach(async () => {
		await db.delete(certification);
	});

	it('lists published certifications with scope and validity', async () => {
		const id = await createCertification(db, {
			slug: 'iso-27001',
			framework: 'ISO/IEC 27001:2022',
			issuer: 'TÜV Süd',
			validFrom: new Date('2025-04-01T00:00:00Z'),
			validUntil: new Date('2028-03-31T00:00:00Z'),
			certificateDocumentId: null
		});
		await setCertificationTranslation(db, id, 'de', { scope: 'Betrieb der Matchory-Plattform' });
		await updateCertification(db, id, { published: true });

		const items = await listPublicCertifications(db, { locale: 'de', defaultLocale: 'de' });

		expect(items).toHaveLength(1);
		expect(items[0]?.framework).toBe('ISO/IEC 27001:2022');
		expect(items[0]?.scope).toBe('Betrieb der Matchory-Plattform');
		expect(items[0]?.isScopeFallback).toBe(false);
	});

	it('hides an unpublished certification', async () => {
		const id = await createCertification(db, {
			slug: 'draft',
			framework: 'SOC 2',
			issuer: 'X',
			validFrom: null,
			validUntil: null,
			certificateDocumentId: null
		});
		await setCertificationTranslation(db, id, 'de', { scope: 'x' });

		expect(await listPublicCertifications(db, { locale: 'de', defaultLocale: 'de' })).toHaveLength(0);
	});

	it('does not link a certificate document that is not publicly visible', async () => {
		const categoryId = await createCategory(db, { slug: 'certs', position: 0 });
		const gated = await createDocument(db, { slug: 'iso-cert', categoryId, tier: 'request' });
		await updateDocument(db, gated, { status: 'published' });

		const id = await createCertification(db, {
			slug: 'iso-27001',
			framework: 'ISO/IEC 27001:2022',
			issuer: 'TÜV Süd',
			validFrom: null,
			validUntil: null,
			certificateDocumentId: gated
		});
		await setCertificationTranslation(db, id, 'de', { scope: 'x' });
		await updateCertification(db, id, { published: true });

		expect((await listPublicCertifications(db, { locale: 'de', defaultLocale: 'de' }))[0]?.certificateFileId).toBeNull();
	});
});
```

- [x] **Step 2: Run and watch it fail**

- [x] **Step 3: Schema**

Create `src/lib/server/db/schema/certifications.ts`:

```ts
import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { document } from './documents';

export const certification = pgTable('certification', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	framework: text('framework').notNull(),
	issuer: text('issuer').notNull(),
	validFrom: timestamp('valid_from', { withTimezone: true }),
	validUntil: timestamp('valid_until', { withTimezone: true }),
	// The certificate itself, if it is published as a document. `set null` so
	// deleting the document leaves the certification intact rather than
	// cascading away a compliance record.
	certificateDocumentId: uuid('certificate_document_id').references(() => document.id, {
		onDelete: 'set null'
	}),
	published: boolean('published').notNull().default(false),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const certificationTranslation = pgTable(
	'certification_translation',
	{
		certificationId: uuid('certification_id')
			.notNull()
			.references(() => certification.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		scope: text('scope').notNull()
	},
	(table) => [primaryKey({ columns: [table.certificationId, table.locale] })]
);
```

Export it from `schema/index.ts`, then `pnpm db:generate --name certifications && pnpm db:migrate`.

- [x] **Step 4: Repository**

Create `src/lib/server/content/certifications.ts`:

```ts
import { and, asc, eq, inArray } from 'drizzle-orm';
import { pickTranslation } from '../../i18n/locale';
import type { Db } from '../db';
import {
	certification,
	certificationTranslation,
	document,
	documentFile
} from '../db/schema';

export interface PublicCertification {
	id: string;
	slug: string;
	framework: string;
	issuer: string;
	scope: string;
	scopeLocale: string;
	isScopeFallback: boolean;
	validFrom: Date | null;
	validUntil: Date | null;
	/** The current file of the linked certificate, if that document is public. */
	certificateFileId: string | null;
}

export async function listPublicCertifications(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<PublicCertification[]> {
	const rows = await db
		.select()
		.from(certification)
		.where(eq(certification.published, true))
		.orderBy(asc(certification.position), asc(certification.slug));

	if (rows.length === 0) return [];

	const ids = rows.map((row) => row.id);
	const documentIds = rows
		.map((row) => row.certificateDocumentId)
		.filter((id): id is string => id !== null);

	const [scopes, files] = await Promise.all([
		db
			.select()
			.from(certificationTranslation)
			.where(inArray(certificationTranslation.certificationId, ids)),
		documentIds.length === 0
			? Promise.resolve([])
			: db
					.select({
						documentId: documentFile.documentId,
						fileId: documentFile.id,
						locale: documentFile.locale
					})
					.from(documentFile)
					.innerJoin(document, eq(documentFile.documentId, document.id))
					.where(
						and(
							inArray(documentFile.documentId, documentIds),
							eq(documentFile.isCurrent, true),
							// The certificate link is only offered when the linked
							// document is itself publicly visible — otherwise the badge
							// would hand out a download the portal refuses to serve.
							eq(document.tier, 'public'),
							eq(document.status, 'published')
						)
					)
	]);

	const result: PublicCertification[] = [];

	for (const row of rows) {
		const scope = pickTranslation(
			scopes
				.filter((item) => item.certificationId === row.id)
				.map((item) => ({ locale: item.locale, value: item.scope })),
			opts.locale,
			opts.defaultLocale
		);
		if (!scope) continue;

		const file = row.certificateDocumentId
			? pickTranslation(
					files
						.filter((item) => item.documentId === row.certificateDocumentId)
						.map((item) => ({ locale: item.locale, value: item.fileId })),
					opts.locale,
					opts.defaultLocale
				)
			: null;

		result.push({
			id: row.id,
			slug: row.slug,
			framework: row.framework,
			issuer: row.issuer,
			scope: scope.value,
			scopeLocale: scope.locale,
			isScopeFallback: scope.isFallback,
			validFrom: row.validFrom,
			validUntil: row.validUntil,
			certificateFileId: file?.value ?? null
		});
	}

	return result;
}

export interface AdminCertification {
	id: string;
	slug: string;
	framework: string;
	issuer: string;
	validFrom: Date | null;
	validUntil: Date | null;
	certificateDocumentId: string | null;
	published: boolean;
	position: number;
	translations: { locale: string; scope: string }[];
}

export async function listCertificationsForAdmin(db: Db): Promise<AdminCertification[]> {
	const rows = await db
		.select()
		.from(certification)
		.orderBy(asc(certification.position), asc(certification.slug));
	if (rows.length === 0) return [];

	const scopes = await db
		.select()
		.from(certificationTranslation)
		.where(
			inArray(
				certificationTranslation.certificationId,
				rows.map((row) => row.id)
			)
		);

	return rows.map((row) => ({
		...row,
		translations: scopes
			.filter((scope) => scope.certificationId === row.id)
			.map((scope) => ({ locale: scope.locale, scope: scope.scope }))
	}));
}

export async function getCertificationForAdmin(
	db: Db,
	id: string
): Promise<AdminCertification | null> {
	return (await listCertificationsForAdmin(db)).find((row) => row.id === id) ?? null;
}

export async function createCertification(
	db: Db,
	input: {
		slug: string;
		framework: string;
		issuer: string;
		validFrom: Date | null;
		validUntil: Date | null;
		certificateDocumentId: string | null;
		position?: number;
	}
): Promise<string> {
	const [row] = await db
		.insert(certification)
		.values({ ...input, position: input.position ?? 0 })
		.returning({ id: certification.id });

	if (!row) throw new Error('failed to insert certification');
	return row.id;
}

export async function updateCertification(
	db: Db,
	id: string,
	input: Partial<{
		slug: string;
		framework: string;
		issuer: string;
		validFrom: Date | null;
		validUntil: Date | null;
		certificateDocumentId: string | null;
		published: boolean;
		position: number;
	}>
): Promise<void> {
	await db
		.update(certification)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(certification.id, id));
}

export async function deleteCertification(db: Db, id: string): Promise<void> {
	await db.delete(certification).where(eq(certification.id, id));
}

export async function setCertificationTranslation(
	db: Db,
	certificationId: string,
	locale: string,
	values: { scope: string }
): Promise<void> {
	await db
		.insert(certificationTranslation)
		.values({ certificationId, locale, ...values })
		.onConflictDoUpdate({
			target: [certificationTranslation.certificationId, certificationTranslation.locale],
			set: values
		});
}
```

- [x] **Step 5: Render the badges on the landing page**

Add messages — DE: `"nav_certifications": "Zertifizierungen"`, `"certifications_issued_by": "Ausgestellt von {issuer}"`, `"certifications_valid": "Gültig {from} – {until}"`, `"certifications_certificate": "Zertifikat"`; EN: "Certifications", "Issued by {issuer}", "Valid {from} – {until}", "Certificate".

Create `src/routes/(portal)/+page.server.ts`:

```ts
import { getConfig } from '$lib/server/config';
import { listPublicCertifications } from '$lib/server/content/certifications';
import { getDb } from '$lib/server/db/instance';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
	const certifications = await listPublicCertifications(getDb(), {
		locale: locals.locale,
		defaultLocale: getConfig().defaultLocale
	});

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=60, must-revalidate' });
	return { certifications };
};
```

In `src/routes/(portal)/+page.svelte`, insert a badge grid above the section list:

```svelte
{#if data.certifications.length > 0}
	<section class="mb-12" data-testid="certifications">
		<h2 class="mb-4 text-xl font-medium">{m.nav_certifications()}</h2>
		<ul class="grid gap-4 sm:grid-cols-2">
			{#each data.certifications as item (item.id)}
				{@const validity = fileValidity({ validFrom: item.validFrom, validUntil: item.validUntil })}
				<li
					data-testid="certification-{item.slug}"
					class="rounded-lg border border-neutral-200 bg-white p-5"
				>
					<div class="flex flex-wrap items-baseline gap-2">
						<span class="font-medium">{item.framework}</span>
						<Badge tone={validity === 'expired' ? 'danger' : validity === 'expiring' ? 'warn' : 'ok'}>
							{validity === 'expired'
								? m.documents_status_expired()
								: validity === 'expiring'
									? m.documents_status_expiring()
									: m.documents_status_current()}
						</Badge>
						{#if item.isScopeFallback}<FallbackNotice locale={item.scopeLocale} />{/if}
					</div>

					<p class="mt-1 text-sm text-neutral-600">{item.scope}</p>
					<p class="mt-1 text-sm text-neutral-500">{m.certifications_issued_by({ issuer: item.issuer })}</p>

					{#if item.validFrom && item.validUntil}
						<p class="text-sm text-neutral-500">
							{m.certifications_valid({
								from: formatDate(item.validFrom, data.locale),
								until: formatDate(item.validUntil, data.locale)
							})}
						</p>
					{/if}

					{#if item.certificateFileId}
						<a
							data-testid="certificate-{item.slug}"
							href="/api/documents/{item.certificateFileId}"
							class="mt-2 inline-block text-sm underline underline-offset-4"
						>
							{m.certifications_certificate()}
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}
```

Import `Badge`, `FallbackNotice`, `fileValidity`, and `formatDate` at the top of that page.

- [x] **Step 6: Admin routes**

Build `src/routes/(admin)/admin/certifications/` on the primitives from Task 11 — `DataTable` for
the list, `LocaleTabs` + `FormField` for the edit page. The edit page's meta form carries `slug`,
`framework`, `issuer`, `validFrom`, `validUntil`, a `certificateDocumentId` select over
`listDocumentsForAdmin` with an empty option, a `published` checkbox, and `position`; the
per-locale form carries a single `scope` field with test ids `translation-scope-{locale}` and
`translation-save-{locale}`. Audit actions: `certification.created`, `certification.updated`,
`certification.published`, `certification.deleted`. Register
`{ path: '/admin/certifications', label: () => m.nav_certifications() }` in `ADMIN_SECTIONS`.

Add to `tests/e2e/admin-content.spec.ts` a test mirroring the controls one: create a certification,
fill the German scope, tick published, save, then assert
`page.getByTestId('certification-<slug>')` is visible on `/de`.

- [x] **Step 7: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(content): certifications with scope, validity, and badges

Certifications are the first thing an enterprise buyer looks for, so they
render as badges on the landing page rather than behind a nav click, each with
framework, issuer, scope, and validity window, and a validity badge that turns
amber inside 60 days and red past expiry.

A certification may link the certificate itself as a document. The link is
offered only when that document is publicly visible — otherwise the badge
would advertise a download the portal refuses to serve. The foreign key is set
null on delete, so removing a document does not cascade away a compliance
record."
```

---

### Task 13: Subprocessor list

DACH legal teams ask for the subprocessor list first, every time (spec §3.2). Former subprocessors
stay listed under their own heading: advance notice of changes is frequently a contractual
obligation, and a list that silently drops entries cannot evidence one.

**Files:**
- Create: `src/lib/server/db/schema/subprocessors.ts`, `src/lib/server/content/subprocessors.ts`, `src/routes/(portal)/subprocessors/{+page.server.ts,+page.svelte}`, `src/routes/(admin)/admin/subprocessors/{+page.server.ts,+page.svelte,new/+page.server.ts,new/+page.svelte,[id]/+page.server.ts,[id]/+page.svelte}`
- Modify: `schema/index.ts`, `src/lib/portal/sections.ts`, `src/lib/admin/sections.ts`, `messages/*.json`
- Test: `tests/integration/content.test.ts`, `tests/e2e/admin-content.spec.ts`

- [x] **Step 1: Write the failing tests**

Append to `tests/integration/content.test.ts`:

```ts
describe('subprocessors', () => {
	beforeEach(async () => {
		await db.delete(subprocessor);
	});

	async function seed(overrides: Partial<{ endedAt: Date | null; published: boolean }> = {}) {
		const id = await createSubprocessor(db, {
			slug: 'hetzner',
			name: 'Hetzner Online GmbH',
			legalEntity: 'Hetzner Online GmbH',
			country: 'DE',
			region: 'EU',
			hostingProvider: null,
			dpaUrl: 'https://www.hetzner.com/dpa',
			startedAt: new Date('2023-01-01T00:00:00Z'),
			endedAt: overrides.endedAt ?? null
		});
		await setSubprocessorTranslation(db, id, 'de', {
			purpose: 'Hosting der Anwendung',
			dataCategories: 'Sämtliche Kundendaten'
		});
		await updateSubprocessor(db, id, { published: overrides.published ?? true });
		return id;
	}

	it('lists a current subprocessor with purpose and data categories', async () => {
		await seed();

		const { current, former } = await listPublicSubprocessors(db, {
			locale: 'de',
			defaultLocale: 'de'
		});

		expect(former).toHaveLength(0);
		expect(current[0]?.name).toBe('Hetzner Online GmbH');
		expect(current[0]?.purpose).toBe('Hosting der Anwendung');
		expect(current[0]?.country).toBe('DE');
	});

	it('moves an ended subprocessor to the former list rather than dropping it', async () => {
		await seed({ endedAt: new Date('2026-01-01T00:00:00Z') });

		const { current, former } = await listPublicSubprocessors(db, {
			locale: 'de',
			defaultLocale: 'de'
		});

		expect(current).toHaveLength(0);
		expect(former).toHaveLength(1);
	});

	it('hides an unpublished subprocessor entirely', async () => {
		await seed({ published: false });

		const { current, former } = await listPublicSubprocessors(db, {
			locale: 'de',
			defaultLocale: 'de'
		});

		expect([...current, ...former]).toHaveLength(0);
	});
});
```

- [x] **Step 2: Run and watch it fail**

- [x] **Step 3: Schema**

```ts
// src/lib/server/db/schema/subprocessors.ts
import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const subprocessor = pgTable('subprocessor', {
	id: uuid('id').primaryKey().defaultRandom(),
	slug: text('slug').notNull().unique(),
	name: text('name').notNull(),
	legalEntity: text('legal_entity').notNull(),
	/** ISO 3166-1 alpha-2, rendered through Intl.DisplayNames per locale. */
	country: text('country').notNull(),
	region: text('region').notNull(),
	hostingProvider: text('hosting_provider'),
	dpaUrl: text('dpa_url'),
	startedAt: timestamp('started_at', { withTimezone: true }),
	/** Set rather than deleted: a removed subprocessor is a disclosure, not an
	 * absence, and DACH data processing agreements frequently require notice. */
	endedAt: timestamp('ended_at', { withTimezone: true }),
	published: boolean('published').notNull().default(false),
	position: integer('position').notNull().default(0),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const subprocessorTranslation = pgTable(
	'subprocessor_translation',
	{
		subprocessorId: uuid('subprocessor_id')
			.notNull()
			.references(() => subprocessor.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		purpose: text('purpose').notNull(),
		dataCategories: text('data_categories').notNull()
	},
	(table) => [primaryKey({ columns: [table.subprocessorId, table.locale] })]
);
```

Export from `schema/index.ts`; `pnpm db:generate --name subprocessors && pnpm db:migrate`.

- [x] **Step 4: Repository**

`src/lib/server/content/subprocessors.ts` follows `certifications.ts` exactly, with these
signatures and one difference in the public read model:

```ts
export interface PublicSubprocessor {
	id: string;
	slug: string;
	name: string;
	legalEntity: string;
	country: string;
	region: string;
	hostingProvider: string | null;
	dpaUrl: string | null;
	startedAt: Date | null;
	endedAt: Date | null;
	purpose: string;
	dataCategories: string;
	purposeLocale: string;
	isPurposeFallback: boolean;
}

/** Split rather than filtered: an ended entry stays visible under its own heading. */
export async function listPublicSubprocessors(
	db: Db,
	opts: { locale: string; defaultLocale: string }
): Promise<{ current: PublicSubprocessor[]; former: PublicSubprocessor[] }>;

export async function listSubprocessorsForAdmin(db: Db): Promise<AdminSubprocessor[]>;
export async function getSubprocessorForAdmin(db: Db, id: string): Promise<AdminSubprocessor | null>;
export async function createSubprocessor(db: Db, input: NewSubprocessor): Promise<string>;
export async function updateSubprocessor(db: Db, id: string, input: Partial<NewSubprocessor & { published: boolean; position: number }>): Promise<void>;
export async function deleteSubprocessor(db: Db, id: string): Promise<void>;
export async function setSubprocessorTranslation(db: Db, subprocessorId: string, locale: string, values: { purpose: string; dataCategories: string }): Promise<void>;
```

`listPublicSubprocessors` selects `published = true` ordered by position then name, resolves each
row's `purpose`/`dataCategories` through `pickTranslation` (skipping rows with no usable
translation), and partitions on `endedAt === null || endedAt > now`.

- [x] **Step 5: Portal page**

Messages — DE: `"nav_subprocessors": "Unterauftragsverarbeiter"`, `"subprocessors_intro": "Alle Dienstleister, die im Auftrag personenbezogene Daten verarbeiten."`, `"subprocessors_current": "Aktuell"`, `"subprocessors_former": "Ehemalig"`, `"subprocessors_purpose": "Zweck"`, `"subprocessors_data": "Datenkategorien"`, `"subprocessors_country": "Land"`, `"subprocessors_region": "Region"`, `"subprocessors_dpa": "AVV"`, `"subprocessors_since": "Seit {date}"`, `"subprocessors_until": "Bis {date}"`, `"subprocessors_empty": "Es sind keine Unterauftragsverarbeiter veröffentlicht."`. EN: "Subprocessors", "Every provider processing personal data on our behalf.", "Current", "Former", "Purpose", "Data categories", "Country", "Region", "DPA", "Since {date}", "Until {date}", "No subprocessors have been published."

Register `{ path: '/subprocessors', label: () => m.nav_subprocessors() }` in `PORTAL_SECTIONS`.

`+page.server.ts` mirrors the controls one, calling `listPublicSubprocessors`. `+page.svelte`
renders two tables, `current` then `former` (the second only when non-empty), each row showing
name, legal entity, country via `new Intl.DisplayNames([data.locale], { type: 'region' }).of(row.country)`,
region, purpose, data categories, and — when `dpaUrl` is set — an external link:

```svelte
	<a href={row.dpaUrl} rel="noreferrer noopener external" target="_blank" class="underline">
		{m.subprocessors_dpa()}
	</a>
```

A link is not a loaded resource, so this does not breach the no-third-party-resources rule; the
Task 16 test asserts on *requests the page makes*, not on hrefs.

Give each row `data-testid="subprocessor-{row.slug}"`.

- [x] **Step 6: Admin routes**

Built on the Task 11 primitives, same shape as certifications. Meta fields: `slug`, `name`,
`legalEntity`, `country`, `region`, `hostingProvider`, `dpaUrl`, `startedAt`, `endedAt`,
`published`, `position`. Per-locale fields: `purpose` and `dataCategories`, test ids
`translation-purpose-{locale}` / `translation-datacategories-{locale}` / `translation-save-{locale}`.
Audit actions `subprocessor.created`, `.updated`, `.published`, `.deleted`. Register in
`ADMIN_SECTIONS`. Add the round-trip test to `tests/e2e/admin-content.spec.ts`.

- [x] **Step 7: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(content): subprocessor list with current and former entries

DACH legal teams ask for this list first, every time. Ending a subprocessor
sets ended_at and moves it to a Former heading rather than deleting the row:
advance notice of subprocessor changes is frequently a contractual obligation,
and a list that silently drops entries cannot evidence one.

Country codes are stored as ISO 3166-1 alpha-2 and rendered through
Intl.DisplayNames, so the list reads in the visitor's language without a
translated country name per row."
```

---

### Task 14: Public FAQ

Spec §11 puts a public FAQ in Phase 1; the full answer library — owners, review dates, tags, usage
counters, per-locale full-text search — is Phase 6. This task builds the table those will extend
and the public subset that deflects questions before they are asked.

**Files:**
- Create: `src/lib/server/db/schema/answers.ts`, `src/lib/server/content/answers.ts`, `src/routes/(portal)/faq/{+page.server.ts,+page.svelte}`, `src/routes/(admin)/admin/faq/{+page.server.ts,+page.svelte,new/+page.server.ts,new/+page.svelte,[id]/+page.server.ts,[id]/+page.svelte}`
- Modify: `schema/index.ts`, `src/lib/portal/sections.ts`, `src/lib/admin/sections.ts`, `messages/*.json`
- Test: `tests/integration/content.test.ts`, `tests/e2e/admin-content.spec.ts`

- [x] **Step 1: Write the failing tests**

Append to `tests/integration/content.test.ts`:

```ts
describe('answers', () => {
	beforeEach(async () => {
		await db.delete(answer);
	});

	it('groups public answers by category', async () => {
		const first = await createAnswer(db, { slug: 'where-hosted', category: 'infrastructure' });
		await setAnswerTranslation(db, first, 'de', {
			question: 'Wo werden die Daten gehostet?',
			answer: 'In Deutschland, bei Hetzner.'
		});
		await updateAnswer(db, first, { visibility: 'public' });

		const second = await createAnswer(db, { slug: 'internal-only', category: 'infrastructure' });
		await setAnswerTranslation(db, second, 'de', { question: 'Intern?', answer: 'Ja.' });

		const groups = await listPublicAnswers(db, { locale: 'de', defaultLocale: 'de' });

		expect(groups).toHaveLength(1);
		expect(groups[0]?.category).toBe('infrastructure');
		expect(groups[0]?.answers).toHaveLength(1);
		expect(groups[0]?.answers[0]?.question).toBe('Wo werden die Daten gehostet?');
	});

	it('never exposes an internal answer, which is the default', async () => {
		const id = await createAnswer(db, { slug: 'secret', category: 'general' });
		await setAnswerTranslation(db, id, 'de', { question: 'Geheim?', answer: 'Ja.' });

		const groups = await listPublicAnswers(db, { locale: 'de', defaultLocale: 'de' });
		expect(groups.flatMap((group) => group.answers)).toHaveLength(0);
	});
});
```

- [x] **Step 2: Run and watch it fail**

- [x] **Step 3: Schema, repository, and pages**

```ts
// src/lib/server/db/schema/answers.ts
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const answer = pgTable(
	'answer',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		slug: text('slug').notNull().unique(),
		category: text('category').notNull(),
		// Internal by default: an answer written for a questionnaire reaches the
		// public FAQ only when somebody decides it should.
		visibility: text('visibility').notNull().default('internal'),
		position: integer('position').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [check('answer_visibility_check', sql`${table.visibility} IN ('public', 'internal')`)]
);

export const answerTranslation = pgTable(
	'answer_translation',
	{
		answerId: uuid('answer_id')
			.notNull()
			.references(() => answer.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		question: text('question').notNull(),
		answer: text('answer').notNull()
	},
	(table) => [primaryKey({ columns: [table.answerId, table.locale] })]
);
```

Add `ANSWER_VISIBILITIES = ['public', 'internal'] as const` to `src/lib/content-types.ts`. Export
the schema, `pnpm db:generate --name answers && pnpm db:migrate`.

`src/lib/server/content/answers.ts` mirrors `certifications.ts`, exporting
`listPublicAnswers(db, opts): Promise<{ category: string; answers: PublicAnswer[] }[]>` (filtering
`visibility = 'public'`, grouping by `category`, ordering by `position` then `slug`),
`listAnswersForAdmin`, `getAnswerForAdmin`, `createAnswer`, `updateAnswer`, `deleteAnswer`, and
`setAnswerTranslation`. `PublicAnswer` is `{ id, slug, question, answer, translationLocale, isTranslationFallback }`.

Messages — DE: `"nav_faq": "Häufige Fragen"`, `"faq_intro": "Antworten auf die Fragen, die uns am häufigsten gestellt werden."`, `"faq_empty": "Es wurden noch keine Fragen veröffentlicht."`. EN: "FAQ", "Answers to the questions we are asked most often.", "No questions have been published yet."

Register `/faq` in `PORTAL_SECTIONS` and `/admin/faq` in `ADMIN_SECTIONS`.

The portal page renders each category as a heading followed by a `<dl>` of question/answer pairs,
each `<div data-testid="answer-{item.slug}">` carrying a `<FallbackNotice>` when the translation
fell back. Answers render as plain text in a `<p>` with `whitespace-pre-line`, not as markdown —
see the deviation note below.

**Deviation:** answer bodies are plain text rather than markdown. Rendering markdown means either a
sanitiser or an XSS hole, and the FAQ is the surface most likely to be pasted into from a
questionnaire. Phase 6 owns the answer library and can revisit it with the sanitiser it needs.

The admin routes follow certifications: meta fields `slug`, `category`, a `visibility` select over
`ANSWER_VISIBILITIES`, and `position`; per-locale `question` and `answer` fields with test ids
`translation-question-{locale}`, `translation-answer-{locale}`, `translation-save-{locale}`. Audit
actions `answer.created`, `.updated`, `.published` (when visibility becomes public), `.deleted`.

- [x] **Step 4: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(content): public FAQ over the answer table

Spec section 11 puts a public FAQ in Phase 1 and the full answer library —
owners, review dates, tags, usage counters, per-locale full-text search — in
Phase 6. This is the table those extend and the public subset that deflects
questions before they are asked.

Visibility defaults to internal, so an answer written for a questionnaire
reaches the portal only when somebody decides it should. Bodies are plain text
rather than markdown: rendering markdown means a sanitiser or an XSS hole, and
this is the surface most likely to be pasted into."
```

---

### Task 15: Updates feed

The changelog a buyer subscribes to in Phase 4. Phase 1 publishes it; the subscriptions, digests,
and scheduled composer come later.

**Files:**
- Create: `src/lib/server/db/schema/updates.ts`, `src/lib/server/content/updates.ts`, `src/routes/(portal)/updates/{+page.server.ts,+page.svelte}`, `src/routes/(admin)/admin/updates/{+page.server.ts,+page.svelte,new/+page.server.ts,new/+page.svelte,[id]/+page.server.ts,[id]/+page.svelte}`
- Modify: `schema/index.ts`, `src/lib/content-types.ts`, `src/lib/portal/sections.ts`, `src/lib/admin/sections.ts`, `messages/*.json`
- Test: `tests/integration/content.test.ts`, `tests/e2e/admin-content.spec.ts`

- [x] **Step 1: Write the failing tests**

```ts
describe('updates', () => {
	beforeEach(async () => {
		await db.delete(updatePost);
	});

	it('lists published updates newest first', async () => {
		for (const [slug, when] of [
			['older', '2026-01-01T00:00:00Z'],
			['newer', '2026-06-01T00:00:00Z']
		] as const) {
			const id = await createUpdate(db, { slug, kind: 'advisory' });
			await setUpdateTranslation(db, id, 'de', { title: slug, body: 'Text' });
			await updateUpdate(db, id, { publishedAt: new Date(when) });
		}

		const posts = await listPublicUpdates(db, { locale: 'de', defaultLocale: 'de' });
		expect(posts.map((post) => post.slug)).toEqual(['newer', 'older']);
	});

	it('hides an update with no publication date and one dated in the future', async () => {
		const unpublished = await createUpdate(db, { slug: 'draft', kind: 'advisory' });
		await setUpdateTranslation(db, unpublished, 'de', { title: 'Entwurf', body: 'x' });

		const scheduled = await createUpdate(db, { slug: 'scheduled', kind: 'advisory' });
		await setUpdateTranslation(db, scheduled, 'de', { title: 'Geplant', body: 'x' });
		await updateUpdate(db, scheduled, { publishedAt: new Date(Date.now() + 86_400_000) });

		expect(await listPublicUpdates(db, { locale: 'de', defaultLocale: 'de' })).toHaveLength(0);
	});
});
```

- [x] **Step 2: Run and watch it fail**

- [x] **Step 3: Schema, repository, and pages**

```ts
// src/lib/server/db/schema/updates.ts
import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const updatePost = pgTable(
	'update_post',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		slug: text('slug').notNull().unique(),
		kind: text('kind').notNull(),
		// Null means unpublished and a future value means scheduled — one column
		// answering both questions, so a post cannot be published and undated.
		publishedAt: timestamp('published_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('update_post_published_idx').on(table.publishedAt),
		check(
			'update_post_kind_check',
			sql`${table.kind} IN ('document', 'subprocessor', 'certification', 'advisory')`
		)
	]
);

export const updatePostTranslation = pgTable(
	'update_post_translation',
	{
		postId: uuid('post_id')
			.notNull()
			.references(() => updatePost.id, { onDelete: 'cascade' }),
		locale: text('locale').notNull(),
		title: text('title').notNull(),
		body: text('body').notNull()
	},
	(table) => [primaryKey({ columns: [table.postId, table.locale] })]
);
```

Add `UPDATE_KINDS = ['document', 'subprocessor', 'certification', 'advisory'] as const` to
`src/lib/content-types.ts`. Export the schema; `pnpm db:generate --name updates && pnpm db:migrate`.

`src/lib/server/content/updates.ts` exports `listPublicUpdates(db, opts)` — where
`publishedAt IS NOT NULL AND published_at <= now()`, ordered `desc(publishedAt)` — plus
`listUpdatesForAdmin`, `getUpdateForAdmin`, `createUpdate`, `updateUpdate`, `deleteUpdate`, and
`setUpdateTranslation`. `PublicUpdate` is
`{ id, slug, kind, publishedAt, title, body, translationLocale, isTranslationFallback }`.

Messages — DE: `"nav_updates": "Aktuelles"`, `"updates_intro": "Änderungen an Dokumenten, Zertifizierungen und Unterauftragsverarbeitern."`, `"updates_empty": "Es wurden noch keine Meldungen veröffentlicht."`, `"update_kind_document": "Dokument"`, `"update_kind_subprocessor": "Unterauftragsverarbeiter"`, `"update_kind_certification": "Zertifizierung"`, `"update_kind_advisory": "Hinweis"`. EN: "Updates", "Changes to documents, certifications, and subprocessors.", "No updates have been published yet.", "Document", "Subprocessor", "Certification", "Advisory".

Register `/updates` in `PORTAL_SECTIONS` and `/admin/updates` in `ADMIN_SECTIONS`.

The portal page renders a `<ol>` of `<article data-testid="update-{post.slug}">`, each with a
`<Badge>` for the kind, a `<time datetime={post.publishedAt.toISOString()}>` showing
`formatDate(post.publishedAt, data.locale)`, the title as an `<h2>`, the body in a
`whitespace-pre-line` paragraph (plain text, for the same reason as the FAQ), and a
`<FallbackNotice>` when the translation fell back.

The admin routes follow certifications: meta fields `slug`, a `kind` select over `UPDATE_KINDS`,
and a `publishedAt` `datetime-local` input that may be left empty; per-locale `title` and `body`.
Audit actions `update.created`, `.updated`, `.published`, `.deleted`.

- [x] **Step 4: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(content): updates feed

The changelog Phase 4's subscriptions and digests will send. One published_at
column answers both 'is it published' and 'when' — null is unpublished, a
future value is scheduled — so a post cannot be published and undated, and
scheduling costs no extra state.

Bodies are plain text for the same reason as the FAQ's."
```

---

### Task 16: Branding configuration, CSP, and the no-third-party-resources test

Spec §3.5 makes "no trackers, no cookie banner" a differentiator and §13 makes "loads no
third-party resources" a success criterion. Phase 0 has a permanent test for the cookie half and
none for the other. Branding is where a CDN font would sneak in, so both land together — and a
Content-Security-Policy turns the claim from an assertion into something the browser enforces.

Branding colours are served as a stylesheet from `/branding.css` rather than an inline `<style>`,
which is what lets `style-src` stay `'self'` with no `unsafe-inline` anywhere.

**Files:**
- Create: `src/lib/server/content/branding.ts`, `src/routes/branding.css/+server.ts`, `src/routes/api/branding/logo/+server.ts`, `src/routes/(admin)/admin/settings/branding/{+page.server.ts,+page.svelte}`
- Modify: `vite.config.ts`, `src/routes/+layout.server.ts`, `src/routes/(portal)/+layout.svelte`, `src/lib/admin/sections.ts`, `messages/*.json`
- Test: `tests/unit/branding.test.ts`, `tests/e2e/security.spec.ts`

**Interfaces:**
- Produces: `getBranding(db): Promise<Branding>`, `setBranding(db, values): Promise<void>`,
  `parseBranding(value: unknown): Branding`, `BRANDING_SETTING_KEY`.

- [x] **Step 1: Write the failing branding tests**

Create `tests/unit/branding.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { brandingCss, parseBranding } from '../../src/lib/server/content/branding';

describe('parseBranding', () => {
	it('fills every field on a fresh install', () => {
		const branding = parseBranding(undefined);
		expect(branding.organizationName).toBe('Trust Center');
		expect(branding.primaryColor).toMatch(/^#[0-9a-f]{6}$/i);
		expect(branding.logoStorageKey).toBeNull();
	});

	it('keeps valid stored values', () => {
		const branding = parseBranding({
			organizationName: 'Matchory',
			primaryColor: '#0F62FE',
			surfaceColor: '#FAFAFA',
			inkColor: '#171717',
			logoStorageKey: null,
			logoContentType: null,
			imprintUrl: 'https://matchory.com/impressum',
			privacyUrl: null,
			contactEmail: 'security@matchory.com'
		});

		expect(branding.organizationName).toBe('Matchory');
		expect(branding.primaryColor).toBe('#0F62FE');
	});

	it('rejects a colour that is not a six-digit hex value', () => {
		// The value is interpolated into a stylesheet, so anything that could
		// close a declaration block has to be refused at the boundary.
		expect(() => parseBranding({ primaryColor: 'red; } body { display:none' })).toThrow();
		expect(() => parseBranding({ primaryColor: '#fff' })).toThrow();
	});

	it('rejects a non-https imprint URL', () => {
		expect(() => parseBranding({ imprintUrl: 'javascript:alert(1)' })).toThrow();
	});
});

describe('brandingCss', () => {
	it('emits the custom properties the components read', () => {
		const css = brandingCss(parseBranding({ primaryColor: '#0F62FE' }));
		expect(css).toContain('--tc-primary: #0F62FE');
		expect(css).toContain(':root');
	});
});
```

- [x] **Step 2: Run and watch it fail**

- [x] **Step 3: Implement branding**

Create `src/lib/server/content/branding.ts`:

```ts
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db';
import { setting } from '../db/schema';

export const BRANDING_SETTING_KEY = 'branding';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const httpsUrl = z.string().url().startsWith('https://');

const schema = z.object({
	organizationName: z.string().min(1).max(120).default('Trust Center'),
	primaryColor: hexColor.default('#171717'),
	surfaceColor: hexColor.default('#FAFAFA'),
	inkColor: hexColor.default('#171717'),
	logoStorageKey: z.string().nullable().default(null),
	logoContentType: z.enum(['image/png', 'image/svg+xml', 'image/webp']).nullable().default(null),
	imprintUrl: httpsUrl.nullable().default(null),
	privacyUrl: httpsUrl.nullable().default(null),
	contactEmail: z.string().email().nullable().default(null)
});

export type Branding = z.infer<typeof schema>;

/** Throws on invalid input rather than silently defaulting: a stored value
 * that fails validation is a configuration error an operator must see. */
export function parseBranding(value: unknown): Branding {
	return schema.parse(value ?? {});
}

export async function getBranding(db: Db): Promise<Branding> {
	const [row] = await db
		.select()
		.from(setting)
		.where(eq(setting.key, BRANDING_SETTING_KEY))
		.limit(1);

	return parseBranding(row?.value);
}

export async function setBranding(db: Db, values: Branding): Promise<void> {
	await db
		.insert(setting)
		.values({ key: BRANDING_SETTING_KEY, value: values })
		.onConflictDoUpdate({
			target: setting.key,
			set: { value: values, updatedAt: new Date() }
		});
}

/**
 * Served from /branding.css rather than inlined in a <style> tag, which is the
 * only reason the Content-Security-Policy can keep style-src at 'self' with no
 * unsafe-inline. Colours are validated as six-digit hex above, so nothing here
 * can close the declaration block.
 */
export function brandingCss(branding: Branding): string {
	return `:root {\n\t--tc-primary: ${branding.primaryColor};\n\t--tc-surface: ${branding.surfaceColor};\n\t--tc-ink: ${branding.inkColor};\n}\n`;
}
```

- [x] **Step 4: Serve the stylesheet and the logo**

`src/routes/branding.css/+server.ts`:

```ts
import { brandingCss, getBranding } from '$lib/server/content/branding';
import { getDb } from '$lib/server/db/instance';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
	const css = brandingCss(await getBranding(getDb()));

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=300, must-revalidate' });
	return new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8' } });
};
```

`src/routes/api/branding/logo/+server.ts` resolves `logoStorageKey`, 404s when it is null, and
streams it through `getStorage()` exactly as the document endpoint does — with two differences: no
audit event (a logo is not a document access) and `cache-control: public, max-age=3600`. Its
`content-type` comes from the branding record's `logoContentType`, and a record with a
`logoStorageKey` but no `logoContentType` 404s rather than guessing.

- [x] **Step 5: Wire branding into the layouts**

In `src/routes/+layout.server.ts`, add `branding: await getBranding(getDb())` to the returned data
(the load becomes `async`). In `src/routes/(portal)/+layout.svelte`, add to `<svelte:head>`:

```svelte
<svelte:head>
	<link rel="stylesheet" href="/branding.css" />
	{#if data.branding.logoStorageKey}
		<link rel="icon" href="/api/branding/logo" />
	{/if}
</svelte:head>
```

and replace `{m.site_title()}` in the header and footer with `{data.branding.organizationName}`,
rendering the logo as an `<img src="/api/branding/logo" alt={data.branding.organizationName}
class="h-8 w-auto" />` when a key is set. Add the imprint and privacy links to the footer when
those URLs are set, using `m.portal_imprint()` and `m.portal_privacy()`.

- [x] **Step 6: Turn on the Content-Security-Policy**

In `vite.config.ts`, inside the `sveltekit({...})` call:

```ts
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'form-action': ['self'],
					'base-uri': ['self'],
					'object-src': ['none'],
					'frame-ancestors': ['none']
				}
			},
```

`mode: 'auto'` lets SvelteKit nonce its own hydration script. Nothing else inline exists, which is
why every source stays `'self'` — the policy *enforces* the claim in spec §13 rather than
restating it.

- [x] **Step 7: Write the permanent no-third-party test**

Append to `tests/e2e/security.spec.ts`:

```ts
test('the public portal loads no third-party resources', async ({ page, baseURL }) => {
	const foreign: string[] = [];
	const origin = new URL(baseURL ?? 'http://localhost:4173').origin;

	page.on('request', (request) => {
		const url = new URL(request.url());
		// data: and blob: are the page's own bytes, not a third party.
		if (url.protocol === 'data:' || url.protocol === 'blob:') return;
		if (url.origin !== origin) foreign.push(request.url());
	});

	for (const path of ['/de', '/de/documents', '/de/controls']) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
	}

	expect(foreign).toEqual([]);
});

test('serves a content security policy that permits only same-origin resources', async ({
	request
}) => {
	const response = await request.get('/de');
	const csp = response.headers()['content-security-policy'];

	expect(csp).toBeTruthy();
	expect(csp).toContain("default-src 'self'");
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).not.toContain('unsafe-inline');
});
```

- [x] **Step 8: Build the branding admin form**

`src/routes/(admin)/admin/settings/branding/+page.server.ts` loads `getBranding(getDb())` and has
one `default` action that parses the form through the branding schema, handles an optional logo
upload via `readUpload` (allowed types `image/png`, `image/svg+xml`, `image/webp`) storing it with
`newStorageKey()` and deleting the previous object, calls `setBranding`, and records
`settings.branding.updated` with the changed field names in `meta` — never the values, which could
carry a contact email.

The page renders a `FormField` per property: organisation name, three colour inputs
(`type="color"`), a file input for the logo, and URL/email inputs for imprint, privacy, and
contact. Register `{ path: '/admin/settings/branding', label: () => m.admin_branding() }` in
`ADMIN_SECTIONS` and add `"admin_branding"` to both catalogs (`"Erscheinungsbild"` / `"Branding"`)
along with `"admin_logo"`, `"admin_color_primary"`, `"admin_color_surface"`, `"admin_color_ink"`,
`"admin_organization_name"`, `"admin_contact_email"`.

- [x] **Step 9: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(portal): branding configuration and an enforced no-third-party policy

Organisation name, logo, and three colours, configured in the admin and stored
in the setting table. Colours are served as a stylesheet from /branding.css
rather than an inline style tag, which is the only reason style-src can stay
'self' with no unsafe-inline anywhere in the policy.

Adds the Content-Security-Policy the product has been asserting in prose: every
source is 'self', frame-ancestors is none, and nothing is unsafe-inline. Spec
section 13's 'loads no third-party resources' is now enforced by the browser
and covered by a permanent test that records every request the portal makes and
fails on any foreign origin — the sibling of Phase 0's no-cookies test, which
had no counterpart until now.

Colour values are validated as six-digit hex at the boundary because they are
interpolated into a stylesheet, and the logo is streamed through the storage
port like every other stored object, never from a public path."
```

---

### Task 17: SEO — metadata, canonical URLs, hreflang, sitemap, robots

Locale-prefixed URLs (Task 1) are what make this answerable: every page has one canonical address
per locale, and the alternates are mechanical.

**Files:**
- Create: `src/lib/components/portal/Seo.svelte`, `src/routes/sitemap.xml/+server.ts`, `src/routes/robots.txt/+server.ts`
- Delete: `static/robots.txt`
- Modify: every `(portal)` page, `src/routes/(admin)/admin/+layout.svelte`
- Test: `tests/e2e/seo.spec.ts`, `tests/e2e/security.spec.ts`

- [x] **Step 1: Write the failing SEO tests**

Create `tests/e2e/seo.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('every portal page carries a canonical URL and one alternate per locale', async ({ page }) => {
	await page.goto('/de/documents');

	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
		'href',
		/\/de\/documents$/
	);
	await expect(page.locator('link[rel="alternate"][hreflang="de"]')).toHaveAttribute(
		'href',
		/\/de\/documents$/
	);
	await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
		'href',
		/\/en\/documents$/
	);
	// x-default points at the deployment's default locale, so a crawler with
	// no language preference is sent somewhere deterministic.
	await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
		'href',
		/\/de\/documents$/
	);
});

test('portal pages carry Open Graph metadata', async ({ page }) => {
	await page.goto('/de/documents');

	await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
	await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'de');
	await expect(page.locator('meta[name="description"]')).toHaveCount(1);
});

test('the admin area is noindex', async ({ page }) => {
	// Signed in, because an anonymous visitor is redirected to the portal and
	// would be asserted against the wrong page.
	await page.goto('/auth/login');
	await page.getByPlaceholder('Enter any login').fill('admin');
	await page.getByPlaceholder('and password').fill('any-password');
	await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

	const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
	if (await consent.isVisible().catch(() => false)) await consent.click();

	const response = await page.goto('/de/admin');

	expect(response?.headers()['x-robots-tag']).toMatch(/noindex/);
	await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('robots.txt disallows the admin area and names the sitemap', async ({ request }) => {
	const response = await request.get('/robots.txt');
	const body = await response.text();

	expect(body).toMatch(/Disallow: \/admin/);
	expect(body).toMatch(/Disallow: \/api/);
	expect(body).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/);
});

test('the sitemap lists every locale of every published section', async ({ request }) => {
	const body = await (await request.get('/sitemap.xml')).text();

	expect(body).toContain('<urlset');
	expect(body).toMatch(/<loc>[^<]*\/de\/documents<\/loc>/);
	expect(body).toMatch(/<loc>[^<]*\/en\/documents<\/loc>/);
	expect(body).toMatch(/hreflang="en"/);
});
```

Append to `tests/e2e/security.spec.ts`:

```ts
test('a gated document never appears in the sitemap', async ({ request }) => {
	const body = await (await request.get('/sitemap.xml')).text();
	expect(body).not.toContain('gated-fixture');
});
```

- [x] **Step 2: Run and watch it fail**

- [x] **Step 3: Write the `Seo` component**

```svelte
<!-- src/lib/components/portal/Seo.svelte -->
<script lang="ts">
	import { page } from '$app/state';
	import { COMPILED_LOCALES } from '$lib/i18n/compiled';
	import { localizePath, stripLocale } from '$lib/i18n/locale';

	let {
		title,
		description,
		siteName,
		locale,
		locales,
		defaultLocale
	}: {
		title: string;
		description: string;
		siteName: string;
		locale: string;
		locales: readonly string[];
		defaultLocale: string;
	} = $props();

	// Absolute URLs: canonical and og:url must not be relative, and the origin
	// a crawler sees has to be the configured one rather than whatever host
	// header reached the app.
	let origin = $derived(page.url.origin);
	let basePath = $derived(stripLocale(page.url.pathname, COMPILED_LOCALES).path);
	let canonical = $derived(`${origin}${localizePath(basePath, locale)}`);
</script>

<svelte:head>
	<title>{title} · {siteName}</title>
	<meta name="description" content={description} />
	<link rel="canonical" href={canonical} />

	{#each locales as alternate (alternate)}
		<link rel="alternate" hreflang={alternate} href="{origin}{localizePath(basePath, alternate)}" />
	{/each}
	<link rel="alternate" hreflang="x-default" href="{origin}{localizePath(basePath, defaultLocale)}" />

	<meta property="og:type" content="website" />
	<meta property="og:site_name" content={siteName} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={description} />
	<meta property="og:url" content={canonical} />
	<meta property="og:locale" content={locale} />
	{#each locales.filter((item) => item !== locale) as alternate (alternate)}
		<meta property="og:locale:alternate" content={alternate} />
	{/each}
	<meta name="twitter:card" content="summary" />
</svelte:head>
```

Add `<Seo title={…} description={…} siteName={data.branding.organizationName} locale={data.locale}
locales={data.locales} defaultLocale={data.defaultLocale} />` to every `(portal)` page, using that
page's heading message as the title and its intro message as the description.

- [x] **Step 4: Write the sitemap and robots routes**

`src/routes/sitemap.xml/+server.ts`:

```ts
import { getConfig } from '$lib/server/config';
import { listPublicAnswers } from '$lib/server/content/answers';
import { listPublicCertifications } from '$lib/server/content/certifications';
import { listPublicControlGroups } from '$lib/server/content/controls';
import { listPublicDocuments } from '$lib/server/content/documents';
import { listPublicSubprocessors } from '$lib/server/content/subprocessors';
import { listPublicUpdates } from '$lib/server/content/updates';
import { getDb } from '$lib/server/db/instance';
import { localizePath } from '$lib/i18n/locale';
import type { RequestHandler } from './$types';

const escapeXml = (value: string) =>
	value.replace(/[<>&'"]/g, (char) =>
		char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : char === "'" ? '&apos;' : '&quot;'
	);

export const GET: RequestHandler = async ({ setHeaders }) => {
	const { baseUrl, locales, defaultLocale } = getConfig();
	const db = getDb();
	const opts = { locale: defaultLocale, defaultLocale };

	// A section appears only when it has something published. Listing an empty
	// page invites a crawler to index nothing, and — more importantly — the
	// content queries are the same public read models the pages use, so a gated
	// document cannot reach the sitemap by a different path than it reaches the
	// page. That equivalence is what the security test relies on.
	const [documents, controls, subprocessors, answers, updates, certifications] = await Promise.all([
		listPublicDocuments(db, opts),
		listPublicControlGroups(db, opts),
		listPublicSubprocessors(db, opts),
		listPublicAnswers(db, opts),
		listPublicUpdates(db, opts),
		listPublicCertifications(db, opts)
	]);

	const paths = [
		'/',
		...(documents.length > 0 ? ['/documents'] : []),
		...(controls.length > 0 ? ['/controls'] : []),
		...(subprocessors.current.length + subprocessors.former.length > 0 ? ['/subprocessors'] : []),
		...(answers.length > 0 ? ['/faq'] : []),
		...(updates.length > 0 ? ['/updates'] : [])
	];
	void certifications; // rendered on '/', which is always listed

	const urls = paths
		.flatMap((path) =>
			locales.map((locale) => {
				const alternates = locales
					.map(
						(alternate) =>
							`\t\t<xhtml:link rel="alternate" hreflang="${alternate}" href="${escapeXml(
								`${baseUrl}${localizePath(path, alternate)}`
							)}" />`
					)
					.join('\n');

				return `\t<url>\n\t\t<loc>${escapeXml(`${baseUrl}${localizePath(path, locale)}`)}</loc>\n${alternates}\n\t</url>`;
			})
		)
		.join('\n');

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=600, must-revalidate' });

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`,
		{ headers: { 'content-type': 'application/xml; charset=utf-8' } }
	);
};
```

`src/routes/robots.txt/+server.ts`, replacing `static/robots.txt` (delete that file):

```ts
import { getConfig } from '$lib/server/config';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ setHeaders }) => {
	const { baseUrl } = getConfig();

	// The portal is meant to be found — that is the point of a trust center —
	// so crawling is allowed everywhere except the staff area and the endpoints
	// that only exist to be called by the app.
	const body = [
		'User-agent: *',
		'Disallow: /admin',
		'Disallow: /api',
		'Disallow: /auth',
		'',
		`Sitemap: ${baseUrl}/sitemap.xml`,
		''
	].join('\n');

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=3600, must-revalidate' });
	return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
```

- [x] **Step 5: Make the admin `noindex`**

Add to `src/routes/(admin)/admin/+layout.svelte`:

```svelte
<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>
```

and set the header too, in `src/routes/(admin)/admin/+layout.server.ts`, so it applies to
non-HTML responses from the group as well:

```ts
export const load: LayoutServerLoad = ({ locals, setHeaders }) => {
	if (!locals.staff) redirect(303, '/');
	setHeaders({ 'x-robots-tag': 'noindex, nofollow' });
	// ... unchanged
};
```

- [x] **Step 6: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(seo): canonical URLs, hreflang, Open Graph, sitemap, and robots

Locale-prefixed URLs make this mechanical: every page has one canonical
address per locale, alternates are generated from the enabled locale set, and
x-default points at the deployment's default so a crawler with no language
preference lands somewhere deterministic.

The sitemap is built from the same public read models the pages use, not from
a parallel query. That equivalence is what lets the security test assert a
gated document never reaches it — the two could not diverge without the pages
diverging too.

robots.txt becomes a route because it needs BASE_URL for the Sitemap line, and
the admin group is now noindex by both meta tag and X-Robots-Tag, which spec
section 6.2 requires and Phase 0 left open."
```

---

### Task 18: Production image, compose deployment, and self-hosting documentation

Spec §13's fourth success criterion: the full deployment runs from one `docker compose up` against
a self-hosted Postgres, with no external service beyond SMTP and an OIDC issuer. Phase 0 deferred
the container to this phase; this closes it.

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `docs/self-hosting.md`
- Modify: `vite.config.ts`, `package.json`, `src/hooks.server.ts`, `.dockerignore`, `.github/workflows/ci.yml`, `playwright.config.ts`, `README.md`
- Test: the CI image build itself, plus a documented smoke run

- [x] **Step 1: Swap the adapter**

```bash
pnpm remove @sveltejs/adapter-auto
pnpm add -D @sveltejs/adapter-node
```

In `vite.config.ts`, change the import to `import adapter from '@sveltejs/adapter-node';`. The
adapter belongs **inside** `vite.config.ts`'s `sveltekit({...})` call, where the existing one
already is. Do not create a `svelte.config.js`: SvelteKit warns and silently ignores the inline
configuration when one exists, and every setting in this project lives inline.

Run `pnpm build` and confirm `build/index.js` appears.

- [x] **Step 2: Run migrations at start, behind a switch**

Distroless has no shell, so "exec into the container and migrate" does not exist. Extend `init` in
`src/hooks.server.ts`:

```ts
export const init: ServerInit = async () => {
	try {
		getConfig();
	} catch (cause) {
		console.error(cause instanceof Error ? cause.message : cause);
		process.exit(1);
	}

	// Default on, because the single-container deployment this ships for has
	// nowhere else to run them. Operators running more than one replica set
	// RUN_MIGRATIONS=false and run a one-off migration job instead — two
	// replicas racing the same migration is a real failure mode, and there is
	// no advisory lock around drizzle's migrator to prevent it.
	if (process.env.RUN_MIGRATIONS !== 'false') {
		const { migrate } = await import('drizzle-orm/postgres-js/migrator');
		await migrate(getDb(), { migrationsFolder: './drizzle' });
	}
};
```

- [x] **Step 3: Write the Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1

# --- production dependencies -------------------------------------------------
# A separate install rather than pruning the build stage's tree: pnpm's default
# symlinked layout does not survive a COPY between stages, so this one asks for
# a hoisted layout that does.
FROM node:22-bookworm-slim AS deps
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --config.node-linker=hoisted

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# `--ignore-scripts` above skipped the prepare hook, so the message catalogs are
# compiled explicitly. This is the step that fixes the locale set into the
# image: LOCALES can only ever select a subset of what is compiled here.
RUN pnpm paraglide:compile && pnpm build
# The storage directory is created here so the runtime volume inherits its
# ownership — distroless:nonroot cannot chown anything at start.
RUN mkdir -p /data/storage && chown -R 65532:65532 /data

# --- runtime -----------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/build        ./build
# The migrations travel with the image: the server applies them at start unless
# RUN_MIGRATIONS=false.
COPY --from=build /app/drizzle      ./drizzle
COPY --from=build /app/package.json ./package.json
COPY --from=build --chown=65532:65532 /data /data

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/data/storage \
    BODY_SIZE_LIMIT=32M

EXPOSE 3000
USER 65532:65532

CMD ["build/index.js"]
```

`BODY_SIZE_LIMIT` is adapter-node's own request cap; it must exceed `MAX_UPLOAD_MB` or a large
upload is rejected by the adapter before the application's friendlier error can run.

Extend `.dockerignore` so the build context stays small and no local state leaks in:

```
.env
.env.*
!.env.example

node_modules
.svelte-kit
build
.git
data
test-results
playwright-report
docs
```

- [x] **Step 4: Write the production compose file**

```yaml
# docker-compose.yml — a complete single-host deployment.
# See docs/self-hosting.md for every variable and for the OIDC setup.
services:
  app:
    build: .
    image: trust-center:local
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://trustcenter:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@postgres:5432/trustcenter
      BASE_URL: ${BASE_URL:?set BASE_URL, e.g. https://trust.example.com}
      LOCALES: ${LOCALES:-de,en}
      DEFAULT_LOCALE: ${DEFAULT_LOCALE:-de}
      OIDC_ISSUER: ${OIDC_ISSUER:?set OIDC_ISSUER}
      OIDC_CLIENT_ID: ${OIDC_CLIENT_ID:?set OIDC_CLIENT_ID}
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET:?set OIDC_CLIENT_SECRET}
      OIDC_ADMIN_GROUP: ${OIDC_ADMIN_GROUP:?set OIDC_ADMIN_GROUP}
      OIDC_APPROVER_GROUP: ${OIDC_APPROVER_GROUP:-}
      MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-25}
    ports:
      - '127.0.0.1:3000:3000'
    volumes:
      - storage:/data/storage
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: trustcenter
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: trustcenter
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U trustcenter']
      interval: 5s
      timeout: 3s
      retries: 20
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  storage:
  pgdata:
```

The app is bound to `127.0.0.1` deliberately: it speaks plain HTTP and expects a TLS-terminating
reverse proxy in front. `docs/self-hosting.md` says so explicitly.

- [x] **Step 5: Write the self-hosting guide**

Create `docs/self-hosting.md` covering, in this order:

1. **What you need** — Docker, a Postgres 16 instance (the compose file provides one), an OIDC
   issuer, and a TLS-terminating reverse proxy. No other external service in Phase 1.
2. **Quick start** — copy `.env.example` to `.env`, set `POSTGRES_PASSWORD`, `BASE_URL`, and the
   five `OIDC_*` values, then `docker compose up -d`. First sign-in at `BASE_URL/auth/login`
   creates the staff user; there is no seeded account and no setup wizard, because roles come
   from IdP groups.
3. **Every environment variable** — one table, each row naming the variable, whether it is
   required, its default, and what it does. Copy the descriptions from `.env.example` so the two
   cannot drift; add `RUN_MIGRATIONS`, `PORT`, and `BODY_SIZE_LIMIT`, which are runtime-only.
4. **Setting up the OIDC issuer** — a worked Keycloak example and a worked Authentik example:
   create a confidential client, redirect URI `${BASE_URL}/auth/callback`, scopes
   `openid email profile groups`, and a groups claim mapper. Note `OIDC_GROUPS_CLAIM` for issuers
   that name it something else (Entra ID uses `roles` for app roles).
5. **Locales** — the two-layer rule, stated plainly: `LOCALES` selects from what the image
   compiled, and adding a language means adding `messages/<locale>.json`, listing it in
   `project.inlang/settings.json`, and rebuilding the image. Include the exact commands.
6. **Storage and backups** — what lives in the `storage` volume, what lives in Postgres, and that
   a restore needs both. `pg_dump` plus a volume copy; a database restored without its objects
   leaves documents that list but do not download.
7. **Upgrading** — pull, `docker compose up -d`; migrations run at start. For more than one
   replica, set `RUN_MIGRATIONS=false` and run a one-off migration container first.
8. **Reverse proxy** — a worked Caddy and nginx example, both forwarding `X-Forwarded-For` and
   `X-Forwarded-Proto`. Note that `getClientAddress()` needs `ADDRESS_HEADER=X-Forwarded-For` and
   `XFF_DEPTH` set to the number of trusted proxies, or every audit event records the proxy's
   address instead of the visitor's. Add both to the variable table.
9. **What this deployment does not send anywhere** — no telemetry, no third-party requests from
   the portal, no cookies for public visitors. Point at `tests/e2e/security.spec.ts` as the
   evidence rather than asking for trust.

In `README.md`, add a line pointing at the guide, and a `docker compose up -d` quick start beside
the existing development one.

- [x] **Step 6: Fix the CI double build and the stale Playwright comment**

In `playwright.config.ts`, stop rebuilding in CI, where the workflow has already built:

```ts
	webServer: {
		command: process.env.CI
			? 'pnpm preview --port 4173 --strictPort'
			: 'pnpm build && pnpm preview --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		env: { BASE_URL: 'http://localhost:4173' }
	}
```

Replace the long `use:` comment above it with the two sentences that are still true — the browser
locale is pinned so `Accept-Language` negotiation is deterministic, and the suite runs against a
production preview build for parity with what ships. Delete the trailing clause about the
unreproduced dev-mode defect; it was retracted in the Phase 0 carry-over and no longer explains
anything.

Note the `env` key renames from `PUBLIC_BASE_URL` to `BASE_URL` (Task 1).

In `.github/workflows/ci.yml`, add an image build after the test steps:

```yaml
      - name: Build the production image
        run: docker build -t trust-center:ci .
      - name: Confirm the image starts and serves the portal
        run: |
          docker run -d --name tc-smoke --network host \
            -e DATABASE_URL=postgres://trustcenter:trustcenter@localhost:5432/trustcenter \
            -e BASE_URL=http://localhost:3000 \
            -e LOCALES=de,en -e DEFAULT_LOCALE=de \
            -e OIDC_ISSUER=http://localhost:5556 \
            -e OIDC_CLIENT_ID=trust-center -e OIDC_CLIENT_SECRET=dev-secret \
            -e OIDC_ADMIN_GROUP=trust-center-admins \
            trust-center:ci
          for i in $(seq 1 30); do
            if curl -fsS -o /dev/null http://localhost:3000/de; then exit 0; fi
            sleep 2
          done
          docker logs tc-smoke
          exit 1
```

This is the step that would catch a broken adapter configuration, a missing runtime dependency, or
migrations that fail to apply — none of which `pnpm build` can see.

- [x] **Step 7: Verify the image by hand**

```bash
docker build -t trust-center:local .
docker image inspect trust-center:local --format '{{.Config.User}}'   # expect 65532:65532
```

Then, with the dev compose stack already running, start the image against it, load
`http://localhost:3000/de`, sign in through the dev IdP, and confirm a document upload survives a
container restart (proving the volume is writable by the nonroot user):

```bash
docker run --rm --network host \
  -e DATABASE_URL=postgres://trustcenter:trustcenter@localhost:5433/trustcenter \
  -e BASE_URL=http://localhost:3000 -e LOCALES=de,en -e DEFAULT_LOCALE=de \
  -e OIDC_ISSUER=http://localhost:5556 -e OIDC_CLIENT_ID=trust-center \
  -e OIDC_CLIENT_SECRET=dev-secret -e OIDC_ADMIN_GROUP=trust-center-admins \
  -v tc-storage:/data/storage trust-center:local
```

Note the `:5433` — host port 5432 belongs to an unrelated project on this machine.

- [x] **Step 8: Run everything and commit**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
git add -A
git commit -m "feat(deploy): production image, compose deployment, and self-hosting guide

adapter-node in a distroless nonroot image, with the migrations copied in and
applied at start — distroless has no shell, so the usual 'exec in and migrate'
does not exist. RUN_MIGRATIONS=false switches that off for operators running
more than one replica, who need a one-off migration job instead; two replicas
racing drizzle's migrator is a real failure mode and there is no advisory lock
around it.

Production dependencies are installed in their own stage with a hoisted node
linker, because pnpm's symlinked layout does not survive a COPY between
stages. The storage directory is created in the build stage so the runtime
volume inherits ownership a nonroot user can write to.

docs/self-hosting.md documents every variable, both worked OIDC setups, the
backup pair (a database restored without its storage volume lists documents
that will not download), and the reverse-proxy headers getClientAddress needs
— without them every audit event records the proxy's address instead of the
visitor's.

CI now builds the image and smoke-tests that it boots and serves the portal,
which is the only step that can catch a broken adapter, a missing runtime
dependency, or a migration that fails to apply. The redundant second build in
Playwright's webServer is gone."
```

---

## Definition of done

Phase 1 is complete when all of the following hold:

- `pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e` is green
  from a clean checkout, and `pnpm build` succeeds with no `.env` present.
- `docker compose up -d` from `docker-compose.yml` serves the portal, and a staff member can sign
  in through a real OIDC issuer, create content in both locales, and see it published.
- The permanent security tests pass: no cookies on the portal, no third-party requests, a CSP with
  no `unsafe-inline`, a gated document absent from HTML and from the sitemap, and every download
  writing exactly one audit event.
- Every user-facing string is in `messages/de.json` and `messages/en.json`, and no `.svelte` file
  contains a hardcoded German or English sentence.
- `docs/self-hosting.md` documents every environment variable the application reads.

## Whole-branch review

After Task 18, before merging, run a review over the complete branch diff rather than only the last
task — Phase 0's equivalent pass caught its three highest-value defects, all of them cross-task
issues no per-task review could see. Look specifically for:

- A public read model that filters on `tier`/`status`/`published`/`visibility` in one place and not
  another. Every one of these is a leak.
- A `recordEvent` call whose `meta` carries something that will become requester personal data in
  Phase 2 — the append-only trigger means it can never be corrected.
- An admin mutation with no audit event.
- A hardcoded `'de'` or `'en'` outside message catalogs and test fixtures.
- `getConfig()` or `getDb()` called at module scope anywhere.
- Any `$lib/server/...` import reaching a `.svelte` component.

## Carry-over to Phase 2

Record findings in `docs/superpowers/phase-2-carryover.md` as Phase 0 did, starting from the items
this plan did not fold in (`__Host-` cookie prefix, session revocation on re-login, auditing failed
OIDC callbacks, `staff_session.expires_at` index and cleanup, the route-level disabled-staff test)
and adding whatever the whole-branch review surfaces. Add explicitly: **whether Tasks 12–15 showed
that the Task 11 primitives should go further** toward spec §6.6's configuration-object ambition,
with the evidence either way.
