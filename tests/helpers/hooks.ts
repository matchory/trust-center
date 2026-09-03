import type { Handle } from '@sveltejs/kit';
import { vi } from 'vitest';

type Event = Parameters<Handle>[0]['event'];

/**
 * `getConfig()` memoises on first call and parses straight out of
 * `process.env`, so the environment has to be set before anything calls
 * `handle()` for the first time. The files using this deliberately own
 * `process.env` for their own duration — every other unit test file calls
 * `parseConfig(env, compiled)` directly with its own object and never touches
 * `process.env`, so this has no effect on them.
 *
 * `LOCALES=de` is a strict subset of the `de,en` compiled here (see
 * project.inlang/settings.json), which is what makes the "compiled but not
 * enabled" 404 reachable at all.
 */
export function applyHandleEnv(): void {
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
}

/**
 * A minimal stand-in for SvelteKit's `RequestEvent`, covering only what
 * `handle` actually reads: `url`, `request`, `route.id`, `cookies.get`, and
 * `locals` (which `handle` writes into). `cookies.get` always returns
 * `undefined`, so the session branch is skipped and `getDb()` is never reached
 * — no database is needed.
 */
export function fakeEvent(pathname: string, search = '', routeId: string | null = null): Event {
	return {
		url: new URL(`https://trust.example.com${pathname}${search}`),
		request: new Request(`https://trust.example.com${pathname}${search}`),
		cookies: { get: () => undefined },
		locals: {} as App.Locals,
		route: { id: routeId }
	} as unknown as Event;
}

export function fakeResolve(status = 200) {
	return vi.fn(async () => new Response(null, { status, headers: new Headers() }));
}
