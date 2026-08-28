// Relative rather than `$lib/...` on purpose: this module is pulled in by the
// config singleton, which unit tests import without SvelteKit's aliases.
import { locales } from '../paraglide/runtime.js';

/**
 * The locales Paraglide compiled a catalog for. A build input, fixed for the
 * life of an image — a locale with no catalog is not a locale.
 *
 * `getConfig().locales` is the subset an operator enabled at runtime and is
 * always a subset of this. URL prefix routing is structural and uses THIS
 * list: `/en/x` is a locale-prefixed path whether or not English is enabled,
 * so a disabled locale 404s rather than being mistaken for a content slug.
 */
export const COMPILED_LOCALES: readonly string[] = locales;
