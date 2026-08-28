import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/integration/**/*.test.ts'],
		globalSetup: ['./tests/setup/pg.ts'],
		testTimeout: 30_000,
		hookTimeout: 120_000,
		pool: 'forks',
		singleFork: true
	}
});
