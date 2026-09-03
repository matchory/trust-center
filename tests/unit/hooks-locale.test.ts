import { isHttpError } from '@sveltejs/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server';
import { applyHandleEnv, fakeEvent, fakeResolve } from '../helpers/hooks';

beforeAll(applyHandleEnv);

describe('handle: locale routing', () => {
	it('rejects a compiled-but-disabled locale with a 404, before resolve is called', async () => {
		const resolve = fakeResolve();

		try {
			await handle({ event: fakeEvent('/en/documents'), resolve });
			expect.fail('expected handle to throw');
		} catch (caught) {
			if (!isHttpError(caught)) throw caught;
			expect(caught.status).toBe(404);
		}

		expect(resolve).not.toHaveBeenCalled();
	});

	it('allows a compiled and enabled locale through', async () => {
		const resolve = fakeResolve();
		const event = fakeEvent('/de/documents');

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.pathLocale).toBe('de');
		expect(event.locals.locale).toBe('de');
	});

	it('allows the unprefixed root through, leaving pathLocale null for the layout redirect', async () => {
		const resolve = fakeResolve();
		const event = fakeEvent('/');

		await handle({ event, resolve });

		expect(resolve).toHaveBeenCalledOnce();
		expect(event.locals.pathLocale).toBeNull();
	});
});
