import { and, eq, sql } from 'drizzle-orm';
import { recordEvent } from './audit';
import { outboundEmail, requester } from './db/schema';
import { revokeAllRequesterSessions } from './identity/requester';
import type { Db } from './db';

/**
 * The one operation spec §10 permits against audit_event other than INSERT: a
 * column-scoped UPDATE setting ip, ua, and actor_id to NULL. It only ever moves
 * data toward less identifiability, it deletes nothing, and it writes its own
 * audit event.
 *
 * The domain rows go further — a requester's identifying columns are blanked
 * outright — but the row itself stays, so grants and requests keep their
 * foreign keys and the record of *what happened* survives the record of *who*.
 *
 * Irreversible by construction: nothing here keeps a copy of what it cleared.
 */
export async function purgeRequester(
	db: Db,
	input: { requesterId: string; staffUserId: string; ip: string | null }
): Promise<{ eventsPseudonymized: number }> {
	return db.transaction(async (tx) => {
		// Exactly the three columns spec §10 names. Written as an explicit SET of
		// three NULLs rather than a dynamic column list, so widening it is a
		// visible code change and not a configuration accident.
		const pseudonymized = await tx.execute<{ id: string }>(sql`
			UPDATE audit_event
			SET actor_id = NULL, ip = NULL, ua = NULL
			WHERE actor_type = 'requester' AND actor_id = ${input.requesterId}
			RETURNING id
		`);

		await revokeAllRequesterSessions(tx, input.requesterId);

		const [row] = await tx
			.select({ email: requester.email })
			.from(requester)
			.where(eq(requester.id, input.requesterId))
			.limit(1);

		// Read before the address is blanked below, and the two mail updates run
		// in this order for the same reason: both match on `to`.
		if (row) {
			// Only a pending row can still be delivered, and a purge that leaves
			// one queued would mail a person who asked to be forgotten.
			await tx
				.update(outboundEmail)
				.set({ status: 'failed', lastError: 'requester purged' })
				.where(and(eq(outboundEmail.to, row.email), eq(outboundEmail.status, 'pending')));

			// Every row, not just the pending ones: a delivered notification names
			// the address as plainly as an undelivered one. The rows themselves
			// stay — that a notification went out is a fact about the system, not
			// about the person. `to` is NOT NULL, so it is blanked, not nulled.
			await tx.update(outboundEmail).set({ to: '' }).where(eq(outboundEmail.to, row.email));
		}

		await tx
			.update(requester)
			.set({
				// Not NULL: the column is unique and NOT NULL, and two purged
				// requesters must not collide. The id is already non-identifying.
				email: `purged-${input.requesterId}@invalid`,
				name: '',
				company: '',
				companyDomain: '',
				notes: null,
				purgedAt: new Date()
			})
			.where(eq(requester.id, input.requesterId));

		await recordEvent(tx, {
			action: 'requester.purged',
			// Staff are outside the requester purge and may be identified.
			actor: { type: 'staff', id: input.staffUserId },
			// A pseudonymous identifier rather than personal data: spec §10 keeps
			// requester personal data out of `subject_id`, and a UUID that no
			// longer resolves to a person is not that. The event must name what
			// was purged or it is not an audit trail.
			subjectType: 'requester',
			subjectId: input.requesterId,
			ip: input.ip ?? undefined,
			meta: { eventsPseudonymized: pseudonymized.length }
		});

		return { eventsPseudonymized: pseudonymized.length };
	});
}
