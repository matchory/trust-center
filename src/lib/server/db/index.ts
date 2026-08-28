import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url: string): { db: Db; close: () => Promise<void> } {
	const sql = postgres(url, { max: 10 });
	return { db: drizzle(sql, { schema }), close: () => sql.end() };
}

export { schema };
