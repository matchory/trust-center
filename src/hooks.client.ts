import type { ClientInit } from '@sveltejs/kit';
import { assertIsLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';

// Paraglide's default client strategy (url → preferredLanguage → baseLocale)
// resolves independently of `event.locals.locale`, which also honours
// Accept-Language at the unprefixed root (see hooks.server.ts). Left alone,
// hydration would re-run that independent resolution and could silently
// overwrite server-rendered message text with a different locale than the
// one baked into `<html lang>`. The server already published its decision
// there via `%lang%`, so the client reads it back rather than re-deciding.
export const init: ClientInit = () => {
	overwriteGetLocale(() => assertIsLocale(document.documentElement.lang));
};
