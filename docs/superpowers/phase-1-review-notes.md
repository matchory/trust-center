# Phase 1 — running notes for the whole-branch review

Findings noticed while executing the plan, to be resolved before merge (see the
plan's "Whole-branch review" section).

## Open

- **Intermittent `500 Could not determine clientAddress` on admin POST actions.**
  Seen once during a full `pnpm test:e2e` run on
  `POST /(admin)/admin/documents/[id]`. Every admin action calls
  `getClientAddress()` to populate the audit event's `ip`. When it throws, the
  whole action 500s and *no* audit event is written — the mutation is lost, not
  merely unattributed. The e2e suite did not catch it because the test that hit
  it only asserts the document stays off the portal, which an unpublished
  document satisfies either way. Decide whether `ip` should degrade to `null`
  rather than failing the mutation. Re-check after Task 18 swaps in
  `adapter-node`, which is the adapter production actually runs.

- **`state_referenced_locally` warnings** in the two admin edit pages
  (`documents/[id]`, `controls/[id]`): `let activeLocale = $state(data.locale)`
  deliberately seeds once and does not track `data`. Intentional, but it leaves
  `pnpm check` permanently noisy. Task 11 extracts `LocaleTabs.svelte` from
  exactly this code — silence it there rather than twice here.

## Resolved during execution

- Drizzle wraps driver errors, so `error.message` is only
  `Failed query: <sql> params: …`. Audit constraint tests assert on `cause`
  instead (Task 2).
- `svelte/no-navigation-without-resolve` narrowed to `ignoreLinks`: locale-
  prefixed paths are not route ids (Task 3).
- Admin action `fail()` payloads given one explicit type per route so the page
  can narrow on `field` alone (Tasks 8, 10).
- Several e2e assertions rewritten to name the row they mean: the dev database
  persists between runs, so matching on a fixture's display text alone breaks
  on the second run (Tasks 8, 10).
