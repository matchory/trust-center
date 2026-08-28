import { describe, expect, it } from 'vitest';
import {
	classifyPath,
	localizePath,
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

const COMPILED = ['de', 'en'] as const;

describe('localizePath', () => {
	it('prefixes the root without leaving a trailing slash pair', () => {
		expect(localizePath('/', 'de')).toBe('/de');
	});

	it('prefixes a nested path', () => {
		expect(localizePath('/documents/avv', 'en')).toBe('/en/documents/avv');
	});

	it('is idempotent in composition with stripLocale', () => {
		expect(localizePath(stripLocale('/en/documents', COMPILED).path, 'de')).toBe('/de/documents');
	});
});

describe('classifyPath', () => {
	it('accepts a prefix that is compiled and enabled', () => {
		expect(classifyPath('/en/documents', COMPILED, ['de', 'en'])).toEqual({
			kind: 'localized',
			locale: 'en',
			path: '/documents'
		});
	});

	it('reports a compiled but disabled locale as unknown, so it can 404', () => {
		expect(classifyPath('/en/documents', COMPILED, ['de'])).toEqual({
			kind: 'unknown-locale',
			locale: 'en'
		});
	});

	it('treats a prefix with no compiled catalog as an ordinary path', () => {
		expect(classifyPath('/fr/documents', COMPILED, ['de', 'en'])).toEqual({
			kind: 'unprefixed',
			path: '/fr/documents'
		});
	});

	it('reports the bare root as unprefixed', () => {
		expect(classifyPath('/', COMPILED, ['de', 'en'])).toEqual({ kind: 'unprefixed', path: '/' });
	});

	it('accepts a bare locale prefix as that locale at the root', () => {
		expect(classifyPath('/de', COMPILED, ['de', 'en'])).toEqual({
			kind: 'localized',
			locale: 'de',
			path: '/'
		});
	});
});
