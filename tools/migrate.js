#!/usr/bin/env node
// Standalone migration entry point for operators running RUN_MIGRATIONS=false.
// Deliberately does not import the application: it needs DATABASE_URL and the
// drizzle folder and nothing else, so it works in a distroless image that has
// no shell to exec into.
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;

if (!url) {
	console.error('DATABASE_URL is not set.');
	process.exit(1);
}

const client = postgres(url, { max: 1 });

try {
	await migrate(drizzle(client), { migrationsFolder: './drizzle' });
	console.log('migrations applied');
} finally {
	await client.end();
}
