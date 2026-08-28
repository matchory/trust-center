import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/integration/**/*.test.ts'],
		globalSetup: ['./tests/setup/pg.ts'],
		testTimeout: 30_000,
		hookTimeout: 120_000,
		pool: 'forks',
		// Serialize test files: they share one Testcontainers Postgres. On Vitest 4 this
		// is `fileParallelism`, NOT `poolOptions.forks.singleFork` — that option is read
		// only to emit a deprecation warning and does not configure the pool.
		fileParallelism: false
	}
});
