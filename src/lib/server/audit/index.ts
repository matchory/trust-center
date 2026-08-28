import { and, desc, eq } from 'drizzle-orm';
import { auditEvent } from '../db/schema';
import type { Db } from '../db';

export type AuditActor = {
	type: 'staff' | 'requester' | 'system';
	id: string | null;
};

export interface AuditEventInput {
	action: string;
	actor: AuditActor;
	subjectType?: string;
	subjectId?: string;
	ip?: string;
	ua?: string;
	requestId?: string;
	meta?: Record<string, unknown>;
}

export type AuditEventRow = typeof auditEvent.$inferSelect;

/**
 * Appends an event to the audit log. There is deliberately no update or
 * delete counterpart: the log is append-only.
 */
export async function recordEvent(db: Db, input: AuditEventInput): Promise<void> {
	await db.insert(auditEvent).values({
		action: input.action,
		actorType: input.actor.type,
		actorId: input.actor.id,
		subjectType: input.subjectType ?? null,
		subjectId: input.subjectId ?? null,
		ip: input.ip ?? null,
		ua: input.ua ?? null,
		requestId: input.requestId ?? null,
		meta: input.meta ?? null
	});
}

export async function queryEvents(
	db: Db,
	filter: {
		subjectType?: string;
		subjectId?: string;
		actorId?: string;
		limit?: number;
	}
): Promise<AuditEventRow[]> {
	const conditions = [];
	if (filter.subjectType) conditions.push(eq(auditEvent.subjectType, filter.subjectType));
	if (filter.subjectId) conditions.push(eq(auditEvent.subjectId, filter.subjectId));
	if (filter.actorId) conditions.push(eq(auditEvent.actorId, filter.actorId));

	return db
		.select()
		.from(auditEvent)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(auditEvent.at), desc(auditEvent.id))
		.limit(filter.limit ?? 100);
}
