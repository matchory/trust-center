import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../../src/lib/server/db';

let container: StartedPostgreSqlContainer | undefined;

export async function setup() {
	container = await new PostgreSqlContainer('postgres:16-alpine').start();
	const url = container.getConnectionUri();
	process.env.TEST_DATABASE_URL = url;

	const { db, close } = createDb(url);
	await migrate(db, { migrationsFolder: './drizzle' });
	await close();
}

export async function teardown() {
	await container?.stop();
}
