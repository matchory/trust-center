# Phase 1 carry-over from Phase 0

Findings deliberately deferred during Phase 0, with the reasoning that deferred them.
Nothing here blocks Phase 0; all of it was surfaced by review and consciously parked.

## Decide before writing Phase 1 code

**The locale contract is split, and the spec does not reconcile it.** Task 6 made the
locale set runtime-configurable (`PUBLIC_LOCALES`); Task 7 made it compile-time fixed
(Paraglide catalogs). Phase 0 closed the dangerous edge — a mismatch now fails loudly at
boot instead of 500-ing the public portal on a visitor's `Accept-Language` header — but
the contradiction itself stands. Either commit to build-time locales and amend the
Global Constraint's wording, or move to `$env/dynamic/public` and treat catalogs as a
documented build input. Phase 1's Dockerfile will make this concrete either way.

**The spec contradicts itself on the audit log.** Section 10 lists "append-only audit"
and "audit events … pseudonymized on requester purge" as adjacent bullets; the second is
an `UPDATE` and the first forbids one. Phase 0 enforced the `DELETE` half at the database
(`drizzle/0003`) and deliberately left `UPDATE` alone, because the correct policy cannot
be designed until the requester-purge path exists to gate on. Resolve the wording — most
likely "append-only except a single audited, column-scoped pseudonymization" — before
Phase 2 builds the purge.

## Security hardening

- `BEFORE TRUNCATE` trigger on `audit_event`. Row-level `DELETE` triggers do not fire on
  `TRUNCATE`, and the app role owns the table. The existing trigger stops the realistic
  failure (a careless call site); this closes the hole an auditor would find.
- `__Host-` cookie prefix for the session cookie, and a `kit.csp` config. CSP would
  *enforce* the "no third-party resources" claim the spec makes rather than asserting it,
  and is the single most visible security header this product could ship.
- An e2e assertion that the public portal loads no third-party resources. Its sibling
  claim (no cookies) has a permanent test; this half has none.
- `pgEnum` or `CHECK` constraints on `staff_user.role` and `audit_event.actor_type`.
  The app fails closed already; this is defence in depth while the tables are empty.
- Revoke prior sessions on re-login, or add an explicit "sign out other devices".
- Audit failed callbacks (state mismatch, replayed code, IdP `error=`). These are exactly
  the events wanted when investigating an attack, and none is recorded today.
- A project `handleError` hook: SvelteKit's default `console.error` logs the oauth error
  `cause`, which carries the callback query string including the authorization code.
- `robots.txt` currently grants blanket crawl permission; the admin shell has no
  `noindex`, which spec section 6.2 requires.

## Correctness and hygiene

- `seq` is typed nullable in the application: Drizzle's `bigserial` with `mode: 'bigint'`
  sets `hasDefault` but not `notNull`, so the snapshot disagrees with Postgres. Harmless
  under `migrate`; a `push` would try to `DROP NOT NULL`. One word: `.notNull()`.
- A route-level test for the disabled-staff denial. The layer below is tested, but
  deleting the check in the callback restores the false-success audit record it exists to
  prevent and nothing goes red.
- Scope the e2e audit-event query to its own actor. It satisfies the mutation test but
  does not prove *these* events came from *this* login.
- Integration-test isolation now needs a fresh database per run — with `DELETE` blocked
  on `audit_event`, deleting rows between tests is no longer possible.
- `drizzle.config.ts`'s error text names `pnpm db:migrate`, but the config also loads for
  `drizzle-kit generate`, which needs no database and has no such script.
- One trailing clause in `playwright.config.ts`'s comment survives from before the
  dev-mode claim was disproved and now contradicts the finding above it.
- Session cleanup and an index on `staff_session.expires_at` — expired rows accumulate
  forever. The spec's `JobRunner` port is the natural home.
- Paraglide's `strategy` is declared in both `package.json` and `vite.config.ts` and
  honoured in neither, since both entry points overwrite the locale resolver.
- Auth redirects are locale-blind (`/admin`, `/`), so an English visitor signing out
  lands on the German root.
- CI builds twice — once as a step, once inside Playwright's `webServer`.
- Scaffold residue: unreferenced `src/lib/assets/favicon.svg`, placeholder
  `src/lib/index.ts`, `sv`-boilerplate `.vscode/extensions.json`.
- Add `vitePreprocess()` before any `.svelte` file needs generics or `satisfies` in a
  typed script block.

## Notes for whoever picks this up

- `adapter-node` is configured **inside `vite.config.ts`'s `sveltekit({...})` call**.
  There is deliberately no `svelte.config.js`; adding one makes SvelteKit warn and ignore
  the inline config.
- The generic admin primitives (filterable table, form scaffold, locale tabs) were moved
  out of Phase 0 on purpose. Build documents first and controls second, then extract the
  primitives from the pair rather than designing them speculatively.
- `pnpm dev` client-side routing was verified working during Phase 0. An earlier claim
  of a `vite@8.2.2`/`@sveltejs/kit@2.70.3` dev-mode bug did not reproduce and has been
  retracted; the preview-based Playwright server was kept on its own merits.
