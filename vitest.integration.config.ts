import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		// Same reason as vitest.config.ts: server modules import through `$lib`,
		// SvelteKit resolves that alias via its Vite plugin, and plain Vitest
		// never loads it. Needed here as soon as an integration test reaches a
		// module that transitively imports getConfig().
		alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) }
	},
	test: {
		environment: 'node',
		include: ['tests/integration/**/*.test.ts'],
		globalSetup: ['./tests/setup/pg.ts', './tests/setup/minio.ts'],
		testTimeout: 30_000,
		hookTimeout: 120_000,
		pool: 'forks',
		// Serialize test files: they share one Testcontainers Postgres. On Vitest 4 this
		// is `fileParallelism`, NOT `poolOptions.forks.singleFork` — that option is read
		// only to emit a deprecation warning and does not configure the pool.
		fileParallelism: false
	}
});
