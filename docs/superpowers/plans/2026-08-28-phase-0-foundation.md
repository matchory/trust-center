# Trust Center Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the walking skeleton of the Trust Center — a SvelteKit application that boots from `docker compose up`, authenticates staff through OIDC with group-derived roles, records an append-only audit log, and serves localized routes — so that every later phase is feature work on a stable base.

**Architecture:** A single SvelteKit application backed by Postgres via Drizzle. Domain logic is written as pure functions over state (config parsing, locale fallback, role mapping) so it tests without a database; everything touching Postgres is tested against a real container via Testcontainers; the OIDC round trip is proven end-to-end against a local stub identity provider. No admin content types exist yet — this phase delivers the shell, the identity model, and the audit primitive.

**Tech Stack:** SvelteKit 2 (Svelte 5 runes), TypeScript strict, Postgres 16, Drizzle ORM + drizzle-kit, Tailwind CSS v4, Paraglide JS v2, `openid-client` v6, Zod, Vitest, `@testcontainers/postgresql`, Playwright, `node-oidc-provider` (dev only).

**Spec:** `docs/superpowers/specs/2026-08-28-trust-center-design.md`

## Global Constraints

Every task's requirements implicitly include this section. Values are copied from the spec.

- **TypeScript `strict: true`.** No `any` in committed code.
- **Svelte 5 runes syntax** (`$state`, `$derived`, `$props`). Not the Svelte 4 store/`export let` style.
- **Staff authentication is OIDC-only.** No password field, no credential column, no local account creation path may exist anywhere in the schema or code.
- **Two staff roles only:** `admin` (full rights) and `approver` (triage and decide access requests, no configuration rights).
- **Roles are re-evaluated on every login** from the IdP group claim, so IdP offboarding takes effect immediately.
- **Sessions are opaque server-side rows**, never JWTs. Only `sub`, email, name, and group claims are retained from the IdP; no access or refresh tokens are stored.
- **Session and magic-link tokens are stored hashed** (SHA-256), never in plaintext.
- **`audit_event` is append-only.** No code path may update or delete an audit event.
- **The public portal sets no cookies and loads no third-party resources.** No CDN fonts, no analytics scripts, no external CSS.
- **Locales are configured per deployment** via `PUBLIC_LOCALES` and `PUBLIC_DEFAULT_LOCALE`. Nothing may hardcode `de` or `en` outside message catalogs and test fixtures.
- **TDD throughout:** write the failing test, watch it fail, implement minimally, watch it pass, commit.
- **Commit after every task.** Conventional Commits format.
- **Licence: AGPL-3.0-or-later.** Task 1 adds the full `LICENSE` text and sets
  `"license": "AGPL-3.0-or-later"` in `package.json`.

## Deviations from the spec, with rationale

Two deliberate departures. Both are recorded here so they are visible to reviewers rather than discovered later.

1. **The dev identity provider is a `node-oidc-provider` stub, not Dex.** The spec named Dex. Dex's builtin connector cannot attach groups to `staticPasswords` users (dexidp/dex#1080, open since 2017; #3958 closed as duplicate), and our entire role model is group-claim-driven with two distinct roles to exercise. A ~70-line stub under `tools/dev-idp/` gives deterministic users, deterministic groups, and a fast container for CI. Any real OIDC provider works in production; the self-hosting docs will name Keycloak and Authentik as tested options.

2. **The application container arrives in Phase 1, not Phase 0.** The spec's Phase 0 description has compose bringing up the app alongside its dependencies. This plan runs the app on the host via `pnpm dev` and containerises only Postgres, Mailpit, and the IdP, because host-run dev gives HMR and a far faster edit loop. The production `Dockerfile` and the full single-command deployment land in Phase 1, in time for the v1.0 success criterion that requires them.

3. **Generic admin primitives move from Phase 0 to Phase 1.** The spec placed the filterable table, form scaffold, and locale tabs in Phase 0. A generic form scaffold cannot be sensibly designed before two real content types exist to generalize from; building it now would be speculative abstraction. Phase 1 builds documents first, controls second, and extracts the primitives from the pair.

---

## File Structure

```
docker-compose.dev.yml            Postgres, Mailpit, stub IdP
Dockerfile                        production image (added in Phase 1)
drizzle.config.ts                 drizzle-kit configuration
vitest.config.ts                  unit tests (node, no container)
vitest.integration.config.ts      integration tests (Testcontainers Postgres)
playwright.config.ts              end-to-end tests

tools/dev-idp/
  server.js                       node-oidc-provider stub, two users, two groups
  Dockerfile

src/lib/server/config/
  parse.ts                        parseConfig() — pure, validated, testable
  index.ts                        the process.env singleton

src/lib/server/db/
  index.ts                        connection + Drizzle instance factory
  schema/index.ts                 barrel re-export
  schema/setting.ts               setting table
  schema/audit.ts                 audit_event table
  schema/staff.ts                 staff_user, staff_session tables

src/lib/server/audit/index.ts     recordEvent(), queryEvents()

src/lib/server/auth/
  roles.ts                        mapRole() — pure
  session.ts                      create/validate/revoke staff sessions
  oidc.ts                         discovery, authorization URL, code exchange

src/lib/i18n/
  locales.ts                      configured locale set from public env
  locale.ts                       resolveLocale(), stripLocale(), pickTranslation()

src/hooks.ts                      reroute — strips the locale prefix
src/hooks.server.ts               session resolution into locals
src/routes/auth/login/+server.ts
src/routes/auth/callback/+server.ts
src/routes/auth/logout/+server.ts
src/routes/(admin)/+layout.server.ts   role guard
src/routes/(admin)/+layout.svelte      admin shell
src/routes/(admin)/+page.svelte        admin landing

tests/unit/                       pure-function tests
tests/integration/                database-backed tests
tests/setup/pg.ts                 Testcontainers global setup
tests/e2e/                        Playwright specs
```

---

### Task 1: Project scaffold, tooling, and CI

**Files:**
- Create: `package.json`, `svelte.config.js`, `vite.config.ts`, `tsconfig.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`, `src/app.html`, `src/app.css`, `src/routes/+layout.svelte`, `src/routes/+page.svelte`
- Create: `tests/unit/smoke.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: a working `pnpm dev`, `pnpm test:unit`, `pnpm lint`, `pnpm check` toolchain that all later tasks rely on

- [ ] **Step 1: Scaffold the SvelteKit project**

```bash
cd /Users/moritz/Projects/matchory-trust-center
pnpm dlx sv create . --template minimal --types ts --no-add-ons --install pnpm
curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE
```

Then set `"license": "AGPL-3.0-or-later"` in `package.json`.

If the directory-not-empty prompt appears, accept continuing — `docs/` and `.git/` are expected to be present.

- [ ] **Step 2: Add the remaining dependencies**

```bash
pnpm add zod drizzle-orm postgres openid-client
pnpm add -D drizzle-kit vitest @testcontainers/postgresql @playwright/test \
  tailwindcss @tailwindcss/vite prettier eslint typescript-eslint \
  eslint-plugin-svelte @types/node
pnpm exec playwright install chromium
```

`openid-client` MUST resolve to v6 or later. v6 renamed the exports this plan uses (`discovery`, `buildAuthorizationUrl`, `authorizationCodeGrant`); if `pnpm why openid-client` shows v5, run `pnpm add openid-client@^6`.

- [ ] **Step 3: Set TypeScript to strict**

In `tsconfig.json`, inside `compilerOptions`, ensure:

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 4: Wire Tailwind into Vite**

`vite.config.ts`:

```ts
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()]
});
```

`src/app.css`:

```css
@import 'tailwindcss';
```

`src/routes/+layout.svelte`:

```svelte
<script lang="ts">
  import '../app.css';
  let { children } = $props();
</script>

{@render children()}
```

- [ ] **Step 5: Add the unit test configuration**

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts']
  }
});
```

- [ ] **Step 6: Write the failing smoke test**

`tests/unit/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { projectName } from '../../src/lib/meta';

describe('project metadata', () => {
  it('exposes the project name', () => {
    expect(projectName).toBe('trust-center');
  });
});
```

- [ ] **Step 7: Run it to confirm it fails**

Run: `pnpm vitest run --config vitest.config.ts`
Expected: FAIL — cannot resolve `../../src/lib/meta`.

- [ ] **Step 8: Implement minimally**

`src/lib/meta.ts`:

```ts
export const projectName = 'trust-center';
```

- [ ] **Step 9: Add the scripts and confirm the test passes**

In `package.json` `scripts`:

```json
{
  "dev": "vite dev",
  "build": "vite build",
  "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
  "lint": "prettier --check . && eslint .",
  "format": "prettier --write .",
  "test:unit": "vitest run --config vitest.config.ts",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "test:e2e": "playwright test"
}
```

Run: `pnpm test:unit`
Expected: PASS, 1 test.

- [ ] **Step 10: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm check
      - run: pnpm test:unit
      - run: pnpm test:integration
```

The `test:integration` step will fail until Task 4 creates its configuration file; that is expected and is fixed there.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: scaffold SvelteKit project with tooling and CI"
```

---

### Task 2: Environment configuration

**Files:**
- Create: `src/lib/server/config/parse.ts`
- Create: `src/lib/server/config/index.ts`
- Create: `tests/unit/config.test.ts`
- Create: `.env.example`

**Interfaces:**
- Consumes: nothing
- Produces: `parseConfig(env: Record<string, string | undefined>): AppConfig` and the `config` singleton. `AppConfig` fields used by later tasks: `databaseUrl`, `publicBaseUrl`, `oidc.issuer`, `oidc.clientId`, `oidc.clientSecret`, `oidc.groupsClaim`, `oidc.adminGroup`, `oidc.approverGroup`, `sessionTtlHours`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/server/config/parse';

const valid = {
  DATABASE_URL: 'postgres://tc:tc@localhost:5432/tc',
  PUBLIC_BASE_URL: 'https://trust.example.com',
  OIDC_ISSUER: 'https://idp.example.com',
  OIDC_CLIENT_ID: 'trust-center',
  OIDC_CLIENT_SECRET: 'secret',
  OIDC_ADMIN_GROUP: 'trust-center-admins'
};

describe('parseConfig', () => {
  it('parses a valid environment', () => {
    const config = parseConfig(valid);
    expect(config.databaseUrl).toBe('postgres://tc:tc@localhost:5432/tc');
    expect(config.oidc.adminGroup).toBe('trust-center-admins');
  });

  it('defaults the groups claim to "groups"', () => {
    expect(parseConfig(valid).oidc.groupsClaim).toBe('groups');
  });

  it('defaults the session TTL to 12 hours', () => {
    expect(parseConfig(valid).sessionTtlHours).toBe(12);
  });

  it('leaves the approver group undefined when unset', () => {
    expect(parseConfig(valid).oidc.approverGroup).toBeUndefined();
  });

  it('names every missing variable in one error', () => {
    expect(() => parseConfig({})).toThrowError(
      /DATABASE_URL[\s\S]*OIDC_CLIENT_ID[\s\S]*PUBLIC_BASE_URL/
    );
  });

  it('rejects a non-URL issuer', () => {
    expect(() => parseConfig({ ...valid, OIDC_ISSUER: 'not-a-url' })).toThrowError(/OIDC_ISSUER/);
  });

  it('rejects a non-numeric session TTL', () => {
    expect(() => parseConfig({ ...valid, SESSION_TTL_HOURS: 'twelve' })).toThrowError(
      /SESSION_TTL_HOURS/
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit`
Expected: FAIL — cannot resolve `src/lib/server/config/parse`.

- [ ] **Step 3: Implement the parser**

`src/lib/server/config/parse.ts`:

```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url(),
  OIDC_ISSUER: z.string().url(),
  OIDC_CLIENT_ID: z.string().min(1),
  OIDC_CLIENT_SECRET: z.string().min(1),
  OIDC_ADMIN_GROUP: z.string().min(1),
  OIDC_APPROVER_GROUP: z.string().min(1).optional(),
  OIDC_GROUPS_CLAIM: z.string().min(1).default('groups'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12)
});

export interface AppConfig {
  databaseUrl: string;
  publicBaseUrl: string;
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

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(env);

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
    publicBaseUrl: parsed.PUBLIC_BASE_URL,
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

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm test:unit`
Expected: PASS, 8 tests.

- [ ] **Step 5: Add the singleton and the example environment**

`src/lib/server/config/index.ts`:

```ts
import { parseConfig } from './parse';

export const config = parseConfig(process.env);
export type { AppConfig } from './parse';
```

`.env.example`:

```bash
DATABASE_URL=postgres://trustcenter:trustcenter@localhost:5432/trustcenter
PUBLIC_BASE_URL=http://localhost:5173

OIDC_ISSUER=http://localhost:5556
OIDC_CLIENT_ID=trust-center
OIDC_CLIENT_SECRET=dev-secret
OIDC_ADMIN_GROUP=trust-center-admins
OIDC_APPROVER_GROUP=trust-center-approvers

PUBLIC_LOCALES=de,en
PUBLIC_DEFAULT_LOCALE=de
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add validated environment configuration"
```

---

### Task 3: Development environment

**Files:**
- Create: `docker-compose.dev.yml`
- Create: `tools/dev-idp/server.js`
- Create: `tools/dev-idp/package.json`
- Create: `tools/dev-idp/Dockerfile`

**Interfaces:**
- Consumes: the environment variable names from Task 2
- Produces: a Postgres instance on `localhost:5432`, Mailpit on `localhost:8025`, and an OIDC issuer on `http://localhost:5556` serving two users: `admin@example.test` (group `trust-center-admins`) and `approver@example.test` (group `trust-center-approvers`), both with password `password`.

- [ ] **Step 1: Write the stub identity provider**

`tools/dev-idp/package.json`:

```json
{
  "name": "trust-center-dev-idp",
  "private": true,
  "type": "module",
  "dependencies": {
    "oidc-provider": "^8.5.1"
  }
}
```

`tools/dev-idp/server.js`:

```js
import Provider from 'oidc-provider';

const ISSUER = process.env.ISSUER ?? 'http://localhost:5556';
const REDIRECT_URI = process.env.REDIRECT_URI ?? 'http://localhost:5173/auth/callback';

const USERS = {
  'admin@example.test': {
    sub: 'admin',
    email: 'admin@example.test',
    name: 'Ada Admin',
    groups: ['trust-center-admins']
  },
  'approver@example.test': {
    sub: 'approver',
    email: 'approver@example.test',
    name: 'Arno Approver',
    groups: ['trust-center-approvers']
  },
  'nobody@example.test': {
    sub: 'nobody',
    email: 'nobody@example.test',
    name: 'Nora Nobody',
    groups: []
  }
};

const BY_SUB = Object.fromEntries(Object.values(USERS).map((u) => [u.sub, u]));

const provider = new Provider(ISSUER, {
  clients: [
    {
      client_id: 'trust-center',
      client_secret: 'dev-secret',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code']
    }
  ],
  pkce: { required: () => true },
  scopes: ['openid', 'email', 'profile', 'groups'],
  claims: {
    openid: ['sub'],
    email: ['email'],
    profile: ['name'],
    groups: ['groups']
  },
  // With the default conformIdTokenClaims:true, the authorization-code flow
  // restricts the ID token to `sub` and serves email/groups from userinfo only.
  // completeLogin() reads claims straight off the ID token, so disable it.
  conformIdTokenClaims: false,
  features: {
    devInteractions: { enabled: true }
  },
  async findAccount(_ctx, id) {
    const user = BY_SUB[id];
    if (!user) return undefined;
    return {
      accountId: id,
      async claims() {
        return { sub: user.sub, email: user.email, name: user.name, groups: user.groups };
      }
    };
  }
});

// The built-in dev interaction screen accepts any password; the login name
// selects which fixture account is returned.
provider.listen(5556, () => {
  console.log(`dev-idp listening on ${ISSUER}`);
});
```

The built-in developer interaction accepts any password, so tests log in with the account `sub` (`admin`, `approver`, or `nobody`) and any password.

`tools/dev-idp/Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
EXPOSE 5556
CMD ["node", "server.js"]
```

- [ ] **Step 2: Write the compose file**

`docker-compose.dev.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: trustcenter
      POSTGRES_PASSWORD: trustcenter
      POSTGRES_DB: trustcenter
    ports:
      - '5432:5432'
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U trustcenter']
      interval: 2s
      timeout: 3s
      retries: 15
    volumes:
      - pgdata:/var/lib/postgresql/data

  mailpit:
    image: axllent/mailpit:latest
    ports:
      - '1025:1025'
      - '8025:8025'

  dev-idp:
    build: ./tools/dev-idp
    environment:
      ISSUER: http://localhost:5556
      REDIRECT_URI: http://localhost:5173/auth/callback
    ports:
      - '5556:5556'

volumes:
  pgdata:
```

- [ ] **Step 3: Bring the environment up**

```bash
docker compose -f docker-compose.dev.yml up -d --build
```

- [ ] **Step 4: Verify all three services, including the groups claim support**

```bash
pg_isready -h localhost -p 5432 -U trustcenter
curl -fsS http://localhost:8025/api/v1/messages >/dev/null && echo "mailpit ok"
curl -fsS http://localhost:5556/.well-known/openid-configuration | head -c 200
```

Expected: `accepting connections`, `mailpit ok`, and a JSON document whose `scopes_supported` includes `groups`. The final check is the reason this stub exists instead of Dex — confirm `groups` is present before continuing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add development environment with Postgres, Mailpit, and a stub OIDC provider"
```

---

### Task 4: Database layer, migrations, and the integration test harness

**Files:**
- Create: `drizzle.config.ts`
- Create: `src/lib/server/db/index.ts`
- Create: `src/lib/server/db/schema/setting.ts`
- Create: `src/lib/server/db/schema/index.ts`
- Create: `tests/setup/pg.ts`
- Create: `vitest.integration.config.ts`
- Create: `tests/integration/setting.test.ts`

**Interfaces:**
- Consumes: `config.databaseUrl` from Task 2
- Produces: `createDb(url: string): Db` where `Db` is `PostgresJsDatabase<typeof schema>`; and the `setting` table with columns `key` (primary key) and `value` (jsonb). Integration tests read `process.env.TEST_DATABASE_URL` (set by the global setup) in their own `beforeAll`.

- [ ] **Step 1: Define the first schema and the connection factory**

`src/lib/server/db/schema/setting.ts`:

```ts
import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const setting = pgTable('setting', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
```

`src/lib/server/db/schema/index.ts`:

```ts
export * from './setting';
```

`src/lib/server/db/index.ts`:

```ts
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
  const sql = postgres(url, { max: 10 });
  return { db: drizzle(sql, { schema }), close: () => sql.end() };
}

export { schema };
```

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/server/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://trustcenter:trustcenter@localhost:5432/trustcenter'
  }
});
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm exec drizzle-kit generate --name init
```

Expected: a new SQL file under `drizzle/` creating the `setting` table.

- [ ] **Step 3: Write the Testcontainers harness**

`tests/setup/pg.ts`:

```ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../../src/lib/server/db';

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const url = container.getConnectionUri();
  process.env.TEST_DATABASE_URL = url;

  const { db, close } = createDb(url);
  await migrate(db, { migrationsFolder: './drizzle' });
  await close();
}

export async function teardown() {
  await container?.stop();
}
```

- [ ] **Step 4: Write the integration test configuration**

`vitest.integration.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['./tests/setup/pg.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
    // Serialize test files: they share one Testcontainers Postgres. On Vitest 4 this
    // is `fileParallelism`, NOT `poolOptions.forks.singleFork` — that option is read
    // only to emit a deprecation warning and does not configure the pool.
    fileParallelism: false
  }
});
```

- [ ] **Step 5: Write the failing integration test**

`tests/integration/setting.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '../../src/lib/server/db';

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

describe('setting table', () => {
  it('round-trips a jsonb value', async () => {
    await db.insert(schema.setting).values({ key: 'branding', value: { primary: '#0b3d2e' } });

    const rows = await db.select().from(schema.setting).where(eq(schema.setting.key, 'branding'));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual({ primary: '#0b3d2e' });
  });

  it('rejects a duplicate key', async () => {
    await db.insert(schema.setting).values({ key: 'locales', value: ['de', 'en'] });

    await expect(
      db.insert(schema.setting).values({ key: 'locales', value: ['fr'] })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run and confirm it passes**

Run: `pnpm test:integration`
Expected: PASS, 2 tests. Docker must be running; the first run pulls `postgres:16-alpine`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add Drizzle database layer with a Testcontainers integration harness"
```

---

### Task 5: Append-only audit log

**Files:**
- Create: `src/lib/server/db/schema/audit.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Create: `src/lib/server/audit/index.ts`
- Create: `tests/integration/audit.test.ts`

**Interfaces:**
- Consumes: `Db`, `schema` from Task 4
- Produces:
  - `type AuditActor = { type: 'staff' | 'requester' | 'system'; id: string | null }`
  - `recordEvent(db: Db, input: AuditEventInput): Promise<void>` where `AuditEventInput = { action: string; actor: AuditActor; subjectType?: string; subjectId?: string; ip?: string; ua?: string; requestId?: string; meta?: Record<string, unknown> }`
  - `queryEvents(db: Db, filter: { subjectType?: string; subjectId?: string; actorId?: string; limit?: number }): Promise<AuditEventRow[]>`

- [ ] **Step 1: Define the schema**

`src/lib/server/db/schema/audit.ts`:

```ts
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    ip: text('ip'),
    ua: text('ua'),
    requestId: text('request_id'),
    meta: jsonb('meta')
  },
  (table) => [
    index('audit_event_subject_idx').on(table.subjectType, table.subjectId),
    index('audit_event_at_idx').on(table.at),
    index('audit_event_actor_idx').on(table.actorType, table.actorId)
  ]
);
```

Add `export * from './audit';` to `src/lib/server/db/schema/index.ts`.

- [ ] **Step 2: Write the failing tests**

`tests/integration/audit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { queryEvents, recordEvent } from '../../src/lib/server/audit';

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

describe('audit log', () => {
  it('records an event and reads it back by subject', async () => {
    await recordEvent(db, {
      action: 'document.downloaded',
      actor: { type: 'requester', id: 'req-1' },
      subjectType: 'document',
      subjectId: 'doc-42',
      ip: '198.51.100.7',
      meta: { version: 3 }
    });

    const events = await queryEvents(db, { subjectType: 'document', subjectId: 'doc-42' });

    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('document.downloaded');
    expect(events[0]?.actorId).toBe('req-1');
    expect(events[0]?.meta).toEqual({ version: 3 });
    expect(events[0]?.at).toBeInstanceOf(Date);
  });

  it('accepts a system actor without an id', async () => {
    await recordEvent(db, {
      action: 'grant.expired',
      actor: { type: 'system', id: null },
      subjectType: 'grant',
      subjectId: 'grant-9'
    });

    const events = await queryEvents(db, { subjectType: 'grant', subjectId: 'grant-9' });

    expect(events[0]?.actorType).toBe('system');
    expect(events[0]?.actorId).toBeNull();
  });

  it('returns events newest first and honours the limit', async () => {
    for (const n of [1, 2, 3]) {
      await recordEvent(db, {
        action: `staff.login.${n}`,
        actor: { type: 'staff', id: 'staff-ordering' },
        subjectType: 'staff',
        subjectId: 'ordering'
      });
    }

    const events = await queryEvents(db, { subjectType: 'staff', subjectId: 'ordering', limit: 2 });

    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe('staff.login.3');
    expect(events[1]?.action).toBe('staff.login.2');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test:integration`
Expected: FAIL — cannot resolve `src/lib/server/audit`.

- [ ] **Step 4: Implement the module**

`src/lib/server/audit/index.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';
import { auditEvent } from '../db/schema';
import type { Db } from '../db';

export type AuditActor = {
  type: 'staff' | 'requester' | 'system';
  id: string | null;
};

export interface AuditEventInput {
  action: string;
  actor: AuditActor;
  subjectType?: string;
  subjectId?: string;
  ip?: string;
  ua?: string;
  requestId?: string;
  meta?: Record<string, unknown>;
}

export type AuditEventRow = typeof auditEvent.$inferSelect;

/**
 * Appends an event to the audit log. There is deliberately no update or
 * delete counterpart: the log is append-only.
 */
export async function recordEvent(db: Db, input: AuditEventInput): Promise<void> {
  await db.insert(auditEvent).values({
    action: input.action,
    actorType: input.actor.type,
    actorId: input.actor.id,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    ip: input.ip ?? null,
    ua: input.ua ?? null,
    requestId: input.requestId ?? null,
    meta: input.meta ?? null
  });
}

export async function queryEvents(
  db: Db,
  filter: {
    subjectType?: string;
    subjectId?: string;
    actorId?: string;
    limit?: number;
  }
): Promise<AuditEventRow[]> {
  const conditions = [];
  if (filter.subjectType) conditions.push(eq(auditEvent.subjectType, filter.subjectType));
  if (filter.subjectId) conditions.push(eq(auditEvent.subjectId, filter.subjectId));
  if (filter.actorId) conditions.push(eq(auditEvent.actorId, filter.actorId));

  return db
    .select()
    .from(auditEvent)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(auditEvent.at), desc(auditEvent.id))
    .limit(filter.limit ?? 100);
}
```

- [ ] **Step 5: Generate the migration and run the tests**

```bash
pnpm exec drizzle-kit generate --name audit_event
pnpm test:integration
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add append-only audit log"
```

---

### Task 6: Locale resolution and translation fallback

**Files:**
- Create: `src/lib/i18n/locales.ts`
- Create: `src/lib/i18n/locale.ts`
- Create: `tests/unit/locale.test.ts`

**Interfaces:**
- Consumes: `PUBLIC_LOCALES`, `PUBLIC_DEFAULT_LOCALE`
- Produces:
  - `stripLocale(pathname: string, locales: readonly string[]): { locale: string | null; path: string }`
  - `resolveLocale(input: { pathLocale: string | null; acceptLanguage?: string }, locales: readonly string[], defaultLocale: string): string`
  - `pickTranslation<T>(translations: readonly { locale: string; value: T }[], requested: string, defaultLocale: string): { value: T; locale: string; isFallback: boolean } | null`

- [ ] **Step 1: Write the failing tests**

`tests/unit/locale.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pickTranslation, resolveLocale, stripLocale } from '../../src/lib/i18n/locale';

const LOCALES = ['de', 'en'] as const;

describe('stripLocale', () => {
  it('extracts a known locale prefix', () => {
    expect(stripLocale('/de/dokumente', LOCALES)).toEqual({ locale: 'de', path: '/dokumente' });
  });

  it('returns the bare path when the prefix is not a known locale', () => {
    expect(stripLocale('/documents', LOCALES)).toEqual({ locale: null, path: '/documents' });
  });

  it('normalises a bare locale root to "/"', () => {
    expect(stripLocale('/en', LOCALES)).toEqual({ locale: 'en', path: '/' });
  });

  it('does not treat a longer segment starting with a locale as a prefix', () => {
    expect(stripLocale('/denmark', LOCALES)).toEqual({ locale: null, path: '/denmark' });
  });
});

describe('resolveLocale', () => {
  it('prefers the path locale', () => {
    expect(resolveLocale({ pathLocale: 'en', acceptLanguage: 'de-DE' }, LOCALES, 'de')).toBe('en');
  });

  it('falls back to Accept-Language when there is no path locale', () => {
    expect(
      resolveLocale({ pathLocale: null, acceptLanguage: 'en-GB,en;q=0.9' }, LOCALES, 'de')
    ).toBe('en');
  });

  it('falls back to the default locale for an unsupported language', () => {
    expect(resolveLocale({ pathLocale: null, acceptLanguage: 'fr-FR' }, LOCALES, 'de')).toBe('de');
  });

  it('falls back to the default locale when Accept-Language is absent', () => {
    expect(resolveLocale({ pathLocale: null }, LOCALES, 'de')).toBe('de');
  });
});

describe('pickTranslation', () => {
  const translations = [
    { locale: 'de', value: 'Auftragsverarbeitungsvertrag' },
    { locale: 'en', value: 'Data Processing Agreement' }
  ];

  it('returns the exact match without a fallback flag', () => {
    expect(pickTranslation(translations, 'de', 'de')).toEqual({
      value: 'Auftragsverarbeitungsvertrag',
      locale: 'de',
      isFallback: false
    });
  });

  it('falls back to the default locale and flags it', () => {
    const englishOnly = [{ locale: 'en', value: 'Penetration Test Report' }];

    expect(pickTranslation(englishOnly, 'de', 'en')).toEqual({
      value: 'Penetration Test Report',
      locale: 'en',
      isFallback: true
    });
  });

  it('returns null when neither the requested nor the default locale exists', () => {
    expect(pickTranslation([{ locale: 'fr', value: 'Rapport' }], 'de', 'en')).toBeNull();
  });

  it('returns null for an empty translation set', () => {
    expect(pickTranslation([], 'de', 'en')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit`
Expected: FAIL — cannot resolve `src/lib/i18n/locale`.

- [ ] **Step 3: Implement**

`src/lib/i18n/locale.ts`:

```ts
export interface StrippedPath {
  locale: string | null;
  path: string;
}

export function stripLocale(pathname: string, locales: readonly string[]): StrippedPath {
  const segments = pathname.split('/');
  const candidate = segments[1];

  if (candidate === undefined || !locales.includes(candidate)) {
    return { locale: null, path: pathname };
  }

  const rest = `/${segments.slice(2).join('/')}`;
  return { locale: candidate, path: rest === '/' ? '/' : rest.replace(/\/$/, '') };
}

function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='))
        ?.slice(2);
      return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number.parseFloat(q) };
    })
    .filter((entry) => entry.tag.length > 0 && !Number.isNaN(entry.q))
    .sort((a, b) => b.q - a.q)
    .map((entry) => entry.tag);
}

export function resolveLocale(
  input: { pathLocale: string | null; acceptLanguage?: string },
  locales: readonly string[],
  defaultLocale: string
): string {
  if (input.pathLocale !== null && locales.includes(input.pathLocale)) {
    return input.pathLocale;
  }

  if (input.acceptLanguage) {
    for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
      const base = tag.split('-')[0];
      const match = locales.find((locale) => locale === tag || locale === base);
      if (match) return match;
    }
  }

  return defaultLocale;
}

export interface PickedTranslation<T> {
  value: T;
  locale: string;
  isFallback: boolean;
}

/**
 * Resolves the best available translation. Partial translation is the normal
 * steady state, so a fallback to the default locale is expected — but callers
 * must be able to tell, because the portal labels fallback content rather than
 * silently mixing languages.
 */
export function pickTranslation<T>(
  translations: readonly { locale: string; value: T }[],
  requested: string,
  defaultLocale: string
): PickedTranslation<T> | null {
  const exact = translations.find((t) => t.locale === requested);
  if (exact) return { value: exact.value, locale: exact.locale, isFallback: false };

  const fallback = translations.find((t) => t.locale === defaultLocale);
  if (fallback) return { value: fallback.value, locale: fallback.locale, isFallback: true };

  return null;
}
```

`src/lib/i18n/locales.ts`:

```ts
import { PUBLIC_DEFAULT_LOCALE, PUBLIC_LOCALES } from '$env/static/public';

export const LOCALES: readonly string[] = PUBLIC_LOCALES.split(',').map((l) => l.trim());
export const DEFAULT_LOCALE: string = PUBLIC_DEFAULT_LOCALE;

if (!LOCALES.includes(DEFAULT_LOCALE)) {
  throw new Error(
    `PUBLIC_DEFAULT_LOCALE "${DEFAULT_LOCALE}" is not present in PUBLIC_LOCALES "${PUBLIC_LOCALES}"`
  );
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm test:unit`
Expected: PASS, 20 tests total.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add locale resolution and translation fallback"
```

---

### Task 7: Message catalogs and locale routing

**Files:**
- Create: `project.inlang/settings.json`
- Create: `messages/de.json`, `messages/en.json`
- Modify: `vite.config.ts`
- Create: `src/hooks.ts`
- Modify: `src/routes/+layout.svelte`
- Create: `src/routes/+layout.server.ts`
- Modify: `src/routes/+page.svelte`
- Create: `tests/e2e/locale.spec.ts`
- Create: `playwright.config.ts`

**Interfaces:**
- Consumes: `stripLocale`, `resolveLocale`, `LOCALES`, `DEFAULT_LOCALE` from Task 6
- Produces: `event.locals.locale` set on every request; `/de/...` and `/en/...` routing

- [ ] **Step 1: Configure Paraglide**

`project.inlang/settings.json`:

```json
{
  "$schema": "https://inlang.com/schema/project-settings",
  "baseLocale": "de",
  "locales": ["de", "en"],
  "modules": [
    "https://cdn.jsdelivr.net/npm/@inlang/plugin-message-format@4/dist/index.js"
  ],
  "plugin.inlang.messageFormat": {
    "pathPattern": "./messages/{locale}.json"
  }
}
```

`messages/de.json`:

```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "site_title": "Trust Center",
  "nav_admin": "Verwaltung",
  "admin_sign_in": "Anmelden",
  "admin_sign_out": "Abmelden"
}
```

`messages/en.json`:

```json
{
  "$schema": "https://inlang.com/schema/inlang-message-format",
  "site_title": "Trust Center",
  "nav_admin": "Administration",
  "admin_sign_in": "Sign in",
  "admin_sign_out": "Sign out"
}
```

Install and wire the plugin:

```bash
pnpm add -D @inlang/paraglide-js
```

`vite.config.ts` — add the Paraglide plugin ahead of SvelteKit:

```ts
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['url', 'preferredLanguage', 'baseLocale']
    }),
    tailwindcss(),
    sveltekit()
  ]
});
```

Add `src/lib/paraglide` to `.gitignore` — it is generated output.

- [ ] **Step 2: Add the reroute hook**

`src/hooks.ts`:

```ts
import type { Reroute } from '@sveltejs/kit';
import { LOCALES } from '$lib/i18n/locales';
import { stripLocale } from '$lib/i18n/locale';

export const reroute: Reroute = ({ url }) => stripLocale(url.pathname, LOCALES).path;
```

- [ ] **Step 3: Expose the locale through locals and layout data**

Add to `src/app.d.ts` inside `declare global { namespace App { ... } }`:

```ts
interface Locals {
  locale: string;
}
```

`src/hooks.server.ts`:

```ts
import type { Handle } from '@sveltejs/kit';
import { DEFAULT_LOCALE, LOCALES } from '$lib/i18n/locales';
import { resolveLocale, stripLocale } from '$lib/i18n/locale';

export const handle: Handle = async ({ event, resolve }) => {
  const { locale: pathLocale } = stripLocale(event.url.pathname, LOCALES);

  event.locals.locale = resolveLocale(
    { pathLocale, acceptLanguage: event.request.headers.get('accept-language') ?? undefined },
    LOCALES,
    DEFAULT_LOCALE
  );

  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.locale)
  });
};
```

In `src/app.html`, change `<html lang="en">` to `<html lang="%lang%">`.

`src/routes/+layout.server.ts`:

```ts
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({ locale: locals.locale });
```

`src/routes/+page.svelte`:

```svelte
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
</script>

<h1 data-testid="site-title">{m.site_title()}</h1>
<p data-testid="admin-link-label">{m.nav_admin()}</p>
```

- [ ] **Step 4: Write the failing end-to-end test**

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: { baseURL: 'http://localhost:5173' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
```

`tests/e2e/locale.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test('serves German at the default root', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('admin-link-label')).toHaveText('Verwaltung');
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
});

test('serves English under the /en prefix', async ({ page }) => {
  await page.goto('/en');
  await expect(page.getByTestId('admin-link-label')).toHaveText('Administration');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('sets no cookies on the public portal', async ({ page, context }) => {
  await page.goto('/');
  expect(await context.cookies()).toHaveLength(0);
});
```

- [ ] **Step 5: Run to verify the tests fail, then pass**

Run: `pnpm test:e2e`
Expected before implementation is complete: FAIL. After Steps 1–3 are in place, re-run.
Expected: PASS, 3 tests.

The third test enforces a global constraint: the public portal must set no cookies. It stays in the suite permanently.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add message catalogs and locale-prefixed routing"
```

---

### Task 8: OIDC role mapping

**Files:**
- Create: `src/lib/server/auth/roles.ts`
- Create: `tests/unit/roles.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type StaffRole = 'admin' | 'approver'`
  - `mapRole(groups: readonly string[], adminGroup: string, approverGroup: string | undefined): StaffRole | null`
  - `extractGroups(claims: Record<string, unknown>, groupsClaim: string): string[]`

- [ ] **Step 1: Write the failing tests**

`tests/unit/roles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractGroups, mapRole } from '../../src/lib/server/auth/roles';

describe('mapRole', () => {
  it('maps the admin group to admin', () => {
    expect(mapRole(['trust-center-admins'], 'trust-center-admins', 'trust-center-approvers')).toBe(
      'admin'
    );
  });

  it('maps the approver group to approver', () => {
    expect(
      mapRole(['trust-center-approvers'], 'trust-center-admins', 'trust-center-approvers')
    ).toBe('approver');
  });

  it('prefers admin when the user is in both groups', () => {
    expect(
      mapRole(
        ['trust-center-approvers', 'trust-center-admins'],
        'trust-center-admins',
        'trust-center-approvers'
      )
    ).toBe('admin');
  });

  it('returns null when the user is in no mapped group', () => {
    expect(mapRole(['engineering'], 'trust-center-admins', 'trust-center-approvers')).toBeNull();
  });

  it('returns null for an empty group list', () => {
    expect(mapRole([], 'trust-center-admins', 'trust-center-approvers')).toBeNull();
  });

  it('returns null for the approver group when no approver group is configured', () => {
    expect(mapRole(['trust-center-approvers'], 'trust-center-admins', undefined)).toBeNull();
  });
});

describe('extractGroups', () => {
  it('reads a string array claim', () => {
    expect(extractGroups({ groups: ['a', 'b'] }, 'groups')).toEqual(['a', 'b']);
  });

  it('wraps a single string claim', () => {
    expect(extractGroups({ groups: 'a' }, 'groups')).toEqual(['a']);
  });

  it('honours a custom claim name', () => {
    expect(extractGroups({ roles: ['x'] }, 'roles')).toEqual(['x']);
  });

  it('returns an empty array when the claim is absent', () => {
    expect(extractGroups({}, 'groups')).toEqual([]);
  });

  it('discards non-string entries', () => {
    expect(extractGroups({ groups: ['a', 1, null, 'b'] }, 'groups')).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit`
Expected: FAIL — cannot resolve `src/lib/server/auth/roles`.

- [ ] **Step 3: Implement**

`src/lib/server/auth/roles.ts`:

```ts
export type StaffRole = 'admin' | 'approver';

/**
 * Derives the staff role from IdP group membership. Returning null means the
 * user authenticated successfully but is not authorised to use the admin area.
 * Admin wins over approver when both groups are present.
 */
export function mapRole(
  groups: readonly string[],
  adminGroup: string,
  approverGroup: string | undefined
): StaffRole | null {
  if (groups.includes(adminGroup)) return 'admin';
  if (approverGroup !== undefined && groups.includes(approverGroup)) return 'approver';
  return null;
}

export function extractGroups(claims: Record<string, unknown>, groupsClaim: string): string[] {
  const raw = claims[groupsClaim];

  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  return [];
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `pnpm test:unit`
Expected: PASS, 31 tests total.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add OIDC group to staff role mapping"
```

---

### Task 9: Staff users and sessions

**Files:**
- Create: `src/lib/server/db/schema/staff.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Create: `src/lib/server/auth/session.ts`
- Create: `tests/integration/session.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 4), `StaffRole` (Task 8), `recordEvent` (Task 5)
- Produces:
  - `upsertStaffUser(db, { oidcSub, email, name, role }): Promise<StaffUser>`
  - `createStaffSession(db, { staffUserId, ttlHours, ip, ua }): Promise<{ token: string; expiresAt: Date }>`
  - `validateStaffSession(db, token): Promise<{ user: StaffUser; expiresAt: Date } | null>`
  - `revokeStaffSession(db, token): Promise<void>`
  - `SESSION_COOKIE = 'tc_staff_session'`

- [ ] **Step 1: Define the schema**

`src/lib/server/db/schema/staff.ts`:

```ts
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const staffUser = pgTable('staff_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  oidcSub: text('oidc_sub').notNull().unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const staffSession = pgTable(
  'staff_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    staffUserId: uuid('staff_user_id')
      .notNull()
      .references(() => staffUser.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    ua: text('ua'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index('staff_session_user_idx').on(table.staffUserId)]
);
```

Add `export * from './staff';` to `src/lib/server/db/schema/index.ts`.

There is deliberately no password, hash, or credential column. Staff authentication is delegated entirely to the IdP.

- [ ] **Step 2: Write the failing tests**

`tests/integration/session.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import {
  createStaffSession,
  revokeStaffSession,
  upsertStaffUser,
  validateStaffSession
} from '../../src/lib/server/auth/session';

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

describe('staff users', () => {
  it('creates a user on first login', async () => {
    const user = await upsertStaffUser(db, {
      oidcSub: 'sub-create',
      email: 'a@example.test',
      name: 'A',
      role: 'admin'
    });

    expect(user.id).toBeTruthy();
    expect(user.role).toBe('admin');
  });

  it('updates the role on subsequent login so IdP changes take effect', async () => {
    await upsertStaffUser(db, {
      oidcSub: 'sub-demote',
      email: 'b@example.test',
      name: 'B',
      role: 'admin'
    });

    const after = await upsertStaffUser(db, {
      oidcSub: 'sub-demote',
      email: 'b@example.test',
      name: 'B',
      role: 'approver'
    });

    expect(after.role).toBe('approver');
  });
});

describe('staff sessions', () => {
  it('issues a token that validates back to the user', async () => {
    const user = await upsertStaffUser(db, {
      oidcSub: 'sub-session',
      email: 'c@example.test',
      name: 'C',
      role: 'admin'
    });

    const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: 12 });
    const resolved = await validateStaffSession(db, token);

    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.user.role).toBe('admin');
  });

  it('never stores the token in plaintext', async () => {
    const user = await upsertStaffUser(db, {
      oidcSub: 'sub-hash',
      email: 'd@example.test',
      name: 'D',
      role: 'admin'
    });

    const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: 12 });
    const rows = await db.select().from((await import('../../src/lib/server/db')).schema.staffSession);

    expect(rows.some((row) => row.tokenHash === token)).toBe(false);
  });

  it('rejects an unknown token', async () => {
    expect(await validateStaffSession(db, 'not-a-real-token')).toBeNull();
  });

  it('rejects an expired session', async () => {
    const user = await upsertStaffUser(db, {
      oidcSub: 'sub-expired',
      email: 'e@example.test',
      name: 'E',
      role: 'admin'
    });

    const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: -1 });

    expect(await validateStaffSession(db, token)).toBeNull();
  });

  it('rejects a revoked session immediately', async () => {
    const user = await upsertStaffUser(db, {
      oidcSub: 'sub-revoked',
      email: 'f@example.test',
      name: 'F',
      role: 'admin'
    });

    const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: 12 });
    await revokeStaffSession(db, token);

    expect(await validateStaffSession(db, token)).toBeNull();
  });

  it('rejects a session belonging to a disabled user', async () => {
    const user = await upsertStaffUser(db, {
      oidcSub: 'sub-disabled',
      email: 'g@example.test',
      name: 'G',
      role: 'admin'
    });

    const { token } = await createStaffSession(db, { staffUserId: user.id, ttlHours: 12 });

    const { schema } = await import('../../src/lib/server/db');
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.staffUser)
      .set({ disabledAt: new Date() })
      .where(eq(schema.staffUser.id, user.id));

    expect(await validateStaffSession(db, token)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test:integration`
Expected: FAIL — cannot resolve `src/lib/server/auth/session`.

- [ ] **Step 4: Implement**

`src/lib/server/auth/session.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { staffSession, staffUser } from '../db/schema';
import type { Db } from '../db';
import type { StaffRole } from './roles';

export const SESSION_COOKIE = 'tc_staff_session';

export type StaffUser = typeof staffUser.$inferSelect;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function upsertStaffUser(
  db: Db,
  input: { oidcSub: string; email: string; name: string; role: StaffRole }
): Promise<StaffUser> {
  const [row] = await db
    .insert(staffUser)
    .values({
      oidcSub: input.oidcSub,
      email: input.email,
      name: input.name,
      role: input.role,
      lastLoginAt: new Date()
    })
    .onConflictDoUpdate({
      target: staffUser.oidcSub,
      set: {
        email: input.email,
        name: input.name,
        role: input.role,
        lastLoginAt: new Date()
      }
    })
    .returning();

  if (!row) throw new Error('failed to upsert staff user');
  return row;
}

export async function createStaffSession(
  db: Db,
  input: { staffUserId: string; ttlHours: number; ip?: string; ua?: string }
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);

  await db.insert(staffSession).values({
    tokenHash: hashToken(token),
    staffUserId: input.staffUserId,
    expiresAt,
    ip: input.ip ?? null,
    ua: input.ua ?? null
  });

  return { token, expiresAt };
}

export async function validateStaffSession(
  db: Db,
  token: string
): Promise<{ user: StaffUser; expiresAt: Date } | null> {
  const [row] = await db
    .select({ session: staffSession, user: staffUser })
    .from(staffSession)
    .innerJoin(staffUser, eq(staffSession.staffUserId, staffUser.id))
    .where(and(eq(staffSession.tokenHash, hashToken(token)), isNull(staffSession.revokedAt)))
    .limit(1);

  if (!row) return null;
  if (row.session.expiresAt.getTime() <= Date.now()) return null;
  if (row.user.disabledAt !== null) return null;

  return { user: row.user, expiresAt: row.session.expiresAt };
}

export async function revokeStaffSession(db: Db, token: string): Promise<void> {
  await db
    .update(staffSession)
    .set({ revokedAt: new Date() })
    .where(eq(staffSession.tokenHash, hashToken(token)));
}
```

- [ ] **Step 5: Generate the migration and run the tests**

```bash
pnpm exec drizzle-kit generate --name staff
pnpm test:integration
```

Expected: PASS, 13 tests total.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add staff users and opaque server-side sessions"
```

---

### Task 10: OIDC login, callback, and logout

**Files:**
- Create: `src/lib/server/auth/oidc.ts`
- Create: `src/routes/auth/login/+server.ts`
- Create: `src/routes/auth/callback/+server.ts`
- Create: `src/routes/auth/logout/+server.ts`
- Modify: `src/hooks.server.ts`
- Modify: `src/app.d.ts`

**Interfaces:**
- Consumes: `config` (Task 2), `recordEvent` (Task 5), `mapRole`/`extractGroups` (Task 8), session functions (Task 9)
- Produces: `event.locals.staff: { id: string; email: string; name: string; role: StaffRole } | null`; the routes `/auth/login`, `/auth/callback`, `/auth/logout`

- [ ] **Step 1: Add the shared database instance and the OIDC helper**

`src/lib/server/db/instance.ts`:

```ts
import { config } from '../config';
import { createDb } from './index';

export const { db } = createDb(config.databaseUrl);
```

`src/lib/server/auth/oidc.ts`:

```ts
import * as client from 'openid-client';
import { config } from '../config';

let cached: client.Configuration | undefined;

export async function getOidcConfig(): Promise<client.Configuration> {
  if (!cached) {
    cached = await client.discovery(
      new URL(config.oidc.issuer),
      config.oidc.clientId,
      config.oidc.clientSecret
    );
  }
  return cached;
}

export function redirectUri(): string {
  return new URL('/auth/callback', config.publicBaseUrl).toString();
}

export interface PendingLogin {
  url: string;
  state: string;
  codeVerifier: string;
}

export async function beginLogin(): Promise<PendingLogin> {
  const oidc = await getOidcConfig();
  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
  const state = client.randomState();

  const url = client.buildAuthorizationUrl(oidc, {
    redirect_uri: redirectUri(),
    scope: 'openid email profile groups',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  });

  return { url: url.toString(), state, codeVerifier };
}

export async function completeLogin(
  currentUrl: URL,
  expected: { state: string; codeVerifier: string }
): Promise<Record<string, unknown>> {
  const oidc = await getOidcConfig();

  const tokens = await client.authorizationCodeGrant(oidc, currentUrl, {
    pkceCodeVerifier: expected.codeVerifier,
    expectedState: expected.state
  });

  const claims = tokens.claims();
  if (!claims) throw new Error('ID token contained no claims');

  return claims as unknown as Record<string, unknown>;
}
```

Access and refresh tokens are intentionally discarded — the IdP is needed only at login.

- [ ] **Step 2: Implement the login route**

`src/routes/auth/login/+server.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import { beginLogin } from '$lib/server/auth/oidc';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ cookies }) => {
  const { url, state, codeVerifier } = await beginLogin();

  const options = {
    path: '/auth',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: !url.startsWith('http://localhost'),
    maxAge: 600
  };

  cookies.set('tc_oidc_state', state, options);
  cookies.set('tc_oidc_verifier', codeVerifier, options);

  redirect(303, url);
};
```

- [ ] **Step 3: Implement the callback route**

`src/routes/auth/callback/+server.ts`:

```ts
import { error, redirect } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { completeLogin } from '$lib/server/auth/oidc';
import { extractGroups, mapRole } from '$lib/server/auth/roles';
import { SESSION_COOKIE, createStaffSession, upsertStaffUser } from '$lib/server/auth/session';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db/instance';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies, getClientAddress, request }) => {
  const state = cookies.get('tc_oidc_state');
  const codeVerifier = cookies.get('tc_oidc_verifier');

  cookies.delete('tc_oidc_state', { path: '/auth' });
  cookies.delete('tc_oidc_verifier', { path: '/auth' });

  if (!state || !codeVerifier) error(400, 'Login session expired. Please try again.');

  const claims = await completeLogin(url, { state, codeVerifier });

  const sub = typeof claims.sub === 'string' ? claims.sub : null;
  const email = typeof claims.email === 'string' ? claims.email : null;
  const name = typeof claims.name === 'string' ? claims.name : (email ?? 'Unknown');
  if (!sub || !email) error(400, 'The identity provider did not return sub and email claims.');

  const groups = extractGroups(claims, config.oidc.groupsClaim);
  const role = mapRole(groups, config.oidc.adminGroup, config.oidc.approverGroup);

  const ip = getClientAddress();
  const ua = request.headers.get('user-agent') ?? undefined;

  if (role === null) {
    await recordEvent(db, {
      action: 'staff.login.denied',
      actor: { type: 'staff', id: sub },
      subjectType: 'staff',
      subjectId: sub,
      ip,
      ua,
      meta: { email, groups }
    });
    error(403, 'Your account is not a member of a group authorised to use this trust center.');
  }

  const user = await upsertStaffUser(db, { oidcSub: sub, email, name, role });
  const { token, expiresAt } = await createStaffSession(db, {
    staffUserId: user.id,
    ttlHours: config.sessionTtlHours,
    ip,
    ua
  });

  await recordEvent(db, {
    action: 'staff.login.succeeded',
    actor: { type: 'staff', id: user.id },
    subjectType: 'staff',
    subjectId: user.id,
    ip,
    ua,
    meta: { role }
  });

  cookies.set(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicBaseUrl.startsWith('https://'),
    expires: expiresAt
  });

  redirect(303, '/admin');
};
```

- [ ] **Step 4: Implement logout**

`src/routes/auth/logout/+server.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import { recordEvent } from '$lib/server/audit';
import { SESSION_COOKIE, revokeStaffSession } from '$lib/server/auth/session';
import { db } from '$lib/server/db/instance';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, locals, getClientAddress }) => {
  const token = cookies.get(SESSION_COOKIE);

  if (token) {
    await revokeStaffSession(db, token);
    if (locals.staff) {
      await recordEvent(db, {
        action: 'staff.logout',
        actor: { type: 'staff', id: locals.staff.id },
        subjectType: 'staff',
        subjectId: locals.staff.id,
        ip: getClientAddress()
      });
    }
  }

  cookies.delete(SESSION_COOKIE, { path: '/' });
  redirect(303, '/');
};
```

- [ ] **Step 5: Resolve the session in hooks**

Add to `src/app.d.ts`, inside `interface Locals`:

```ts
staff: { id: string; email: string; name: string; role: 'admin' | 'approver' } | null;
```

Update `src/hooks.server.ts` to resolve the session after setting the locale:

```ts
import type { Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, validateStaffSession } from '$lib/server/auth/session';
import { db } from '$lib/server/db/instance';
import { DEFAULT_LOCALE, LOCALES } from '$lib/i18n/locales';
import { resolveLocale, stripLocale } from '$lib/i18n/locale';

export const handle: Handle = async ({ event, resolve }) => {
  const { locale: pathLocale } = stripLocale(event.url.pathname, LOCALES);

  event.locals.locale = resolveLocale(
    { pathLocale, acceptLanguage: event.request.headers.get('accept-language') ?? undefined },
    LOCALES,
    DEFAULT_LOCALE
  );

  event.locals.staff = null;
  const token = event.cookies.get(SESSION_COOKIE);

  if (token) {
    const session = await validateStaffSession(db, token);
    if (session) {
      event.locals.staff = {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: session.user.role as 'admin' | 'approver'
      };
    } else {
      event.cookies.delete(SESSION_COOKIE, { path: '/' });
    }
  }

  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.locale)
  });
};
```

- [ ] **Step 6: Verify the application compiles**

Run: `pnpm check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add OIDC login, callback, and logout"
```

---

### Task 11: Admin shell, route guard, and the end-to-end login test

**Files:**
- Create: `src/routes/(admin)/admin/+layout.server.ts`
- Create: `src/routes/(admin)/admin/+layout.svelte`
- Create: `src/routes/(admin)/admin/+page.svelte`
- Create: `tests/e2e/auth.spec.ts`
- Modify: `src/routes/+page.svelte`

**Interfaces:**
- Consumes: `locals.staff` (Task 10), message catalogs (Task 7)
- Produces: `/admin`, guarded; `data.staff` available to every admin page

- [ ] **Step 1: Write the failing end-to-end tests**

`tests/e2e/auth.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page, account: string) {
  await page.goto('/auth/login');
  await page.getByLabel('Login').fill(account);
  await page.getByLabel('Password').fill('any-password');
  await page.getByRole('button', { name: /sign-?in|continue|login/i }).click();

  const consent = page.getByRole('button', { name: /continue|authorize|allow/i });
  if (await consent.isVisible().catch(() => false)) {
    await consent.click();
  }
}

test('redirects an anonymous visitor away from the admin area', async ({ page }) => {
  const response = await page.goto('/admin');
  expect(page.url()).not.toContain('/admin');
  expect(response?.status()).toBeLessThan(400);
});

test('an admin can sign in and reach the admin area', async ({ page }) => {
  await signIn(page, 'admin');

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId('staff-email')).toHaveText('admin@example.test');
  await expect(page.getByTestId('staff-role')).toHaveText('admin');
});

test('a user in no mapped group is refused', async ({ page }) => {
  await signIn(page, 'nobody');

  await expect(page.getByText(/not a member of a group authorised/i)).toBeVisible();
});

test('signing out revokes the session immediately', async ({ page }) => {
  await signIn(page, 'admin');
  await expect(page).toHaveURL(/\/admin$/);

  await page.getByTestId('sign-out').click();

  await page.goto('/admin');
  expect(page.url()).not.toContain('/admin');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:e2e`
Expected: FAIL — `/admin` does not exist.

Before running, ensure the development environment is up and `.env` exists:

```bash
docker compose -f docker-compose.dev.yml up -d
cp -n .env.example .env
pnpm exec drizzle-kit migrate
```

- [ ] **Step 3: Implement the guard**

`src/routes/(admin)/admin/+layout.server.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
  if (!locals.staff) redirect(303, '/');
  return { staff: locals.staff, locale: locals.locale };
};
```

- [ ] **Step 4: Implement the shell**

`src/routes/(admin)/admin/+layout.svelte`:

```svelte
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
  import type { LayoutServerData } from './$types';

  let { data, children }: { data: LayoutServerData; children: import('svelte').Snippet } = $props();
</script>

<div class="min-h-screen bg-neutral-50 text-neutral-900">
  <header class="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
    <a href="/admin" class="font-semibold">{m.site_title()} · {m.nav_admin()}</a>

    <div class="flex items-center gap-4 text-sm">
      <span data-testid="staff-email">{data.staff.email}</span>
      <span data-testid="staff-role" class="rounded bg-neutral-100 px-2 py-0.5">{data.staff.role}</span>
      <form method="POST" action="/auth/logout">
        <button data-testid="sign-out" type="submit" class="underline">{m.admin_sign_out()}</button>
      </form>
    </div>
  </header>

  <main class="mx-auto max-w-5xl px-6 py-8">
    {@render children()}
  </main>
</div>
```

`src/routes/(admin)/admin/+page.svelte`:

```svelte
<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<h1 class="text-2xl font-semibold">{data.staff.name}</h1>
<p class="mt-2 text-neutral-600">Content management arrives in Phase 1.</p>
```

- [ ] **Step 5: Add the sign-in link to the public page**

`src/routes/+page.svelte`:

```svelte
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js';
</script>

<h1 data-testid="site-title">{m.site_title()}</h1>
<p data-testid="admin-link-label">{m.nav_admin()}</p>
<a href="/auth/login" data-testid="sign-in">{m.admin_sign_in()}</a>
```

- [ ] **Step 6: Run the full suite**

```bash
pnpm test:e2e
pnpm test:unit
pnpm test:integration
pnpm check
pnpm lint
```

Expected: all green. The `locale.spec.ts` no-cookies test still passes, because the session cookie is only set after `/auth/login`.

If the stub provider's interaction form uses different field labels than `Login` and `Password`, adjust the `signIn` helper's selectors to match what `node-oidc-provider`'s dev interaction actually renders; capture them once with `pnpm exec playwright codegen http://localhost:5556`.

- [ ] **Step 7: Add the end-to-end job to CI**

In `.github/workflows/ci.yml`, append to the `verify` job's steps:

```yaml
      - run: docker compose -f docker-compose.dev.yml up -d --build
      - run: pnpm exec playwright install --with-deps chromium
      - run: cp .env.example .env
      - run: pnpm exec drizzle-kit migrate
      - run: pnpm test:e2e
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add guarded admin shell with end-to-end OIDC login coverage"
```

---

## Phase 0 completion criteria

- [ ] `docker compose -f docker-compose.dev.yml up -d` brings up Postgres, Mailpit, and the stub IdP
- [ ] `pnpm dev` serves `/` in German and `/en` in English
- [ ] The public portal sets zero cookies, enforced by a permanent test
- [ ] An admin signs in through OIDC and reaches `/admin`; an unmapped user is refused with 403
- [ ] Sign-out revokes the session immediately
- [ ] The audit log records `staff.login.succeeded`, `staff.login.denied`, and `staff.logout`
- [ ] No password, credential, or hash column exists anywhere in the schema
- [ ] `pnpm lint`, `pnpm check`, `pnpm test:unit`, `pnpm test:integration`, and `pnpm test:e2e` all pass in CI

## Next

Phase 1 (the public trust center MVP) gets its own plan, written once this foundation is real. It builds documents first and controls second, then extracts the generic admin primitives from that pair — which is why those primitives moved out of Phase 0.
