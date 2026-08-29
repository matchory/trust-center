import { describe, expect, it } from 'vitest';
import { resolveMetaAction, translationAction } from '../../src/lib/server/admin/actions';

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
