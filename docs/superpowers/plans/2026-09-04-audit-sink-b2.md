# Audit sink B2 — syslog adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the audit log to a SIEM over syslog, as the audit sink's second adapter, so the port
is proven by two transports that stress it in opposite directions.

**Architecture:** A second `AuditSinkAdapter` implementation over `node:tls`. It receives the same
`SinkBatch` every sink receives — one NDJSON body and a manifest — and splits the body back into its
LF-terminated lines, sending one RFC 5424 message per line with RFC 6587 octet-counting framing, then
a trailing message carrying the manifest. One connection per batch, closed after the manifest. It
returns `null` from `ship()`, because there is no object at the far end to point an auditor at.

**Tech Stack:** `node:tls` and `node:net` (no new dependency), Zod for configuration, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-audit-sink-design.md` — §5.1, §5.3, §5.4, §11, §13, §14.
B1's carry-over (`docs/superpowers/subsystem-b1-carryover.md` §5) states what the spine already
provides and what B2 must not assume it inherits.

---

## Global Constraints

- **Tabs, single quotes, no trailing commas, 100-column print width** (`.prettierrc`). Run
  `pnpm format` before every commit.
- **Comments explain *why*, naming the failure mode prevented or a spec section** (`spec §5.3`).
  Match the surrounding density; do not restate code.
- **`getConfig()`, `getDb()`, `getStorage()` are lazy singletons.** Importing any module in this plan
  must never open a connection or require a configured environment — `pnpm build` runs with an empty
  environment and CI proves it.
- **`audit_event` is append-only.** Nothing in this plan writes, updates or deletes a row in it.
- **The sink writes no audit events** (spec §8). No `recordEvent` call appears anywhere in this
  subsystem.
- **`last_error` holds a value from the closed set only** — never a receiver message, never a socket
  error string (spec §5.4). The set is `SHIPMENT_ERROR_REASONS` in
  `src/lib/server/db/schema/auditsink.ts` and it does not change in this plan.
- **`rejectUnauthorized` is never disabled, and no environment variable exists to disable it**
  (spec §5.3). A plan step that adds one is wrong.
- **UDP is not supported** (spec §5.3). `tls://` and `tcp://` only.
- Defaults, verbatim from spec §11: `AUDIT_SINK_SYSLOG_FACILITY` **`local0`**,
  `AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES` **8192**.
- Adapter timeout **30_000 ms**, matching `TIMEOUT_MS` in `src/lib/server/auditsink/s3.ts`.

## Decisions this plan makes that the spec left open

§5.3 fixes the framing, the transport, the TLS posture and the message-size rule, but not the RFC
5424 header fields or which closed reason an oversized row produces. Each of these is decided here
with its reasoning, so a reviewer can reject the decision rather than discover it.

- **D1 — SEVERITY is `notice` (5), not `info` (6).** RFC 5424 defines 5 as "normal but significant
  condition", which is what an audit record is. It also survives the `*.info` filters SIEM operators
  routinely apply, and a compliance record silently dropped by a default filter is the failure mode
  this subsystem exists to prevent. PRI is `facility * 8 + 5`; with the `local0` default that is
  `<133>`. §11 defines no severity variable, so this is fixed, not configurable.
- **D2 — HOSTNAME is the host of `BASE_URL`.** `os.hostname()` in a container is a scheduler-assigned
  id that means nothing to the SIEM operator reading the message, and it changes on every deploy.
  The trust center's own host names the deployment, is already public, and is stable.
- **D3 — APP-NAME is `trustcenter`**, matching the `trustcenter.*` telemetry namespace.
- **D4 — PROCID carries the batch id.** RFC 5424 says a change in PROCID indicates a discontinuity in
  reporting, which is exactly a batch boundary. This is what lets a SIEM correlate rows to the
  manifest message that follows them without a structured-data element, and therefore without a
  private enterprise number this project does not have.
- **D5 — MSGID is `audit` for row messages, `manifest` for the trailing one, `attest` for an
  attestation.** A SIEM can route on it. RFC 5424 caps MSGID at 32 characters; all three fit.
- **D6 — STRUCTURED-DATA is nil (`-`).** A private SD-ID requires a registered enterprise number.
  D4 already supplies the correlation SD would have carried.
- **D7 — MSG carries a UTF-8 BOM before the JSON.** RFC 5424 §6.4 makes the BOM how a receiver knows
  the MSG is UTF-8; without it a receiver may treat the payload as unknown bytes. The consequence is
  that the octets on the wire are not byte-identical to the canonical line, which costs nothing:
  §5.3 already records that the digest is not reproducible from what a SIEM stored.
- **D8 — a row exceeding `MAX_MESSAGE_BYTES` fails the batch with reason `config`.** The limit is an
  operator setting and the remedy is an operator setting — raise it, or raise the receiver's. It is
  not `network`, which would send an operator looking at sockets. The batch fails rather than the row
  being truncated or skipped, per §5.3: a truncated row can never reproduce its digest, and a skipped
  one makes the sink silently lossy.
- **D9 — PEM variables accept `\n` escape sequences and convert them to newlines.** A PEM block is
  multi-line and a `docker run -e` argument is not; without this the CA and client-certificate
  variables are unusable in the deployment shape this product actually ships in. A value already
  containing real newlines is passed through unchanged.

---

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `src/lib/server/auditsink/syslog-message.ts` | RFC 5424 message construction and RFC 6587 framing. Pure — no sockets. |
| `src/lib/server/auditsink/syslog.ts` | `createSyslogAdapter`, the connection, the write loop, error mapping |
| `tests/unit/auditsink-syslog-message.test.ts` | Header fields, PRI, framing, the BOM, the size rule |
| `tests/unit/auditsink-syslog-config.test.ts` | URL parsing, the group rule, the PEM normalization |
| `tests/integration/auditsink-syslog.test.ts` | The adapter against an in-process TLS server |
| `tests/helpers/syslog-server.ts` | A TLS/TCP syslog receiver on loopback, plus self-signed material |

**Modified:** `src/lib/server/config/parse.ts`, `src/lib/server/auditsink/index.ts` (`adapters()`),
`src/lib/server/auditsink/status.ts` (`adapterFor()`), `docs/self-hosting.md`, `.env.example`,
`docs/superpowers/specs/2026-09-04-audit-sink-design.md` (§19), `docs/superpowers/backlog.md`.

**Deliberately not modified:** `src/lib/server/db/schema/auditsink.ts` — `SINK_NAMES` and the
`audit_batch_shipment_sink_check` CHECK constraint already carry `'syslog'`, so **no migration is
needed in this plan.** A step that adds one is wrong.

---

## Task 1: RFC 5424 messages and RFC 6587 framing

**Files:**
- Create: `src/lib/server/auditsink/syslog-message.ts`, `tests/unit/auditsink-syslog-message.test.ts`

**Interfaces:**
- Consumes: nothing. Pure module, no imports beyond `node:buffer` semantics.
- Produces:
  - `SYSLOG_FACILITIES: readonly string[]` — the RFC 5424 facility names this accepts.
  - `facilityCode(name: string): number`
  - `interface MessageParams { facility: string; hostname: string; procId: string; msgId: string; timestamp: Date; message: string }`
  - `buildMessage(params: MessageParams): string` — one RFC 5424 message, no framing.
  - `frame(message: string): Buffer` — RFC 6587 octet counting.
  - `MessageTooLarge` — an error class carrying no receiver data.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
	buildMessage,
	facilityCode,
	frame,
	MessageTooLarge,
	SYSLOG_FACILITIES
} from '../../src/lib/server/auditsink/syslog-message';

const params = {
	facility: 'local0',
	hostname: 'trust.example.com',
	procId: '11111111-1111-4111-8111-111111111111',
	msgId: 'audit',
	timestamp: new Date('2026-09-04T12:00:00.123Z'),
	message: '{"a":1}'
};

describe('facilityCode', () => {
	it('maps the RFC 5424 names to their numbers', () => {
		expect(facilityCode('local0')).toBe(16);
		expect(facilityCode('local7')).toBe(23);
		expect(facilityCode('daemon')).toBe(3);
		expect(facilityCode('authpriv')).toBe(10);
	});

	it('offers exactly the names it can map', () => {
		for (const name of SYSLOG_FACILITIES) expect(facilityCode(name)).toBeTypeOf('number');
	});
});

describe('buildMessage', () => {
	it('builds a version-1 header with a nil structured-data field', () => {
		// PRI is facility * 8 + severity, and severity is notice (5), not info:
		// notice survives the `*.info` filters SIEM operators routinely apply,
		// and a compliance record dropped by a default filter is the failure
		// this subsystem exists to prevent (decision D1).
		expect(buildMessage(params)).toBe(
			'<133>1 2026-09-04T12:00:00.123Z trust.example.com trustcenter ' +
				'11111111-1111-4111-8111-111111111111 audit - ﻿{"a":1}'
		);
	});

	it('moves PRI with the facility', () => {
		expect(buildMessage({ ...params, facility: 'local7' })).toMatch(/^<189>1 /);
	});

	it('prefixes the message with a UTF-8 BOM so the receiver reads it as UTF-8', () => {
		// RFC 5424 §6.4. The wire bytes are therefore not byte-identical to the
		// canonical line, which costs nothing: §5.3 already records that the
		// digest is not reproducible from what a SIEM stored (decision D7).
		const message = buildMessage(params);
		expect(message.slice(message.indexOf('- ') + 2)).toBe('﻿{"a":1}');
	});

	it('emits a nil value for a field it has nothing to put in', () => {
		expect(buildMessage({ ...params, procId: '' })).toContain(' trustcenter - audit - ');
	});
});

describe('frame', () => {
	it('prefixes the octet count and a space, per RFC 6587', () => {
		expect(frame('abc')).toEqual(Buffer.from('3 abc', 'utf8'));
	});

	it('counts octets, not characters', () => {
		// 'ä' is two octets in UTF-8. A length-prefixed frame that counted
		// characters would desynchronise the receiver's stream for every
		// subsequent message on the connection.
		expect(frame('ä').toString('utf8')).toBe('2 ä');
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit tests/unit/auditsink-syslog-message.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * RFC 5424 message construction and RFC 6587 octet-counting framing, kept
 * apart from the socket so the wire format is testable without one — the
 * header fields are where a receiver silently rejects or misfiles a message,
 * and that is not a property a mocked socket can assert (spec §5.3).
 */

/** RFC 5424 §6.2.1, in numeric order, restricted to the facilities an
 * application may legitimately claim. Kernel, mail, news, uucp and cron are
 * omitted: they are the system's to write, not ours. */
const FACILITY_CODES: Record<string, number> = {
	user: 1,
	daemon: 3,
	auth: 4,
	syslog: 5,
	authpriv: 10,
	ftp: 11,
	local0: 16,
	local1: 17,
	local2: 18,
	local3: 19,
	local4: 20,
	local5: 21,
	local6: 22,
	local7: 23
};

export const SYSLOG_FACILITIES = Object.keys(FACILITY_CODES) as readonly string[];

/** `notice`, not `info` — decision D1. */
const SEVERITY_NOTICE = 5;

/** RFC 5424 field length caps (§6.2). Exceeding one is a rejected message at
 * a strict receiver, so they are enforced here rather than discovered. */
const MAX_HOSTNAME = 255;
const MAX_APP_NAME = 48;
const MAX_PROC_ID = 128;
const MAX_MSG_ID = 32;

export const APP_NAME = 'trustcenter';

export function facilityCode(name: string): number {
	const code = FACILITY_CODES[name];
	if (code === undefined) throw new Error(`unknown syslog facility: ${name}`);

	return code;
}

export interface MessageParams {
	facility: string;
	hostname: string;
	procId: string;
	msgId: string;
	timestamp: Date;
	message: string;
}

/** RFC 5424 requires a printable-ASCII field, and `-` where there is no
 * value. A field that is empty or over its cap becomes nil rather than
 * producing a message a strict receiver drops. */
function field(value: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) return '-';

	return /^[\x21-\x7e]+$/.test(trimmed) ? trimmed : '-';
}

export function buildMessage(params: MessageParams): string {
	const pri = facilityCode(params.facility) * 8 + SEVERITY_NOTICE;
	const header = [
		`<${pri}>1`,
		params.timestamp.toISOString(),
		field(params.hostname, MAX_HOSTNAME),
		field(APP_NAME, MAX_APP_NAME),
		field(params.procId, MAX_PROC_ID),
		field(params.msgId, MAX_MSG_ID),
		// Structured data is nil: a private SD-ID needs a registered enterprise
		// number, and PROCID already carries the batch correlation it would
		// have held (decisions D4, D6).
		'-'
	].join(' ');

	return `${header} ﻿${params.message}`;
}

/** Thrown with no receiver data and no message content: `last_error` is
 * written to a table that forbids DELETE and is excluded from retention, so a
 * row's bytes must never reach it (spec §5.4, issue #11). */
export class MessageTooLarge extends Error {
	constructor(readonly bytes: number) {
		super('message exceeds the configured maximum');
		this.name = 'MessageTooLarge';
	}
}

/**
 * RFC 6587 octet counting — `MSG-LEN SP SYSLOG-MSG` — which is the only
 * unambiguous framing over a stream. The count is octets after UTF-8
 * encoding, not characters: counting characters would desynchronise the
 * receiver for every later message on the same connection.
 */
export function frame(message: string): Buffer {
	const body = Buffer.from(message, 'utf8');

	return Buffer.concat([Buffer.from(`${body.byteLength} `, 'ascii'), body]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test:unit tests/unit/auditsink-syslog-message.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/auditsink/syslog-message.ts tests/unit/auditsink-syslog-message.test.ts
git commit -m "feat(auditsink): RFC 5424 messages and RFC 6587 framing"
```

---

## Task 2: Configuration

**Files:**
- Modify: `src/lib/server/config/parse.ts`
- Create: `tests/unit/auditsink-syslog-config.test.ts`

**Interfaces:**
- Consumes: `SYSLOG_FACILITIES` (Task 1).
- Produces: `getConfig().auditSink.syslog?: { url: string; tls: boolean; host: string; port: number; ca?: string; clientCert?: string; clientKey?: string; facility: string; maxMessageBytes: number }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/lib/server/config/parse';

const base = {
	DATABASE_URL: 'postgres://u:p@localhost:5432/db',
	BASE_URL: 'https://trust.example.com',
	LOCALES: 'de,en',
	DEFAULT_LOCALE: 'de',
	OIDC_ISSUER: 'https://idp.example.com',
	OIDC_CLIENT_ID: 'client',
	OIDC_CLIENT_SECRET: 'secret'
};

function parse(overrides: Record<string, string>) {
	return parseConfig({ ...base, ...overrides }, ['de', 'en']);
}

describe('the syslog sink configuration', () => {
	it('parses a tls URL into host, port and a tls flag', () => {
		const { syslog } = parse({ AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com:6514' }).auditSink;

		expect(syslog).toMatchObject({ host: 'siem.example.com', port: 6514, tls: true });
	});

	it('defaults the port per scheme — 6514 for tls, 514 for tcp', () => {
		expect(parse({ AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com' }).auditSink.syslog?.port).toBe(
			6514
		);
		expect(parse({ AUDIT_SINK_SYSLOG_URL: 'tcp://siem.example.com' }).auditSink.syslog?.port).toBe(
			514
		);
	});

	it('refuses udp outright', () => {
		// Spec §5.3: silent loss disqualifies a compliance record, and there is
		// no variable anywhere that re-enables it.
		expect(() => parse({ AUDIT_SINK_SYSLOG_URL: 'udp://siem.example.com:514' })).toThrow();
	});

	it('refuses a facility it cannot map', () => {
		expect(() =>
			parse({
				AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com',
				AUDIT_SINK_SYSLOG_FACILITY: 'kern'
			})
		).toThrow();
	});

	it('defaults the facility to local0 and the message cap to 8 KiB', () => {
		const { syslog } = parse({ AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com' }).auditSink;

		expect(syslog).toMatchObject({ facility: 'local0', maxMessageBytes: 8192 });
	});

	it('converts escaped newlines in a PEM variable into real ones', () => {
		// A PEM block is multi-line and `docker run -e` is not; without this the
		// CA variable is unusable in the shape this product ships in (D9).
		const { syslog } = parse({
			AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com',
			AUDIT_SINK_SYSLOG_CA: '-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----'
		}).auditSink;

		expect(syslog?.ca).toBe('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----');
	});

	it('leaves a PEM that already has real newlines alone', () => {
		const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
		const { syslog } = parse({
			AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com',
			AUDIT_SINK_SYSLOG_CA: pem
		}).auditSink;

		expect(syslog?.ca).toBe(pem);
	});

	it('requires the client certificate and key together, or neither', () => {
		expect(() =>
			parse({
				AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com',
				AUDIT_SINK_SYSLOG_CLIENT_CERT: '-----BEGIN CERTIFICATE-----'
			})
		).toThrow();
	});

	it('accepts the sink enabled with syslog alone and no S3', () => {
		// The B1 boot rule was S3-shaped: extended, not replaced, or enabling
		// the sink with syslog alone would refuse to boot (B1 carry-over §5).
		const { auditSink } = parse({
			AUDIT_SINK_ENABLED: 'true',
			AUDIT_SINK_SYSLOG_URL: 'tls://siem.example.com'
		});

		expect(auditSink.enabled).toBe(true);
		expect(auditSink.s3).toBeUndefined();
		expect(auditSink.syslog).toBeDefined();
	});

	it('still refuses the sink enabled with no sink at all', () => {
		expect(() => parse({ AUDIT_SINK_ENABLED: 'true' })).toThrow();
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit tests/unit/auditsink-syslog-config.test.ts`
Expected: FAIL — `auditSink.syslog` is undefined and the enabled-with-syslog case throws.

- [ ] **Step 3: Add the schema fields**

In `src/lib/server/config/parse.ts`, import the facility list at the top, beside the existing
imports:

```ts
import { SYSLOG_FACILITIES } from '../auditsink/syslog-message';
```

Add a helper beside `blankAsUndefined`:

```ts
/**
 * A PEM block is multi-line and a `docker run -e` argument is not, so an
 * operator's only way to pass one is `\n` escapes. A value that already
 * contains real newlines passes through untouched (decision D9).
 */
const pemText = (schema: z.ZodString) => schema.transform((value) => value.replace(/\\n/g, '\n'));
```

Add the fields after `AUDIT_SINK_S3_PREFIX`:

```ts
			// `tls://host:6514` or `tcp://host:514`. UDP is absent by construction
			// rather than rejected by a rule, because silent loss disqualifies a
			// compliance record and there must be no variable that re-enables it
			// (spec §5.3).
			AUDIT_SINK_SYSLOG_URL: blankAsUndefined(
				z
					.string()
					.min(1)
					.refine((value) => /^tls:\/\/|^tcp:\/\//.test(value), {
						message: 'AUDIT_SINK_SYSLOG_URL must start with tls:// or tcp:// — UDP is not supported'
					})
					.refine((value) => URL.parse(value) !== null, {
						message: 'AUDIT_SINK_SYSLOG_URL is not a valid URL'
					})
			),
			AUDIT_SINK_SYSLOG_CA: blankAsUndefined(pemText(z.string().min(1))),
			AUDIT_SINK_SYSLOG_CLIENT_CERT: blankAsUndefined(pemText(z.string().min(1))),
			AUDIT_SINK_SYSLOG_CLIENT_KEY: blankAsUndefined(pemText(z.string().min(1))),
			AUDIT_SINK_SYSLOG_FACILITY: z.enum(SYSLOG_FACILITIES as [string, ...string[]]).default('local0'),
			// 8 KiB, matching rsyslog's default. A row above it fails the batch
			// rather than being truncated: a truncated row can never reproduce
			// its digest (spec §5.3).
			AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(8192)
```

- [ ] **Step 4: Extend the boot rules**

Replace the `if (value.AUDIT_SINK_ENABLED && s3FieldsSet === 0)` condition in the existing
`superRefine`, and add the client-pair rule after the S3 group rule:

```ts
			const anySinkConfigured = s3FieldsSet > 0 || value.AUDIT_SINK_SYSLOG_URL !== undefined;

			if (value.AUDIT_SINK_ENABLED && !anySinkConfigured) {
				ctx.addIssue({
					code: 'custom',
					path: ['AUDIT_SINK_ENABLED'],
					message:
						'AUDIT_SINK_ENABLED is true but no sink is configured — set the AUDIT_SINK_S3_* ' +
						'or AUDIT_SINK_SYSLOG_* variables'
				});
			} else if (s3FieldsSet > 0 && s3FieldsSet < s3Fields.length) {
				ctx.addIssue({
					code: 'custom',
					path: ['AUDIT_SINK_S3_BUCKET'],
					message:
						'AUDIT_SINK_S3_BUCKET, AUDIT_SINK_S3_REGION, AUDIT_SINK_S3_ACCESS_KEY_ID and ' +
						'AUDIT_SINK_S3_SECRET_ACCESS_KEY must all be set together, or none at all'
				});
			}

			// Half of a mutual-TLS pair is not a weaker configuration, it is a
			// handshake that fails on every tick — the same reasoning the S3
			// group rule above carries.
			const clientPair = [value.AUDIT_SINK_SYSLOG_CLIENT_CERT, value.AUDIT_SINK_SYSLOG_CLIENT_KEY];
			const clientPairSet = clientPair.filter((field) => field !== undefined).length;

			if (clientPairSet === 1) {
				ctx.addIssue({
					code: 'custom',
					path: ['AUDIT_SINK_SYSLOG_CLIENT_CERT'],
					message:
						'AUDIT_SINK_SYSLOG_CLIENT_CERT and AUDIT_SINK_SYSLOG_CLIENT_KEY must be set ' +
						'together, or neither'
				});
			}
```

- [ ] **Step 5: Map it into `AppConfig`**

Add to the `auditSink` block of the returned object, after `s3`:

```ts
			syslog: parsed.AUDIT_SINK_SYSLOG_URL
				? (() => {
						const url = new URL(parsed.AUDIT_SINK_SYSLOG_URL);
						const tls = url.protocol === 'tls:';

						return {
							url: parsed.AUDIT_SINK_SYSLOG_URL!,
							tls,
							host: url.hostname,
							// The scheme's default, because an operator who writes
							// `tls://siem.example.com` means 6514 and should not have to
							// say so.
							port: url.port ? Number(url.port) : tls ? 6514 : 514,
							ca: parsed.AUDIT_SINK_SYSLOG_CA,
							clientCert: parsed.AUDIT_SINK_SYSLOG_CLIENT_CERT,
							clientKey: parsed.AUDIT_SINK_SYSLOG_CLIENT_KEY,
							facility: parsed.AUDIT_SINK_SYSLOG_FACILITY,
							maxMessageBytes: parsed.AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES
						};
					})()
				: undefined
```

Add the matching field to the `AppConfig` interface's `auditSink` type.

- [ ] **Step 6: Run the config suites**

Run: `pnpm test:unit tests/unit/auditsink-syslog-config.test.ts tests/unit/config.test.ts`
Expected: PASS. `config.test.ts` must be unchanged — if its "enabled with no sink" case now fails,
Step 4's condition is wrong.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add src/lib/server/config/parse.ts tests/unit/auditsink-syslog-config.test.ts
git commit -m "feat(auditsink): parse and validate the syslog sink configuration"
```

---

## Task 3: The adapter

**Files:**
- Create: `src/lib/server/auditsink/syslog.ts`, `tests/helpers/syslog-server.ts`,
  `tests/integration/auditsink-syslog.test.ts`

**Interfaces:**
- Consumes: `buildMessage`, `frame`, `facilityCode`, `MessageTooLarge` (Task 1); `AuditSinkAdapter`,
  `SinkBatch`, `Attestation`, `SinkError` from `./port`; the config shape from Task 2.
- Produces: `createSyslogAdapter(config: SyslogSinkConfig): AuditSinkAdapter`, and
  `interface SyslogSinkConfig { host; port; tls; ca?; clientCert?; clientKey?; facility; maxMessageBytes; hostname; connect?: ConnectFn }`.

- [ ] **Step 1: Write the test receiver**

Create `tests/helpers/syslog-server.ts`. `openssl` is used rather than a new dependency; it is
present on macOS and on `ubuntu-latest`. Each certificate is self-signed and also serves as its own
CA, which exercises the private-CA path without building a signing chain.

```ts
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';

export interface Material {
	cert: string;
	key: string;
}

/** A self-signed certificate that is also its own CA, so a test can pass it as
 * `ca` and exercise private-CA verification without a signing chain. */
export function selfSigned(commonName: string): Material {
	const dir = mkdtempSync(join(tmpdir(), 'syslog-tls-'));
	const keyPath = join(dir, 'key.pem');
	const certPath = join(dir, 'cert.pem');

	execFileSync('openssl', [
		'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
		'-keyout', keyPath, '-out', certPath, '-days', '1',
		'-subj', `/CN=${commonName}`,
		'-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
	]);

	return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}

export interface SyslogServer {
	port: number;
	/** Complete RFC 6587 frames, unframed back into messages. */
	messages: string[];
	/** Closes the socket mid-stream on the nth frame, for the write-failure test. */
	closeAfter: (frames: number) => void;
	close: () => Promise<void>;
}

/**
 * A receiver on loopback that un-frames RFC 6587 octet counting, so the tests
 * assert what a real syslog server would parse rather than what the adapter
 * believes it wrote.
 */
export async function startSyslogServer(options: {
	tls?: Material;
	/** Set to require a client certificate, for the mutual-TLS test. */
	requireClientCert?: Material;
} = {}): Promise<SyslogServer> {
	const messages: string[] = [];
	let closeAtFrame = Infinity;

	const onConnection = (socket: NodeJS.ReadWriteStream & { destroy: () => void }) => {
		let buffer = Buffer.alloc(0);

		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);

			for (;;) {
				const space = buffer.indexOf(0x20);
				if (space < 0) return;

				const length = Number(buffer.subarray(0, space).toString('ascii'));
				if (!Number.isFinite(length)) return;
				if (buffer.byteLength < space + 1 + length) return;

				messages.push(buffer.subarray(space + 1, space + 1 + length).toString('utf8'));
				buffer = buffer.subarray(space + 1 + length);

				if (messages.length >= closeAtFrame) {
					socket.destroy();
					return;
				}
			}
		});
		socket.on('error', () => undefined);
	};

	const server: TlsServer | TcpServer = options.tls
		? createTlsServer(
				{
					cert: options.tls.cert,
					key: options.tls.key,
					requestCert: options.requireClientCert !== undefined,
					rejectUnauthorized: options.requireClientCert !== undefined,
					ca: options.requireClientCert ? [options.requireClientCert.cert] : undefined
				},
				onConnection
			)
		: createTcpServer(onConnection);

	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('no port');

	return {
		port: address.port,
		messages,
		closeAfter: (frames) => (closeAtFrame = frames),
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
			})
	};
}
```

- [ ] **Step 2: Write the failing integration test**

Create `tests/integration/auditsink-syslog.test.ts`. It needs no database; it lives in the
integration suite because it opens real sockets.

```ts
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyslogAdapter } from '../../src/lib/server/auditsink/syslog';
import { buildManifest, serializeBatch } from '../../src/lib/server/auditsink/serialize';
import { selfSigned, startSyslogServer, type SyslogServer } from '../helpers/syslog-server';
import type { SinkBatch } from '../../src/lib/server/auditsink/port';
import type { AuditRowText } from '../../src/lib/server/auditsink/serialize';

const server = selfSigned('localhost');
const client = selfSigned('trustcenter');
let running: SyslogServer | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

function row(overrides: Partial<AuditRowText> = {}): AuditRowText {
	return {
		id: randomUUID(),
		seq: '42',
		at: '2026-09-04T12:00:00.123456Z',
		actor_type: 'staff',
		actor_id: 'staff-1',
		action: 'document.published',
		subject_type: 'document',
		subject_id: 'doc-1',
		ip: null,
		ua: null,
		request_id: 'req-1',
		meta: '{"a": 1}',
		...overrides
	};
}

function batch(rows: readonly AuditRowText[] = [row(), row()]): SinkBatch {
	const id = randomUUID();
	const { body, digest } = serializeBatch(rows);

	return {
		id,
		body,
		digest,
		manifest: buildManifest({
			id,
			createdAt: '2026-09-04T12:00:00.000000Z',
			prevCursor: { xmin: 1n, seq: 1n },
			cursor: { xmin: 2n, seq: 42n },
			rowCount: rows.length,
			minSeq: 42n,
			maxSeq: 42n,
			byteCount: body.byteLength,
			digest
		})
	};
}

function adapterFor(port: number, overrides: Record<string, unknown> = {}) {
	return createSyslogAdapter({
		host: '127.0.0.1',
		port,
		tls: true,
		ca: server.cert,
		facility: 'local0',
		maxMessageBytes: 8192,
		hostname: 'trust.example.com',
		...overrides
	});
}

describe('the syslog adapter', () => {
	it('sends one message per row and a trailing manifest message', async () => {
		running = await startSyslogServer({ tls: server });

		const sink = batch();
		await expect(adapterFor(running.port).ship(sink)).resolves.toBeNull();

		expect(running.messages).toHaveLength(3);
		expect(running.messages[0]).toContain(` ${sink.id} audit - `);
		expect(running.messages[2]).toContain(` ${sink.id} manifest - `);
		// The manifest message is what a SIEM correlates the rows to, since
		// there is no object at the far end (spec §5.3).
		expect(running.messages[2]).toContain(sink.digest);
	});

	it('returns null rather than a key, because there is no object to point at', async () => {
		running = await startSyslogServer({ tls: server });

		await expect(adapterFor(running.port).ship(batch())).resolves.toBeNull();
	});

	it('verifies the server certificate against the configured CA', async () => {
		running = await startSyslogServer({ tls: server });

		await expect(adapterFor(running.port).ship(batch())).resolves.toBeNull();
	});

	it('refuses a server it cannot verify, and never disables rejectUnauthorized', async () => {
		// Spec §5.3: there is no variable that turns this off, so an untrusted
		// receiver must fail rather than degrade.
		running = await startSyslogServer({ tls: selfSigned('someone-else') });

		await expect(adapterFor(running.port).ship(batch())).rejects.toMatchObject({ reason: 'tls' });
	});

	it('presents a client certificate when one is configured', async () => {
		running = await startSyslogServer({ tls: server, requireClientCert: client });

		await expect(
			adapterFor(running.port, { clientCert: client.cert, clientKey: client.key }).ship(batch())
		).resolves.toBeNull();
	});

	it('fails when the receiver demands a client certificate and none is configured', async () => {
		running = await startSyslogServer({ tls: server, requireClientCert: client });

		await expect(adapterFor(running.port).ship(batch())).rejects.toMatchObject({ reason: 'tls' });
	});

	it('reports network when the receiver closes mid-batch', async () => {
		running = await startSyslogServer({ tls: server });
		running.closeAfter(1);

		await expect(
			adapterFor(running.port).ship(batch([row(), row(), row(), row()]))
		).rejects.toMatchObject({ reason: 'network' });
	});

	it('reports network when nothing is listening', async () => {
		await expect(adapterFor(1).ship(batch())).rejects.toMatchObject({ reason: 'network' });
	});

	it('fails the batch with config when a row exceeds the message cap', async () => {
		// Not truncated and not skipped: a truncated row can never reproduce its
		// digest, and a skipped one makes the sink silently lossy (spec §5.3,
		// decision D8).
		running = await startSyslogServer({ tls: server });

		await expect(
			adapterFor(running.port, { maxMessageBytes: 64 }).ship(batch())
		).rejects.toMatchObject({ reason: 'config' });
		expect(running.messages).toHaveLength(0);
	});

	it('sends nothing at all when a later row is the oversized one', async () => {
		// The size check runs over the whole batch before the connection opens,
		// so a partial batch never reaches the receiver.
		running = await startSyslogServer({ tls: server });
		const rows = [row(), row({ meta: `{"pad":"${'x'.repeat(400)}"}` })];

		await expect(
			adapterFor(running.port, { maxMessageBytes: 300 }).ship(batch(rows))
		).rejects.toMatchObject({ reason: 'config' });
		expect(running.messages).toHaveLength(0);
	});

	it('speaks plain TCP when the scheme says so', async () => {
		running = await startSyslogServer();

		await expect(
			adapterFor(running.port, { tls: false, ca: undefined }).ship(batch())
		).resolves.toBeNull();
	});

	it('writes an attestation as one message', async () => {
		running = await startSyslogServer({ tls: server });

		await adapterFor(running.port).attest({
			at: '2026-09-04T12:00:00.000Z',
			event_count: '10',
			max_seq: '10',
			cursor: { xmin: '5', seq: '10' },
			last_batch_id: null,
			batches_since: 2
		});

		expect(running.messages).toHaveLength(1);
		expect(running.messages[0]).toContain(' attest - ');
	});
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test:integration tests/integration/auditsink-syslog.test.ts`
Expected: FAIL — `src/lib/server/auditsink/syslog.ts` does not exist.

- [ ] **Step 4: Implement**

```ts
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { SinkError } from './port';
import { buildMessage, frame, MessageTooLarge } from './syslog-message';
import type { Attestation, AuditSinkAdapter, SinkBatch } from './port';

const TIMEOUT_MS = 30_000;

export interface SyslogSinkConfig {
	host: string;
	port: number;
	tls: boolean;
	ca?: string;
	clientCert?: string;
	clientKey?: string;
	facility: string;
	maxMessageBytes: number;
	/** The HOSTNAME field, from BASE_URL rather than os.hostname() (decision D2). */
	hostname: string;
}

/**
 * The closed-set reason for a socket failure (spec §5.4), assigned by the
 * first matching rule. Nothing from the cause reaches the SinkError: it is
 * written to a table that forbids DELETE and is excluded from retention, so a
 * receiver's message there outlives every erasure path (issue #11).
 */
function socketReason(cause: unknown): SinkError {
	const code = (cause as { code?: string } | null)?.code ?? '';
	const name = cause instanceof Error ? cause.name : '';

	// Rule 2 before rule 4: a certificate a private CA does not cover is a
	// TLS failure, and reporting it as `network` sends an operator to look at
	// firewalls instead of at trust configuration.
	if (code.startsWith('ERR_TLS') || code.startsWith('UNABLE_TO_') || code.startsWith('CERT_')) {
		return new SinkError('tls');
	}
	if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
		return new SinkError('tls');
	}
	if (code === 'EPROTO' || code === 'ECONNRESET') {
		// A receiver that rejects our client certificate resets the connection
		// during the handshake; one that drops mid-batch resets it after. The
		// adapter knows which phase it was in, so this is decided by the caller
		// below rather than guessed here.
		return new SinkError('network');
	}
	if (name === 'TimeoutError' || code === 'ETIMEDOUT') return new SinkError('timeout');

	return new SinkError('network');
}

export function createSyslogAdapter(config: SyslogSinkConfig): AuditSinkAdapter {
	/**
	 * One connection per batch, closed after the last message (spec §5.3). A
	 * pooled connection would have to answer what a half-written batch means
	 * on a socket the next batch inherits, and there is no acknowledgement to
	 * resynchronise with.
	 */
	async function send(procId: string, messages: readonly { msgId: string; body: string }[]) {
		const frames = messages.map((entry) => {
			const message = buildMessage({
				facility: config.facility,
				hostname: config.hostname,
				procId,
				msgId: entry.msgId,
				timestamp: new Date(),
				message: entry.body
			});
			const framed = frame(message);

			// Checked for the whole batch before the socket opens, so an
			// oversized row later in the batch cannot leave a partial batch at
			// the receiver (spec §5.3, decision D8).
			if (framed.byteLength > config.maxMessageBytes) {
				throw new MessageTooLarge(framed.byteLength);
			}

			return framed;
		});

		await new Promise<void>((resolve, reject) => {
			let handshakeComplete = !config.tls;
			const socket: Socket = config.tls
				? connectTls({
						host: config.host,
						port: config.port,
						ca: config.ca ? [config.ca] : undefined,
						cert: config.clientCert,
						key: config.clientKey,
						// Never disabled, and no variable exists to disable it
						// (spec §5.3). This line is the whole TLS posture.
						rejectUnauthorized: true
					})
				: connectTcp({ host: config.host, port: config.port });

			const fail = (cause: unknown) => {
				socket.destroy();
				// A failure before the handshake finished is a trust problem
				// however the socket reports it; after it, the connection was
				// good and the receiver went away.
				reject(handshakeComplete ? socketReason(cause) : tlsOrSocketReason(cause));
			};

			socket.setTimeout(TIMEOUT_MS, () => fail(new Error('timeout')));
			socket.on('error', fail);
			socket.on(config.tls ? 'secureConnect' : 'connect', () => {
				handshakeComplete = true;
				socket.write(Buffer.concat(frames), (error) => {
					if (error) return fail(error);
					socket.end(() => resolve());
				});
			});
		});
	}

	/** Before the handshake completes, a reset is the receiver refusing our
	 * certificate — the mutual-TLS case — which is a `tls` failure and not a
	 * network one. */
	function tlsOrSocketReason(cause: unknown): SinkError {
		const reason = socketReason(cause);

		return reason.reason === 'network' && config.tls ? new SinkError('tls') : reason;
	}

	function guard<T>(work: () => Promise<T>): Promise<T> {
		return work().catch((cause: unknown) => {
			if (cause instanceof MessageTooLarge) throw new SinkError('config');
			if (cause instanceof SinkError) throw cause;
			throw socketReason(cause);
		});
	}

	return {
		name: 'syslog',
		async ship(batch: SinkBatch): Promise<null> {
			// The shared body, split back into the lines it was built from
			// (spec §5.1: one body for all sinks). The canonical format is
			// LF-terminated, so the trailing empty element is dropped rather
			// than sent as a message.
			const lines = Buffer.from(batch.body).toString('utf8').split('\n').filter(Boolean);

			await guard(() =>
				send(batch.id, [
					...lines.map((body) => ({ msgId: 'audit', body })),
					{ msgId: 'manifest', body: JSON.stringify(batch.manifest) }
				])
			);

			// No object key: a syslog receiver has nowhere to point an auditor,
			// and the batch id is already in `batch_id`.
			return null;
		},
		async attest(attestation: Attestation): Promise<void> {
			await guard(() =>
				send('attestation', [{ msgId: 'attest', body: JSON.stringify(attestation) }])
			);
		}
	};
}
```

- [ ] **Step 5: Run the integration tests**

Run: `pnpm test:integration tests/integration/auditsink-syslog.test.ts`
Expected: PASS, 13 tests.

If the mutual-TLS refusal case reports `network` rather than `tls`, the phase tracking in `fail` is
wrong — the handshake had not completed, so `tlsOrSocketReason` should have run.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add src/lib/server/auditsink/syslog.ts tests/helpers/syslog-server.ts tests/integration/auditsink-syslog.test.ts
git commit -m "feat(auditsink): the syslog adapter over TLS"
```

---

## Task 4: Wire the second sink in

**Files:**
- Modify: `src/lib/server/auditsink/index.ts`, `src/lib/server/auditsink/status.ts`
- Test: `tests/unit/auditsink-switch.test.ts`

**Interfaces:**
- Consumes: `createSyslogAdapter` (Task 3), the config shape (Task 2).
- Produces: nothing new. Both `adapters()` and `adapterFor()` return a syslog adapter when one is
  configured.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/auditsink-switch.test.ts`. The existing `vi.mock` of the config module gains a
`syslogConfigured` flag alongside `s3Configured`, and the syslog module is mocked the way the S3
module already is:

```ts
const syslogConfigured = vi.fn(() => false);

vi.mock('../../src/lib/server/auditsink/syslog', () => ({
	createSyslogAdapter: () => ({ name: 'syslog', ship: async () => null, attest: async () => {} })
}));
```

In the config mock's `auditSink` object, beside `s3`:

```ts
		syslog: syslogConfigured()
			? {
					host: 'siem.example.com',
					port: 6514,
					tls: true,
					facility: 'local0',
					maxMessageBytes: 8192,
					hostname: 'trust.example.com'
				}
			: undefined
```

Then the cases:

```ts
	it('claims for syslog alone when only syslog is configured', async () => {
		sinkEnabled.mockReturnValue(true);
		s3Configured.mockReturnValue(false);
		syslogConfigured.mockReturnValue(true);

		await runAuditSinkBatch(db);

		expect(claimShipments).toHaveBeenCalledTimes(1);
		expect(buildBatch).toHaveBeenCalledTimes(1);
	});

	it('ships to both sinks when both are configured', async () => {
		sinkEnabled.mockReturnValue(true);
		syslogConfigured.mockReturnValue(true);
		claimShipments.mockResolvedValueOnce([{ batchId: 'b1', sink: 's3', attempts: 0 }]);

		await runAuditSinkBatch(db);
		await runAuditSinkShip(db);

		// One call, two adapters — shipClaimed fans out internally, and the
		// property here is that both were passed to it.
		expect(shipClaimed).toHaveBeenCalledTimes(1);
	});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test:unit tests/unit/auditsink-switch.test.ts -t syslog`
Expected: FAIL — `adapters()` returns an empty list, so phase one returns before claiming.

- [ ] **Step 3: Implement**

In `src/lib/server/auditsink/index.ts`, replace `adapters()`:

```ts
function adapters(): AuditSinkAdapter[] {
	const { auditSink } = getConfig();
	const active: AuditSinkAdapter[] = [];

	if (auditSink.s3) active.push(createS3Adapter(auditSink.s3));
	if (auditSink.syslog) active.push(createSyslogAdapter(auditSink.syslog));

	return active;
}
```

and add the import. In `src/lib/server/auditsink/status.ts`, replace `adapterFor()`:

```ts
function adapterFor(sink: SinkName): AuditSinkAdapter | null {
	const { auditSink } = getConfig();

	if (sink === 's3') return auditSink.s3 ? createS3Adapter(auditSink.s3) : null;

	return auditSink.syslog ? createSyslogAdapter(auditSink.syslog) : null;
}
```

Both call sites need the `hostname` field, which the config does not carry — add it where the adapter
is built, from `getConfig().baseUrl`:

```ts
	const hostname = new URL(getConfig().baseUrl).host;
```

and pass `{ ...auditSink.syslog, hostname }`.

- [ ] **Step 4: Run the suites**

Run: `pnpm test:unit && pnpm test:integration tests/integration/auditsink-status.test.ts`
Expected: PASS. The status test's "reports a sink that is not configured" case must still pass — with
no syslog configured, the syslog row reports `configured: false` and `objectLock: null`.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add src/lib/server/auditsink tests/unit/auditsink-switch.test.ts
git commit -m "feat(auditsink): activate the syslog sink alongside S3"
```

---

## Task 5: Documentation

**Files:**
- Modify: `docs/self-hosting.md` (§3 table, §13), `.env.example`,
  `docs/superpowers/specs/2026-09-04-audit-sink-design.md` (§19), `docs/superpowers/backlog.md`
- Create: `docs/superpowers/subsystem-b2-carryover.md`

**Interfaces:**
- Consumes: everything. Produces: no code.

- [ ] **Step 1: Remove the "Not yet shipped" subsection**

`docs/self-hosting.md` §13 ends with a subsection stating that the syslog transport is not
implemented and that `AUDIT_SINK_SYSLOG_*` is not read. Both sentences become false in this plan.
Delete the subsection.

- [ ] **Step 2: Write §13's syslog subsection**

Insert before "### Watching it". Hand-wrap at 80 columns; verify with the check in Step 6. Cover, per
spec §14:

- `tls://host:6514` and `tcp://host:514`, with plain TCP documented as **discouraged and why**.
- **UDP is not offered**, and why: silent loss disqualifies a compliance record.
- The three TLS variables, that `rejectUnauthorized` is never disabled and there is no variable to
  disable it, and the `\n` escape convention for PEM values (decision D9).
- `AUDIT_SINK_SYSLOG_FACILITY` and `AUDIT_SINK_SYSLOG_MAX_MESSAGE_BYTES`, and that a row above the
  cap **fails the batch** rather than being truncated or skipped.
- The message shape an operator will see in their SIEM: PRI, APP-NAME `trustcenter`, PROCID carrying
  the batch id, MSGID `audit` / `manifest` / `attest`, and that the payload is the same canonical JSON
  line the S3 sink ships.
- **The two honesty notes of §5.3, stated plainly and not softened.** RFC 6587 has no
  acknowledgement, so "shipped" means "written to a socket" — materially weaker than a PUT returning
  200, and a receiver whose queue overflows loses silently. And `sha256sum` verification does not
  apply: there is no object at the far end, and after SIEM-side normalization an auditor cannot
  reproduce the digest at all. `byte_count` and the shipment digest for this sink describe what was
  sent, not what was stored.

- [ ] **Step 3: Add the variables to §3 and `.env.example`**

Six rows in §3's table, in the `AUDIT_SINK_*` block, matching the format of the S3 rows
(`Variable | Required | Default | What it does`), each ending "See §13.". And a block in
`.env.example` after the S3 block, matching the comment density around it.

- [ ] **Step 4: Update the design's §19**

The "What B1 shipped, and what B2 owns" section says B2 is not started and that
`AUDIT_SINK_SYSLOG_*` is not read. Replace the B2 paragraph with what B2 shipped, and record
decisions D1–D9 as a short list — they are choices the spec left open and a later reader will ask why
PROCID carries a batch id.

- [ ] **Step 5: Write the carry-over and close the backlog item**

Create `docs/superpowers/subsystem-b2-carryover.md`, in the shape of `subsystem-b1-carryover.md`:
what the plan deviated from and why, what was measured, and defects left standing. Candidates the
implementer should evaluate honestly rather than copy:

- No acknowledgement means a shipment recorded as delivered may not have been stored. This is
  spec-sanctioned, not a defect, but it is the single most important thing a reader must know.
- `openssl` as a test-time dependency of the integration suite.
- Whether `socketReason`'s phase distinction actually separates a rejected client certificate from a
  mid-batch reset, or whether the test passes for an incidental reason.

In `docs/superpowers/backlog.md`, no item closes — B2 was never on it. If the implementer finds
something they are deferring, it goes on the backlog under "Open" rather than into a comment.

- [ ] **Step 6: Full gate**

```bash
pnpm lint && pnpm check && pnpm build && pnpm test:unit && pnpm test:integration && pnpm test:e2e
env -i PATH="$PATH" HOME="$HOME" pnpm check && env -i PATH="$PATH" HOME="$HOME" pnpm build
```

Expected: all green. Record the counts in the carry-over. Then check the wrapping:

```bash
python3 - <<'PY'
import pathlib
lines = pathlib.Path('docs/self-hosting.md').read_text().split('\n')
infence = False
for i, line in enumerate(lines, 1):
    if line.startswith('```'):
        infence = not infence
        continue
    if not infence and len(line) > 80 and not line.startswith('|'):
        print(i, len(line))
PY
```

Expected: the same four pre-existing lines (263, 265, 324, 460) and no others.

- [ ] **Step 7: Commit**

```bash
pnpm format
git add docs .env.example
git commit -m "docs(auditsink): the syslog transport, and what shipping to a SIEM cannot promise"
```

---

## Self-review

**Spec coverage.** §5.1 (one body for all sinks) → Task 3 Step 4, where `ship` splits the shared body
rather than asking for a different one. §5.3 → Tasks 1, 2, 3: framing (T1), TLS trust and the three
variables (T2, T3), one connection per batch and the write timeout (T3), the message cap and its
failure mode (T1 `MessageTooLarge`, T3 D8), UDP refused (T2), plain TCP accepted (T2, T3), and both
honesty notes (T5 Step 2). §5.4's decision procedure → T3's `socketReason`, with rules 2, 3 and 4
producible and rules 5–8 unreachable over a socket, which is correct: they are HTTP statuses.
§11's variables → T2. §13's "against an in-process TLS server, including private-CA verification and
a mid-batch write failure" → T3 Steps 1–2, both named cases present. §14's syslog bullets → T5.
§15's "no CEF" → nothing to build.

**Gaps found and closed while reviewing.** The `hostname` field is in `SyslogSinkConfig` but not in
the parsed config, because it comes from `BASE_URL` and not from an `AUDIT_SINK_SYSLOG_*` variable —
Task 4 Step 3 now says where it is added, which it did not before. Task 3's oversize check was
originally per-message inside the write loop, which would have left a partial batch at the receiver;
it is now computed for the whole batch before the socket opens, and Task 3 Step 2 has a test that
fails if that regresses. `attest()` had no PROCID that means anything — it uses the literal
`attestation`, since an attestation belongs to no batch.

**Type consistency.** `SinkBatch`, `Attestation`, `SinkError` and `AuditSinkAdapter` are B1's and are
not redefined here. `ship()` returns `Promise<null>`, which satisfies B1's `Promise<string | null>`.
`objectLock` is absent from the returned adapter, which is why B1 made it optional — `status.ts`
already guards with `adapter?.objectLock ?`. `SinkName` already includes `'syslog'`, in both the
TypeScript union and the CHECK constraint, so no migration appears in this plan.

**One thing a reviewer should push on.** Task 3's `socketReason` distinguishes a TLS failure from a
network failure by socket error codes and by whether the handshake had completed. That is the
fiddliest code in the plan and the place a test can pass for the wrong reason. If the mutual-TLS
refusal and the mid-batch reset both produce `ECONNRESET`, the phase flag is the only thing telling
them apart, and it should be verified by reading the test's failure output rather than trusting a
green run.
