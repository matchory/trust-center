import postgres from 'postgres';

/**
 * Drops the database `provisionE2eDatabase` created. A separate file from the
 * provisioning side because Playwright imports `globalTeardown` on its own and
 * must not re-run provisioning as a side effect of that import.
 */
export default async function globalTeardown(): Promise<void> {
	const name = process.env.E2E_DATABASE_NAME;
	// Not DATABASE_URL: provisioning repoints that at the disposable database,
	// and a connection to the database being dropped cannot drop it.
	const adminUrl = process.env.E2E_ADMIN_DATABASE_URL;
	if (!name || !adminUrl) return;

	const admin = postgres(adminUrl, { max: 1 });

	try {
		// The app under test holds a pool open until its process exits, and
		// Playwright may not have reaped it yet. WITH (FORCE) terminates those
		// backends rather than failing with "database is being accessed by other
		// users" and leaking a database per run.
		await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
	} finally {
		await admin.end();
	}
}
