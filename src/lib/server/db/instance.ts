import { getConfig } from '../config';
import { createDb, type Db } from './index';

let cached: Db | undefined;

/**
 * Instantiated lazily so importing this module never opens a database
 * connection (or requires a configured environment) at import time —
 * `vite build` must not need runtime secrets or a reachable database.
 */
export function getDb(): Db {
	return (cached ??= createDb(getConfig().databaseUrl).db);
}
