import { defineConfig } from '@playwright/test';
import { provisionE2eDatabase } from './tests/setup/e2e-db';

const PREVIEW = 'http://localhost:4173';
const ORIGIN_PREVIEW = 'http://localhost:4174';

// The origin project's server is told it lives here while actually listening on
// ORIGIN_PREVIEW. Under a single-origin run the configured origin and the
// request origin are the same string, so nothing can distinguish a canonical URL
// built from BASE_URL (correct) from one built from the request host (the bug
// fixed in b72f18c). Only a deliberate mismatch can fail that way.
const CONFIGURED_ORIGIN = 'https://trust.example.test';

// Awaited at config load, on purpose: Playwright interpolates `webServer.env`
// while this module is evaluated, which is before `globalSetup` would run. A
// database provisioned any later could not reach the server under test.
const databaseUrl = await provisionE2eDatabase();

export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 30_000,
	globalTeardown: './tests/setup/e2e-db-teardown.ts',
	// Pin the browser's locale so Accept-Language (which resolveLocale()
	// honours at the unprefixed root) is deterministic across machines/CI,
	// rather than depending on the host's LANG/OS locale.
	use: { baseURL: PREVIEW, locale: 'de-DE' },

	projects: [
		{ name: 'app', testIgnore: /origin\.spec\.ts$/ },
		{
			name: 'origin',
			testMatch: /origin\.spec\.ts$/,
			use: { baseURL: ORIGIN_PREVIEW, locale: 'de-DE' }
		}
	],

	// Run against a production preview build rather than `vite dev`, for parity
	// with what actually ships.
	webServer: [
		{
			// CI has already run `pnpm build`; rebuilding here doubles the slowest
			// step of the workflow for nothing.
			command: process.env.CI
				? 'pnpm preview --port 4173 --strictPort'
				: 'pnpm build && pnpm preview --port 4173 --strictPort',
			url: PREVIEW,
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
			// BASE_URL matches the port this server listens on, so redirectUri() in
			// src/lib/server/auth/oidc.ts resolves to an origin the dev IdP's client
			// registration accepts (compose.dev.yaml lists both).
			// The caps are lowered so the route's *refusal* is reachable in a test
			// without building a 25 MB, thousand-page fixture. What is under test is
			// how an over-cap upload is handled, not the number itself.
			// EVENT_SIGNING_KEY is set so /admin/settings/integrations' "reveal the
			// derived secret" control is reachable — it is the one place a live
			// HMAC secret can reach a page, so it is worth exercising in a browser.
			// EVENT_EGRESS_ENABLED stays unset and therefore false, so no
			// deployment under test actually calls out.
			env: {
				BASE_URL: PREVIEW,
				DATABASE_URL: databaseUrl,
				MAX_PDF_PAGES: '5',
				MAX_UPLOAD_MB: '1',
				EVENT_SIGNING_KEY: 'e2e-signing-key-'.padEnd(32, 'x')
			}
		},
		{
			command: 'pnpm preview --port 4174 --strictPort',
			url: ORIGIN_PREVIEW,
			reuseExistingServer: !process.env.CI,
			timeout: 60_000,
			env: { BASE_URL: CONFIGURED_ORIGIN, DATABASE_URL: databaseUrl }
		}
	]
});
