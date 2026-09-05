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

### `openssl` is an undeclared prerequisite of the integration suite

**From:** subsystem B2, 2026-09-05. **Blocks:** nothing today. **Cost:** minutes, or an hour to
remove the dependency.

`tests/helpers/syslog-server.ts` shells out to `openssl req -x509` to mint the TLS material the
syslog adapter's 14 integration tests run against. Nothing in `package.json` or
`.github/workflows/ci.yml` names it. It is present on `ubuntu-latest` and on the machine B2 was
written on (macOS 25.6), so CI is green — but a runner without it, or with a build old enough to
reject `-addext`, fails the whole file with an `execFileSync` error rather than an assertion, which
reads as a broken adapter rather than a missing tool.

Either declare it (a line in the CI workflow and in the testing notes) or remove it by generating
the certificate in Node. A checked-in fixture certificate is the third option and the worst one: it
expires, and nobody notices an expiry until CI turns red for an unrelated-looking reason.

### A literal U+FEFF in source has slipped through three times

**From:** subsystem B2, 2026-09-05. **Blocks:** nothing. **Cost:** minutes.

The syslog message format prefixes its payload with a UTF-8 BOM (RFC 5424 §6.4), and the rule for
this codebase is that it is written as the escape `\ufeff`, never as the character. During B2 a
literal U+FEFF was typed into source three separate times — once into the implementation, once into
the carry-over, once into a report. Every one was caught, twice only by a deliberate byte-scan.

A character that is invisible in every editor and diff viewer should not be guarded by remembering to
look for it. An eslint rule banning literal U+FEFF outside string escapes, or a prettier check, turns
the fourth occurrence into a failed lint instead of a fourth catch — or a miss.

### No test pins the reset-after-write mapping §13 now promises

**From:** subsystem B2, 2026-09-05. **Blocks:** nothing. **Cost:** under an hour.

`docs/self-hosting.md` §13 now tells an operator that a receiver which resets the connection *after*
taking a batch reports `network` — every batch delivered, every batch recorded failed, retried
forever, duplicated into the SIEM on each backoff. The behaviour is correct and was traced by hand,
but nothing asserts it: it rests on the `ended` flag gating the `end` and `close` handlers in
`src/lib/server/auditsink/syslog.ts`, and the integration suite only covers the reset that arrives
*during* the write.

A documented promise with no test behind it is the kind that quietly stops being true. Worth a case
the next time that block is touched, at the latest.

### The syslog adapter buffers a whole batch before writing it

**From:** subsystem B2 cleanup pass, 2026-09-05. **Blocks:** nothing. **Cost:** half a day, most of
it re-establishing the correctness the fix round bought.

`send()` in `src/lib/server/auditsink/syslog.ts` frames every row into an array and then
`Buffer.concat`s it into one contiguous buffer for a single `socket.write`. At the 8 MiB batch
ceiling the framed array and the concatenated copy exist at once, on top of the line strings, so
peak footprint is several times the batch. Writing each frame as it is produced, respecting `drain`,
would remove one full-batch copy and let early frames be collected as they flush.

Deliberately not done during the cleanup pass. `ended = true` is set in that single write callback,
and it is the flag that separates a graceful mid-batch FIN from a completed write — the property
that took a fix round and a counterfactual to get right. Streaming would interleave backpressure
with the `end`/`close` handlers that depend on it. The prize is one 8 MiB copy once a minute; the
risk is the one piece of this subsystem that has already been wrong once.

Worth doing only alongside a test that pins the graceful-FIN and reset-after-write mappings first —
see the entry above.

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
