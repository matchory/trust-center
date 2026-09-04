# Integrations subsystem B2 — the syslog sink — Carry-over

**Date:** 2026-09-05
**Branch:** `feat/audit-sink-b2`, 6 commits from `583a25f`
**Spec:** `docs/superpowers/specs/2026-09-04-audit-sink-design.md` (§5.3, §5.4, §11, §13, §14)
**Plan:** `docs/superpowers/plans/2026-09-04-audit-sink-b2.md`
**Ledger:** `.superpowers/sdd/2026-09-04-audit-sink-b2/progress.md`

Records what this subsystem deliberately did not do, what it measured, and the defects it left
standing — in the shape `subsystem-b1-carryover.md` uses. B2 is the syslog half of the audit sink;
B1 shipped the spine, the tables, the reader, the serialization and the S3 adapter. B1's carry-over
§5 describes the state at B1's close ("`AUDIT_SINK_SYSLOG_*` is not parsed today") and is now
history rather than a claim about the tree.

---

## 1. The thing to read first: what "shipped" means for this sink

**A syslog shipment recorded as delivered may not have been stored anywhere.** This is
spec-sanctioned (§5.3), documented for operators in `docs/self-hosting.md` §13, and not a defect —
but it is the single most important property of this subsystem and it is the one a reader skimming
green tests will not infer.

RFC 6587 has no acknowledgement. The strongest signal available is that the receiver closed the
connection after we finished writing, and that is what the adapter waits for. A receiver whose own
queue overflows discards messages silently; nothing about that reaches this deployment. The shipment
row says `shipped`, `byte_count` says how many bytes we wrote, and the panel stays green.

The consequence for the evidentiary claim in §1.2: **`byte_count` and the shipment digest for this
sink describe what was sent, not what was stored**, and §4.1's "verify with `sha256sum`" has nothing
to run against — there is no object at the far end, and after SIEM-side normalization an auditor
cannot reconstruct the bytes at all. A deployment that needs a record it can demonstrate arrived
configures the S3 sink; the two run together and each batch goes to both.

---

## 2. The two rulings taken during implementation

Both are recorded in the ledger with their cost-if-wrong, both were agreed by the task reviewer, and
both change observable behaviour, so they belong here rather than in a commit message.

### 2.1 `ship()` waits for the receiver to close, not for our own `end()`

The plan's adapter resolved in `socket.end()`'s callback. That callback fires when *our* FIN has been
flushed locally, which under TLS 1.3 happens **before** a rejection alert or a mid-batch reset
arrives — so a batch the receiver refused was recorded as shipped. Four of the plan's own tests
failed on the first run for this reason, including two that merely count received messages: the
assertion ran before the receiver had parsed anything.

Recording a batch as shipped when the receiver rejected it is a false entry in a compliance record,
and at-least-once with a documented dedupe rule (§6.2, `docs/self-hosting.md` §13) already makes a
duplicate the cheaper of the two errors. So the adapter waits.

**The cost, and it is a real one.** A receiver that holds the connection open after our half-close —
some relays keep a session alive by design — stalls the batch to the 30-second timeout. The batch is
then retried on the normal backoff even though its bytes arrived, and the operator sees a growing
backlog and `timeout` in the panel against a receiver that looks healthy from its own side. Named in
`docs/self-hosting.md` §13 under *What shipping to a SIEM cannot promise*. If it ever bites in the
field, the fix is a grace timer after our half-close rather than reverting to resolve-on-`end()`.

A related discovery, measured rather than reasoned: the reviewer's suggested fix for the graceful
mid-batch close — an `ended` flag set in the write callback, with `close` resolving only when it is
set — **does not work on its own**. Node flushes the queued write before the socket closes, so the
callback always runs first and `close` with `ended === false` is not a state a graceful FIN can
produce. The signal a gracefully-giving-up receiver does emit is the FIN itself, arriving while we
are still writing, so the fix is the flag *plus* an `end` handler. The `close` arm is retained as an
uncovered backstop; counterfactual CF-3 in the task 3 report confirms no test reaches it.

### 2.2 A pre-handshake reset with no TLS error code is classified `tls`

**Known imprecision, deliberately taken.** §5.4 rule 2 reads "TLS handshake or verification failed",
and a connection that dies mid-negotiation is literally that, so `phaseReason()` converts a bare
reset to `tls` when the TCP connection was established, TLS was requested, and the handshake had not
completed.

**Cost if wrong: an operator whose load balancer resets connections is pointed at certificates before
connectivity.** That is why it stays out of `docs/self-hosting.md` — telling an operator that `tls`
sometimes means "your LB is resetting" makes the lookup key worse for the common case, and §5.4
exists to make the key a lookup rather than a menu.

Two things narrow it. Both ends of the window are checked, so a refusal before TCP is up
(`ECONNREFUSED`, no route) stays `network`, and a reset after the handshake — a receiver that went
away mid-batch — is also `network`. And every *identifiable* TLS failure carries a code and matches
the earlier rule anyway, which brings us to the honest answer to the question the plan's self-review
asked a reviewer to push on:

**Does the phase distinction actually separate a rejected client certificate from a mid-batch reset?
No — and the plan was wrong to expect it to.** Under TLS 1.3 the client reaches `secureConnect`
before the server has looked at the client certificate, so by the time the rejection alert arrives
the handshake is long complete and the phase flag is irrelevant. What classifies that case is the
error code: a receiver demanding a client certificate and getting none yields
`ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`, and an unverifiable server `DEPTH_ZERO_SELF_SIGNED_CERT`
— neither matching Node's `ERR_TLS*`, which is why `ERR_SSL*` was added to the code rules. Measured,
not assumed; removing the `ERR_SSL` rule makes the mutual-TLS test report `network`.

Since the phase flag turned out to be load-bearing for nothing the plan tested, a test was added that
exercises it directly: a receiver that accepts TCP and drops the connection on the ClientHello
reports a bare reset with no TLS code and must classify as `tls`. Without it the phase logic would be
untested speculation.

---

## 3. Deviations from the plan

### 3.1 Five corrections made before the first task was dispatched

The pre-flight scan found five conflicts in the plan's own code; each ruling is in the ledger with
its cost-if-wrong. Summarised because the plan file still carries the uncorrected text:

- `SYSLOG_FACILITIES` is an `as const` tuple and `z.enum()` takes it without a cast, so an unknown
  facility is a type error as well as a parse error. The plan's `readonly string[]` plus
  `as [string, ...string[]]` erased the literal types and was unsound.
- The BOM is written as a `\u`-escape, never as a literal character, in implementation and tests
  alike. An invisible character in an exact-match assertion is unreviewable and survives no
  copy-paste reliably. The task 1 implementer hit this twice before the scan's ruling caught it.
- The config test fixture gains `OIDC_ADMIN_GROUP`, without which every test in the file throws
  during parsing before reaching its assertion.
- `new URL(value)` in a try/catch replaces `URL.parse(value) !== null`. `URL.parse` is Node 22.1+ and
  this is a boot-critical refinement in an image pinned to `node:22`.
- The socket timeout fails with an error carrying `code: 'ETIMEDOUT'`. A bare `Error` has no code and
  `name === 'Error'`, so the plan's version mapped a stalled receiver to `network` — the exact
  confusion §5.4 separates `timeout` from `network` to prevent. `socketReason` is exported so the
  mapping is unit-testable without a socket that stalls for thirty seconds.

### 3.2 The oversize check runs before the socket opens, and the tests that prove it

The plan checked the message cap inside the write loop, which would leave a partial batch at the
receiver when a later row is the oversized one. It is now computed for the whole batch before the
socket opens.

Both of the plan's tests for this were non-discriminating, twice over. At `maxMessageBytes: 300` the
*first* row already frames to 379 bytes, so the cap tripped on row 1 and the "later row" test
asserted nothing about a later row. And `messages.length === 0` passes with the check in either
place, because `socket.destroy()` discards the buffered write and the receiver sees nothing either
way. The receiver helper therefore counts **accepted TCP connections**, and both tests assert the
socket never opened. With the check moved back into the write loop, both fail.

### 3.3 The `connect?: ConnectFn` seam was dropped

The plan declared an injection seam on `SyslogSinkConfig` for a fake socket. It is not implemented:
every test drives a real socket against a loopback receiver. Re-review reframed this as an
alternative to the 5 MB in-flight fixture rather than unused configurability, and it is worth
recording which way that came out — the real-socket test is what caught that the reviewer's suggested
fix was wrong about Node's flush ordering, and a fake socket would not have.

### 3.4 The mid-batch fixture is 20 000 rows, not four

Both mid-batch tests need the receiver to go away *while the write is in flight*: once we have
written everything and sent our FIN, syslog offers no signal at all. Measured 2026-09-05, three runs
each — 4 rows: the reset test failed 2 of 3 and the graceful-close test always failed; 500 and 2 000
rows: reset passes, graceful still fails; 20 000 rows (~5 MB): both pass 3 of 3. The threshold
measurement is recorded in a comment beside the fixture. Cost: ~300 ms on the file.

---

## 4. Measurements

- **Suites at the close of the branch**, all green: **394 unit** across 43 files, **430 integration**
  across 42 files, **106 e2e**, `pnpm lint` clean, `pnpm check` **0 errors / 0 warnings over 2721
  files**, and `pnpm check` and `pnpm build` both green under `env -i` — the CI property that the
  build needs neither secrets nor a database. B1 closed at 369 unit and 415 integration.
- **B2's own tests**: 9 unit for the message module, 10 unit for the configuration, 4 unit for
  `socketReason`, and 14 integration against an in-process TLS receiver (5.7 s).
- **TLS error codes**, measured against a real receiver on 2026-09-05, because the classification
  depends on them and the plan guessed wrong: a server demanding a client certificate the client does
  not have → `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`; an unverifiable server certificate →
  `DEPTH_ZERO_SELF_SIGNED_CERT`. Neither is `ERR_TLS*`.
- **Message size**: an ordinary audit row frames to ~379 bytes, against the 8192-byte default cap. A
  deployment meets the cap only with large `meta`.
- **CI cost: none.** No new container, no new dependency. `node:tls` and `node:net` are in the
  runtime already, and the receiver the tests run against is in-process.

---

## 5. Defects and costs left standing

### 5.1 `openssl` is a test-time dependency of the integration suite

`tests/helpers/syslog-server.ts` shells out to `openssl req -x509` through `execFileSync` to mint a
self-signed certificate that is also its own CA — which is what lets one file exercise private-CA
verification without a signing chain. It behaved as expected on macOS 25.6 (`-addext
subjectAltName=...` accepted) and openssl is present in the CI image, so this is not currently
breaking anything.

It is recorded because it is an undeclared dependency: nothing in `package.json` or the CI workflow
names it, and a runner without `openssl`, or with a build old enough to reject `-addext`, fails the
whole syslog integration file with an `execFileSync` error rather than an assertion. The alternatives
are a checked-in fixture certificate, which expires and which nobody will notice expiring, or
generating the material in Node, which is a good deal more code for a test helper. Left as it is and
put on the backlog under *Open*, rather than discovered in CI on some other platform.

### 5.2 The oversize cap counts the RFC 6587 framing prefix

`framed.byteLength` includes the `MSG-LEN SP` prefix, so the 8192-byte default is roughly five bytes
tighter than rsyslog's `MaxMessageSize`, which §5.3 anchors it to. Errs conservative — a message that
passes ours passes theirs — and the discrepancy is invisible at any realistic row size. Not worth a
behaviour change; worth knowing before somebody "fixes" it in the other direction.

### 5.3 `field()` maps an over-cap or non-printable header value to nil, silently

RFC 5424 requires printable ASCII and `-` where there is no value, so a hostname that is too long or
non-ASCII becomes `-` rather than an error. In practice HOSTNAME comes from `BASE_URL` (D2) and an
IDN host would vanish from every message with no signal. There is no boundary test at exactly
`MAX_HOSTNAME` or `MAX_APP_NAME`. The failure is cosmetic at the receiver rather than lossy — MSG is
untouched — which is why it stands.

### 5.4 Handshake phases classify asymmetrically

A reset during the handshake is `tls` (§2.2 above); a *stall* during the handshake is `timeout`. Both
are defensible on §5.4 read literally, and the pair was chosen rather than fallen into, but they are
not symmetric and a later reader should not take one as evidence about the other.

### 5.5 Two guards no test can reach

`guard()`'s fallback routes a non-`SinkError` throw through `socketReason` to `network`; its one live
source is `facilityCode()` on an unknown facility, which is §5.4 rule 1 `config` and which config
parsing already makes unreachable. And the write-callback's error branch cannot fail any test,
because Node also emits `'error'` for the same failure and the handler already catches it. Both are
defensive and both are untested. Neither is worth production code to make reachable.

Related and harmless: `fail({ code: 'ECONNRESET' })` labels a graceful FIN a reset internally. It
never escapes the closed-set `SinkError('network')`, so no operator ever sees the mislabel.

### 5.6 Two coverage gaps inherited from the plan's tests

The mutual-TLS pair rule is tested for cert-without-key but not key-without-cert; the check is
symmetric over one filter, so this is a coverage gap rather than a correctness one. And the "ships to
both sinks" switch test asserts only that `shipClaimed` was called once, which would also pass under
S3-only wiring — the sibling "claims for syslog alone" case is what actually catches a reverted
`adapters()`.

---

## 6. What a later reader does not have to rediscover

- **`SinkName`, the CHECK constraint and the queue-depth gauge already carried `'syslog'`** from B1,
  so B2 added an adapter and a config block and needed no migration. A third sink would need one.
- **`ship()` returning `null`** is the case B1 widened the port's return type for; there is no object
  key to record and `audit_batch_shipment.object_key` stays null for this sink by design.
- **`objectLock` is absent from the syslog adapter**, which is why B1 made the port method optional.
  A syslog receiver's retention is not something we can ask it, and the panel reports `null` rather
  than inventing an answer.
- **The `AUDIT_SINK_ENABLED` boot rule was widened, not replaced** — syslog alone is a configured
  sink. The S3 partial-configuration branch is untouched, and a second rule was added for the
  mutual-TLS pair.
- **Nothing in this subsystem writes an audit event**, per §8, and nothing from a receiver reaches
  `last_error`: every rejection is a `SinkError` carrying only a closed-set reason. `MessageTooLarge`
  carries a byte count and no content, deliberately, because `last_error` is written to a table that
  forbids DELETE and is excluded from retention.
- **`rejectUnauthorized: true` is a literal at the one call site.** No option, config field or
  environment variable can reach it, and that is the whole TLS posture §5.3 asks for.
