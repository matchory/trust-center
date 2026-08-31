# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Setup: `cp .env.example .env`, then `pnpm dev:up` (Postgres, Mailpit, dev OIDC provider), `pnpm install`, `pnpm db:migrate`, `pnpm dev`.

| Command | Notes |
| --- | --- |
| `pnpm lint` / `pnpm format` | prettier + eslint |
| `pnpm check` | compiles Paraglide messages, then `svelte-check` |
| `pnpm test:unit` | Node environment, no database, `tests/unit/**` |
| `pnpm test:integration` | Testcontainers Postgres, `tests/integration/**` |
| `pnpm test:e2e` | Playwright against a production preview build |
| `pnpm db:generate` / `pnpm db:migrate` | drizzle-kit; there is no `push` script, and none should be added (see Migrations) |

Running one test:

```sh
pnpm test:unit tests/unit/access-rules.test.ts        # extra args pass through to vitest
pnpm test:integration tests/integration/audit.test.ts -t 'append-only'
pnpm test:e2e tests/e2e/portal.spec.ts --project=app  # --project=origin runs origin.spec.ts only
```

Locally `pnpm test:e2e` rebuilds first (`pnpm build && pnpm preview`); under `CI=1` it assumes the build already happened. It also needs `pnpm dev:up` running — it mints its own throwaway database *inside* the dev Postgres and signs in against the dev IdP.

CI (`.github/workflows/ci.yml`) runs lint → check → build → unit → integration → e2e → Docker image smoke test. `pnpm check` and `pnpm build` deliberately run with **no `.env`**, proving the build needs neither secrets nor a database.

## Architecture

SvelteKit (Svelte 5 runes, adapter-node) + Postgres via Drizzle + postgres-js. Ships as one container; `docs/self-hosting.md` is the operator-facing reference and `docs/superpowers/specs/2026-08-28-trust-center-design.md` is the governing design (section numbers are cited in code comments — `spec §6.5` and the like). `docs/superpowers/phase-*-carryover.md` records measurements and known defects deliberately deferred.

### Layout

- `src/lib/server/**` — all server-only logic, grouped by concern: `access` (requests, rules, grants, expiry), `identity` (requester sessions, magic links), `auth` (OIDC, staff sessions, roles), `content` (the translatable content types plus branding), `delivery` (mediated download + PDF watermarking), `audit`, `mail` (queue + SMTP + templates), `jobs`, `storage`, `db`, `config`.
- `src/routes/(portal)/` — the public, cacheable, cookie-free trust portal, plus the gated `/access` subtree.
- `src/routes/(admin)/admin/` — staff area, guarded by `locals.staff` in its layout load.
- `src/lib/{content,access}-types.ts` — shared enums (tiers, statuses, rule actions) used by both schema and UI.

### Lazy singletons

`getConfig()`, `getDb()`, and `getStorage()` are memoised and instantiated on first call. Importing any of these modules must never open a connection or require a configured environment — `vite build` must work with an empty environment. Config is validated once in `hooks.server.ts`'s `init`, which exits the process on failure rather than 500ing every request.

### Locale routing (two layers)

This is the single most cross-cutting concern; touching it means reading `src/hooks.ts`, `src/hooks.server.ts`, `src/lib/i18n/locale.ts`, and `src/lib/i18n/compiled.ts` together.

- **`COMPILED_LOCALES`** is a build input — the catalogs Paraglide compiled. Prefix routing is *structural* and uses this list, so `/en/avv` 404s when English is disabled instead of degrading into a lookup for a document slugged `en`.
- **`getConfig().locales`** is the runtime subset an operator enabled via `LOCALES`, always a subset of the compiled set.
- `hooks.ts`'s `reroute` strips the prefix, so **`/de/documents` is not a route id**. Build page hrefs with `localizePath()`, never `resolve()`; eslint's `svelte/no-navigation-without-resolve` is relaxed for links for exactly this reason.
- Every page URL is locale-prefixed. The root layout load 302s unprefixed requests after negotiating `Accept-Language`, and only those responses get `Vary: Accept-Language`.
- `hooks.server.ts` overwrites Paraglide's server AsyncLocalStorage rather than using `paraglideMiddleware`. **`localeStorage.run` must stay the outermost wrapper around `resolve`**, or SSR translations silently fall back to the base locale.
- UI strings live in `messages/{locale}.json` (inlang message-format); `src/lib/paraglide/` is generated and gitignored — never edit it. Content translations live in per-type translation tables and resolve through `pickTranslation()`, which reports `isFallback` so the portal can label fallback content instead of silently mixing languages.

### Audit log

Append-only, enforced by Postgres triggers (`drizzle/0003`, `drizzle/0004`), not by convention: DELETE and TRUNCATE are blocked, and UPDATE may only *clear* `ip`, `ua`, and `actor_id` — the requester-erasure path. This rests on a companion invariant: **requester personal data appears in `audit_event` only in those three columns**, never in `meta` and never in `subject_id`. Keep it that way when adding events.

`recordEvent()` has no update or delete counterpart. `AuditActor` is a discriminated union so a `staff` actor's id is always a `staff_user.id` and never a raw OIDC `sub`. Action names are permanent once written — `translationAction()` and `resolveMetaAction()` in `src/lib/server/admin/actions.ts` own the naming convention. Reads are keyset-paginated on `seq`, never OFFSET.

### Sessions and cookies

Two independent identities on `event.locals`:

- `staff` — OIDC, role derived from IdP groups (`mapRole`), cookie is `__Host-`-prefixed at `Path=/`.
- `requester` — magic-link verified prospect, cookie is `__Secure-` and **scoped to `/{locale}/access`**, so no public route ever sets a cookie (asserted permanently in `tests/e2e/security.spec.ts`). Switching locale therefore goes through `access/switch` under the locale being *left*, which re-issues the cookie at the target path.

Set and delete options must match attribute for attribute or the deletion silently does nothing. `requesterCookieOptions(locale)` and `STAFF_COOKIE_OPTIONS` are the single source for both — do not inline cookie options at a call site.

### Document delivery

`src/lib/server/delivery/serve.ts` is the one mediated path out of storage, used by two routes that must stay distinct paths (not branches):

- `/api/documents/{fileId}` — `public` tier, streamed untouched, no session.
- `/{locale}/access/documents/{fileId}` — `request` tier, buffered and watermarked per recipient, requires a live grant; it lives under `/access` because that is where the requester cookie is scoped.

The caller-declared `tier` is applied as an equality in the query, so a new tier never widens access by omission. Storage keys are opaque and generated; `StorageAdapter` implementations must never expose a publicly reachable URL, and no method accepts a caller-supplied filename.

### Background jobs

`src/lib/server/jobs/index.ts` declares `JOBS` (mail drain, session cleanup, unverified-request sweep, expiry reminders, retention sweep) as `setInterval` timers started from `init`. Every tick runs under a transaction-scoped Postgres advisory lock (`runJob`), so multiple replicas are safe. `RUN_MIGRATIONS=false` and `RUN_JOBS=false` exist for operators who run migrations and workers separately; both default to on because the shipped deployment is a single container.

Mail is always queued to a table and drained by the job — nothing sends inline. A deployment with no `SMTP_URL` queues without draining, and that is a supported configuration (`MailNotConfigured` is swallowed by the job).

Rate limits live in Postgres (`src/lib/server/ratelimit.ts`) as a single upsert statement — no read-then-write, and no per-replica in-memory counter. Identifiers are hashed into the key so the table never becomes an index of who asked for what.

### Admin content editors

`saveMetaAction` / `saveTranslationAction` in `src/lib/server/admin/actions.ts` cover *translatable content types* (parse → update → `recordEvent`) and nothing more. Decision, revocation, erasure, and settings surfaces are not content editors and correctly bypass the helper — see `docs/superpowers/phase-3-carryover.md` before generalising it further.

## Migrations

`pnpm db:generate` produces SQL under `drizzle/`, but several migrations are hand-written or hand-extended with triggers and functions that Drizzle cannot express (`0003`, `0004`). Always read the generated SQL before committing, and keep the snapshot in `drizzle/meta/` consistent. Migrations run automatically at boot; the integration and e2e suites both migrate a fresh database from the same folder, so a migration that only works against an existing database will fail there.

## Conventions

- Tabs, single quotes, no trailing commas, 100-column print width (`.prettierrc`).
- Comments in this codebase explain *why a decision was made*, often naming the failure mode it prevents or a spec section. Match that: prefer a comment recording the reason over one restating the code.
- CSP is configured in `vite.config.ts` in `auto` mode with no third-party origins — the public portal makes no external requests and sets no cookies. Keep it that way; the e2e security spec enforces it.
