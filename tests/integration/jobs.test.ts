import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import {
	accessRequest,
	requesterSession,
	staffSession,
	staffUser
} from '../../src/lib/server/db/schema';
import { cleanupExpiredSessions, runJob } from '../../src/lib/server/jobs';
import { createRequesterSession, upsertRequester } from '../../src/lib/server/identity/requester';
import { recordingSpans } from '../helpers/telemetry';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;
let staffUserId: string;

const spans = recordingSpans();

beforeAll(async () => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));

	const [row] = await db
		.insert(staffUser)
		.values({
			oidcSub: `sub-${randomUUID()}`,
			email: `staff-${randomUUID()}@example.test`,
			name: 'Jobs Fixture',
			role: 'admin'
		})
		.returning({ id: staffUser.id });

	staffUserId = row!.id;
});

afterAll(async () => {
	await close();
});

describe('runJob', () => {
	it('runs the job and reports that it ran', async () => {
		let ran = 0;
		const result = await runJob(db, `test-${randomUUID()}`, async () => {
			ran++;
		});

		expect(ran).toBe(1);
		expect(result.ran).toBe(true);
	});

	it('lets only one of two concurrent runs of the same job proceed', async () => {
		// The advisory lock is what stops two replicas both sending the same
		// expiry reminder.
		const name = `test-${randomUUID()}`;
		let running = 0;
		let maxConcurrent = 0;

		const job = async () => {
			running++;
			maxConcurrent = Math.max(maxConcurrent, running);
			await new Promise((resolve) => setTimeout(resolve, 150));
			running--;
		};

		const results = await Promise.all([runJob(db, name, job), runJob(db, name, job)]);

		expect(maxConcurrent).toBe(1);
		expect(results.filter((r) => r.ran)).toHaveLength(1);
	});

	it('lets two different jobs run at the same time', async () => {
		// The lock is per job name, not global — a slow sweep must not block mail.
		const results = await Promise.all([
			runJob(db, `test-a-${randomUUID()}`, async () => {}),
			runJob(db, `test-b-${randomUUID()}`, async () => {})
		]);

		expect(results.every((r) => r.ran)).toBe(true);
	});

	it('releases the lock when the job throws', async () => {
		const name = `test-${randomUUID()}`;

		await expect(
			runJob(db, name, async () => {
				throw new Error('job failed');
			})
		).rejects.toThrow('job failed');

		// A lock leaked on failure would wedge this job forever.
		expect((await runJob(db, name, async () => {})).ran).toBe(true);
	});
});

describe('cleanupExpiredSessions', () => {
	it('deletes expired sessions of both kinds and keeps live ones', async () => {
		const expiredHash = randomUUID();
		const liveHash = randomUUID();

		await db.insert(staffSession).values([
			{ tokenHash: expiredHash, staffUserId, expiresAt: new Date(Date.now() - 60_000) },
			{ tokenHash: liveHash, staffUserId, expiresAt: new Date(Date.now() + 600_000) }
		]);

		const person = await upsertRequester(db, {
			email: `person-${randomUUID()}@acme.example`,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		await createRequesterSession(db, { requesterId: person.id, ttlHours: -1 });

		await cleanupExpiredSessions(db);

		expect(
			await db.select().from(staffSession).where(eq(staffSession.tokenHash, expiredHash))
		).toHaveLength(0);
		expect(
			await db.select().from(staffSession).where(eq(staffSession.tokenHash, liveHash))
		).toHaveLength(1);
		expect(
			await db.select().from(requesterSession).where(eq(requesterSession.requesterId, person.id))
		).toHaveLength(0);
	});
});

describe('sweepUnverifiedRequests', () => {
	it('deletes stale unverified requests and keeps fresh and verified ones', async () => {
		const { sweepUnverifiedRequests } = await import('../../src/lib/server/jobs');

		const [stale] = await db
			.insert(accessRequest)
			.values({
				status: 'unverified',
				submittedEmail: `a-${randomUUID()}@acme.example`,
				submittedName: 'A',
				submittedCompany: 'Acme',
				createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
			})
			.returning({ id: accessRequest.id });

		const [fresh] = await db
			.insert(accessRequest)
			.values({
				status: 'unverified',
				submittedEmail: `b-${randomUUID()}@acme.example`,
				submittedName: 'B',
				submittedCompany: 'Acme'
			})
			.returning({ id: accessRequest.id });

		const person = await upsertRequester(db, {
			email: `person-${randomUUID()}@acme.example`,
			name: 'A',
			company: 'Acme',
			locale: 'de'
		});
		const [verified] = await db
			.insert(accessRequest)
			.values({
				status: 'pending',
				requesterId: person.id,
				createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000)
			})
			.returning({ id: accessRequest.id });

		await sweepUnverifiedRequests(db, 30);

		expect(
			await db.select().from(accessRequest).where(eq(accessRequest.id, stale!.id))
		).toHaveLength(0);
		expect(
			await db.select().from(accessRequest).where(eq(accessRequest.id, fresh!.id))
		).toHaveLength(1);
		// An old *verified* request is a record of a decision, not junk.
		expect(
			await db.select().from(accessRequest).where(eq(accessRequest.id, verified!.id))
		).toHaveLength(1);
	});
});

describe('runJob telemetry', () => {
	it('emits one span per tick, naming the job and whether it held the lock', async () => {
		await runJob(db, 'telemetry-span-probe', async () => {});

		const finished = spans();
		expect(finished).toHaveLength(1);
		expect(finished[0]?.name).toBe('job telemetry-span-probe');
		expect(finished[0]?.attributes['job.name']).toBe('telemetry-span-probe');
		expect(finished[0]?.attributes['job.lock_acquired']).toBe(true);
	});

	// A job that throws must still end its span, or the active context leaks
	// into the next tick and the failure surfaces somewhere unrelated.
	it('ends the span and marks it an error when the job throws', async () => {
		await expect(
			runJob(db, 'telemetry-error-probe', async () => {
				throw new Error('tick failed');
			})
		).rejects.toThrow('tick failed');

		const finished = spans();
		expect(finished).toHaveLength(1);
		expect(finished[0]?.status.code).toBe(2);
	});
});
