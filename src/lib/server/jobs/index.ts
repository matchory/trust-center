import { lt, sql } from 'drizzle-orm';
import { getConfig } from '../config';
import { getDb } from '../db/instance';
import {
	closeUnacceptedGrants,
	sendAcceptanceReminders,
	sendExpiryReminders
} from '../access/expiry';
import { runAuditSinkBatch, runAuditSinkShip } from '../auditsink';
import { accessRequest, requesterSession, staffSession } from '../db/schema';
import { runEgressClaim, runEgressDeliveries } from '../egress';
import { getMailer, MailNotConfigured } from '../mail';
import { drainOutbox } from '../mail/queue';
import { redactDeliveredMail, sweepEventDeliveries, sweepRateLimits } from '../retention';
import { getStorage } from '../storage';
import { sweepUnconfirmedSubscriptions } from '../subscriptions';
import { notifySubscribers } from '../subscriptions/notify';
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
	/** Runs under the advisory lock. */
	run: (db: Db) => Promise<void>;
	/**
	 * Runs after the lock's transaction has committed, on a pooled connection.
	 * For work that talks to the network.
	 *
	 * `runJob` wraps `run` in `db.transaction`, so without this phase the lock
	 * connection sits `idle in transaction` for the whole tick — up to 250
	 * seconds for a 25-row egress batch on a 10 s timeout. That pins the xmin
	 * horizon so autovacuum reclaims nothing on `ratelimit` and
	 * `outbound_email`, is killed outright by
	 * `idle_in_transaction_session_timeout`, and holds two of the pool's ten
	 * connections behind which request-path queries queue. `mail:drain` gets
	 * away with the single-phase shape because it talks to one configured relay
	 * on a short timeout; egress talks to arbitrary operator-supplied hosts
	 * (spec §5.1).
	 *
	 * Only runs when `run` actually held the lock: if another replica had it,
	 * this replica claimed nothing and has nothing to deliver.
	 *
	 * The consequence is worth stating rather than discovering later:
	 * `trustcenter.job.tick.duration` covers phase one only. The `event deliver`
	 * spans and `trustcenter.egress.delivery.duration` cover phase two, which is
	 * where the time goes.
	 */
	afterLock?: (db: Db) => Promise<void>;
}

export const JOBS: readonly Job[] = [
	// Short, because a magic link arriving a minute late is a person waiting.
	{ name: 'mail:drain', everyMs: 15_000, run: drainMailQueue },
	// Fifteen seconds, matching mail:drain and on the same reasoning: a magic
	// link a minute late is a person waiting, and a Teams notice fifteen
	// minutes late is a defect (spec §5.1).
	{
		name: 'egress:deliver',
		everyMs: 15_000,
		run: runEgressClaim,
		afterLock: runEgressDeliveries
	},
	// Sixty seconds rather than mail's and egress's fifteen: the latency budget
	// for the audit sink is minutes to hours, and a batch is worth more than a
	// prompt one (audit sink spec §3.1). The shipping phase is `afterLock` for
	// the reason egress's is — it talks to operator-supplied storage, and the
	// lock's transaction must not be held across the network.
	{
		name: 'auditsink:batch',
		everyMs: 60_000,
		run: runAuditSinkBatch,
		afterLock: runAuditSinkShip
	},
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
			const config = getConfig();
			await sendExpiryReminders(db, {
				reminderDays: config.accessGrantReminderDays,
				locales: config.locales
			});
			// Two queries in one tick rather than one widened predicate: the expiry
			// reminder filters `expires_at > now()`, which excludes exactly the
			// inert grants this one is for.
			await sendAcceptanceReminders(db, { reminderDays: config.accessGrantReminderDays });
			await closeUnacceptedGrants(db);
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
			// A row whose confirmation token has expired can never become
			// confirmed, so it holds an address nobody proved they control.
			// Folded in here rather than becoming a seventh timer (spec §8).
			await sweepUnconfirmedSubscriptions(db);
			// Terminal deliveries older than 30 days, folded in for the reason the
			// subscription sweep was: the interval is right and a tick that finds
			// nothing costs one indexed query (event egress spec §5.6).
			await sweepEventDeliveries(db, { retentionDays: 30 });
		}
	},
	{
		// Fifteen minutes rather than an hour or a day (P4.14): a lone post
		// reaches subscribers promptly enough that nobody asks for an immediate
		// mode, while a burst published together still coalesces into one mail by
		// itself. The interval IS the digest window, in one operator-visible
		// place rather than as a per-subscriber preference.
		name: 'subscriptions:notify',
		everyMs: 15 * 60 * 1000,
		run: async (db) => {
			const config = getConfig();
			await notifySubscribers(db, {
				baseUrl: config.baseUrl,
				enabledLocales: config.locales,
				defaultLocale: config.defaultLocale
			});
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
			void runJob(getDb(), job.name, () => job.run(getDb()))
				.then((result) => (result.ran && job.afterLock ? job.afterLock(getDb()) : undefined))
				.catch((cause) => {
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
