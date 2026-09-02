export interface StrippedPath {
	locale: string | null;
	path: string;
}

export function stripLocale(pathname: string, locales: readonly string[]): StrippedPath {
	const segments = pathname.split('/');
	const candidate = segments[1];

	if (candidate === undefined || !locales.includes(candidate)) {
		return { locale: null, path: pathname };
	}

	const rest = `/${segments.slice(2).join('/')}`;
	return { locale: candidate, path: rest === '/' ? '/' : rest.replace(/\/$/, '') };
}

function parseAcceptLanguage(header: string): string[] {
	return header
		.split(',')
		.map((part) => {
			const [tag = '', ...params] = part.trim().split(';');
			const q = params
				.map((p) => p.trim())
				.find((p) => p.startsWith('q='))
				?.slice(2);
			return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number.parseFloat(q) };
		})
		.filter((entry) => entry.tag.length > 0 && !Number.isNaN(entry.q))
		.sort((a, b) => b.q - a.q)
		.map((entry) => entry.tag);
}

export function resolveLocale(
	input: { pathLocale: string | null; acceptLanguage?: string },
	locales: readonly string[],
	defaultLocale: string
): string {
	if (input.pathLocale !== null && locales.includes(input.pathLocale)) {
		return input.pathLocale;
	}

	if (input.acceptLanguage) {
		for (const tag of parseAcceptLanguage(input.acceptLanguage)) {
			const base = tag.split('-')[0];
			const match = locales.find((locale) => locale === tag || locale === base);
			if (match) return match;
		}
	}

	return defaultLocale;
}

export interface PickedTranslation<T> {
	value: T;
	locale: string;
	isFallback: boolean;
}

/**
 * Resolves the best available translation. Partial translation is the normal
 * steady state, so a fallback to the default locale is expected — but callers
 * must be able to tell, because the portal labels fallback content rather than
 * silently mixing languages.
 */
export function pickTranslation<T>(
	translations: readonly { locale: string; value: T }[],
	requested: string,
	defaultLocale: string
): PickedTranslation<T> | null {
	const exact = translations.find((t) => t.locale === requested);
	if (exact) return { value: exact.value, locale: exact.locale, isFallback: false };

	const fallback = translations.find((t) => t.locale === defaultLocale);
	if (fallback) return { value: fallback.value, locale: fallback.locale, isFallback: true };

	return null;
}

/** Builds the canonical, always-prefixed URL path for a locale. */
export function localizePath(path: string, locale: string): string {
	return path === '/' ? `/${locale}` : `/${locale}${path}`;
}

/**
 * Intl.DisplayNames rather than a hand-maintained map: it names any locale the
 * deployment compiles, in that locale's own language, and it is built into the
 * platform — the portal loads nothing third-party.
 */
export function endonym(locale: string): string {
	return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale;
}

export type LocaleRoute =
	| { kind: 'localized'; locale: string; path: string }
	| { kind: 'unprefixed'; path: string }
	| { kind: 'unknown-locale'; locale: string };

/**
 * The whole locale routing decision as a pure function, so `hooks.server.ts`
 * stays a switch over three cases and the interesting part is unit-testable.
 *
 * The distinction that matters: a prefix Paraglide compiled a catalog for is
 * *structurally* a locale prefix even when the operator has disabled it, so it
 * must 404 rather than fall through to content lookup — otherwise disabling a
 * locale would turn `/en/avv` into a search for a document slugged "en".
 */
export function classifyPath(
	pathname: string,
	compiled: readonly string[],
	enabled: readonly string[]
): LocaleRoute {
	const { locale, path } = stripLocale(pathname, compiled);

	if (locale === null) return { kind: 'unprefixed', path };
	if (!enabled.includes(locale)) return { kind: 'unknown-locale', locale };
	return { kind: 'localized', locale, path };
}
