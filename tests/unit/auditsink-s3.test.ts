import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createS3Adapter,
	objectKeys,
	resetObjectLockProbes
} from '../../src/lib/server/auditsink/s3';
import { buildManifest } from '../../src/lib/server/auditsink/serialize';
import type { SinkBatch } from '../../src/lib/server/auditsink/port';
import type { SinkError } from '../../src/lib/server/auditsink/port';

const config = {
	bucket: 'audit',
	region: 'eu-central-1',
	accessKeyId: 'k',
	secretAccessKey: 's',
	prefix: 'tc'
};

function batch(): SinkBatch {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		body: new TextEncoder().encode('{"a":1}\n'),
		digest: 'a'.repeat(64),
		manifest: buildManifest({
			id: '11111111-1111-4111-8111-111111111111',
			createdAt: '2026-09-04T12:00:00.000000Z',
			prevCursor: { xmin: 1n, seq: 1n },
			cursor: { xmin: 2n, seq: 2n },
			rowCount: 1,
			minSeq: 2n,
			maxSeq: 2n,
			byteCount: 8,
			digest: 'a'.repeat(64)
		})
	};
}

function ok() {
	// The signature is declared rather than taken from the implementation, so
	// mock.calls is a typed tuple without the implementation naming arguments
	// it does not use.
	return vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>(
		async () => new Response(null, { status: 200 })
	);
}

/** The adapter always signs before fetching, so every call carries a Request.
 * Asserted rather than cast, so a future adapter that passes a bare URL fails
 * here instead of silently losing the signature checks below. */
function requestOf(call: [URL | RequestInfo, (RequestInit | undefined)?]): Request {
	expect(call[0]).toBeInstanceOf(Request);

	return call[0] as Request;
}

describe('objectKeys', () => {
	it('lays keys out by date under the prefix', () => {
		const keys = objectKeys('batch-1', new Date('2026-09-04T12:00:00Z'), 'tc');

		expect(keys.body).toBe('tc/audit/2026/09/04/batch-1.ndjson');
		expect(keys.manifest).toBe('tc/audit/2026/09/04/batch-1.manifest.json');
	});

	it('omits the prefix segment when none is configured', () => {
		expect(objectKeys('batch-1', new Date('2026-09-04T12:00:00Z')).body).toBe(
			'audit/2026/09/04/batch-1.ndjson'
		);
	});

	it('dates the key in UTC, not in the host timezone', () => {
		// 2026-09-04T23:30Z is already the 5th in Sydney and still the 4th in
		// New York. A key that moved with the host would put one batch under a
		// date no other replica agrees on.
		expect(objectKeys('batch-1', new Date('2026-09-04T23:30:00Z')).body).toContain('2026/09/04');
	});
});

describe('createS3Adapter', () => {
	it('PUTs the body and the manifest, and signs both', async () => {
		const fetchMock = ok();
		const adapter = createS3Adapter({ ...config, fetch: fetchMock });

		await adapter.ship(batch());

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = requestOf(fetchMock.mock.calls[0]!);
		expect(first.method).toBe('PUT');
		expect(first.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
	});

	it('returns the body key it wrote, so the shipment row can record it', async () => {
		const adapter = createS3Adapter({ ...config, fetch: ok() });

		await expect(adapter.ship(batch())).resolves.toBe(
			'tc/audit/2026/09/04/11111111-1111-4111-8111-111111111111.ndjson'
		);
	});

	it('addresses a configured endpoint path-style, and Amazon virtual-hosted', async () => {
		const minio = ok();
		await createS3Adapter({ ...config, endpoint: 'http://127.0.0.1:9000/', fetch: minio }).ship(
			batch()
		);
		const amazon = ok();
		await createS3Adapter({ ...config, fetch: amazon }).ship(batch());

		expect(requestOf(minio.mock.calls[0]!).url).toBe(
			'http://127.0.0.1:9000/audit/tc/audit/2026/09/04/11111111-1111-4111-8111-111111111111.ndjson'
		);
		expect(requestOf(amazon.mock.calls[0]!).url).toBe(
			'https://audit.s3.eu-central-1.amazonaws.com/tc/audit/2026/09/04/11111111-1111-4111-8111-111111111111.ndjson'
		);
	});

	it('sends no object-lock headers, leaving retention to the bucket', async () => {
		// Verified 2026-09-04 (specs/2026-09-04-audit-sink-spike.md): the
		// bucket default applies to a plain PUT. Sending retention per object
		// would need s3:PutObjectRetention, widening the write-only policy
		// §5.2 depends on.
		const fetchMock = ok();
		await createS3Adapter({ ...config, fetch: fetchMock }).ship(batch());

		const request = requestOf(fetchMock.mock.calls[0]!);
		expect(request.headers.get('x-amz-object-lock-mode')).toBeNull();
		expect(request.headers.get('x-amz-object-lock-retain-until-date')).toBeNull();
	});

	it('writes the attestation under its own prefix, stamped by time', async () => {
		const fetchMock = ok();
		const adapter = createS3Adapter({ ...config, fetch: fetchMock });

		await adapter.attest({
			at: '2026-09-04T12:00:00.000Z',
			event_count: '10',
			max_seq: '10',
			cursor: { xmin: '5', seq: '10' },
			last_batch_id: null,
			batches_since: 2
		});

		expect(requestOf(fetchMock.mock.calls[0]!).url).toContain(
			'/tc/attest/2026/09/04/2026-09-04T12-00-00-000Z.json'
		);
	});

	it('maps 403 with a signature error code to auth, and a plain 403 to permission', async () => {
		const signature = () =>
			new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
		const denied = () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });

		await expect(
			createS3Adapter({ ...config, fetch: async () => signature() }).ship(batch())
		).rejects.toMatchObject({ reason: 'auth' });
		await expect(
			createS3Adapter({ ...config, fetch: async () => denied() }).ship(batch())
		).rejects.toMatchObject({ reason: 'permission' });
	});

	it('maps a missing bucket to not_found', async () => {
		const adapter = createS3Adapter({
			...config,
			fetch: async () => new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })
		});

		await expect(adapter.ship(batch())).rejects.toMatchObject({ reason: 'not_found' });
	});

	it('maps other failures to http_status with the code', async () => {
		const adapter = createS3Adapter({
			...config,
			fetch: async () => new Response('boom', { status: 500 })
		});

		await expect(adapter.ship(batch())).rejects.toMatchObject({
			reason: 'http_status',
			statusCode: 500
		});
	});

	it('maps a transport failure to network', async () => {
		const adapter = createS3Adapter({
			...config,
			fetch: async () => {
				throw new TypeError('fetch failed');
			}
		});

		await expect(adapter.ship(batch())).rejects.toMatchObject({ reason: 'network' });
	});

	it('maps an aborted request to timeout', async () => {
		const adapter = createS3Adapter({
			...config,
			fetch: async () => {
				throw new DOMException('The operation was aborted.', 'TimeoutError');
			}
		});

		await expect(adapter.ship(batch())).rejects.toMatchObject({ reason: 'timeout' });
	});

	it('never stores a response body on the error', async () => {
		const adapter = createS3Adapter({
			...config,
			fetch: async () => new Response('alice@example.com', { status: 500 })
		});

		// Spec §5.4 / issue #11: a receiver echoing input must not put a
		// requester's address into a column no purge reaches.
		const error = await adapter.ship(batch()).catch((cause: SinkError) => cause);
		expect(JSON.stringify(error)).not.toContain('alice@example.com');
		expect(String(error)).not.toContain('alice@example.com');
	});

	it('does not PUT the manifest when the body PUT failed', async () => {
		// The manifest is the claim that the body exists. Writing it after a
		// failed body would publish a digest for bytes no one can read.
		const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
		const adapter = createS3Adapter({ ...config, fetch: fetchMock });

		await expect(adapter.ship(batch())).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe('the object-lock probe', () => {
	beforeEach(() => {
		resetObjectLockProbes();
	});

	function lockConfig(xml: string, status = 200) {
		return vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>(
			async () => new Response(xml, { status })
		);
	}

	it('reads governance and compliance out of the bucket configuration', async () => {
		const governance =
			'<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled>' +
			'<Rule><DefaultRetention><Mode>GOVERNANCE</Mode><Days>3650</Days></DefaultRetention></Rule>' +
			'</ObjectLockConfiguration>';

		await expect(
			createS3Adapter({ ...config, fetch: lockConfig(governance) }).objectLock!()
		).resolves.toBe('governance');

		resetObjectLockProbes();
		await expect(
			createS3Adapter({
				...config,
				bucket: 'other',
				fetch: lockConfig(governance.replace('GOVERNANCE', 'COMPLIANCE'))
			}).objectLock!()
		).resolves.toBe('compliance');
	});

	it('reports none for a bucket with lock enabled but no default rule', async () => {
		// Honest rather than reassuring: the adapter sends no per-object
		// retention, so nothing it writes is retained.
		const enabledOnly =
			'<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled>' +
			'</ObjectLockConfiguration>';

		await expect(
			createS3Adapter({ ...config, fetch: lockConfig(enabledOnly) }).objectLock!()
		).resolves.toBe('none');
	});

	it('reports none for a bucket created without lock', async () => {
		const missing = '<Error><Code>ObjectLockConfigurationNotFoundError</Code></Error>';

		await expect(
			createS3Adapter({ ...config, fetch: lockConfig(missing, 404) }).objectLock!()
		).resolves.toBe('none');
	});

	it('reports unknown when the write-only policy forbids reading it', async () => {
		// Spec §5.2: we cannot prove the bucket is locked, and being loud about
		// what we could not see is the point.
		await expect(
			createS3Adapter({
				...config,
				fetch: lockConfig('<Error><Code>AccessDenied</Code></Error>', 403)
			}).objectLock!()
		).resolves.toBe('unknown');
	});

	it('reports unknown rather than throwing when the store is unreachable', async () => {
		const adapter = createS3Adapter({
			...config,
			fetch: async () => {
				throw new TypeError('fetch failed');
			}
		});

		await expect(adapter.objectLock!()).resolves.toBe('unknown');
	});

	it('probes once per bucket, so a page render is not an S3 round trip', async () => {
		const fetchMock = lockConfig('<ObjectLockConfiguration/>');
		const adapter = createS3Adapter({ ...config, fetch: fetchMock });

		await adapter.objectLock!();
		await adapter.objectLock!();
		await createS3Adapter({ ...config, fetch: fetchMock }).objectLock!();

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
