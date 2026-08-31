import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { recordEvent } from './audit';
import { ndaAcceptance, outboundEmail, requester } from './db/schema';
import { revokeAllRequesterSessions } from './identity/requester';
import type { Db } from './db';
import type { StorageAdapter } from './storage';

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
 * `nda_acceptance` is the one exception, and it is confined to that table: its
 * identity columns stay. Art. 6(1)(b)/(f) with the 17(3)(e) exemption — either
 * the record identifies the counterparty or it should not be retained at all,
 * and pseudonymising them leaves a record saying somebody once typed a name,
 * which is the same as not keeping it. The *rendering* is a different question
 * and goes: it names the person in full, in richer form than any column, and
 * the columns already hold everything the exemption needs.
 *
 * `storage` is an argument rather than a `getStorage()` call, as everywhere
 * else below the route layer.
 *
 * Irreversible by construction: nothing here keeps a copy of what it cleared.
 */
export async function purgeRequester(
	db: Db,
	input: {
		requesterId: string;
		staffUserId: string;
		ip: string | null;
		storage: StorageAdapter;
	}
): Promise<{ eventsPseudonymized: number }> {
	const orphaned = await db.transaction(async (tx) => {
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

			// The payload too, not only the address. `redactDeliveredMail` clears
			// it after mailRetentionDays — an unrelated window a purge must not
			// wait on — and this phase puts the highest-value payload in the
			// system behind it: the key of a signed record.
			await tx.update(outboundEmail).set({ payload: {} }).where(eq(outboundEmail.to, row.email));

			// Every row, not just the pending ones: a delivered notification names
			// the address as plainly as an undelivered one. The rows themselves
			// stay — that a notification went out is a fact about the system, not
			// about the person. `to` is NOT NULL, so it is blanked, not nulled.
			// Last, because both updates above match on it.
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

		// Read and nulled inside the transaction; the objects themselves are
		// deleted after it commits. A delete that cannot be rolled back must not
		// happen before the row that stops naming it.
		const records = await tx
			.select({ key: ndaAcceptance.recordPdfKey })
			.from(ndaAcceptance)
			.where(
				and(eq(ndaAcceptance.requesterId, input.requesterId), isNotNull(ndaAcceptance.recordPdfKey))
			);

		await tx
			.update(ndaAcceptance)
			.set({ recordPdfKey: null })
			.where(eq(ndaAcceptance.requesterId, input.requesterId));

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

		return {
			eventsPseudonymized: pseudonymized.length,
			keys: records.flatMap((record) => (record.key ? [record.key] : []))
		};
	});

	for (const key of orphaned.keys) {
		await input.storage.delete(key);
	}

	return { eventsPseudonymized: orphaned.eventsPseudonymized };
}
