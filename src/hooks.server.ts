import { AsyncLocalStorage } from 'node:async_hooks';
import type { Handle } from '@sveltejs/kit';
import { DEFAULT_LOCALE, LOCALES } from '$lib/i18n/locales';
import { resolveLocale, stripLocale } from '$lib/i18n/locale';
import { assertIsLocale, overwriteServerAsyncLocalStorage } from '$lib/paraglide/runtime.js';

type Locale = ReturnType<typeof assertIsLocale>;

// Paraglide's `m.*()` message functions resolve their locale through this
// AsyncLocalStorage in an SSR context (see runtime.js `getLocale`). We own
// locale resolution ourselves (via `resolveLocale`/`stripLocale`), so rather
// than using `paraglideMiddleware` — which applies its own URL-strategy
// redirects — we populate the same storage directly, per request, so that
// Paraglide's message lookups agree with `event.locals.locale`.
const localeStorage = new AsyncLocalStorage<{ locale?: Locale }>();
overwriteServerAsyncLocalStorage(localeStorage);

export const handle: Handle = async ({ event, resolve }) => {
	const { locale: pathLocale } = stripLocale(event.url.pathname, LOCALES);

	event.locals.locale = resolveLocale(
		{ pathLocale, acceptLanguage: event.request.headers.get('accept-language') ?? undefined },
		LOCALES,
		DEFAULT_LOCALE
	);

	return localeStorage.run({ locale: assertIsLocale(event.locals.locale) }, () =>
		resolve(event, {
			transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.locale)
		})
	);
};
