import { sql } from 'drizzle-orm';
import { outboundEmail } from '../db/schema';
import { renderTemplate } from './templates';
import type { MailPayload, MailTemplate } from './templates';
import type { MailAdapter } from './index';
import type { Db } from '../db';

/** Five attempts over roughly a quarter of an hour, then a permanent failure. */
const MAX_ATTEMPTS = 5;

export async function enqueueEmail(
	db: Db,
	input: { to: string; template: MailTemplate; locale: string; payload: MailPayload }
): Promise<void> {
	await db.insert(outboundEmail).values({
		to: input.to,
		template: input.template,
		locale: input.locale,
		payload: input.payload
	});
}

interface ClaimedRow {
	id: string;
	to: string;
	template: MailTemplate;
	locale: string;
	payload: MailPayload;
	attempts: number;
}

/**
 * Claims due rows with FOR UPDATE SKIP LOCKED inside one transaction, so a
 * second drain — in this process or another replica — walks past them rather
 * than sending the same mail twice. The claim pushes each row's next attempt
 * ahead, so a crash mid-send retries later rather than being retried by the
 * very next tick.
 *
 * `mailer` and `from` are passed in rather than resolved from config here: this
 * module would otherwise need a fully configured environment to drain a queue,
 * which is both untestable and more than it needs to know. The job that calls
 * it owns that lookup.
 */
export async function drainOutbox(
	db: Db,
	options: { limit: number; mailer: MailAdapter; from: string }
): Promise<{ sent: number; failed: number }> {
	const claimed = await db.transaction(async (tx) => {
		const rows = (await tx.execute(sql`
			SELECT id, "to", template, locale, payload, attempts
			FROM outbound_email
			WHERE status = 'pending' AND next_attempt_at <= now()
			ORDER BY next_attempt_at
			LIMIT ${options.limit}
			FOR UPDATE SKIP LOCKED
		`)) as unknown as ClaimedRow[];

		if (rows.length > 0) {
			await tx.execute(sql`
				UPDATE outbound_email
				SET next_attempt_at = now() + interval '5 minutes'
				WHERE id = ANY(${sql.raw(`ARRAY['${rows.map((r) => r.id).join("','")}']::uuid[]`)})
			`);
		}

		return rows;
	});

	if (claimed.length === 0) return { sent: 0, failed: 0 };

	const { mailer, from } = options;
	let sent = 0;
	let failed = 0;

	for (const row of claimed) {
		try {
			const rendered = renderTemplate(row.template, row.locale, row.payload);
			const { providerId } = await mailer.send({
				to: row.to,
				from,
				subject: rendered.subject,
				text: rendered.text
			});

			await db.execute(sql`
				UPDATE outbound_email
				SET status = 'sent', sent_at = now(), provider_id = ${providerId ?? null},
				    attempts = attempts + 1, last_error = NULL
				WHERE id = ${row.id}::uuid
			`);
			sent++;
		} catch (cause) {
			const attempts = Number(row.attempts) + 1;
			const giveUp = attempts >= MAX_ATTEMPTS;
			const message = cause instanceof Error ? cause.message : String(cause);

			// Exponential backoff: 1, 2, 4, 8 minutes.
			await db.execute(sql`
				UPDATE outbound_email
				SET status = ${giveUp ? 'failed' : 'pending'},
				    attempts = ${attempts},
				    last_error = ${message},
				    next_attempt_at = now() + make_interval(mins => ${2 ** (attempts - 1)})
				WHERE id = ${row.id}::uuid
			`);
			failed++;
		}
	}

	return { sent, failed };
}
