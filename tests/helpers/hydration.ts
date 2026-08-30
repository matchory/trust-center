import type { Page } from '@playwright/test';

/**
 * Waits for the page's JavaScript to have loaded and run, which is when Svelte
 * claims the server-rendered tree and SvelteKit's client router starts
 * intercepting link clicks.
 *
 * Two distinct failures come from not waiting, and neither looks like a race:
 *
 * - Filling a field first is lost. An input rendered as `value={data.x}` has
 *   its DOM value written again during hydration, discarding whatever
 *   Playwright typed, and the form then submits the server's value as if the
 *   test had never touched it — a test that passes its own "saved" assertion
 *   while writing the wrong row.
 * - Clicking a link first is a full document load. The router is not listening
 *   yet, so the browser navigates normally, `window` is reset, and any test
 *   that distinguishes client-side from full navigation reports a full one.
 *
 * `networkidle` is the signal because hydration runs inside the entry module:
 * once no request has been in flight for half a second, the chunks are loaded
 * and hydration is done.
 */
export async function awaitHydration(page: Page) {
	await page.waitForLoadState('networkidle');
}
