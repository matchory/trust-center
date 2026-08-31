import { lt, sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { getDb } from '../db/instance';
import { sendExpiryReminders } from '../access/expiry';
import { accessRequest, requesterSession, staffSession } from '../db/schema';
import { getMailer, MailNotConfigured } from '../mail';
import { drainOutbox } from '../mail/queue';
import { redactDeliveredMail, sweepRateLimits } from '../retention';
import { getStorage } from '../storage';
import { runJob } from './runner';
import type { Db } from '../db';

export { runJob };

/** Expired sessions are dead weight on every validation and a retention risk. */
export async function cleanupExpiredSessions(db: Db): Promise<void> {
	const now = new Date();
	await db.delete(staffSession).where(lt(staffSession.expiresAt, now));
	await db.delete(requesterSession).where(lt(requesterSession.expiresAt, now));
}

/**
 * An unverified request holds an email address nobody has proven they control.
 * Once its magic link can no longer be used it has no purpose, so it does not
 * linger. The window is a multiple of the link TTL so a slow mail relay cannot
 * delete a request out from under a prospect who is about to click.
 */
export async function sweepUnverifiedRequests(db: Db, linkTtlMinutes: number): Promise<void> {
	await db.delete(accessRequest).where(
		sql`${accessRequest.status} = 'unverified'
			    AND ${accessRequest.createdAt} < now() - make_interval(mins => ${linkTtlMinutes * 4})`
	);
}

/** Drains the outbound queue, resolving the mailer and from-address here. */
export async function drainMailQueue(db: Db): Promise<void> {
	const { mail } = getConfig();

	try {
		await drainOutbox(db, {
			limit: 25,
			mailer: getMailer(),
			from: mail.from,
			storage: getStorage()
		});
	} catch (cause) {
		// A deployment with no SMTP_URL is a valid configuration — `pnpm build`
		// and the unit suite both run that way. Queueing without draining is the
		// documented behaviour, not an error to log every fifteen seconds.
		if (cause instanceof MailNotConfigured) return;
		throw cause;
	}
}

interface Job {
	name: string;
	everyMs: number;
	run: (db: Db) => Promise<void>;
}

export const JOBS: readonly Job[] = [
	// Short, because a magic link arriving a minute late is a person waiting.
	{ name: 'mail:drain', everyMs: 15_000, run: drainMailQueue },
	{ name: 'sessions:cleanup', everyMs: 60 * 60 * 1000, run: cleanupExpiredSessions },
	{
		name: 'requests:sweep',
		everyMs: 15 * 60 * 1000,
		run: (db) => sweepUnverifiedRequests(db, getConfig().magicLinkTtlMinutes)
	},
	// Six hours: the window is measured in days, and a reminder is stamped once
	// per grant, so a tick that finds nothing costs one indexed query.
	{
		name: 'grants:remind',
		everyMs: 6 * 60 * 60 * 1000,
		run: async (db) => {
			await sendExpiryReminders(db, { reminderDays: getConfig().accessGrantReminderDays });
		}
	},
	{
		name: 'retention:sweep',
		everyMs: 6 * 60 * 60 * 1000,
		run: async (db) => {
			// A day, not an hour: no limiter here uses a window longer than an
			// hour, and deleting a counter can only forgive, never deny.
			await sweepRateLimits(db, { olderThanHours: 24 });
			await redactDeliveredMail(db, { retentionDays: getConfig().mailRetentionDays });
		}
	}
];

const timers: NodeJS.Timeout[] = [];

/**
 * One `setInterval` per job, each tick guarded by the advisory lock so more
 * than one replica is safe. `unref()` keeps these timers from holding the
 * process open, which otherwise makes a container refuse to stop.
 */
export function startJobRunner(): void {
	if (timers.length > 0) return;

	for (const job of JOBS) {
		const timer = setInterval(() => {
			void runJob(getDb(), job.name, () => job.run(getDb())).catch((cause) => {
				console.error(
					JSON.stringify({
						level: 'error',
						job: job.name,
						message: cause instanceof Error ? cause.message : String(cause)
					})
				);
			});
		}, job.everyMs);

		timer.unref();
		timers.push(timer);
	}
}

export function stopJobRunner(): void {
	for (const timer of timers) clearInterval(timer);
	timers.length = 0;
}
