import { PUBLIC_DEFAULT_LOCALE, PUBLIC_LOCALES } from '$env/static/public';

export const LOCALES: readonly string[] = PUBLIC_LOCALES.split(',').map((l) => l.trim());
export const DEFAULT_LOCALE: string = PUBLIC_DEFAULT_LOCALE;

if (!LOCALES.includes(DEFAULT_LOCALE)) {
	throw new Error(
		`PUBLIC_DEFAULT_LOCALE "${DEFAULT_LOCALE}" is not present in PUBLIC_LOCALES "${PUBLIC_LOCALES}"`
	);
}
