import { AsyncLocalStorage } from 'node:async_hooks';
import { SpanKind } from '@opentelemetry/api';
import {
	error,
	isHttpError,
	type Handle,
	type HandleServerError,
	type ServerInit
} from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	STAFF_COOKIE_OPTIONS,
	validateStaffSession
} from '$lib/server/auth/session';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import {
	REQUESTER_SESSION_COOKIE,
	requesterCookieOptions,
	validateRequesterSession
} from '$lib/server/identity/requester';
import { COMPILED_LOCALES } from '$lib/i18n/compiled';
import { classifyPath, resolveLocale } from '$lib/i18n/locale';
import { assertIsLocale, overwriteServerAsyncLocalStorage } from '$lib/paraglide/runtime.js';
import {
	activeTraceId,
	recordRequestDuration,
	requestAttributes,
	requestSpanName,
	withSpan
} from '$lib/server/telemetry';

type Locale = ReturnType<typeof assertIsLocale>;

// Paraglide's `m.*()` message functions resolve their locale through this
// AsyncLocalStorage in an SSR context (see runtime.js `getLocale`). We own
// locale resolution ourselves, so rather than using `paraglideMiddleware` —
// which applies its own URL-strategy redirects — we populate the same storage
// directly, per request, so Paraglide's lookups agree with `locals.locale`.
const localeStorage = new AsyncLocalStorage<{ locale?: Locale }>();
overwriteServerAsyncLocalStorage(localeStorage);

/**
 * Fails the process on invalid configuration rather than letting every request
 * 500 with the same parse error. `getConfig()` is memoised, so this also warms
 * it before the first request.
 */
export const init: ServerInit = async () => {
	try {
		getConfig();
	} catch (cause) {
		console.error(cause instanceof Error ? cause.message : cause);
		process.exit(1);
	}

	// Before migrations, so a slow migration is itself a span — which is the
	// observation an operator wants when a deploy is slow to come up.
	//
	// This dynamic import is *not* what keeps `pnpm build` working with an empty
	// environment, unlike the migrator's below: this file already imports the
	// same barrel statically for `handle`, so the module is in the graph either
	// way. What protects the build is inside `startTelemetry` — the SDK packages
	// are behind an `await Promise.all([import(…)])` that only runs when an
	// endpoint is configured. Do not turn those into static imports in
	// provider.ts on the strength of this line.
	const { startTelemetry, shutdownTelemetry } = await import('$lib/server/telemetry');
	await startTelemetry(getConfig().telemetry);

	// adapter-node already handles SIGTERM and SIGINT and emits this once the
	// server has stopped accepting connections, so we add no signal handler of
	// our own and cannot fight the adapter's shutdown ordering.
	process.on('sveltekit:shutdown', () => {
		// A final flush failing — the collector being unreachable mid-deploy is
		// the ordinary case, not an exotic one — must not become an unhandled
		// rejection during teardown: under Node's default mode that can abort
		// the very shutdown sequence this handler exists to make graceful.
		void shutdownTelemetry().catch((cause) => {
			console.error(
				JSON.stringify({
					level: 'error',
					scope: 'telemetry',
					message: cause instanceof Error ? cause.message : String(cause)
				})
			);
		});
	});

	// Default on, because the single-container deployment this ships for has
	// nowhere else to run them. Operators running more than one replica set
	// RUN_MIGRATIONS=false and run a one-off migration job instead — two
	// replicas racing the same migration is a real failure mode, and there is
	// no advisory lock around drizzle's migrator to prevent it.
	if (process.env.RUN_MIGRATIONS !== 'false') {
		const { migrate } = await import('drizzle-orm/postgres-js/migrator');
		// The span telemetry is started ahead of migrations for: a deploy that is
		// slow to come up is either a slow migration or something else, and this
		// is what tells the operator which.
		await withSpan('database migrate', {}, () =>
			migrate(getDb(), { migrationsFolder: './drizzle' })
		);
	}

	// After migrations, so no job queries a table that does not exist yet.
	// RUN_JOBS=false belongs to operators running a separate worker; the default
	// single-container deployment has nowhere else to run them. Imported
	// dynamically so `pnpm build` still needs neither config nor a database.
	if (process.env.RUN_JOBS !== 'false') {
		const { startJobRunner } = await import('$lib/server/jobs');
		startJobRunner();
	}
};

/**
 * Everything `handle` did before instrumentation, unchanged and at its original
 * indentation: the span belongs around this, not woven through it.
 */
async function handleRequest({ event, resolve }: Parameters<Handle>[0]): Promise<Response> {
	const { locales, defaultLocale } = getConfig();
	const route = classifyPath(event.url.pathname, COMPILED_LOCALES, locales);

	// A compiled-but-disabled locale is not a content path. Refusing it here
	// keeps `/en/avv` from degrading into a lookup for a document slugged "en"
	// the day an operator narrows LOCALES.
	if (route.kind === 'unknown-locale') {
		error(404, `Locale "${route.locale}" is not enabled on this deployment.`);
	}

	event.locals.pathLocale = route.kind === 'localized' ? route.locale : null;
	event.locals.locale =
		route.kind === 'localized'
			? route.locale
			: resolveLocale(
					{
						pathLocale: null,
						acceptLanguage: event.request.headers.get('accept-language') ?? undefined
					},
					locales,
					defaultLocale
				);

	event.locals.staff = null;
	const token = event.cookies.get(SESSION_COOKIE);

	if (token) {
		const session = await validateStaffSession(getDb(), token);
		const role = session?.user.role;

		if (session && (role === 'admin' || role === 'approver')) {
			event.locals.staff = {
				id: session.user.id,
				email: session.user.email,
				name: session.user.name,
				role
			};
		} else {
			// As with the requester cookie below, every attribute must match the
			// set or the deletion is rejected — see STAFF_COOKIE_OPTIONS.
			event.cookies.delete(SESSION_COOKIE, STAFF_COOKIE_OPTIONS);
		}
	}

	event.locals.requester = null;
	const requesterToken = event.cookies.get(REQUESTER_SESSION_COOKIE);

	if (requesterToken) {
		const session = await validateRequesterSession(getDb(), requesterToken);

		if (session) {
			event.locals.requester = {
				id: session.requester.id,
				email: session.requester.email,
				name: session.requester.name,
				company: session.requester.company
			};
		} else {
			// Every attribute must match how it was set, or the delete silently
			// does nothing — see requesterCookieOptions.
			event.cookies.delete(REQUESTER_SESSION_COOKIE, requesterCookieOptions(event.locals.locale));
		}
	}

	// localeStorage.run MUST remain the outermost wrapper around resolve, or
	// server-rendered translations silently fall back to the base locale.
	return localeStorage.run({ locale: assertIsLocale(event.locals.locale) }, async () => {
		const response = await resolve(event, {
			transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.locale)
		});

		// Only the unprefixed responses vary by Accept-Language — and those are
		// all redirects issued by the root layout. Every content URL carries its
		// locale in the path and stays unconditionally cacheable.
		if (route.kind === 'unprefixed') response.headers.append('Vary', 'Accept-Language');

		return response;
	});
}

/**
 * Opened at the very top of `handle`, ahead of locale classification and the
 * two session lookups. `event.route.id` and the method are both populated
 * before `handle` runs, so nothing is lost by starting here — and starting
 * later cost two things: `http.server.request.duration` is a semantic
 * convention name with a semantic convention meaning, and it under-reported by
 * a database round trip on every authenticated request; and the 404 for a
 * compiled-but-disabled locale was thrown before the span existed, so that
 * entire class of request was invisible in traces and metrics alike.
 *
 * The span wraps outside `localeStorage.run`, which stays the immediate wrapper
 * around `resolve` inside `handleRequest` — the rule CLAUDE.md states, and whose
 * breach shows up as SSR translations silently falling back to the base locale.
 */
export const handle: Handle = async (input) => {
	const routeId = input.event.route.id;
	const method = input.event.request.method;
	const started = performance.now();

	return withSpan(
		requestSpanName(method, routeId),
		{},
		async (span) => {
			// Called on every exit path, a throw included, so no failure between
			// here and `resolve` can drop a request out of both signals at once.
			const record = (status: number) => {
				const attributes = requestAttributes({ method, routeId, status });

				// One set of values, put on the span and handed to the histogram, so
				// the two cannot drift — including the unmatched-route omission.
				span.setAttributes(attributes);
				recordRequestDuration(attributes, (performance.now() - started) / 1000);
			};

			try {
				const response = await handleRequest(input);
				record(response.status);
				return response;
			} catch (cause) {
				// A SvelteKit `error()` carries the status the response will have;
				// anything else SvelteKit renders as a 500, so that is the honest
				// fallback. Approximate rather than observed — the response is built
				// above us — but an approximate status beats the invisibility this
				// replaces, where a throw produced no span attributes and no data
				// point at all.
				record(isHttpError(cause) ? cause.status : 500);
				throw cause;
			}
		},
		// SERVER rather than the SDK's default INTERNAL — see `withSpan`'s `kind`
		// parameter for why the kind is as permanent as the span name.
		SpanKind.SERVER
	);
};

/**
 * Deliberately does not log `error.cause`. `openid-client` attaches the
 * callback request — including the authorization code, and on some flows the
 * client secret — as the cause of its errors, and SvelteKit's default handler
 * `console.error`s the whole chain, writing credentials into the operator's
 * logs. Message, route, and a correlation id are enough to investigate.
 */
export const handleError: HandleServerError = ({ error: caught, event, status, message }) => {
	// The identifier in the log line is the identifier in the trace backend
	// when tracing is on; a uuid remains the fallback when it is not, so the
	// line is never without one.
	const id = activeTraceId() ?? crypto.randomUUID();

	console.error(
		JSON.stringify({
			level: 'error',
			id,
			status,
			method: event.request.method,
			route: event.route.id,
			message: caught instanceof Error ? caught.message : String(caught)
		})
	);

	return { message, id };
};
