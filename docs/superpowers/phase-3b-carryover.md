# Phase 3a carry-over into Phase 3b

Written at the end of Phase 3a, in the same shape as `phase-3-carryover.md`.
Everything here is a decision, a measurement, or a defect that Phase 3a saw and
deliberately did not fold in.

## The three questions the plan asked

### Did the two-axis model hold?

**It held, and this time it was actually tested — the helper took the fourth
content type without a change.**

Phase 2's carry-over closed with a warning: `saveMetaAction` had been used once,
at its plainest, and "the next content type is the test that matters, and there
is not one yet." `access_group` is that content type, and it is the first one to
exercise both halves of the abstraction.

What fitted, unchanged:

- `saveMetaAction` on `/admin/groups/[id]`, with a `z.object` schema, a `read`
  that pulls slug and position, and an `update` that receives `db` — the same
  call shape as `/admin/rules/[id]`.
- `saveTranslationsFromForm` for the per-locale name and description. This is
  the first use of the multi-locale form path outside Phase 1's content types,
  and it needed nothing new.
- `translationAction('access_group')` for the audit action name.
- `DataTable` and `FormField` on the list and detail pages, with no props added.

What did not fit, and why it is not a defect in the abstraction:

- **`saveTranslationAction` (singular) is still unused, three phases in.** It
  writes one locale per POST; every real form in this codebase submits every
  locale at once. Two phases have now routed around it. It is dead weight and
  the next phase touching translations should delete it rather than find a
  fourth way not to use it.
- **`setDocumentGroups` is not a content-type operation and did not pretend to
  be.** Membership is edited from the *document*, so the group's own editor is
  read-only about its members. This was a deliberate deviation from §8, recorded
  in the plan: editing one relation from both sides doubles the surface and the
  tests for nothing.

The finding to carry: **the helper generalises, and the surfaces that do not use
it still are not content-type editors.** The split Phase 2 identified is the
real one, and Phase 3a is the first evidence for the "it generalises" half
rather than only the "it is correctly scoped" half.

### Did expand → migrate → contract pay for itself?

**Yes, and the specific thing it bought was a reviewable diff — not safety.**

Three migrations (`0016`, `0017`, `0018`) and three bridge writes, against one
big-bang alternative. What it actually delivered:

- **Every task left a green suite, and that was load-bearing twice.** Task 6 and
  Task 7 each broke a caller the plan had not listed (rulings C2 and C3, both
  found in the pre-flight scan rather than at runtime). Because the invariant was
  "this task compiles and passes", both were caught as a stated cost with a
  stated fix, rather than as a mystery in a 20-file diff.
- **The bridges were mechanical and short-lived.** Three writes, each one line,
  each removed by Task 9's grep gate — which found exactly the three predicted
  and nothing else. That is the strongest evidence the decomposition was honest:
  no consumer was missed.
- **The backfill was verifiable in isolation.** `0017` could be applied to a
  database seeded with legacy-shaped rows and its output inspected. In a
  big-bang migration the backfill and the schema change are the same statement
  and there is no "before" left to compare against.

What it did **not** buy, and it is worth being honest about:

- **No rollback was ever needed, and the intermediate states were never
  deployed.** The safety story ("the booleans stay authoritative so a deploy can
  be rolled back") was never exercised, because the whole phase landed as one
  branch. On a branch that merges atomically, expand/migrate/contract is a
  *review* technique, not an *operational* one. Say that plainly when planning
  3b: if the phase will merge as one unit, justify the decomposition by the diff
  it produces, not by a rollback nobody will perform.
- **Two of the three migrations needed hand-editing or renaming; `0018` needed
  neither.** Where the constraint can be expressed in the Drizzle schema
  (`termDays: integer().notNull()` plus a `check`), drizzle-kit generates the
  NOT NULL and the CHECK correctly. Only the data backfill in `0017` had to be
  written by hand. Reach for hand-editing only for data movement.

### What does 3b inherit?

The concrete handoffs, in the order 3b will meet them:

- **`PHASE_TIERS` in `src/lib/server/access/scope.ts` is the single constant 3b
  deletes.** It is `['request']`. Adding `'nda'` to it is the entire mechanical
  change; everything else follows from that one edit.
- **`honouredTiers()` is where the refusal lives, and it is called at read time
  only** — in `decideFromRules`, `submitRequest`, `decideRequest` and
  `verify.ts`. Setters deliberately do **not** filter through it: what an
  operator chose is what gets stored, and what the phase grants is decided when
  it is read. So a rule or a request that named `nda` before 3b starts honouring
  it becomes live the moment `PHASE_TIERS` widens. **That is the intended
  behaviour and also the sharpest edge in this handoff** — 3b must decide
  deliberately whether pre-existing `nda` entries should take effect on deploy,
  and if not, it needs a migration, not a code change.
- **`access_group.nda_template_id` is the first column 3b adds.** It is
  deliberately absent (Phase 2's rule: nothing unreachable ships) and would
  reference `nda_template`, which 3b creates.
- **`access_grant_group`'s `ON DELETE RESTRICT` is the pattern to copy for
  `access_grant_nda`.** A cascade would silently narrow live access with nothing
  recording why; restricting makes the operator revoke or re-scope first. The
  operator-facing half is `ScopeGroupInUse` → a 409 with a localized message,
  and 3b should mirror both halves, not just the constraint.
- **`SCOPE_TIERS` lives in `src/lib/access-types.ts`, not in `scope.ts`.** A
  Svelte component may not import from `$lib/server/`, and three forms render a
  checkbox per tier. `scope.ts` re-exports it so server modules read unchanged.

## Defects found and fixed in 3a, recorded because the reasoning matters

- **A blanket approval told the requester they had access to 0 documents.** The
  approval mail computed `documentCount: allRequestTier ? 0 : documentIds.length`,
  so every all-tier approval — the common case — rendered "You have access to 0
  document(s)". Pre-existing since Phase 2 and user-facing. It now asks
  `countGrantDocuments`, which is the function whose stated purpose is that
  question. **The general lesson: a count derived from the form is a count of
  what was typed, not of what was granted.**
- **`countGrantDocuments` filtered neither expiry nor revocation.** Safe by
  accident, because its single caller pre-filtered. This phase added the second
  caller. Both predicates are now inside it.
- **A test file that leaves a row another file cannot delete is a latent flake.**
  `grants-scope.test.ts` left a grant naming a group; `access_grant_group`'s
  RESTRICT then blocked `groups.test.ts`'s `delete from access_group`, but only
  when the runner ordered the two files that way — the full suite masked it for
  four tasks. **The RESTRICT that makes the product correct is the same thing
  that makes test cleanup order load-bearing.** Every future file seeding a
  grant-group pair inherits this; clean up in `afterAll`.
- **The plan put a server-only constant in a client template.** `SCOPE_TIERS`
  was specified in `$lib/server/access/scope.ts` and rendered by two rule forms.
  SvelteKit refuses to build that. Moved to `access-types.ts`. Worth checking
  for whenever a plan introduces a constant and a form in the same phase.
- **A message key can silently do double duty across two features.** The plan
  instructed adding `admin_group` and `admin_groups`; both already existed, for
  the unrelated *control groups* feature, and following it literally would have
  relabelled that page. Nothing type-checks a message key's meaning. **Grep both
  catalogs for every key before adding it.**
- **A parametrized message that interpolates a database slug leaves English in
  German copy.** `request_tier_all({ tier })` would have rendered "Alle request
  Dokumente". Per-tier keys plus a label record — the codebase's existing
  `ACTION_LABEL` / `STATUS_LABEL` shape — is the right form.

## Still open

- **`RuleDecision.tiers` is computed and never read.** `verify.ts` uses only
  `decision.action` and `decision.ruleId`; the grant's tiers come from the
  *request's* set. So a rule's tier set does not bound what its auto-approval
  grants — a requester who ticks the request-tier blanket gets it even from a
  rule whose set is empty. This is **pre-existing** (`decision.maxTier` was
  equally unread) and does **not** breach spec §10.1 today, because §10.1
  forbids auto-granting a tier *whose proposal carries a requirement* and
  `honouredTiers` strips `nda` on both paths. **It becomes a live defect the
  moment 3b honours `nda`.** The correct semantics are the intersection of the
  rule's set with the request's. 3a did not change it because no test in this
  phase covers it and the plan did not ask; **3b must, before widening
  `PHASE_TIERS`.**
- **`AdminRequestDetail` carries both `tiers` and `requestedTiers`, and they are
  the same array.** A request has one tier set. The plan specified both names;
  one is probably redundant.
- **Duplicate-slug creation still 500s, now asymmetrically.** No route under
  `src/` handles Postgres `23505`, including the categories page these were
  modelled on — pre-existing and codebase-wide. But the group routes now catch
  `23503` (the in-use FK violation), so they handle one Postgres error class and
  not its neighbour. That asymmetry is the strongest argument for fixing both.
- **The Secretive signing agent locked mid-phase twice**, leaving completed work
  staged and uncommittable until a human unlocked it. Not a code defect; worth
  knowing because it stalls an otherwise unattended run, and the constraint
  forbids `--no-gpg-sign`.
- Everything under "Still open" in `phase-3-carryover.md` remains open: no e2e
  covers the admin file upload, and the e2e run still starts two application
  servers against one database.

## Known items carried forward

- **Groups have no public surface at all**, by design (§4.2). If 3b gives a
  group an NDA template, it acquires a public meaning for the first time — the
  requester must see what they are agreeing to — and that is a genuinely new
  decision, not an extension of this one.
- **An auto-approved decision grants no groups.** Rules grant tiers and explicit
  documents only. This is 3a's simplest correct reading of §10.1's guard; 3b
  should revisit it explicitly once a group can carry a requirement.
- **`access_request` has tiers but not groups**, per §4.2: offering groups on the
  public form would leak the operator's internal bundling to prospects.
- **Invite-driven requests remain modelled but unreachable**, unchanged from
  Phase 2.
- **The return-visit fast path still has no entry point**, unchanged from
  Phase 2.
