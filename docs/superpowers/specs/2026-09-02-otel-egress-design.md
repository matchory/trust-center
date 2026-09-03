# Integrations subsystem C — OTel egress — Design

**Date:** 2026-09-02
**Status:** Approved for planning
**Author:** Moritz Friedrich (CISO, Matchory), with Claude

Supplements `2026-08-31-integrations-decomposition.md`, which decomposed integrations into five
subsystems and sequenced them **C → A → B → D → E**. This document governs C where the two differ;
§9 C of that note is superseded by everything below, including two of its factual claims (§3).

C is the only one of the five that is not an integration subsystem in the ordinary sense. It has no
tables, no admin surface, and no state beyond a process-lifetime SDK. It is a cross-cutting concern
configured by environment variables, and it ships first because it is independent of the other four
and makes them debuggable in production once they exist.

---

## 1. Summary

When an operator sets `OTEL_EXPORTER_OTLP_ENDPOINT`, the application exports traces and metrics to
that collector over OTLP/HTTP. When they do not, nothing is exported, nothing is imported beyond a
no-op API, and the instrumentation call sites scattered through the server cost a function call that
returns immediately.

Traces answer "why was that slow" and, because `audit_event.request_id` is populated with the trace
id, they answer it in the same query that answers "who downloaded this." Metrics answer the three
operational questions the deployment cannot currently answer at all: is the mail queue draining, are
the background jobs erroring, and which routes are slow.

Instrumentation is written by hand rather than patched in. §4 explains why that is the better
engineering answer here and not merely the smaller one.

---

## 2. Scope

**In.** Traces and metrics over OTLP/HTTP; a request span carrying `http.route`; spans around the
background jobs, the mail drain, mediated document delivery and PDF watermarking; four metrics;
trace-id correlation into `audit_event.request_id` and into `handleError`'s log line.

**Out, deliberately.**

- **Logs.** The structured JSON lines already go to stdout, where the operator's container runtime
  collects them. Shipping them again through OTLP duplicates that pipeline and buys a logging
  refactor. Revisit when there is a reader who wants trace-correlated logs specifically.
- **Auto-instrumentation.** §4.
- **Database spans.** §3.1 and C11 — there is no maintained instrumentation for the driver this
  project uses, and the obvious hand-rolled seam is one the privacy invariant forbids touching.
- **An admin surface.** Telemetry configuration is an operator concern, set by environment variable
  and validated at boot. It is not content, and it is not a setting a staff user changes at runtime.

---

## 3. Findings from the code

Established 2026-09-02 against `84b71e0`. Two of these contradict §9 C of the decomposition note.

### 3.1 The database gotcha names a library this project does not use

§9 C records as a requirement that "`pg` auto-instrumentation must not capture statement parameters."
The driver is `postgres` (postgres-js, `package.json:64`), and `@opentelemetry/instrumentation-pg`
instruments `pg` and `pg-pool` only. The single npm package targeting postgres-js is
`opentelemetry-instrumentation-postgres`, v0.0.3, last published 2022 — an unmaintained
single-maintainer package, which does not belong in a security product's dependency tree.

The gotcha is therefore inapplicable rather than wrong. Its underlying concern — that requester
addresses reach a monitoring platform through a statement parameter — is real, and becomes a rule
this document enforces itself (§8) rather than a library setting to remember.

### 3.2 The route gotcha is satisfied by construction, not by configuration

§9 C also records that "spans carry `http.route`, not `http.target`." Under manual instrumentation
the attribute is built from `event.route.id`, which *is* the route id; there is no code path that
could supply a raw path. The auto-instrumentation alternative sees only the URL and needs a callback
to avoid the high-cardinality attribute — the mistake the gotcha warns about, avoided by architecture
rather than by remembering a setting.

### 3.3 Dependencies are externalised, and the build is ESM

`build/server/chunks/` imports `postgres`, `nodemailer` and `openid-client` by bare specifier, so
runtime dependencies are loaded from `node_modules` and are in principle patchable. But the output is
ESM, so patching needs `import-in-the-middle` behind a `register()` loader hook. That path works and
is fragile in a specific way: a Node or OTel upgrade that breaks it does not error — the spans simply
stop appearing.

### 3.4 The adapter already owns shutdown

`build/index.js` handles `SIGTERM` and `SIGINT`, honours `SHUTDOWN_TIMEOUT`, and emits
`sveltekit:shutdown` on the process. So the exporter flush hook is `process.on('sveltekit:shutdown')`
and C adds no signal handling of its own. Without a flush, every deploy silently loses the last
batch of spans and metrics.

Noted in passing: `stopJobRunner` is exported and called from nowhere, so the job timers are never
stopped on shutdown either. That is a pre-existing gap adjacent to this work, not part of it.

---

## 4. Why instrumentation is manual

The alternative is `@opentelemetry/sdk-node` with auto-instrumentations, loaded through an `--import`
bootstrap before the application's own imports.

| | Auto-instrumentation | Manual |
| --- | --- | --- |
| Inbound HTTP spans | Free, but from the URL — needs a callback to produce `http.route` | Written once, from `event.route.id`, correct by construction |
| Database spans | None: no instrumentation exists for postgres-js (§3.1) | None in v1 (C11) |
| Outbound HTTP | Free — but the only egress today is SMTP | Explicit span in the mail drain |
| Process start | `--import` bootstrap: Dockerfile `CMD`, preview script, self-hosting docs all change | Unchanged |
| Failure mode | ESM patching breaks silently on upgrade (§3.3) | A missing span is a missing line of code |
| Dependency surface | A tree mostly irrelevant to this application | Six packages, chosen |

The decisive point is that auto-instrumentation's main prize — free spans for libraries we did not
write — is nearly worthless in an application whose sole outbound egress is SMTP (§3 of the
decomposition note). What it costs is a change to how the process starts, which is a change to
everything an operator has to know.

Manual instrumentation also matches how this codebase already handles process-lifetime concerns:
`getConfig()`, `getDb()` and `getStorage()` are lazy singletons, and the migrator and job runner are
dynamically imported inside `init` precisely so that `vite build` needs neither configuration nor a
database. C is another of these, not an exception to them.

---

## 5. Lifecycle

`src/lib/server/telemetry/` exports `startTelemetry()`, `withSpan()` and the metric recorders.
`init` calls it through a dynamic import, before migrations — so a slow migration is itself a span,
which is exactly the observation an operator wants on a slow start. The migration step is wrapped in
a `database migrate` span for that reason: starting telemetry first buys nothing unless the thing it
was started ahead of is actually measured, and a deploy that is slow to come up is either a slow
migration or something else.

**Application code imports only `@opentelemetry/api`.** When no provider is registered, its tracer
and meter are no-ops. This is the property that makes the design cheap: every call site is
unconditional, with no `if (telemetryEnabled)` guard anywhere in the server, and a deployment with no
collector pays one immediately-returning call per span site. The SDK packages are imported
dynamically inside `startTelemetry()` and only when an endpoint is configured, so an operator running
without telemetry never loads them.

Shutdown registers on `sveltekit:shutdown` (§3.4) and awaits the provider flush.

---

## 6. Configuration

Four variables, all read and validated in `getConfig()`'s schema and passed explicitly to the
exporters, so a malformed endpoint fails at boot exactly as every other setting does rather than
silently dropping telemetry into a void.

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The switch. Absent or empty, C is entirely inert |
| `OTEL_SERVICE_NAME` | `resource.service.name`, defaulting to `trust-center` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Collector authentication, in the standard `k=v,k=v` form |
| `OTEL_TRACES_SAMPLER_ARG` | The ratio, defaulting to `1` (§9) |

They keep the standard OTel names while being read by us rather than by the SDK's own environment
parsing (C3). That is deliberate: an operator who has configured OTLP before types the names they
already know, and the documentation states plainly that these four are the only ones honoured. The
alternative — letting the SDK read the environment — would put configuration validation outside
`getConfig()` for the first time, and a typo would then degrade to silence rather than to a refusal
to boot.

OTLP/**HTTP**, not gRPC: fewer dependencies, and it traverses the proxies an operator is likely to
already have between the application and their collector.

---

## 7. Traces

### 7.1 The request span

Created in `handle`, named `${method} ${event.route.id}`, ending when the response is produced.
Attributes: `http.request.method`, `http.route`, `http.response.status_code`.

`server.address` was listed here in an earlier draft and is deliberately **not** implemented. It is
the `Host` header — attacker-controlled, unbounded in cardinality, and frequently a literal IP
address on a request that reaches the container directly. §8 bans IP addresses from telemetry
outright, so an attribute whose value is *sometimes* an IP cannot be sanitised into compliance, and
one an attacker can set freely is a cardinality bomb in the operator's own backend. The three that
ship are the three this document's own questions need.

The route id for an unmatched request is `null`; the span is named `${method} unmatched` and carries
no route attribute, so a scan for nonexistent paths cannot inflate cardinality with one route value
per probe.

**Placement.** CLAUDE.md requires that `localeStorage.run` stay the outermost wrapper around
`resolve`, or SSR translations silently fall back to the base locale. The span wraps outside it:

```ts
return tracer.startActiveSpan(name, (span) =>
    localeStorage.run({ locale }, () => resolve(event))
);
```

`localeStorage.run` remains the immediate wrapper of `resolve`, which is what the rule protects.

### 7.2 The other spans

- **`runJob`**, one per tick: job name, whether the advisory lock was acquired, and the outcome. This
  is where "is the mail queue draining" is answered when the answer is "no, and here is the error."
- **The mail drain**, one per send, wrapping the SMTP call.
- **`delivery/serve.ts`**, the one mediated path out of storage: one `document deliver` span around
  the storage read *and* the stamping, with the `document watermark` span nested inside it. Two
  spans rather than one because the gated path buffers the whole object before the stamper sees a
  byte — the difference between the outer and inner span is exactly that buffering, which a span
  around the stamp alone reports as a fast watermark inside an unexplained slow request. Attributes
  are `document.tier`, `document.watermarked` and `document.size_bytes`; the recipient appears on
  neither span (§8).
- **The migration step in `init`**, one `database migrate` span per boot, per §5.

### 7.3 Correlation

`recordEvent` populates `audit_event.request_id` from the active span's trace id. The column has
existed since Phase 0 with no writer; this gives it one, and makes "who downloaded this" and "why was
that request slow" the same query.

`handleError` currently mints a `crypto.randomUUID()` correlation id that reaches the log line and
nothing else. It becomes the trace id when a span is active, and keeps the uuid fallback when one is
not — so the identifier in an error log is the identifier in the trace backend.

A trace id is not personal data and is unaffected by the requester purge, which is consistent only
because §8 forbids the trace from carrying anything that a purge would need to reach.

---

## 8. The privacy invariant

Stated first-class, in the shape §10 of the main spec states the audit rule.

> A span or metric may carry route ids, resource ids, job names, status codes, outcomes and
> durations. It may **never** carry a URL query string, an email address, a requester name or
> company, an IP address, a user agent, a session or magic-link token, or a statement's parameters.

**Why absolute rather than purge-scoped.** Telemetry leaves the boundary. `purgeRequester` is a
column-scoped UPDATE against tables this application owns; it cannot reach a span already accepted by
a collector. Personal data in telemetry is therefore not erasable by us at all, which is why the rule
is "none" rather than "only what we can purge."

This is the exact inverse of the decision taken for subsystem A, and the inversion is the point. A
carries personal data deliberately and documents where our erasure boundary ends, because a Teams
card that cannot name the requester is useless. C carries none, so it needs no boundary statement —
there is nothing on the far side of the edge to describe.

**Query strings are the sharp edge.** Generic advice says prefer `http.route` over `http.target`
for cardinality. Here the reason is stronger: this application's query strings carry credentials —
`/{locale}/access/verify?token=`, and the subscription manage link (P4.21). `url.full` and
`url.query` are therefore banned outright rather than sanitised, and §12.2 makes the ban structural
rather than remembered.

**Metric attribute values are bounded sets only** — route ids, job names, status codes, outcomes.
Never an id, never an address, and never the rate limiter's key, which is a hash of an identifier and
would turn the metric backend into the index of who asked for what that `ratelimit.ts` exists to
avoid being.

---

## 9. Metrics and sampling

Four, chosen because each answers a question the deployment currently cannot answer at all.

| Metric | Kind | Attributes |
| --- | --- | --- |
| `http.server.request.duration` | histogram | `http.route`, `http.request.method`, `http.response.status_code` |
| `trustcenter.job.tick.duration` | histogram | `job.name` |
| `trustcenter.job.tick` | counter | `job.name`, `outcome` (`ok`, `error`, `locked`) |
| `trustcenter.mail.queue.depth` | observable gauge | — |

The queue-depth gauge earns its place because nothing in this application sends mail inline: a
deployment whose SMTP is misconfigured looks entirely healthy from the outside while the queue grows,
and a deployment with no `SMTP_URL` at all is a *supported* configuration whose queue grows forever
by design. The gauge is what distinguishes those two.

Rate-limit rejections are deliberately absent from v1. The useful form is a counter by bucket, but
the bucket names are not yet a closed set, and a metric name is permanent in the same way an audit
action name is (the Phase 2 carry-over on `translationAction`): once a dashboard or alert is built on it,
renaming it breaks someone's on-call. Better to add it when the buckets are settled than to publish a
name we would want back. The `trustcenter.` prefix exists for the same reason — to keep our names
from colliding with a future semantic convention that claims the bare one.

**Sampling** is parent-based over a ratio, defaulting to 1. This is a low-traffic internal trust
portal, and the whole premise of C is explaining a specific download or a specific slow request;
sampling away the one trace somebody needs defeats it. Parent-based so that a trace context arriving
from subsystem A, once it exists, is honoured rather than re-decided.

---

## 10. Dependencies

`@opentelemetry/api` is a normal import and always loaded — it is small and it is the no-op that
makes §5 work. The rest are dynamically imported and only when enabled:
`@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-metrics`, `@opentelemetry/resources`,
`@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`.

They are ordinary production dependencies, so the image carries them whether or not an operator
enables telemetry. That is a real cost, accepted: making them optional peer dependencies would mean a
deployment that sets the endpoint and gets silence, which is the failure mode §6 already rejected.

---

## 11. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| C1 | Manual instrumentation, no `--import` bootstrap | Auto-instrumentation's prize is free spans for libraries we did not write, and the only outbound egress is SMTP; it would cost a change to how the process starts and add a failure mode that is silent on upgrade |
| C2 | Started from `init` by dynamic import, like the migrator and job runner | `vite build` must keep working with an empty environment; this is the existing groove for exactly that |
| C3 | Standard `OTEL_*` names, read and validated by `getConfig()` | Operators type names they know, and a malformed endpoint refuses to boot instead of degrading to silence — configuration validation stays in one place |
| C4 | Application code imports `@opentelemetry/api` only | Its no-op provider makes every call site unconditional; no `if (enabled)` guard anywhere in the server |
| C5 | `http.route` from `event.route.id`; an unmatched request carries none | Correct by construction rather than by a sanitising callback, and a path scanner cannot inflate cardinality |
| C6 | `url.full` and `url.query` are never recorded | This application's query strings carry magic-link and management tokens; sanitising a value we have no reason to hold is a weaker answer than never holding it |
| C7 | The span wraps outside `localeStorage.run` | `localeStorage.run` must stay the immediate wrapper of `resolve` or SSR translations fall back to the base locale |
| C8 | `audit_event.request_id` is written with the trace id, and `handleError` adopts it | A correlation column with no writer since Phase 0; this makes "who downloaded this" and "why was that slow" one query |
| C9 | No personal data in telemetry at all, rather than only what a purge can reach | `purgeRequester` cannot reach a collector; the inverse of subsystem A's choice, for the inverse reason |
| C10 | Flush on `sveltekit:shutdown`, adding no signal handler | adapter-node already owns SIGTERM/SIGINT; without a flush every deploy loses the last batch |
| C11 | No database spans in v1 | No maintained instrumentation exists for postgres-js, and the obvious hand-rolled seam (the driver's `debug` callback, Drizzle's logger) receives bound parameters — the one thing §8 forbids handling |
| C12 | Rate-limit metrics deferred; `trustcenter.` prefix on custom names | Metric names are permanent once an alert is built on one, in the same way audit action names are; the bucket set is not settled yet |
| C13 | Sampling is parent-based over a ratio, defaulting to always-on | Explaining one specific download is the premise; a default that samples it away defeats the feature, and the traffic does not require otherwise. Parent-based so a trace context arriving from subsystem A is honoured rather than re-decided |
| C14 | OTLP/HTTP rather than gRPC | Fewer dependencies, and it traverses an operator's existing proxies |
| C15 | Logs stay on stdout | The container runtime already collects them; exporting them again buys a logging refactor and a duplicated pipeline |

---

## 12. Testing

### 12.1 Unit

Over an `InMemorySpanExporter`, so no collector is needed in CI:

- A matched request emits one span with the route id and status, and no URL-valued attribute.
- An unmatched request emits a span with no `http.route`.
- With no endpoint configured, `startTelemetry()` registers no provider, `withSpan` runs its callback
  exactly once, and the API's no-op tracer is what serves the call sites.
- The metric recorders emit the expected instrument names and attribute keys.

### 12.2 The leak is made unrepresentable, then tested

The request-attribute builder is a pure function that **never receives the URL** — it takes the
method, the route id and the status. A query string cannot reach a span attribute because there is no
parameter through which it could arrive. That is stronger than a test, and it is the same move
`recordEvent`'s `AuditActor` union makes: the wrong value has no way to be expressed.

The test then defends the surface that remains. Drive a request to
`/de/access/verify?token=…` through the handle chain and assert that no attribute value on any
emitted span contains `@`, `token=`, or an IP-shaped string. This belongs with the permanent security
regression tests of §12 of the main spec, beside "the public portal sets no cookies" — it defends a
property that is invisible when it holds and embarrassing when it breaks.

### 12.3 Integration

`recordEvent` called inside an active span writes that span's trace id into `audit_event.request_id`;
called outside one, it writes null and does not throw.

---

## 13. What this defers

- **Database spans** (C11). The seam and its hazard are recorded so the next reader does not
  rediscover them.
- **Rate-limit metrics** (C12), until the bucket names are a closed set.
- **Logs** (§2), until there is a reader who wants trace-correlated logs specifically.
- **`stopJobRunner` never being called** (§3.4). Adjacent, pre-existing, and not C's to fix.
- **Trace context propagation into subsystem A.** C13 chooses a parent-based sampler so that A can
  propagate context when it exists, but nothing is propagated today because nothing goes out.
