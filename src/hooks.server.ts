import { AsyncLocalStorage } from 'node:async_hooks';
import { error, type Handle, type HandleServerError, type ServerInit } from '@sveltejs/kit';
import { SESSION_COOKIE, validateStaffSession } from '$lib/server/auth/session';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { COMPILED_LOCALES } from '$lib/i18n/compiled';
import { classifyPath, resolveLocale } from '$lib/i18n/locale';
import { assertIsLocale, overwriteServerAsyncLocalStorage } from '$lib/paraglide/runtime.js';

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

	// Default on, because the single-container deployment this ships for has
	// nowhere else to run them. Operators running more than one replica set
	// RUN_MIGRATIONS=false and run a one-off migration job instead — two
	// replicas racing the same migration is a real failure mode, and there is
	// no advisory lock around drizzle's migrator to prevent it.
	if (process.env.RUN_MIGRATIONS !== 'false') {
		const { migrate } = await import('drizzle-orm/postgres-js/migrator');
		await migrate(getDb(), { migrationsFolder: './drizzle' });
	}
};

export const handle: Handle = async ({ event, resolve }) => {
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
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
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
};

/**
 * Deliberately does not log `error.cause`. `openid-client` attaches the
 * callback request — including the authorization code, and on some flows the
 * client secret — as the cause of its errors, and SvelteKit's default handler
 * `console.error`s the whole chain, writing credentials into the operator's
 * logs. Message, route, and a correlation id are enough to investigate.
 */
export const handleError: HandleServerError = ({ error: caught, event, status, message }) => {
	const id = crypto.randomUUID();

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
