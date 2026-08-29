import { randomBytes } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createDb } from '../../src/lib/server/db';

/**
 * Gives the end-to-end suite its own database, so fixtures cannot accumulate
 * across runs. Phase 1 had three assertions rewritten because matching on a
 * fixture's display text broke on the second run against the shared dev
 * database; this removes the cause rather than the symptom.
 *
 * Deliberately NOT Testcontainers, unlike the integration suite. Playwright
 * interpolates `webServer.env` while the config module is evaluated, which is
 * strictly before `globalSetup` runs — so a URL minted in `globalSetup` can
 * never reach the server under test. Creating a database inside the dev
 * Postgres that e2e already depends on (the dev IdP shares its compose stack)
 * lets the config await it at load time, which makes the ordering moot.
 */
export async function provisionE2eDatabase(): Promise<string> {
	// Playwright may evaluate the config more than once in a run. Minting a
	// second database would leave the first orphaned and running.
	const existing = process.env.E2E_DATABASE_URL;
	if (existing) return existing;

	const adminUrl = process.env.DATABASE_URL;
	if (!adminUrl) {
		throw new Error(
			'DATABASE_URL is not set. The e2e suite creates its own database inside the ' +
				'dev Postgres — run via `pnpm test:e2e`, which loads .env.'
		);
	}

	const name = `trustcenter_e2e_${randomBytes(6).toString('hex')}`;
	const admin = postgres(adminUrl, { max: 1 });

	try {
		// CREATE DATABASE cannot run inside a transaction, hence `unsafe`. The
		// name is generated here and never derived from input.
		await admin.unsafe(`CREATE DATABASE "${name}"`);
	} finally {
		await admin.end();
	}

	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	const databaseUrl = url.toString();

	const { db, close } = createDb(databaseUrl);
	try {
		await migrate(db, { migrationsFolder: './drizzle' });
	} finally {
		await close();
	}

	process.env.E2E_DATABASE_URL = databaseUrl;
	process.env.E2E_DATABASE_NAME = name;
	// The admin connection is kept under its own name because DATABASE_URL is
	// about to stop pointing at a database we are allowed to drop.
	process.env.E2E_ADMIN_DATABASE_URL = adminUrl;

	// Redirected for the whole run, not just for the server under test. Specs
	// that open their own connection — auth.spec.ts reads audit_event, and
	// security.spec.ts seeds document fixtures — resolve it through this
	// variable, and would otherwise assert against the dev database while the
	// app wrote to the disposable one. Workers are forked after the config is
	// evaluated, so they inherit this.
	process.env.DATABASE_URL = databaseUrl;

	return databaseUrl;
}
