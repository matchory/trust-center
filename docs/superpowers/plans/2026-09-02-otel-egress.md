# Subsystem C — OTel Egress — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export traces and metrics to an operator's OTLP collector, inert unless configured, with the trace id correlated into `audit_event.request_id`.

**Architecture:** Manual instrumentation, not auto-instrumentation. Application code imports only `@opentelemetry/api`, whose no-op provider makes every call site free when telemetry is off; the SDK is dynamically imported from `init` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, exactly as the migrator and job runner already are. Spans are created by hand in `handle`, `runJob`, the mail drain and PDF watermarking.

**Tech Stack:** SvelteKit (adapter-node), TypeScript, Zod 4, Vitest, OpenTelemetry JS (`@opentelemetry/api` + SDK 2.x, OTLP/HTTP exporters).

**Spec:** `docs/superpowers/specs/2026-09-02-otel-egress-design.md`

## Global Constraints

- **`vite build` must work with an empty environment.** No new module may require config or a database at import time. The SDK is imported dynamically inside `startTelemetry()`.
- **No personal data in telemetry, ever** (spec §8). A span or metric may carry route ids, resource ids, job names, status codes, outcomes and durations. Never a URL query string, email, name, company, IP, user agent, token, or statement parameter.
- **`localeStorage.run` must remain the immediate wrapper around `resolve`** in `src/hooks.server.ts`, or SSR translations silently fall back to the base locale (CLAUDE.md).
- **Metric and span names are permanent** once an operator builds an alert on one — treat them like audit action names.
- Formatting: tabs, single quotes, no trailing commas, 100-column print width (`.prettierrc`). Run `pnpm format` before committing.
- `pnpm check` must stay at 0 errors and 0 warnings.
- Comments explain *why*, naming the failure mode prevented — match the surrounding code.
- Custom metric names carry the `trustcenter.` prefix. Semantic-convention names (`http.server.request.duration`) do not.

---

### Task 1: Configuration

Four environment variables, validated in `getConfig()` so a malformed endpoint refuses to boot rather than degrading to silence (spec C3).

**Files:**
- Modify: `src/lib/server/config/parse.ts`
- Modify: `.env.example`
- Modify: `docs/self-hosting.md` (§3 table)
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppConfig['telemetry']` — `{ endpoint: string | undefined; serviceName: string; headers: Record<string, string>; sampleRatio: number }`, reached as `getConfig().telemetry`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/config.test.ts`:

```ts
describe('telemetry configuration', () => {
	it('is inert when no endpoint is set', () => {
		const config = parseConfig(valid, COMPILED);
		expect(config.telemetry.endpoint).toBeUndefined();
		expect(config.telemetry.serviceName).toBe('trust-center');
		expect(config.telemetry.headers).toEqual({});
		expect(config.telemetry.sampleRatio).toBe(1);
	});

	it('parses an endpoint, a service name and a ratio', () => {
		const config = parseConfig(
			{
				...valid,
				OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.com:4318',
				OTEL_SERVICE_NAME: 'trust-center-staging',
				OTEL_TRACES_SAMPLER_ARG: '0.25'
			},
			COMPILED
		);
		expect(config.telemetry.endpoint).toBe('https://collector.example.com:4318');
		expect(config.telemetry.serviceName).toBe('trust-center-staging');
		expect(config.telemetry.sampleRatio).toBe(0.25);
	});

	it('parses headers into a record, keeping values containing "="', () => {
		const config = parseConfig(
			{ ...valid, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer a=b, x-tenant=acme' },
			COMPILED
		);
		expect(config.telemetry.headers).toEqual({
			authorization: 'Bearer a=b',
			'x-tenant': 'acme'
		});
	});

	it('refuses a header entry with no "=" rather than dropping it', () => {
		expect(() => parseConfig({ ...valid, OTEL_EXPORTER_OTLP_HEADERS: 'garbage' }, COMPILED)).toThrow();
	});

	it('refuses an endpoint that is not a URL', () => {
		expect(() =>
			parseConfig({ ...valid, OTEL_EXPORTER_OTLP_ENDPOINT: 'collector:4318' }, COMPILED)
		).toThrow();
	});

	it('refuses a sampler ratio outside 0..1', () => {
		expect(() => parseConfig({ ...valid, OTEL_TRACES_SAMPLER_ARG: '2' }, COMPILED)).toThrow();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:unit tests/unit/config.test.ts -t 'telemetry configuration'`
Expected: FAIL — `config.telemetry` is undefined, so the first assertion throws on reading `.endpoint`.

- [ ] **Step 3: Add the schema entries**

In `src/lib/server/config/parse.ts`, inside `buildSchema`'s `z.object({...})`, after the `STAFF_NOTIFICATION_EMAIL` line:

```ts
			// Standard OTel variable names, read and validated here rather than by
			// the SDK's own environment parsing: a typo'd endpoint must refuse to
			// boot like every other setting, not degrade to silently exporting
			// nothing. Only these four are honoured (spec C3).
			OTEL_EXPORTER_OTLP_ENDPOINT: blankAsUndefined(z.string().url()),
			OTEL_SERVICE_NAME: z.string().min(1).default('trust-center'),
			OTEL_EXPORTER_OTLP_HEADERS: blankAsUndefined(
				z
					.string()
					.min(1)
					.refine(
						(raw) => raw.split(',').every((pair) => pair.includes('=')),
						'expected comma-separated key=value pairs'
					)
			),
			OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1)
```

- [ ] **Step 4: Add the header parser**

In the same file, beside `blankAsUndefined`:

```ts
/**
 * `k=v,k=v`, split on the *first* `=` only — an OTLP bearer token is a header
 * value that can itself contain `=`, and splitting on every one would truncate
 * it into a credential that fails authentication with no error here.
 */
function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
	if (!raw) return {};

	return Object.fromEntries(
		raw
			.split(',')
			.map((pair) => pair.trim())
			.filter((pair) => pair.length > 0)
			.map((pair) => {
				const split = pair.indexOf('=');
				return [pair.slice(0, split).trim(), pair.slice(split + 1).trim()];
			})
	);
}
```

- [ ] **Step 5: Extend `AppConfig` and `parseConfig`**

Add to the `AppConfig` interface, after the `oidc` block:

```ts
	/** Off unless `endpoint` is set; see docs/superpowers/specs/2026-09-02-otel-egress-design.md. */
	telemetry: {
		endpoint: string | undefined;
		serviceName: string;
		headers: Record<string, string>;
		sampleRatio: number;
	};
```

And to the object `parseConfig` returns, after `oidc`:

```ts
		telemetry: {
			endpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT,
			serviceName: parsed.OTEL_SERVICE_NAME,
			headers: parseOtlpHeaders(parsed.OTEL_EXPORTER_OTLP_HEADERS),
			sampleRatio: parsed.OTEL_TRACES_SAMPLER_ARG
		}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test:unit tests/unit/config.test.ts`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 7: Document the four variables**

Append to `.env.example`:

```sh
# --- Telemetry --------------------------------------------------------------
# Unset means the application exports nothing and loads no OpenTelemetry SDK.
# Set it to your own collector's OTLP/HTTP endpoint to receive traces and
# metrics. Only the four variables below are read; other OTEL_* variables are
# ignored, because configuration is validated at boot in one place.
OTEL_EXPORTER_OTLP_ENDPOINT=
OTEL_SERVICE_NAME=trust-center
# Collector authentication, as comma-separated key=value pairs.
OTEL_EXPORTER_OTLP_HEADERS=
# Fraction of traces sampled, 0 to 1. The default keeps all of them: this is a
# low-traffic portal and the point is explaining one specific request.
OTEL_TRACES_SAMPLER_ARG=1
```

Add four rows to the `docs/self-hosting.md` §3 table, after the `STAFF_NOTIFICATION_EMAIL` row:

```markdown
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | Your OTLP/HTTP collector, e.g. `https://otel.internal:4318`. Unset means no telemetry is exported and no OpenTelemetry SDK is loaded. See §11. |
| `OTEL_SERVICE_NAME` | no | `trust-center` | The `service.name` attached to exported traces and metrics. |
| `OTEL_EXPORTER_OTLP_HEADERS` | no | — | Collector authentication, as `key=value` pairs separated by commas. |
| `OTEL_TRACES_SAMPLER_ARG` | no | `1` | Fraction of traces sampled, 0 to 1. The default keeps all of them. |
```

- [ ] **Step 8: Verify formatting and types, then commit**

```bash
pnpm format && pnpm lint && pnpm check
git add src/lib/server/config/parse.ts tests/unit/config.test.ts .env.example docs/self-hosting.md
git commit -m "feat(config): the four telemetry variables, validated at boot"
```

---

### Task 2: Span helpers and the attribute builder

The attribute builder is where spec §12.2 lives: it never receives the URL, so a query string cannot reach a span attribute.

**Files:**
- Create: `src/lib/server/telemetry/attributes.ts`
- Create: `src/lib/server/telemetry/span.ts`
- Create: `src/lib/server/telemetry/index.ts`
- Test: `tests/unit/telemetry-span.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `requestSpanName(method: string, routeId: string | null): string`
  - `requestAttributes(input: { method: string; routeId: string | null; status: number }): Attributes`
  - `withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T>`
  - `activeTraceId(): string | undefined`
  - `src/lib/server/telemetry/index.ts` re-exports all four.

- [ ] **Step 1: Install the API package and the base SDK the tests need**

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-trace-base
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/telemetry-span.test.ts`:

```ts
import { trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
	activeTraceId,
	requestAttributes,
	requestSpanName,
	withSpan
} from '../../src/lib/server/telemetry';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
	spanProcessors: [new SimpleSpanProcessor(exporter)]
});
trace.setGlobalTracerProvider(provider);

beforeEach(() => exporter.reset());
afterAll(async () => provider.shutdown());

describe('requestAttributes', () => {
	it('carries route, method and status', () => {
		expect(requestAttributes({ method: 'GET', routeId: '/(portal)/[locale]', status: 200 })).toEqual({
			'http.request.method': 'GET',
			'http.route': '/(portal)/[locale]',
			'http.response.status_code': 200
		});
	});

	// An unmatched request has no route id. Emitting the raw path instead would
	// give a path scanner one attribute value per probe.
	it('omits http.route entirely for an unmatched request', () => {
		const attributes = requestAttributes({ method: 'GET', routeId: null, status: 404 });
		expect(attributes).not.toHaveProperty('http.route');
		expect(requestSpanName('GET', null)).toBe('GET unmatched');
	});
});

describe('withSpan', () => {
	it('returns the callback value and ends exactly one span', async () => {
		const result = await withSpan('unit', { 'job.name': 'x' }, async () => 42);

		expect(result).toBe(42);
		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('unit');
		expect(spans[0]?.attributes['job.name']).toBe('x');
	});

	// A span left open by a throwing callback leaks the active context into
	// whatever runs next, so the failure shows up somewhere unrelated.
	it('ends the span and marks it an error when the callback throws', async () => {
		await expect(
			withSpan('boom', {}, async () => {
				throw new Error('nope');
			})
		).rejects.toThrow('nope');

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.status.code).toBe(2); // SpanStatusCode.ERROR
	});

	it('exposes the active trace id inside the span and nothing outside it', async () => {
		const inside = await withSpan('outer', {}, async () => activeTraceId());

		expect(inside).toMatch(/^[0-9a-f]{32}$/);
		expect(activeTraceId()).toBeUndefined();
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:unit tests/unit/telemetry-span.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/server/telemetry`, which does not exist yet.

- [ ] **Step 4: Write `attributes.ts`**

```ts
import type { Attributes } from '@opentelemetry/api';

/**
 * Deliberately does not take the URL, and must not grow a parameter that
 * carries one. This application's query strings hold credentials — the magic
 * link at `/{locale}/access/verify?token=`, and the subscription management
 * link — so `url.full` and `url.query` are banned outright rather than
 * sanitised (spec §8, C6). Keeping the URL out of the signature makes the leak
 * unrepresentable rather than merely tested for.
 */
export function requestAttributes(input: {
	method: string;
	routeId: string | null;
	status: number;
}): Attributes {
	return {
		'http.request.method': input.method,
		'http.response.status_code': input.status,
		// Omitted rather than filled with the raw path: an unmatched request is
		// how a path scanner would otherwise mint one attribute value per probe.
		...(input.routeId === null ? {} : { 'http.route': input.routeId })
	};
}

export function requestSpanName(method: string, routeId: string | null): string {
	return `${method} ${routeId ?? 'unmatched'}`;
}
```

- [ ] **Step 5: Write `span.ts`**

```ts
import { SpanStatusCode, isSpanContextValid, trace, type Attributes, type Span } from '@opentelemetry/api';

/**
 * The instrumentation scope every span in this application is created under.
 * Permanent: a collector's pipeline may route on it.
 */
const TRACER_NAME = 'trust-center';

/**
 * Every call site in the server goes through here unconditionally. When no
 * provider is registered — which is every deployment that has not set
 * OTEL_EXPORTER_OTLP_ENDPOINT — the API returns a no-op tracer, so this costs
 * one function call and no allocation of anything exportable. That is what
 * lets the server carry instrumentation with no `if (enabled)` guards.
 */
export async function withSpan<T>(
	name: string,
	attributes: Attributes,
	fn: (span: Span) => Promise<T>
): Promise<T> {
	return trace.getTracer(TRACER_NAME).startActiveSpan(name, { attributes }, async (span) => {
		try {
			return await fn(span);
		} catch (cause) {
			// The message only — never the cause chain. `handleError` exists
			// because openid-client attaches the callback request, authorization
			// code and all, as an error's cause.
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: cause instanceof Error ? cause.message : String(cause)
			});
			throw cause;
		} finally {
			span.end();
		}
	});
}

/**
 * The active trace id, or undefined when tracing is off. The no-op tracer
 * still produces a span context, but an invalid one whose trace id is all
 * zeroes — writing that into `audit_event.request_id` would fill the column
 * with a constant that looks like data.
 */
export function activeTraceId(): string | undefined {
	const span = trace.getActiveSpan();
	if (!span) return undefined;

	const context = span.spanContext();
	return isSpanContextValid(context) ? context.traceId : undefined;
}
```

- [ ] **Step 6: Write `index.ts`**

```ts
export { requestAttributes, requestSpanName } from './attributes';
export { activeTraceId, withSpan } from './span';
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm test:unit tests/unit/telemetry-span.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 8: Commit**

```bash
pnpm format && pnpm lint && pnpm check
git add src/lib/server/telemetry tests/unit/telemetry-span.test.ts package.json pnpm-lock.yaml
git commit -m "feat(telemetry): span helpers, and an attribute builder that cannot see a URL"
```

---

### Task 3: SDK lifecycle

`startTelemetry()` registers a real provider only when an endpoint is configured, and `init` calls it through a dynamic import so `vite build` still needs no environment.

**Files:**
- Create: `src/lib/server/telemetry/provider.ts`
- Modify: `src/lib/server/telemetry/index.ts`
- Modify: `src/hooks.server.ts:34-59` (the `init` body)
- Test: `tests/unit/telemetry-provider.test.ts`

**Interfaces:**
- Consumes: `AppConfig['telemetry']` (Task 1), `TRACER_NAME` conventions (Task 2).
- Produces: `startTelemetry(config: AppConfig['telemetry']): Promise<void>`, `shutdownTelemetry(): Promise<void>`.

- [ ] **Step 1: Install the SDK packages**

```bash
pnpm add @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node @opentelemetry/sdk-metrics \
  @opentelemetry/resources @opentelemetry/semantic-conventions \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http
```

- [ ] **Step 2: Verify the exported names against the installed versions**

The OTel JS 2.x line changed several of these from 1.x — `Resource` became `resourceFromAttributes`, and span processors moved into the `NodeTracerProvider` constructor. Confirm before writing against them:

```bash
node -e "import('@opentelemetry/resources').then(m => console.log(Object.keys(m)))"
node -e "import('@opentelemetry/sdk-trace-node').then(m => console.log(Object.keys(m)))"
node -e "import('@opentelemetry/sdk-trace-base').then(m => console.log(Object.keys(m)))"
```

Expected: `resourceFromAttributes` present; `NodeTracerProvider` present; `BatchSpanProcessor`, `ParentBasedSampler`, `TraceIdRatioBasedSampler` present. If any name differs, use the installed one and adjust Step 4 — the design does not depend on the spelling.

- [ ] **Step 3: Write the failing test**

Create `tests/unit/telemetry-provider.test.ts`:

```ts
import { metrics, trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { shutdownTelemetry, startTelemetry } from '../../src/lib/server/telemetry';

const off = { endpoint: undefined, serviceName: 'trust-center', headers: {}, sampleRatio: 1 };

describe('startTelemetry', () => {
	// The point of the whole design: a deployment with no collector loads no
	// SDK and registers no provider, so every call site stays a no-op.
	it('registers nothing when no endpoint is configured', async () => {
		await startTelemetry(off);

		// The API's own no-op provider has no `getActiveSpanProcessor`; asserting
		// on the delegate would couple to internals, so assert the observable
		// property instead: a span created now is not recording.
		const span = trace.getTracer('probe').startSpan('probe');
		expect(span.isRecording()).toBe(false);
		span.end();

		expect(metrics.getMeter('probe').createCounter('probe')).toBeDefined();
		await shutdownTelemetry();
	});

	it('is idempotent, so a second call does not stack providers', async () => {
		await startTelemetry(off);
		await expect(startTelemetry(off)).resolves.toBeUndefined();
		await shutdownTelemetry();
	});
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm test:unit tests/unit/telemetry-provider.test.ts`
Expected: FAIL — `startTelemetry` is not exported from `src/lib/server/telemetry`.

- [ ] **Step 5: Write `provider.ts`**

```ts
import type { AppConfig } from '../config';

/**
 * Held so shutdown can flush. `undefined` is the normal state: a deployment
 * with no collector never builds one.
 */
let started: { shutdown: () => Promise<void> }[] = [];

/**
 * Imports the SDK dynamically and only when an endpoint is configured, for the
 * same reason `init` imports the migrator and the job runner that way: `vite
 * build` must need neither configuration nor a database, and an operator
 * running without telemetry should not pay to load an exporter they will never
 * use.
 */
export async function startTelemetry(config: AppConfig['telemetry']): Promise<void> {
	if (!config.endpoint || started.length > 0) return;

	const [
		{ resourceFromAttributes },
		{ ATTR_SERVICE_NAME },
		{ BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler },
		{ NodeTracerProvider },
		{ MeterProvider, PeriodicExportingMetricReader },
		{ OTLPTraceExporter },
		{ OTLPMetricExporter },
		{ metrics }
	] = await Promise.all([
		import('@opentelemetry/resources'),
		import('@opentelemetry/semantic-conventions'),
		import('@opentelemetry/sdk-trace-base'),
		import('@opentelemetry/sdk-trace-node'),
		import('@opentelemetry/sdk-metrics'),
		import('@opentelemetry/exporter-trace-otlp-http'),
		import('@opentelemetry/exporter-metrics-otlp-http'),
		import('@opentelemetry/api')
	]);

	const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName });
	const headers = config.headers;

	const tracerProvider = new NodeTracerProvider({
		resource,
		// Parent-based so a trace context arriving from subsystem A, once it
		// exists, is honoured rather than re-decided halfway through a trace.
		sampler: new ParentBasedSampler({
			root: new TraceIdRatioBasedSampler(config.sampleRatio)
		}),
		spanProcessors: [
			new BatchSpanProcessor(new OTLPTraceExporter({ url: `${config.endpoint}/v1/traces`, headers }))
		]
	});
	tracerProvider.register();

	const meterProvider = new MeterProvider({
		resource,
		readers: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({ url: `${config.endpoint}/v1/metrics`, headers })
			})
		]
	});
	metrics.setGlobalMeterProvider(meterProvider);

	started = [tracerProvider, meterProvider];
}

/**
 * Flushes and stops. Called from `sveltekit:shutdown`, which adapter-node
 * already emits after handling SIGTERM — without a flush every deploy drops
 * the last batch of spans and metrics on the floor.
 */
export async function shutdownTelemetry(): Promise<void> {
	const providers = started;
	started = [];
	await Promise.all(providers.map((provider) => provider.shutdown()));
}
```

- [ ] **Step 6: Re-export from `index.ts`**

```ts
export { requestAttributes, requestSpanName } from './attributes';
export { activeTraceId, withSpan } from './span';
export { shutdownTelemetry, startTelemetry } from './provider';
```

- [ ] **Step 7: Wire into `init`**

In `src/hooks.server.ts`, inside `export const init`, immediately after the `getConfig()` try/catch block and **before** the migration block:

```ts
	// Before migrations, so a slow migration is itself a span — which is the
	// observation an operator wants when a deploy is slow to come up. Imported
	// dynamically for the same reason the migrator below is: `pnpm build` must
	// need neither configuration nor a database.
	const { startTelemetry, shutdownTelemetry } = await import('$lib/server/telemetry');
	await startTelemetry(getConfig().telemetry);

	// adapter-node already handles SIGTERM and SIGINT and emits this once the
	// server has stopped accepting connections, so we add no signal handler of
	// our own and cannot fight the adapter's shutdown ordering.
	process.on('sveltekit:shutdown', () => {
		void shutdownTelemetry();
	});
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test:unit tests/unit/telemetry-provider.test.ts && pnpm check`
Expected: PASS, 2 tests; `pnpm check` at 0 errors, 0 warnings.

- [ ] **Step 9: Prove the build still needs no environment**

Run: `env -i PATH="$PATH" HOME="$HOME" pnpm build`
Expected: succeeds with `DATABASE_URL`, `OIDC_CLIENT_SECRET` and `OTEL_EXPORTER_OTLP_ENDPOINT` all unset. This is the global constraint; if it fails, the SDK is being imported statically somewhere.

- [ ] **Step 10: Commit**

```bash
pnpm format && pnpm lint
git add src/lib/server/telemetry src/hooks.server.ts tests/unit/telemetry-provider.test.ts package.json pnpm-lock.yaml
git commit -m "feat(telemetry): the SDK lifecycle, inert unless an endpoint is set"
```

---

### Task 4: The request span and its duration metric

**Files:**
- Create: `src/lib/server/telemetry/metrics.ts`
- Modify: `src/lib/server/telemetry/index.ts`
- Modify: `src/hooks.server.ts` (the `handle` export, the `localeStorage.run` block)
- Modify: `tests/unit/hooks-locale.test.ts` (`fakeEvent` gains `route`)
- Test: `tests/unit/telemetry-request.test.ts`

**Interfaces:**
- Consumes: `withSpan`, `requestAttributes`, `requestSpanName` (Task 2).
- Produces: `recordRequestDuration(input: { method: string; routeId: string | null; status: number; seconds: number }): void`.

- [ ] **Step 1: Update `fakeEvent` in the existing hooks test**

`handle` is about to read `event.route.id`, and `tests/unit/hooks-locale.test.ts`'s `fakeEvent` does not supply `route`, so every case in that file would throw. In `fakeEvent`, add `route` to the returned object:

```ts
		locals: {} as App.Locals,
		// `handle` reads this for the span name and `http.route`; SvelteKit
		// always populates it, so the fake must too.
		route: { id: null }
```

Run: `pnpm test:unit tests/unit/hooks-locale.test.ts`
Expected: PASS — unchanged behaviour, the fake is simply more complete.

- [ ] **Step 2: Write the failing test**

Create `tests/unit/telemetry-request.test.ts`:

```ts
import { trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const exporter = new InMemorySpanExporter();

beforeAll(async () => {
	Object.assign(process.env, {
		DATABASE_URL: 'postgres://tc:tc@localhost:5432/tc',
		BASE_URL: 'https://trust.example.com',
		LOCALES: 'de,en',
		DEFAULT_LOCALE: 'de',
		OIDC_ISSUER: 'https://idp.example.com',
		OIDC_CLIENT_ID: 'trust-center',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_ADMIN_GROUP: 'trust-center-admins'
	});
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
	);
});

beforeEach(() => exporter.reset());

type Event = Parameters<import('@sveltejs/kit').Handle>[0]['event'];

function fakeEvent(pathname: string, search = '', routeId: string | null = null): Event {
	return {
		url: new URL(`https://trust.example.com${pathname}${search}`),
		request: new Request(`https://trust.example.com${pathname}${search}`),
		cookies: { get: () => undefined },
		locals: {} as App.Locals,
		route: { id: routeId }
	} as unknown as Event;
}

describe('the request span', () => {
	it('names the span for the route and carries route, method and status', async () => {
		const { handle } = await import('../../src/hooks.server');
		const resolve = vi.fn(async () => new Response(null, { status: 200, headers: new Headers() }));

		await handle({ event: fakeEvent('/de/documents', '', '/(portal)/[locale]/documents'), resolve });

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('GET /(portal)/[locale]/documents');
		expect(spans[0]?.attributes['http.route']).toBe('/(portal)/[locale]/documents');
		expect(spans[0]?.attributes['http.response.status_code']).toBe(200);
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test:unit tests/unit/telemetry-request.test.ts`
Expected: FAIL — 0 spans finished, because `handle` creates none.

- [ ] **Step 4: Write `metrics.ts`**

```ts
import { metrics, type Attributes } from '@opentelemetry/api';

const METER_NAME = 'trust-center';

/**
 * Instruments are created on first use rather than at module load. An
 * instrument built against the API's no-op meter stays a no-op for the life of
 * the process, so building them at import time — which happens before `init`
 * registers the real provider — would silently export nothing forever.
 */
let instruments: ReturnType<typeof build> | undefined;

function build() {
	const meter = metrics.getMeter(METER_NAME);

	return {
		requestDuration: meter.createHistogram('http.server.request.duration', {
			description: 'Duration of inbound HTTP requests',
			unit: 's'
		})
	};
}

function get() {
	return (instruments ??= build());
}

export function recordRequestDuration(input: {
	method: string;
	routeId: string | null;
	status: number;
	seconds: number;
}): void {
	// Same rule as the span: no route id means no attribute, so an unmatched
	// path cannot mint one time series per probe.
	const attributes: Attributes = {
		'http.request.method': input.method,
		'http.response.status_code': input.status,
		...(input.routeId === null ? {} : { 'http.route': input.routeId })
	};

	get().requestDuration.record(input.seconds, attributes);
}

/** Called by `startTelemetry` after the real meter provider is registered. */
export function resetInstruments(): void {
	instruments = undefined;
}
```

- [ ] **Step 5: Reset instruments after provider registration**

In `src/lib/server/telemetry/provider.ts`, add the import and the call at the end of `startTelemetry`, after `metrics.setGlobalMeterProvider(meterProvider)`:

```ts
	// Any instrument built before this point was built against the no-op meter
	// and would never export. Dropping them forces a rebuild against the real
	// provider on next use.
	resetInstruments();
```

with `import { resetInstruments } from './metrics';` at the top.

- [ ] **Step 6: Export the recorder**

Add to `src/lib/server/telemetry/index.ts`:

```ts
export { recordRequestDuration } from './metrics';
```

- [ ] **Step 7: Test the metric recorder, and the lazy-instrument trap it exists for**

Create `tests/unit/telemetry-metrics.test.ts`:

```ts
import { metrics } from '@opentelemetry/api';
import {
	AggregationTemporality,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import { beforeAll, describe, expect, it } from 'vitest';
import { recordRequestDuration } from '../../src/lib/server/telemetry';
import { resetInstruments } from '../../src/lib/server/telemetry/metrics';

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({
	exporter,
	// Long enough that only the explicit forceFlush below exports.
	exportIntervalMillis: 600_000
});

beforeAll(() => {
	metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
	// The trap this exists for: an instrument built against the API's no-op
	// meter stays a no-op forever, so anything constructed before a provider
	// was registered would silently export nothing. `startTelemetry` calls this
	// for the same reason.
	resetInstruments();
});

describe('recordRequestDuration', () => {
	it('exports http.server.request.duration with the route attributes', async () => {
		recordRequestDuration({
			method: 'GET',
			routeId: '/(portal)/[locale]',
			status: 200,
			seconds: 0.125
		});
		await reader.forceFlush();

		const points = exporter
			.getMetrics()
			.flatMap((resource) => resource.scopeMetrics)
			.flatMap((scope) => scope.metrics)
			.filter((metric) => metric.descriptor.name === 'http.server.request.duration')
			.flatMap((metric) => metric.dataPoints);

		expect(points).toHaveLength(1);
		expect(points[0]?.attributes['http.route']).toBe('/(portal)/[locale]');
		expect(points[0]?.attributes['http.request.method']).toBe('GET');
	});

	// Same rule as the span: an unmatched path must not mint one time series
	// per probe.
	it('omits http.route for an unmatched request', async () => {
		exporter.reset();
		recordRequestDuration({ method: 'GET', routeId: null, status: 404, seconds: 0.01 });
		await reader.forceFlush();

		const points = exporter
			.getMetrics()
			.flatMap((resource) => resource.scopeMetrics)
			.flatMap((scope) => scope.metrics)
			.filter((metric) => metric.descriptor.name === 'http.server.request.duration')
			.flatMap((metric) => metric.dataPoints);

		expect(points.some((point) => 'http.route' in point.attributes)).toBe(false);
	});
});
```

Run: `pnpm test:unit tests/unit/telemetry-metrics.test.ts`
Expected: PASS, 2 tests. If the second case sees the first case's data point, confirm `exporter.reset()` ran — cumulative temporality keeps points across flushes otherwise.

- [ ] **Step 8: Wrap the response in `handle`**

In `src/hooks.server.ts`, replace the final `return localeStorage.run(...)` block of `handle` with:

```ts
	const routeId = event.route.id;
	const method = event.request.method;

	// The span wraps outside `localeStorage.run`, which stays the immediate
	// wrapper around `resolve` — the rule CLAUDE.md states, and whose breach
	// shows up as SSR translations silently falling back to the base locale.
	return withSpan(requestSpanName(method, routeId), {}, async (span) => {
		const started = performance.now();

		const response = await localeStorage.run(
			{ locale: assertIsLocale(event.locals.locale) },
			async () => {
				const resolved = await resolve(event, {
					transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.locale)
				});

				// Only the unprefixed responses vary by Accept-Language — and those
				// are all redirects issued by the root layout. Every content URL
				// carries its locale in the path and stays unconditionally cacheable.
				if (route.kind === 'unprefixed') resolved.headers.append('Vary', 'Accept-Language');

				return resolved;
			}
		);

		span.setAttributes(requestAttributes({ method, routeId, status: response.status }));
		recordRequestDuration({
			method,
			routeId,
			status: response.status,
			seconds: (performance.now() - started) / 1000
		});

		return response;
	});
```

Add to the imports at the top of the file:

```ts
import {
	recordRequestDuration,
	requestAttributes,
	requestSpanName,
	withSpan
} from '$lib/server/telemetry';
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm test:unit tests/unit/telemetry-request.test.ts tests/unit/hooks-locale.test.ts`
Expected: PASS — the new case, and every pre-existing locale case unchanged.

- [ ] **Step 10: Commit**

```bash
pnpm format && pnpm lint && pnpm check
git add src/hooks.server.ts src/lib/server/telemetry tests/unit
git commit -m "feat(telemetry): one span and one duration metric per request"
```

---

### Task 5: Trace correlation into the audit log

Gives `audit_event.request_id` its first writer since Phase 0, and makes an error log line's id the same id as the trace.

**Files:**
- Modify: `src/lib/server/audit/index.ts:42-54`
- Modify: `src/hooks.server.ts` (`handleError`)
- Test: `tests/integration/audit-trace.test.ts`

**Interfaces:**
- Consumes: `activeTraceId()` (Task 2).
- Produces: nothing new; changes `recordEvent`'s behaviour when called inside a span.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/audit-trace.test.ts`:

```ts
import { trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent } from '../../src/lib/server/db/schema';
import { recordEvent } from '../../src/lib/server/audit';
import { withSpan } from '../../src/lib/server/telemetry';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] })
	);
});

afterAll(async () => {
	await close();
});

async function latestRequestId(action: string): Promise<string | null> {
	const [row] = await db
		.select({ requestId: auditEvent.requestId })
		.from(auditEvent)
		.where(eq(auditEvent.action, action))
		.orderBy(desc(auditEvent.seq))
		.limit(1);
	return row?.requestId ?? null;
}

describe('recordEvent trace correlation', () => {
	it('writes the active trace id into request_id', async () => {
		const traceId = await withSpan('audit-trace-test', {}, async () => {
			await recordEvent(db, {
				action: 'staff.login.succeeded',
				actor: { type: 'system', id: null }
			});
			const { activeTraceId } = await import('../../src/lib/server/telemetry');
			return activeTraceId();
		});

		expect(traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(await latestRequestId('staff.login.succeeded')).toBe(traceId);
	});

	// Jobs record events with no request behind them, and a null column is the
	// honest answer there — not a constant that looks like a correlation id.
	it('writes null when there is no active span', async () => {
		await recordEvent(db, { action: 'staff.logout', actor: { type: 'system', id: null } });
		expect(await latestRequestId('staff.logout')).toBeNull();
	});

	// An explicit requestId must win, or a caller that already knows the
	// correlation id it wants silently loses it.
	it('does not override an explicitly supplied requestId', async () => {
		await withSpan('audit-trace-explicit', {}, async () => {
			await recordEvent(db, {
				action: 'staff.login.denied',
				actor: { type: 'system', id: null },
				requestId: 'supplied'
			});
		});
		expect(await latestRequestId('staff.login.denied')).toBe('supplied');
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration tests/integration/audit-trace.test.ts`
Expected: FAIL on the first case — `request_id` is null, because nothing writes it.

- [ ] **Step 3: Write the implementation**

In `src/lib/server/audit/index.ts`, change the `requestId` line of `recordEvent` and add the import:

```ts
import { activeTraceId } from '../telemetry';
```

```ts
		// The correlation column has existed since Phase 0 with no writer. The
		// trace id gives it one, so "who downloaded this" and "why was that
		// request slow" become the same query. An explicit value still wins, and
		// with tracing off this stays null rather than becoming a constant.
		requestId: input.requestId ?? activeTraceId() ?? null,
```

- [ ] **Step 4: Adopt the trace id in `handleError`**

In `src/hooks.server.ts`, replace `const id = crypto.randomUUID();` in `handleError` with:

```ts
	// The identifier in the log line is the identifier in the trace backend
	// when tracing is on; a uuid remains the fallback when it is not, so the
	// line is never without one.
	const id = activeTraceId() ?? crypto.randomUUID();
```

and add `activeTraceId` to the existing `$lib/server/telemetry` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/audit-trace.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm check
git add src/lib/server/audit/index.ts src/hooks.server.ts tests/integration/audit-trace.test.ts
git commit -m "feat(telemetry): correlate audit events and error logs with the trace id"
```

---

### Task 6: Job spans and job metrics

**Files:**
- Modify: `src/lib/server/jobs/runner.ts:29-41`
- Modify: `src/lib/server/telemetry/metrics.ts`
- Test: `tests/integration/jobs.test.ts` (append)

**Interfaces:**
- Consumes: `withSpan` (Task 2), the instrument-building pattern (Task 4).
- Produces: `recordJobTick(input: { name: string; outcome: 'ok' | 'locked' | 'error'; seconds: number }): void`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/jobs.test.ts` (add the imports it needs at the top of that file):

```ts
describe('runJob telemetry', () => {
	it('emits one span per tick, naming the job and whether it held the lock', async () => {
		const exporter = new InMemorySpanExporter();
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
		);

		await runJob(db, 'telemetry-span-probe', async () => {});

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('job telemetry-span-probe');
		expect(spans[0]?.attributes['job.name']).toBe('telemetry-span-probe');
		expect(spans[0]?.attributes['job.lock_acquired']).toBe(true);
	});

	// A job that throws must still end its span, or the active context leaks
	// into the next tick and the failure surfaces somewhere unrelated.
	it('ends the span and marks it an error when the job throws', async () => {
		const exporter = new InMemorySpanExporter();
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
		);

		await expect(
			runJob(db, 'telemetry-error-probe', async () => {
				throw new Error('tick failed');
			})
		).rejects.toThrow('tick failed');

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.status.code).toBe(2);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration tests/integration/jobs.test.ts -t 'runJob telemetry'`
Expected: FAIL — 0 spans finished.

- [ ] **Step 3: Add the job instruments**

In `src/lib/server/telemetry/metrics.ts`, extend `build()`:

```ts
		jobTickDuration: meter.createHistogram('trustcenter.job.tick.duration', {
			description: 'Duration of one background job tick',
			unit: 's'
		}),
		jobTick: meter.createCounter('trustcenter.job.tick', {
			description: 'Background job ticks by outcome'
		})
```

and add the recorder:

```ts
/**
 * `locked` is not a failure: another replica held the advisory lock and this
 * tick correctly skipped. Distinguishing it from `ok` is what makes "the job
 * is not running anywhere" different from "the job is running elsewhere".
 */
export function recordJobTick(input: {
	name: string;
	outcome: 'ok' | 'locked' | 'error';
	seconds: number;
}): void {
	const attributes = { 'job.name': input.name, outcome: input.outcome };

	get().jobTickDuration.record(input.seconds, { 'job.name': input.name });
	get().jobTick.add(1, attributes);
}
```

Export it from `src/lib/server/telemetry/index.ts`:

```ts
export { recordJobTick, recordRequestDuration } from './metrics';
```

- [ ] **Step 4: Wrap `runJob`**

Rewrite the body of `runJob` in `src/lib/server/jobs/runner.ts`:

```ts
export async function runJob(db: Db, name: string, fn: () => Promise<void>): Promise<JobResult> {
	const key = lockKey(name);

	// One span per tick, around the transaction rather than inside it, so the
	// span covers the lock acquisition too — a tick that spends its time
	// waiting on the lock looks identical to a slow job without it.
	return withSpan(`job ${name}`, { 'job.name': name }, async (span) => {
		const started = performance.now();

		try {
			const result = await db.transaction(async (tx) => {
				const rows = (await tx.execute(
					sql`SELECT pg_try_advisory_xact_lock(${key}) AS locked`
				)) as unknown as { locked: boolean }[];

				if (!rows[0]?.locked) return { ran: false };

				await fn();
				return { ran: true };
			});

			span.setAttribute('job.lock_acquired', result.ran);
			recordJobTick({
				name,
				outcome: result.ran ? 'ok' : 'locked',
				seconds: (performance.now() - started) / 1000
			});

			return result;
		} catch (cause) {
			recordJobTick({ name, outcome: 'error', seconds: (performance.now() - started) / 1000 });
			throw cause;
		}
	});
}
```

Add the import:

```ts
import { recordJobTick, withSpan } from '../telemetry';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/jobs.test.ts`
Expected: PASS — the two new cases and every pre-existing one.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm lint && pnpm check
git add src/lib/server/jobs/runner.ts src/lib/server/telemetry tests/integration/jobs.test.ts
git commit -m "feat(telemetry): a span and a metric per background job tick"
```

---

### Task 7: The mail drain span and the queue-depth gauge

The gauge is the one metric that distinguishes "SMTP is misconfigured" from "no SMTP is configured, which is supported" — both look healthy from outside.

**Files:**
- Modify: `src/lib/server/mail/queue.ts:76-95` (the send loop)
- Modify: `src/lib/server/telemetry/metrics.ts`
- Modify: `src/lib/server/telemetry/provider.ts`
- Test: `tests/integration/mail-queue.test.ts` (append)

**Interfaces:**
- Consumes: `withSpan` (Task 2).
- Produces: `registerQueueDepthGauge(read: () => Promise<number>): void`, called once from `startTelemetry`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/mail-queue.test.ts`:

```ts
describe('mail drain telemetry', () => {
	it('emits one span per send, naming the template and never the address', async () => {
		const exporter = new InMemorySpanExporter();
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
		);

		await db.insert(outboundEmail).values({
			to: 'telemetry-probe@example.test',
			template: 'access_link',
			locale: 'de',
			payload: { url: 'https://trust.example/de/access' }
		});

		// `mailerThat`, `storage` and `FROM` already exist in this file.
		await drainOutbox(db, {
			limit: 10,
			mailer: mailerThat('succeed').adapter,
			from: FROM,
			storage
		});

		const sendSpans = exporter.getFinishedSpans().filter((span) => span.name === 'mail send');
		expect(sendSpans).toHaveLength(1);
		expect(sendSpans[0]?.attributes['mail.template']).toBe('access_link');

		// Spec §8: the recipient is personal data and telemetry leaves the
		// boundary, so no attribute may carry it.
		const values = Object.values(sendSpans[0]?.attributes ?? {}).map(String);
		expect(values.some((value) => value.includes('@'))).toBe(false);
	});
});
```

The file already defines `mailerThat('succeed' | 'fail')` returning `{ adapter, sent }`, a module-level `storage`, and `FROM`. Add the OTel imports (`trace`, `BasicTracerProvider`, `InMemorySpanExporter`, `SimpleSpanProcessor`) at the top, and `outboundEmail` if it is not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:integration tests/integration/mail-queue.test.ts -t 'mail drain telemetry'`
Expected: FAIL — no span named `mail send`.

- [ ] **Step 3: Wrap the send**

In `src/lib/server/mail/queue.ts`, inside the `for (const row of claimed)` loop's `try`, wrap the mailer call:

```ts
			const { providerId } = await withSpan(
				'mail send',
				// The template and locale, never `row.to`: the recipient is personal
				// data and telemetry leaves the reach of `purgeRequester` (spec §8).
				{ 'mail.template': row.template, 'mail.locale': row.locale },
				() =>
					mailer.send({
						to: row.to,
						from,
						subject: rendered.subject,
						text: rendered.text,
						attachments
					})
			);
```

Add `import { withSpan } from '../telemetry';` to the file's imports.

- [ ] **Step 4: Add the gauge**

In `src/lib/server/telemetry/metrics.ts`:

```ts
/**
 * Registered by `startTelemetry` only when telemetry is on, so a deployment
 * with no collector never runs the query. Nothing in this application sends
 * mail inline: a deployment whose SMTP is misconfigured looks entirely healthy
 * from the outside while the queue grows, and one with no SMTP_URL at all is a
 * supported configuration whose queue grows by design. This gauge is what
 * tells those two apart.
 */
export function registerQueueDepthGauge(read: () => Promise<number>): void {
	const gauge = metrics.getMeter(METER_NAME).createObservableGauge('trustcenter.mail.queue.depth', {
		description: 'Outbound emails queued and not yet sent'
	});

	gauge.addCallback(async (result) => {
		result.observe(await read());
	});
}
```

Export it from `index.ts` alongside the other recorders, and extend the static import at the top of `provider.ts` to `import { registerQueueDepthGauge, resetInstruments } from './metrics';`

- [ ] **Step 5: Register it at startup**

At the end of `startTelemetry` in `src/lib/server/telemetry/provider.ts`, after `resetInstruments()`:

```ts
	// `getDb` is imported here rather than at module scope: it is lazy, but
	// keeping the database out of this module's import graph preserves the rule
	// that importing telemetry never reaches for a connection. Only when an
	// endpoint is configured does this run at all, so a deployment without a
	// collector never issues the query.
	const [{ getDb }, { sql }] = await Promise.all([
		import('../db/instance'),
		import('drizzle-orm')
	]);

	registerQueueDepthGauge(async () => {
		const rows = (await getDb().execute(
			sql`SELECT count(*)::int AS depth FROM outbound_email WHERE status = 'pending'`
		)) as unknown as { depth: number }[];

		return rows[0]?.depth ?? 0;
	});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test:integration tests/integration/mail-queue.test.ts`
Expected: PASS — the new case and every pre-existing one.

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm lint && pnpm check
git add src/lib/server/mail/queue.ts src/lib/server/telemetry tests/integration/mail-queue.test.ts
git commit -m "feat(telemetry): a span per mail send, and the queue-depth gauge"
```

---

### Task 8: The watermarking span

**Files:**
- Modify: `src/lib/server/delivery/watermark.ts:22`
- Test: `tests/unit/watermark.test.ts` (append)

**Interfaces:**
- Consumes: `withSpan` (Task 2).
- Produces: nothing.

**Deviation from the spec, recorded deliberately.** Spec §7.2 asks for a span around
`delivery/serve.ts` as well. `serveDocumentFile` takes a SvelteKit `RequestEvent` and is exercised
only end-to-end — no integration test constructs one — so a span there would ship untested, and the
e2e suite runs against a built server into which no in-memory exporter can be injected. It also adds
little: the request span from Task 4 already covers the whole delivery request, and what a separate
delivery span would add over it is precisely the split between storage read and watermarking, which
the watermark span below gives on its own. Build the `serve.ts` span when there is a harness that can
assert on it.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/watermark.test.ts`, adding the OTel imports at the top:

```ts
import { trace } from '@opentelemetry/api';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';

describe('stampPdf telemetry', () => {
	// The slowest thing this application does on a request path, and the only
	// one that buffers a whole file — so it is worth its own span. It is also
	// the span with the most dangerous neighbours: `recipient` carries a name,
	// a company and an email, and every one of them is forbidden (spec §8).
	it('emits a span with the page count and nothing about the recipient', async () => {
		const exporter = new InMemorySpanExporter();
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
		);

		await stampPdf(await blankPdf(3), FONT_DIR, recipient);

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		expect(spans[0]?.name).toBe('document watermark');
		expect(spans[0]?.attributes['document.pages']).toBe(3);

		const values = [spans[0]?.name ?? '', ...Object.values(spans[0]?.attributes ?? {}).map(String)];
		expect(values.some((value) => value.includes('@'))).toBe(false);
		expect(values.some((value) => value.includes('Acme'))).toBe(false);
		expect(values.some((value) => value.includes('A Person'))).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit tests/unit/watermark.test.ts -t 'stampPdf telemetry'`
Expected: FAIL — 0 spans finished.

- [ ] **Step 3: Wrap the body of `stampPdf`**

In `src/lib/server/delivery/watermark.ts`, wrap the existing body. The page count is not known until
the document is loaded, so it is set on the span rather than passed as an initial attribute:

```ts
export async function stampPdf(
	/* the existing parameters, unchanged */
): Promise<Uint8Array> {
	return withSpan('document watermark', {}, async (span) => {
		/* the existing body, unchanged, with one line added immediately after
		   the PDFDocument is loaded and before it is modified: */
		span.setAttribute('document.pages', pdf.getPageCount());

		/* ...and the existing return value returned from here. */
	});
}
```

Use whatever local name the existing body already gives the loaded `PDFDocument` — do not introduce a
second load just to count pages.

Add `import { withSpan } from '../telemetry';` to the file's imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:unit tests/unit/watermark.test.ts`
Expected: PASS — the new case and every pre-existing one, including the page-count and drawn-text
assertions.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm lint && pnpm check
git add src/lib/server/delivery/watermark.ts tests/unit/watermark.test.ts
git commit -m "feat(telemetry): a span around watermarking, carrying no recipient"
```

---

### Task 9: The leak regression test, and the documentation

The permanent test spec §12.2 asks for, beside "the public portal sets no cookies" — it defends a property that is invisible when it holds and embarrassing when it breaks.

**Files:**
- Modify: `tests/unit/telemetry-request.test.ts`
- Modify: `docs/self-hosting.md` (§9, and a new §11)
- Test: as above

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/telemetry-request.test.ts`:

```ts
describe('no span attribute carries a secret or an identity', () => {
	// The magic-link and subscription-management tokens live in query strings,
	// so a span that recorded the URL would put a live credential into the
	// operator's monitoring platform — which `purgeRequester` cannot reach.
	// The attribute builder cannot express this (it never receives the URL);
	// this test defends everything the builder does not cover.
	it('records nothing from the query string of a verification link', async () => {
		const { handle } = await import('../../src/hooks.server');
		const resolve = vi.fn(async () => new Response(null, { status: 200, headers: new Headers() }));

		await handle({
			event: fakeEvent(
				'/de/access/verify',
				'?token=SUPERSECRETTOKENVALUE&email=person%40acme.example',
				'/(portal)/access/verify'
			),
			resolve
		});

		const values = exporter
			.getFinishedSpans()
			.flatMap((span) => [span.name, ...Object.values(span.attributes).map(String)]);

		expect(values.some((value) => value.includes('SUPERSECRETTOKENVALUE'))).toBe(false);
		expect(values.some((value) => value.includes('token='))).toBe(false);
		expect(values.some((value) => value.includes('@'))).toBe(false);
		expect(values.some((value) => /\d+\.\d+\.\d+\.\d+/.test(value))).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it passes on the first attempt**

Run: `pnpm test:unit tests/unit/telemetry-request.test.ts`
Expected: PASS immediately — this is a regression test for a property the design already has, not a driver for new code.

To prove it defends something, temporarily add `'url.full': event.url.href` to the attributes passed in `handle`, re-run, and confirm the test **fails**. Then revert that line. Do not commit the mutation.

- [ ] **Step 3: Amend the no-egress section**

`docs/self-hosting.md` §9 currently opens with an unqualified claim that is about to become conditionally untrue. Replace the first bullet:

```markdown
- **No telemetry by default.** Nothing reports usage, versions, or errors to us
  or to anyone else, and with `OTEL_EXPORTER_OTLP_ENDPOINT` unset the
  application loads no OpenTelemetry SDK at all. If you set it, traces and
  metrics go to **your** collector and nowhere else — never to us — and they
  carry no personal data by design (§11).
```

- [ ] **Step 4: Add the telemetry section**

Append to `docs/self-hosting.md` a new §11, after §10:

```markdown
## 11. Telemetry

Off unless you set `OTEL_EXPORTER_OTLP_ENDPOINT`. With it set, the application
exports traces and metrics to your own OTLP/HTTP collector — never to us, and
never anywhere you have not configured.

**What it sends.** One span per HTTP request, named for the matched route; one
per background job tick, per mail send, and per watermarked document. Four
metrics: request duration, job tick duration and outcome, and the depth of the
outbound mail queue. Every audit event written during a request carries that
request's trace id in `request_id`, so an access in the audit log and the trace
that produced it are the same identifier.

**What it never sends.** No email address, requester name, company, IP address,
user agent, session or magic-link token, URL query string, or SQL parameter.
This is a hard boundary, not a setting: telemetry leaves the reach of the
erasure path in §10, so it carries nothing that erasure would need to reach.
`tests/unit/telemetry-request.test.ts` asserts it on every run.

**The mail queue gauge is the one to alert on.** Nothing in this deployment
sends mail inline — everything is queued and drained by the job runner — so a
broken SMTP configuration looks perfectly healthy from the outside while the
queue grows. `trustcenter.mail.queue.depth` rising without falling is the
signal. Note that a deployment with no `SMTP_URL` is a supported configuration
in which that number grows forever by design.

Only the four `OTEL_*` variables in §3 are read. Other standard OpenTelemetry
environment variables are deliberately ignored, because every setting in this
application is validated once at startup and a typo must refuse to boot rather
than silently export nothing.
```

- [ ] **Step 5: Run the whole suite**

```bash
pnpm lint && pnpm check && pnpm test:unit && pnpm test:integration && pnpm test:e2e
```

Expected: all green. The e2e suite needs `pnpm dev:up` running.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add tests/unit/telemetry-request.test.ts docs/self-hosting.md
git commit -m "test(telemetry): pin that no span carries a token, an address or an IP"
```

---

## Verification checklist

Before opening the PR:

- [ ] `env -i PATH="$PATH" HOME="$HOME" pnpm build` succeeds — the build needs no environment.
- [ ] With `OTEL_EXPORTER_OTLP_ENDPOINT` unset, `pnpm dev` starts and no OpenTelemetry SDK appears in the module graph.
- [ ] `pnpm lint`, `pnpm check`, and all three test suites pass.
- [ ] `grep -rn "url.full\|url.query\|event.url.href" src/lib/server/telemetry src/hooks.server.ts` returns nothing.
- [ ] Metric names in the code match the names in `docs/self-hosting.md` §11 exactly — they are permanent once an operator alerts on one.
