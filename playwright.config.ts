import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 30_000,
	// Pin the browser's locale so Accept-Language (which resolveLocale()
	// honours at the unprefixed root) is deterministic across machines/CI,
	// rather than depending on the host's LANG/OS locale.
	use: { baseURL: 'http://localhost:4173', locale: 'de-DE' },
	// Run against a production preview build rather than `vite dev`, for parity
	// with what actually ships.
	webServer: {
		// CI has already run `pnpm build`; rebuilding here doubles the slowest
		// step of the workflow for nothing.
		command: process.env.CI
			? 'pnpm preview --port 4173 --strictPort'
			: 'pnpm build && pnpm preview --port 4173 --strictPort',
		url: 'http://localhost:4173',
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		// Overrides `.env`'s BASE_URL (which targets `pnpm dev`'s port 5173) so
		// redirectUri() in src/lib/server/auth/oidc.ts matches the port this
		// preview server actually listens on. The dev-IdP's client registration
		// (compose.dev.yaml) accepts both origins.
		env: { BASE_URL: 'http://localhost:4173' }
	}
});
