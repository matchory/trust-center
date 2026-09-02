import { and, desc, eq, gte, lt, lte } from 'drizzle-orm';
import { auditEvent } from '../db/schema';
import type { Db } from '../db';
import { activeTraceId } from '../telemetry';

/**
 * `id` is typed per actor type so the two identifier spaces this system has
 * for a human staff member can never be confused at a call site: an
 * *identified* staff actor's `id` is always a `staff_user.id` (UUID) — never
 * a raw OIDC `sub`. A login attempt that never resolved to a staff_user row
 * (e.g. a denied login) is `staff-unresolved` with a null id; the OIDC
 * subject belongs in `meta`, not in an identifier column shared with real
 * staff_user ids.
 */
export type AuditActor =
	| { type: 'staff'; id: string }
	| { type: 'staff-unresolved'; id: null }
	| { type: 'requester'; id: string | null }
	// A person confirming a subscription is not staff and not a requester, and
	// `system` would make "who consented" unanswerable in precisely the case
	// where consent is the fact being evidenced (spec §10.1, P4.11). The id is
	// always a `subscription.id`; the address never appears in any audit column.
	| { type: 'subscriber'; id: string }
	| { type: 'system'; id: null };

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
		// The correlation column has existed since Phase 0 with no writer. The
		// trace id gives it one, so "who downloaded this" and "why was that
		// request slow" become the same query. An explicit value still wins, and
		// with tracing off this stays null rather than becoming a constant.
		requestId: input.requestId ?? activeTraceId() ?? null,
		meta: input.meta ?? null
	});
}

export interface AuditFilter {
	action?: string;
	actorType?: string;
	actorId?: string;
	subjectType?: string;
	subjectId?: string;
	from?: Date;
	to?: Date;
	/** Keyset cursor: return events with `seq` strictly below this. */
	beforeSeq?: bigint;
	limit?: number;
}

/** Above this a page stops being a table and starts being an export. */
const MAX_LIMIT = 500;

export async function queryEvents(db: Db, filter: AuditFilter): Promise<AuditEventRow[]> {
	const conditions = [];
	if (filter.action) conditions.push(eq(auditEvent.action, filter.action));
	if (filter.actorType) conditions.push(eq(auditEvent.actorType, filter.actorType));
	if (filter.actorId) conditions.push(eq(auditEvent.actorId, filter.actorId));
	if (filter.subjectType) conditions.push(eq(auditEvent.subjectType, filter.subjectType));
	if (filter.subjectId) conditions.push(eq(auditEvent.subjectId, filter.subjectId));
	if (filter.from) conditions.push(gte(auditEvent.at, filter.from));
	if (filter.to) conditions.push(lte(auditEvent.at, filter.to));
	// Keyset rather than OFFSET: the log only grows, and OFFSET over a growing
	// table both slows down and skips rows as new events arrive mid-paging.
	if (filter.beforeSeq !== undefined) conditions.push(lt(auditEvent.seq, filter.beforeSeq));

	return db
		.select()
		.from(auditEvent)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(auditEvent.seq))
		.limit(Math.min(filter.limit ?? 100, MAX_LIMIT));
}
