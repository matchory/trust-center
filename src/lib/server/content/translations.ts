import { getConfig } from '../config';

/**
 * Reads `field.<locale>` values out of a form and hands each non-empty locale
 * to `save`. Deliberately not generic over Drizzle tables: an upsert typed
 * over an arbitrary translations table costs more in type gymnastics than the
 * four lines it would save per call site.
 */
export async function saveTranslationsFromForm<T>(
	form: FormData,
	read: (form: FormData, locale: string) => T | null,
	save: (locale: string, values: T) => Promise<void>
): Promise<void> {
	for (const locale of getConfig().locales) {
		const values = read(form, locale);
		if (values !== null) await save(locale, values);
	}
}
