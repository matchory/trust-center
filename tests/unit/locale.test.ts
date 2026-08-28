import { describe, expect, it } from 'vitest';
import {
	assertLocaleSubset,
	pickTranslation,
	resolveLocale,
	stripLocale
} from '../../src/lib/i18n/locale';

const LOCALES = ['de', 'en'] as const;

describe('stripLocale', () => {
	it('extracts a known locale prefix', () => {
		expect(stripLocale('/de/dokumente', LOCALES)).toEqual({ locale: 'de', path: '/dokumente' });
	});

	it('returns the bare path when the prefix is not a known locale', () => {
		expect(stripLocale('/documents', LOCALES)).toEqual({ locale: null, path: '/documents' });
	});

	it('normalises a bare locale root to "/"', () => {
		expect(stripLocale('/en', LOCALES)).toEqual({ locale: 'en', path: '/' });
	});

	it('does not treat a longer segment starting with a locale as a prefix', () => {
		expect(stripLocale('/denmark', LOCALES)).toEqual({ locale: null, path: '/denmark' });
	});
});

describe('resolveLocale', () => {
	it('prefers the path locale', () => {
		expect(resolveLocale({ pathLocale: 'en', acceptLanguage: 'de-DE' }, LOCALES, 'de')).toBe('en');
	});

	it('falls back to Accept-Language when there is no path locale', () => {
		expect(
			resolveLocale({ pathLocale: null, acceptLanguage: 'en-GB,en;q=0.9' }, LOCALES, 'de')
		).toBe('en');
	});

	it('falls back to the default locale for an unsupported language', () => {
		expect(resolveLocale({ pathLocale: null, acceptLanguage: 'fr-FR' }, LOCALES, 'de')).toBe('de');
	});

	it('falls back to the default locale when Accept-Language is absent', () => {
		expect(resolveLocale({ pathLocale: null }, LOCALES, 'de')).toBe('de');
	});
});

describe('assertLocaleSubset', () => {
	it('does not throw when every configured locale is compiled', () => {
		expect(() => assertLocaleSubset(['de', 'en'], ['de', 'en', 'fr'])).not.toThrow();
	});

	it('throws naming both sets when a configured locale has no compiled catalog', () => {
		expect(() => assertLocaleSubset(['de', 'en', 'fr'], ['de', 'en'])).toThrowError(
			/PUBLIC_LOCALES.*\["de","en","fr"\].*compiled into Paraglide.*\["de","en"\].*missing: fr/s
		);
	});
});

describe('pickTranslation', () => {
	const translations = [
		{ locale: 'de', value: 'Auftragsverarbeitungsvertrag' },
		{ locale: 'en', value: 'Data Processing Agreement' }
	];

	it('returns the exact match without a fallback flag', () => {
		expect(pickTranslation(translations, 'de', 'de')).toEqual({
			value: 'Auftragsverarbeitungsvertrag',
			locale: 'de',
			isFallback: false
		});
	});

	it('falls back to the default locale and flags it', () => {
		const englishOnly = [{ locale: 'en', value: 'Penetration Test Report' }];

		expect(pickTranslation(englishOnly, 'de', 'en')).toEqual({
			value: 'Penetration Test Report',
			locale: 'en',
			isFallback: true
		});
	});

	it('returns null when neither the requested nor the default locale exists', () => {
		expect(pickTranslation([{ locale: 'fr', value: 'Rapport' }], 'de', 'en')).toBeNull();
	});

	it('returns null for an empty translation set', () => {
		expect(pickTranslation([], 'de', 'en')).toBeNull();
	});
});
