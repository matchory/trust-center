import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// `src/hooks.server.ts` imports through `$lib/...`. SvelteKit resolves
		// that alias via its Vite plugin, which plain Vitest never loads, so it
		// is declared here too for tests that import server modules directly.
		alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) }
	},
	test: {
		environment: 'node',
		include: ['tests/unit/**/*.test.ts']
	}
});
