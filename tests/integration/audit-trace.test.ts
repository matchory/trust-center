import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/lib/server/db';
import { auditEvent } from '../../src/lib/server/db/schema';
import { recordEvent } from '../../src/lib/server/audit';
import { activeTraceId, withSpan } from '../../src/lib/server/telemetry';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL not set by global setup');
	({ db, close } = createDb(url));

	// `trace.setGlobalTracerProvider` silently refuses a second registration
	// (returns false, no throw) once one is already registered on globalThis —
	// disable first so this file's provider actually takes effect.
	trace.disable();
	trace.setGlobalTracerProvider(
		new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())]
		})
	);

	// `trace.setGlobalTracerProvider` alone installs no context manager, so
	// `context.active()` never propagates and `startActiveSpan` cannot make its
	// span active — without this, `activeTraceId()` returns undefined inside
	// `withSpan` and the central assertion below fails.
	context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterAll(async () => {
	await close();
	// Leave the global tracing API as this file found it, for whichever test
	// file's `beforeAll` runs next in the same worker.
	trace.disable();
});

async function latestRequestId(action: string): Promise<string | null> {
	const [row] = await db
		.select({ requestId: auditEvent.requestId })
		.from(auditEvent)
		.where(eq(auditEvent.action, action))
		.orderBy(desc(auditEvent.seq))
		.limit(1);
	return row?.requestId ?? null;
}

describe('recordEvent trace correlation', () => {
	it('writes the active trace id into request_id', async () => {
		const traceId = await withSpan('audit-trace-test', {}, async () => {
			await recordEvent(db, {
				action: 'staff.login.succeeded',
				actor: { type: 'system', id: null }
			});
			return activeTraceId();
		});

		expect(traceId).toMatch(/^[0-9a-f]{32}$/);
		expect(await latestRequestId('staff.login.succeeded')).toBe(traceId);
	});

	// Jobs record events with no request behind them, and a null column is the
	// honest answer there — not a constant that looks like a correlation id.
	it('writes null when there is no active span', async () => {
		await recordEvent(db, { action: 'staff.logout', actor: { type: 'system', id: null } });
		expect(await latestRequestId('staff.logout')).toBeNull();
	});

	// An explicit requestId must win, or a caller that already knows the
	// correlation id it wants silently loses it.
	it('does not override an explicitly supplied requestId', async () => {
		await withSpan('audit-trace-explicit', {}, async () => {
			await recordEvent(db, {
				action: 'staff.login.denied',
				actor: { type: 'system', id: null },
				requestId: 'supplied'
			});
		});
		expect(await latestRequestId('staff.login.denied')).toBe('supplied');
	});
});
