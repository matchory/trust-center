import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error(
		'DATABASE_URL is not set. drizzle-kit reads no .env file itself — run via ' +
			'`pnpm db:migrate` or `pnpm db:generate` (both load .env), or export ' +
			'DATABASE_URL yourself.'
	);
}

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema/index.ts',
	out: './drizzle',
	dbCredentials: {
		url: databaseUrl
	}
});
