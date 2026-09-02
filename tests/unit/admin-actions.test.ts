import { describe, expect, it } from 'vitest';
import {
	readTranslations,
	resolveMetaAction,
	translationAction,
	uniqueViolationField
} from '../../src/lib/server/admin/actions';

describe('resolveMetaAction', () => {
	it('records the published action when the predicate holds', () => {
		expect(
			resolveMetaAction('answer', { visibility: 'public' }, (d) => d.visibility === 'public')
		).toBe('answer.published');
	});

	it('records the updated action otherwise', () => {
		expect(
			resolveMetaAction('answer', { visibility: 'internal' }, (d) => d.visibility === 'public')
		).toBe('answer.updated');
	});

	it('records the updated action when no predicate is supplied', () => {
		expect(resolveMetaAction('subprocessor', { name: 'x' }, undefined)).toBe(
			'subprocessor.updated'
		);
	});

	it('names translation edits distinctly from meta edits', () => {
		expect(translationAction('document')).toBe('document.translation.updated');
	});
});

describe('uniqueViolationField', () => {
	it('reports a duplicate for the shape Drizzle actually throws', () => {
		// Drizzle wraps the driver error, so the code is on `cause.cause`. Written
		// against `cause.code` this never matches, and the duplicate-slug 500 looks
		// fixed while every route still returns one — which is exactly how
		// `deleteGroup`'s 23503 handler shipped in 3a.
		expect(uniqueViolationField({ query: 'insert …', cause: { code: '23505' } }, 'slug')).toEqual({
			field: 'slug',
			message: 'duplicate'
		});
	});

	it('reads an unwrapped driver error too', () => {
		// So this keeps working if a future Drizzle stops wrapping.
		expect(uniqueViolationField({ code: '23505' }, 'slug')).toEqual({
			field: 'slug',
			message: 'duplicate'
		});
	});

	it('passes an unrelated failure through rather than swallowing it', () => {
		// A foreign-key violation reported to an operator as "that slug is taken"
		// is worse than the 500 this replaces.
		expect(uniqueViolationField({ code: '23503' }, 'slug')).toBeNull();
		expect(uniqueViolationField({ cause: { code: '23503' } }, 'slug')).toBeNull();
		expect(uniqueViolationField(new Error('connection lost'), 'slug')).toBeNull();
		expect(uniqueViolationField(null, 'slug')).toBeNull();
		expect(uniqueViolationField('23505', 'slug')).toBeNull();
	});
});

describe('readTranslations', () => {
	const opts = { required: ['question', 'answer'], optional: ['note'] };

	function formOf(entries: Record<string, string>): FormData {
		const form = new FormData();
		for (const [key, value] of Object.entries(entries)) form.append(key, value);
		return form;
	}

	it('reads one locale per field suffix', () => {
		const result = readTranslations(
			formOf({ 'question.de': 'Frage', 'answer.de': 'Antwort' }),
			['de', 'en'],
			opts
		);

		expect('values' in result && result.values.get('de')).toEqual({
			question: 'Frage',
			answer: 'Antwort',
			note: null
		});
	});

	it('skips a locale nobody translated rather than failing on it', () => {
		// The "not translated" state is normal and visible in the tab strip; a
		// form that refused to save because one locale is blank would make
		// translating a document a single transaction across every language.
		const result = readTranslations(
			formOf({ 'question.de': 'Frage', 'answer.de': 'Antwort' }),
			['de', 'en'],
			opts
		);

		expect('values' in result && result.values.has('en')).toBe(false);
	});

	it('reports a locale filled in only halfway, naming the field and the locale', () => {
		const result = readTranslations(formOf({ 'question.de': 'Frage' }), ['de'], opts);

		expect(result).toEqual({ missing: { field: 'answer', locale: 'de' } });
	});

	it('stores an empty optional field as null', () => {
		const result = readTranslations(
			formOf({ 'question.de': 'F', 'answer.de': 'A', 'note.de': '  ' }),
			['de'],
			opts
		);

		expect('values' in result && result.values.get('de')?.note).toBeNull();
	});
});
