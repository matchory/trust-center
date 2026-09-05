import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSyslogAdapter } from '../../src/lib/server/auditsink/syslog';
import { buildManifest, serializeBatch } from '../../src/lib/server/auditsink/serialize';
import { selfSigned, startSyslogServer, type SyslogServer } from '../helpers/syslog-server';
import type { SinkBatch } from '../../src/lib/server/auditsink/port';
import type { AuditRowText } from '../../src/lib/server/auditsink/serialize';

const server = selfSigned('localhost');
const client = selfSigned('trustcenter');
let running: SyslogServer | undefined;

afterEach(async () => {
	await running?.close();
	running = undefined;
});

function row(overrides: Partial<AuditRowText> = {}): AuditRowText {
	return {
		id: randomUUID(),
		seq: '42',
		at: '2026-09-04T12:00:00.123456Z',
		actor_type: 'staff',
		actor_id: 'staff-1',
		action: 'document.published',
		subject_type: 'document',
		subject_id: 'doc-1',
		ip: null,
		ua: null,
		request_id: 'req-1',
		meta: '{"a": 1}',
		...overrides
	};
}

function batch(rows: readonly AuditRowText[] = [row(), row()]): SinkBatch {
	const id = randomUUID();
	const { body, digest } = serializeBatch(rows);

	return {
		id,
		body,
		digest,
		manifest: buildManifest({
			id,
			createdAt: '2026-09-04T12:00:00.000000Z',
			prevCursor: { xmin: 1n, seq: 1n },
			cursor: { xmin: 2n, seq: 42n },
			rowCount: rows.length,
			minSeq: 42n,
			maxSeq: 42n,
			byteCount: body.byteLength,
			digest
		})
	};
}

/**
 * A batch too large to hand to the kernel in one go, so the receiver goes away
 * while the write is still in flight. Both mid-batch tests need that: once the
 * adapter has written everything and sent its FIN there is no signal left to
 * observe — syslog acknowledges nothing — so a small batch tests the scheduler
 * rather than the adapter, and does so flakily.
 */
function inFlight(): AuditRowText[] {
	// 20 000 rows is ~5 MB. Measured on 2026-09-05: at 2 000 the batch still
	// fits in the loopback socket buffers and the graceful case is delivered
	// whole before the receiver's FIN is seen; the exact threshold is the
	// kernel's, so the fixture sits well clear of it rather than on it.
	return Array.from({ length: 20_000 }, () => row());
}

function adapterFor(port: number, overrides: Record<string, unknown> = {}) {
	return createSyslogAdapter({
		host: '127.0.0.1',
		port,
		tls: true,
		ca: server.cert,
		facility: 'local0',
		maxMessageBytes: 8192,
		hostname: 'trust.example.com',
		...overrides
	});
}

describe('the syslog adapter', () => {
	it('sends one message per row and a trailing manifest message', async () => {
		running = await startSyslogServer({ tls: server });

		const sink = batch();
		await expect(adapterFor(running.port).ship(sink)).resolves.toBeNull();

		expect(running.messages).toHaveLength(3);
		expect(running.messages[0]).toContain(` ${sink.id} audit - `);
		expect(running.messages[2]).toContain(` ${sink.id} manifest - `);
		// The manifest message is what a SIEM correlates the rows to, since
		// there is no object at the far end (spec §5.3).
		expect(running.messages[2]).toContain(sink.digest);
	});

	it('returns null rather than a key, because there is no object to point at', async () => {
		running = await startSyslogServer({ tls: server });

		await expect(adapterFor(running.port).ship(batch())).resolves.toBeNull();
	});

	it('refuses a server it cannot verify, and never disables rejectUnauthorized', async () => {
		// Spec §5.3: there is no variable that turns this off, so an untrusted
		// receiver must fail rather than degrade.
		running = await startSyslogServer({ tls: selfSigned('someone-else') });

		await expect(adapterFor(running.port).ship(batch())).rejects.toMatchObject({ reason: 'tls' });
	});

	it('presents a client certificate when one is configured', async () => {
		running = await startSyslogServer({ tls: server, requireClientCert: client });

		await expect(
			adapterFor(running.port, { clientCert: client.cert, clientKey: client.key }).ship(batch())
		).resolves.toBeNull();
	});

	it('fails when the receiver demands a client certificate and none is configured', async () => {
		running = await startSyslogServer({ tls: server, requireClientCert: client });

		await expect(adapterFor(running.port).ship(batch())).rejects.toMatchObject({ reason: 'tls' });
	});

	it('reports network when the receiver resets mid-batch', async () => {
		running = await startSyslogServer({ tls: server });
		running.closeAfter(1);

		await expect(adapterFor(running.port).ship(batch(inFlight()))).rejects.toMatchObject({
			reason: 'network'
		});
	});

	it('reports network when the receiver closes gracefully mid-batch', async () => {
		// The shape a receiver that hits a parse error actually has: a FIN, no
		// reset, and therefore no error event anywhere. Resolving on close alone
		// records the batch as delivered when the receiver took none of it —
		// a false entry in a record the whole sink exists to keep true.
		running = await startSyslogServer({ tls: server });
		running.endAfter(1);

		await expect(adapterFor(running.port).ship(batch(inFlight()))).rejects.toMatchObject({
			reason: 'network'
		});
	});

	it('reports tls when the receiver drops the connection before the handshake', async () => {
		// The phase is the only evidence here: the socket reports a bare reset
		// with no TLS code, and `network` would send an operator to their
		// firewall rather than to the receiver's TLS configuration (spec §5.4).
		running = await startSyslogServer();
		running.closeAfter(0);

		await expect(adapterFor(running.port).ship(batch())).rejects.toMatchObject({ reason: 'tls' });
	});

	it('reports network when nothing is listening', async () => {
		await expect(adapterFor(1).ship(batch())).rejects.toMatchObject({ reason: 'network' });
	});

	it('fails the batch with config when a row exceeds the message cap', async () => {
		// Not truncated and not skipped: a truncated row can never reproduce its
		// digest, and a skipped one makes the sink silently lossy (spec §5.3,
		// decision D8).
		running = await startSyslogServer({ tls: server });

		await expect(
			adapterFor(running.port, { maxMessageBytes: 64 }).ship(batch())
		).rejects.toMatchObject({ reason: 'config' });
		expect(running.messages).toHaveLength(0);
		expect(running.connections()).toBe(0);
	});

	it('opens no connection at all when a later row is the oversized one', async () => {
		// The size check runs over the whole batch before the connection opens,
		// so a partial batch never reaches the receiver (spec §5.3).
		running = await startSyslogServer({ tls: server });
		const rows = [row(), row({ meta: `{"pad":"${'x'.repeat(400)}"}` })];

		// 500, not the cap the first row already exceeds: at a smaller cap this
		// test passes on the first row and asserts nothing about a later one.
		// A row here frames to 379 bytes, the padded one to 779.
		await expect(
			adapterFor(running.port, { maxMessageBytes: 500 }).ship(batch(rows))
		).rejects.toMatchObject({ reason: 'config' });
		// The connection count, not just the message count: a partial batch that
		// was written and then discarded when the socket was destroyed would
		// leave no messages either, so only "the socket never opened" actually
		// pins the check to before the connection.
		expect(running.connections()).toBe(0);
	});

	it('speaks plain TCP when the scheme says so', async () => {
		running = await startSyslogServer();

		await expect(
			adapterFor(running.port, { tls: false, ca: undefined }).ship(batch())
		).resolves.toBeNull();
	});

	it('writes an attestation as one message', async () => {
		running = await startSyslogServer({ tls: server });

		await adapterFor(running.port).attest({
			at: '2026-09-04T12:00:00.000Z',
			event_count: '10',
			max_seq: '10',
			cursor: { xmin: '5', seq: '10' },
			last_batch_id: null,
			batches_since: 2
		});

		expect(running.messages).toHaveLength(1);
		expect(running.messages[0]).toContain(' attest - ');
	});
});
