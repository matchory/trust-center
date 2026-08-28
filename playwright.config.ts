import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 30_000,
	// Pin the browser's locale so Accept-Language (which resolveLocale()
	// honours at the unprefixed root) is deterministic across machines/CI,
	// rather than depending on the host's LANG/OS locale.
	use: { baseURL: 'http://localhost:4173', locale: 'de-DE' },
	// Run against a production preview build rather than `vite dev`, for
	// parity with what actually ships. A previous version of this comment
	// claimed `vite@8.2.2` + `@sveltejs/kit@2.70.3` have a dev-mode-only bug
	// where the client router never intercepts link clicks — that was never
	// confirmed. Checked directly (`pnpm dev`, a real click on a `/en` link
	// injected at the `/` root, 3 runs): the navigation stayed client-side —
	// no HTTP request was made for `/en`, a marker set on `window` before
	// the click survived it, and `<html lang>` updated correctly — with
	// these exact pinned versions on this machine. No dev-mode defect
	// reproduced. Kept on `preview` anyway: testing against the built
	// artifact is the better default regardless, which is what the "updates
	// rendered messages on client-side navigation" test below depends on.
	webServer: {
		command: 'pnpm build && pnpm preview --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		// Overrides `.env`'s BASE_URL (which targets `pnpm dev`'s port 5173) so
		// redirectUri() in src/lib/server/auth/oidc.ts matches the port this
		// preview server actually listens on. The dev-IdP's client registration
		// (docker-compose.dev.yml) accepts both origins.
		env: { BASE_URL: 'http://localhost:4173' }
	}
});
