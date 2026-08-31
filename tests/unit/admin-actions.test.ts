import { describe, expect, it } from 'vitest';
import {
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
