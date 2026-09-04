# Backlog

Work that is known, deliberately not being done now, and not owned by any open plan. Items leave
here by being done or by being written into a spec or plan that owns them — not by being forgotten.

Residuals that a spec already records (`§16` sections and the like) stay in that spec; they appear
here only when there is an action somebody has to take outside of writing code.

---

## Open

### Verify the object-lock premises against a real Amazon S3 bucket

**From:** subsystem B1, 2026-09-04. **Blocks:** deploying the audit sink against Amazon S3.
**Cost:** minutes, once credentials exist.

The audit sink's two load-bearing infrastructure premises were verified against MinIO and hold
(`specs/2026-09-04-audit-sink-spike.md`). Neither was checked against Amazon, because no AWS
credentials were available. Both are what the S3 Object Lock documentation specifies, but that is
weaker than having run them.

What to run, against a bucket created with object lock and a governance default:

1. PUT an object to a key.
2. PUT again to the **same** key. It must succeed and add a version, not be refused — `§5.2`'s
   deterministic key and the whole retry path depend on it. If Amazon refuses, the retry path fails
   in production while every test passes against MinIO.
3. `list-object-versions` on that key: two versions.
4. Attempt a delete without `s3:BypassGovernanceRetention` (must be refused) and with it (must
   succeed).

Then replace the "not verified against Amazon" wording in three places: the design's `§16`, the
Sources bullet at the end of the same document, and `docs/self-hosting.md` §13 under
"S3-compatible stores".

### Subsystem A has no carry-over document

**From:** noticed 2026-09-04 while writing B1's. **Cost:** an hour of reconstruction, rising.

Phases 1–4, subsystem C and subsystem B1 each have a carry-over recording what was deliberately not
done, what was measured, and which defects were left standing. Subsystem A — event egress — shipped
without one, so what its implementation decided and deferred lives only in commit messages and in the
design's own revision history.

Worth writing while the branch is still readable. `subsystem-c-carryover.md` and
`subsystem-b1-carryover.md` are the shape.

### The subsystem A merge commit calls it "subsystem D"

**From:** noticed 2026-09-04. **Cost:** minutes, but only before it is pushed.

`a9c56a3` reads `Merge branch 'feat/event-egress' — subsystem D: event egress`. The decomposition
(`specs/2026-08-31-integrations-decomposition.md` §4) assigns **A** to event egress and **D** to the
inbound API, and the event-egress design titles itself "Integrations subsystem A". A reader following
the letters will look for event egress under D and find the inbound API instead.

`main` is unpushed as of 2026-09-04, so this is still rewritable. Once it is pushed, leave it and
correct it in prose instead — rewriting shared history costs more than the confusion does.

### The B1 plan's checkboxes were never ticked

**From:** subsystem B1. **Cost:** minutes. **Value:** low.

`plans/2026-09-04-audit-sink-b1.md` has 76 unchecked boxes and every task is done. The record of what
shipped is the design's §19 and the B1 carry-over, both of which are accurate, so this is cosmetic —
noted only so the next reader does not read the plan file as a to-do list.

---

## Done

_(Nothing yet. Items move here with the date and the commit that closed them, rather than being
deleted, so the backlog also records what was once considered.)_
