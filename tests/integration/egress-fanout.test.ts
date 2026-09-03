import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { recordEvent } from '../../src/lib/server/audit';
import {
	auditEvent,
	eventDelivery,
	eventEndpoint,
	eventEndpointFilter
} from '../../src/lib/server/db/schema';
import { currentHorizon, fanOut } from '../../src/lib/server/egress/fanout';

let db: Db;
let close: () => Promise<void>;
let url: string;

beforeAll(() => {
	url = process.env.TEST_DATABASE_URL ?? '';
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));
});

afterAll(async () => {
	await close();
});

beforeEach(async () => {
	// Endpoints and deliveries only. audit_event is append-only and its rows are
	// harmless here — every endpoint starts at the current horizon anyway.
	await db.delete(eventEndpoint);
});

/** An endpoint whose cursor starts where a real one does: the live horizon. */
async function createEndpoint(patterns: string[], overrides: Record<string, unknown> = {}) {
	const horizon = await currentHorizon(db);
	const [row] = await db
		.insert(eventEndpoint)
		.values({
			name: 'n8n',
			url: 'https://hooks.example.test/a',
			format: 'generic',
			cursorXmin: horizon,
			cursorSeq: 0n,
			...overrides
		})
		.returning({ id: eventEndpoint.id });

	for (const pattern of patterns) {
		await db.insert(eventEndpointFilter).values({ endpointId: row!.id, pattern });
	}
	return row!.id;
}

async function deliveredSeqs(endpointId: string): Promise<string[]> {
	const rows = await db
		.select({ auditSeq: eventDelivery.auditSeq })
		.from(eventDelivery)
		.where(eq(eventDelivery.endpointId, endpointId))
		.orderBy(eventDelivery.auditSeq);
	return rows.map((row) => String(row.auditSeq));
}

async function seqOf(action: string, subjectId: string): Promise<string> {
	const [row] = await db
		.select({ seq: auditEvent.seq })
		.from(auditEvent)
		.where(eq(auditEvent.subjectId, subjectId))
		.limit(1);
	if (!row) throw new Error(`no ${action} event for ${subjectId}`);
	return String(row.seq);
}

describe('the visibility watermark', () => {
	/**
	 * GUARD 1 — the failure a naive `WHERE seq > cursor` scan has.
	 *
	 * `audit_event.seq` is a bigserial: `nextval()` is consumed at INSERT but a
	 * row becomes *visible* at COMMIT, and those two orders are not the same.
	 * recordEvent is routinely called inside a transaction that does other work
	 * first, so a concurrent autocommit insert can take a HIGHER seq and commit
	 * FIRST. A naive scan landing in that window sees the higher seq, misses
	 * the lower one, and moves the cursor past it — a silently dropped
	 * approval notification, indistinguishable from Teams having eaten it
	 * (spec §5.2).
	 *
	 * To watch this fail: replace the predicate in fanout.ts with a plain
	 * `seq > cursor_seq` scan advancing to `max(seq)`. This test must then fail
	 * on the second assertion.
	 */
	it('does not consume an event whose transaction is still open, and delivers it after the commit', async () => {
		const endpointId = await createEndpoint(['access_request.*']);
		const slowSubject = crypto.randomUUID();
		const fastSubject = crypto.randomUUID();

		const slow = createDb(url);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));

		// A transaction that takes a LOW seq and stays open.
		const held = slow.db.transaction(async (tx) => {
			await recordEvent(tx, {
				action: 'access_request.approved',
				actor: { type: 'system', id: null },
				subjectType: 'access_request',
				subjectId: slowSubject
			});
			await gate;
		});

		// Give the held transaction time to reach the gate, then take a HIGHER
		// seq and commit first.
		await new Promise((resolve) => setTimeout(resolve, 100));
		await recordEvent(db, {
			action: 'access_request.pending',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: fastSubject
		});

		const fastSeq = await seqOf('access_request.pending', fastSubject);

		// The tick that lands in the window consumes NOTHING: the committed row's
		// inserting transaction started after the still-open one, so it is above
		// the horizon.
		await db.transaction((tx) => fanOut(tx));
		expect(await deliveredSeqs(endpointId)).toEqual([]);

		release();
		await held;
		await slow.close();

		const slowSeq = await seqOf('access_request.approved', slowSubject);
		// The trace only means something if the seqs really are out of order.
		expect(BigInt(slowSeq)).toBeLessThan(BigInt(fastSeq));

		await db.transaction((tx) => fanOut(tx));
		expect(await deliveredSeqs(endpointId)).toEqual([slowSeq, fastSeq]);
	});

	/**
	 * GUARD 2 — the failure the *spec's own* xmin-horizon fix still has, and
	 * the reason the cursor is a keyset on `(xmin, seq)` rather than a `seq`
	 * high-watermark (plan C1).
	 *
	 * `xmin < horizon` excludes rows from still-running transactions. It does
	 * NOT exclude rows from transactions that started later, committed
	 * already, and are excluded by that same predicate — and those can hold a
	 * lower seq, because a transaction's xid is assigned at its first write
	 * while its seq is assigned when recordEvent runs last.
	 *
	 * To watch this fail: advance the cursor to `max(seq)` of the scanned
	 * window instead of to the last row's `(xmin, seq)`. This test must then
	 * fail on the final assertion, with `fastSeq` missing.
	 */
	it('delivers a committed event whose xid is above the horizon but whose seq is below a scanned row', async () => {
		const endpointId = await createEndpoint(['access_request.*']);
		const earlySubject = crypto.randomUUID();
		const fastSubject = crypto.randomUUID();

		// T_early: an xid assigned before T_slow's, committing after T_fast.
		const early = createDb(url);
		let releaseEarly: () => void = () => {};
		const earlyGate = new Promise<void>((resolve) => (releaseEarly = resolve));

		// T_slow: holds the horizon down for the whole tick and writes nothing.
		const slow = createDb(url);
		let releaseSlow: () => void = () => {};
		const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));

		const heldEarly = early.db.transaction(async (tx) => {
			// Forces xid assignment without writing an audit row, so this
			// transaction's xid is low while its seq will be high.
			await tx.execute(sql`SELECT txid_current()`);
			await earlyGate;
			await recordEvent(tx, {
				action: 'access_request.approved',
				actor: { type: 'system', id: null },
				subjectType: 'access_request',
				subjectId: earlySubject
			});
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		const heldSlow = slow.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT txid_current()`);
			await slowGate;
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		// T_fast: a later xid, a LOWER seq than T_early's will be, commits now.
		await recordEvent(db, {
			action: 'access_request.pending',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: fastSubject
		});

		// T_early now takes its (higher) seq and commits.
		releaseEarly();
		await heldEarly;
		await early.close();

		const fastSeq = await seqOf('access_request.pending', fastSubject);
		const earlySeq = await seqOf('access_request.approved', earlySubject);
		// The interleaving must really have happened, or this test proves nothing.
		expect(BigInt(fastSeq)).toBeLessThan(BigInt(earlySeq));

		// The tick: T_slow still holds the horizon, so T_early's row is scanned
		// (its xid is below the horizon) while T_fast's is not (its xid is above).
		await db.transaction((tx) => fanOut(tx));
		expect(await deliveredSeqs(endpointId)).toEqual([earlySeq]);

		releaseSlow();
		await heldSlow;
		await slow.close();

		// The one that matters: the lower seq is NOT stranded below the cursor.
		await db.transaction((tx) => fanOut(tx));
		expect(await deliveredSeqs(endpointId)).toEqual([fastSeq, earlySeq]);
	});
});

describe('fanOut', () => {
	it('inserts one delivery per matching event and respects the filter', async () => {
		const endpointId = await createEndpoint(['access_request.approved']);
		const wanted = crypto.randomUUID();

		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: wanted
		});
		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'system', id: null },
			subjectType: 'document_file',
			subjectId: crypto.randomUUID()
		});

		await db.transaction((tx) => fanOut(tx));

		expect(await deliveredSeqs(endpointId)).toEqual([
			await seqOf('access_request.approved', wanted)
		]);
	});

	it('advances the cursor past events it scanned but did not match', async () => {
		const endpointId = await createEndpoint(['access_request.approved']);

		await recordEvent(db, {
			action: 'document.downloaded',
			actor: { type: 'system', id: null },
			subjectType: 'document_file',
			subjectId: crypto.randomUUID()
		});
		await db.transaction((tx) => fanOut(tx));

		const [before] = await db
			.select({ xmin: eventEndpoint.cursorXmin, seq: eventEndpoint.cursorSeq })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));
		// Advancing only past matches would re-scan every unmatched event
		// forever (spec §5.2).
		expect(before?.seq).toBeGreaterThan(0n);
	});

	it('receives nothing when the endpoint has no filter rows', async () => {
		const endpointId = await createEndpoint([]);
		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});

		await db.transaction((tx) => fanOut(tx));

		// Silence is the safe reading of an empty set (spec §2.2).
		expect(await deliveredSeqs(endpointId)).toEqual([]);
	});

	it('starts a new endpoint at the current horizon so its first tick delivers no history', async () => {
		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});
		// The row above must be below the horizon before the endpoint is made,
		// which is what makes this a test of the cursor rather than of timing.
		await db.execute(sql`SELECT txid_current()`);

		const endpointId = await createEndpoint(['access_request.*']);
		await db.transaction((tx) => fanOut(tx));

		expect(await deliveredSeqs(endpointId)).toEqual([]);
	});

	it('neither fans out nor advances the cursor for a disabled endpoint', async () => {
		const endpointId = await createEndpoint(['access_request.*'], {
			enabled: false,
			disabledAt: new Date(),
			disabledReason: 'no success in 24 h'
		});
		const [before] = await db
			.select({ seq: eventEndpoint.cursorSeq })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));

		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});
		await db.transaction((tx) => fanOut(tx));

		const [after] = await db
			.select({ seq: eventEndpoint.cursorSeq })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));

		// The cursor stalls, so re-enabling is an explicit choice with the
		// backlog count in front of the operator (spec §5.5).
		expect(await deliveredSeqs(endpointId)).toEqual([]);
		expect(after?.seq).toBe(before?.seq);
	});

	it('is a no-op when replayed, so a crash between fan-out and the cursor update is safe', async () => {
		const endpointId = await createEndpoint(['access_request.*']);
		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});

		// Rewind the cursor to where the tick found it, exactly as a crash before
		// the commit would leave it. NOT to (1, 0): that is not a crash, it is a
		// full replay of the log, and this file's audit_event rows accumulate
		// across tests (the table is append-only), so it would measure history
		// rather than idempotency.
		const [start] = await db
			.select({ xmin: eventEndpoint.cursorXmin, seq: eventEndpoint.cursorSeq })
			.from(eventEndpoint)
			.where(eq(eventEndpoint.id, endpointId));

		await db.transaction(async (tx) => {
			await fanOut(tx);
			await tx.update(eventEndpoint).set({ cursorSeq: start!.seq, cursorXmin: start!.xmin });
		});
		await db.transaction((tx) => fanOut(tx));

		expect(await deliveredSeqs(endpointId)).toHaveLength(1);
	});

	it('pauses fan-out for an endpoint whose pending depth is above the threshold', async () => {
		const endpointId = await createEndpoint(['access_request.*']);

		// 1001 pending rows, inserted directly: what is under test is the pause,
		// not how the backlog got there.
		await db.execute(sql`
			INSERT INTO event_delivery (endpoint_id, audit_seq, audit_id)
			SELECT ${endpointId}::uuid, -n, gen_random_uuid() FROM generate_series(1, 1001) AS s(n)
		`);

		await recordEvent(db, {
			action: 'access_request.approved',
			actor: { type: 'system', id: null },
			subjectType: 'access_request',
			subjectId: crypto.randomUUID()
		});
		const result = await db.transaction((tx) => fanOut(tx));

		expect(result.paused).toEqual([endpointId]);
		expect(result.enqueued).toBe(0);

		// Draining below the threshold resumes it. The cursor is the backlog's
		// durable record, so pausing loses nothing (spec §5.2).
		await db.execute(sql`DELETE FROM event_delivery WHERE audit_seq < 0`);
		const resumed = await db.transaction((tx) => fanOut(tx));
		expect(resumed.enqueued).toBe(1);
	});
});
