import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/lib/server/db';

/**
 * `AUDIT_SINK_ENABLED` off means **no batch is ever cut**: the reader does not
 * run, no shipment row is created, and nothing is attested. Spec §11 makes that
 * safe to switch back on — `audit_event` is never swept on the sink's account
 * and the cursor's `(0,0)` default ships the whole history — but only if the
 * off state genuinely does nothing, which is what this file asserts.
 *
 * Mocked rather than driven through a database, on the same reasoning as
 * `egress-switch.test.ts`: the property under test is which calls are NOT made,
 * and a test that proves absence has to control every collaborator.
 */
const sinkEnabled = vi.fn(() => false);
const s3Configured = vi.fn(() => true);

vi.mock('../../src/lib/server/config', () => ({
	getConfig: () => ({
		auditSink: {
			enabled: sinkEnabled(),
			batchRows: 1000,
			maxAgeMs: 900_000,
			maxBytes: 8_000_000,
			attestIntervalMs: 86_400_000,
			s3: s3Configured()
				? {
						bucket: 'audit',
						region: 'eu-central-1',
						accessKeyId: 'k',
						secretAccessKey: 's'
					}
				: undefined
		}
	})
}));

const buildBatch = vi.fn(async () => null);
const claimShipments = vi.fn(async () => [] as { batchId: string; sink: 's3'; attempts: number }[]);
const shipClaimed = vi.fn(async () => {});
const attestationDue = vi.fn(async () => false);
const buildAttestation = vi.fn(async () => ({ at: '2026-09-04T12:00:00.000Z' }));
const markAttested = vi.fn(async () => {});
const attest = vi.fn(async () => {});

vi.mock('../../src/lib/server/auditsink/reader', () => ({
	buildBatch: () => buildBatch()
}));

vi.mock('../../src/lib/server/auditsink/ship', () => ({
	claimShipments: () => claimShipments(),
	shipClaimed: () => shipClaimed()
}));

vi.mock('../../src/lib/server/auditsink/attest', () => ({
	attestationDue: () => attestationDue(),
	buildAttestation: () => buildAttestation(),
	markAttested: () => markAttested()
}));

vi.mock('../../src/lib/server/auditsink/s3', () => ({
	createS3Adapter: () => ({ name: 's3', ship: async () => null, attest: () => attest() })
}));

vi.mock('../../src/lib/server/telemetry', () => ({
	withSpan: (_name: string, _attributes: unknown, fn: () => Promise<void>) => fn()
}));

const db = {} as Db;
const { runAuditSinkBatch, runAuditSinkShip } = await import('../../src/lib/server/auditsink');

beforeEach(() => {
	vi.clearAllMocks();
	sinkEnabled.mockReturnValue(false);
	s3Configured.mockReturnValue(true);
});

describe('the audit sink kill switch', () => {
	it('reads nothing, claims nothing and attests nothing while the sink is off', async () => {
		await runAuditSinkBatch(db);
		await runAuditSinkShip(db);

		expect(buildBatch).not.toHaveBeenCalled();
		expect(claimShipments).not.toHaveBeenCalled();
		expect(attestationDue).not.toHaveBeenCalled();
		expect(shipClaimed).not.toHaveBeenCalled();
		expect(attest).not.toHaveBeenCalled();
	});

	it('does nothing when enabled with no sink configured', async () => {
		// The config parser refuses this pairing at boot (config.test.ts), so
		// this is the defence in depth: a future sink added to SINK_NAMES but
		// not wired here must not silently batch into a void.
		sinkEnabled.mockReturnValue(true);
		s3Configured.mockReturnValue(false);

		await runAuditSinkBatch(db);
		await runAuditSinkShip(db);

		expect(buildBatch).not.toHaveBeenCalled();
		expect(claimShipments).not.toHaveBeenCalled();
	});

	it('reads and claims once enabled with a sink', async () => {
		sinkEnabled.mockReturnValue(true);

		await runAuditSinkBatch(db);

		expect(buildBatch).toHaveBeenCalledTimes(1);
		expect(claimShipments).toHaveBeenCalledTimes(1);
	});

	it('ships only what phase one claimed, and only outside the lock', async () => {
		sinkEnabled.mockReturnValue(true);
		claimShipments.mockResolvedValueOnce([{ batchId: 'b1', sink: 's3', attempts: 0 }]);

		await runAuditSinkBatch(db);
		expect(shipClaimed).not.toHaveBeenCalled();

		await runAuditSinkShip(db);
		expect(shipClaimed).toHaveBeenCalledTimes(1);
	});

	it('writes a due attestation in phase two, and stamps it after', async () => {
		sinkEnabled.mockReturnValue(true);
		attestationDue.mockResolvedValueOnce(true);

		await runAuditSinkBatch(db);
		expect(attest).not.toHaveBeenCalled();

		await runAuditSinkShip(db);
		expect(attest).toHaveBeenCalledTimes(1);
		expect(markAttested).toHaveBeenCalledTimes(1);
	});

	it('stamps the attestation even when the sink rejected it', async () => {
		// One dead sink must not make the attestation series retry forever, and
		// a failed attestation is recorded nowhere: the next interval covers the
		// same ground (spec §8).
		sinkEnabled.mockReturnValue(true);
		attestationDue.mockResolvedValueOnce(true);
		attest.mockRejectedValueOnce(new Error('down'));

		await runAuditSinkBatch(db);
		await runAuditSinkShip(db);

		expect(markAttested).toHaveBeenCalledTimes(1);
	});

	it('does not re-ship the same claim on a later tick', async () => {
		sinkEnabled.mockReturnValue(true);
		claimShipments.mockResolvedValueOnce([{ batchId: 'b1', sink: 's3', attempts: 0 }]);

		await runAuditSinkBatch(db);
		await runAuditSinkShip(db);
		await runAuditSinkShip(db);

		expect(shipClaimed).toHaveBeenCalledTimes(1);
	});
});
