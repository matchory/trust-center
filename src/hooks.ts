import type { Reroute } from '@sveltejs/kit';
import { COMPILED_LOCALES } from '$lib/i18n/compiled';
import { stripLocale } from '$lib/i18n/locale';

// Structural, and deliberately over the COMPILED set rather than the enabled
// one: this hook is universal (it runs in the browser too) and must not depend
// on server configuration. `hooks.server.ts` decides whether the locale is
// enabled.
export const reroute: Reroute = ({ url }) => stripLocale(url.pathname, COMPILED_LOCALES).path;
