import { PUBLIC_DEFAULT_LOCALE, PUBLIC_LOCALES } from '$env/static/public';
import { locales as compiledLocales } from '$lib/paraglide/runtime.js';
import { assertLocaleSubset } from './locale';

export const LOCALES: readonly string[] = PUBLIC_LOCALES.split(',').map((l) => l.trim());
export const DEFAULT_LOCALE: string = PUBLIC_DEFAULT_LOCALE;

if (!LOCALES.includes(DEFAULT_LOCALE)) {
	throw new Error(
		`PUBLIC_DEFAULT_LOCALE "${DEFAULT_LOCALE}" is not present in PUBLIC_LOCALES "${PUBLIC_LOCALES}"`
	);
}

// This module is imported by src/hooks.ts, so this runs at boot rather than
// on the first request — an operator who sets PUBLIC_LOCALES to a locale
// with no compiled catalog gets an actionable startup error instead of every
// visitor whose Accept-Language resolves to it getting an unhandled 500 from
// assertIsLocale() inside handle().
assertLocaleSubset(LOCALES, compiledLocales);
