import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 30_000,
	// Pin the browser's locale so Accept-Language (which resolveLocale()
	// honours at the unprefixed root) is deterministic across machines/CI,
	// rather than depending on the host's LANG/OS locale.
	use: { baseURL: 'http://localhost:4173', locale: 'de-DE' },
	// Run against a production preview build rather than `vite dev`.
	// `vite@8.2.2` + `@sveltejs/kit@2.70.3` (both released within days of
	// each other) have a dev-mode-only bug where SvelteKit's client router
	// never intercepts link clicks and always falls back to a full browser
	// navigation, even with zero project plugins/config — reproduced with a
	// bare `sveltekit()`-only vite.config.ts and an unrelated route with no
	// connection to locale routing. Client-side navigation works correctly
	// in a production build (`vite preview`), which is what the "updates
	// rendered messages on client-side navigation" test below depends on.
	webServer: {
		command: 'pnpm build && pnpm preview --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000
	}
});
