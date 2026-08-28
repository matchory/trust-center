import { isHttpError, type Handle } from '@sveltejs/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { handle } from '../../src/hooks.server';

type Event = Parameters<Handle>[0]['event'];

/**
 * `getConfig()` memoises on first call and parses straight out of
 * `process.env`, so the environment has to be set before anything in this
 * file calls `handle()` for the first time. This file deliberately owns
 * `process.env` for its own duration — every other unit test file calls
 * `parseConfig(env, compiled)` directly with its own object and never touches
 * `process.env`, so this has no effect on them. `LOCALES=de` is a strict
 * subset of the `de,en` compiled here (see project.inlang/settings.json),
 * which is what lets the "compiled but not enabled" case below exist.
 */
beforeAll(() => {
	Object.assign(process.env, {
		DATABASE_URL: 'postgres://tc:tc@localhost:5432/tc',
		BASE_URL: 'https://trust.example.com',
		LOCALES: 'de',
		DEFAULT_LOCALE: 'de',
		OIDC_ISSUER: 'https://idp.example.com',
		OIDC_CLIENT_ID: 'trust-center',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_ADMIN_GROUP: 'trust-center-admins'
	});
});

/**
 * A minimal stand-in for SvelteKit's `RequestEvent`, covering only what
 * `handle` actually reads: `url`, `request.headers`, `cookies.get`, and
 * `locals` (which `handle` writes into). `cookies.get` always returns
 * `undefined`, so the session branch is skipped and `getDb()` is never
 * reached — no database is needed for these tests.
 */
function fakeEvent(pathname: string): Event {
	return {
		url: new URL(`https://trust.example.com${pathname}`),
		request: new Request('https://trust.example.com/'),
		cookies: { get: () => undefined },
		locals: {} as App.Locals
	} as unknown as Event;
}

function fakeResolve() {
	return vi.fn(async () => new Response(null, { headers: new Headers() }));
}

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
