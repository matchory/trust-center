import { createHash, randomUUID } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { describe, expect, it } from 'vitest';
import { createS3Adapter, objectKeys } from '../../src/lib/server/auditsink/s3';
import { buildManifest, serializeBatch } from '../../src/lib/server/auditsink/serialize';
import type { S3SinkConfig } from '../../src/lib/server/auditsink/s3';
import type { SinkBatch } from '../../src/lib/server/auditsink/port';
import type { AuditRowText } from '../../src/lib/server/auditsink/serialize';

const CREATED_AT = '2026-09-04T12:00:00.000000Z';

function testConfig(overrides: Partial<S3SinkConfig> = {}): S3SinkConfig {
	return {
		bucket: process.env.TEST_S3_BUCKET!,
		region: process.env.TEST_S3_REGION!,
		endpoint: process.env.TEST_S3_ENDPOINT!,
		accessKeyId: process.env.TEST_S3_ACCESS_KEY!,
		secretAccessKey: process.env.TEST_S3_SECRET_KEY!,
		...overrides
	};
}

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

function batch(rows: readonly AuditRowText[] = [row()]): SinkBatch {
	const id = randomUUID();
	const { body, digest } = serializeBatch(rows);

	return {
		id,
		body,
		digest,
		manifest: buildManifest({
			id,
			createdAt: CREATED_AT,
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

/** A signed reader, because the bucket is not public — the same property §5.2's
 * storage assumption rests on. */
function reader(): AwsClient {
	return new AwsClient({
		accessKeyId: process.env.TEST_S3_ACCESS_KEY!,
		secretAccessKey: process.env.TEST_S3_SECRET_KEY!,
		service: 's3',
		region: process.env.TEST_S3_REGION!
	});
}

function objectUrl(key: string): string {
	return `${process.env.TEST_S3_ENDPOINT}/${process.env.TEST_S3_BUCKET}/${key}`;
}

describe('the S3 adapter against MinIO', () => {
	it('writes both objects, and the digest reproduces from what was stored', async () => {
		const adapter = createS3Adapter(testConfig());
		const sink = batch();

		const key = await adapter.ship(sink);

		expect(key).toBe(objectKeys(sink.id, new Date(CREATED_AT)).body);
		const stored = new Uint8Array(await (await reader().fetch(objectUrl(key!))).arrayBuffer());
		expect(createHash('sha256').update(stored).digest('hex')).toBe(sink.digest);
	});

	it('writes a manifest that parses and names the same digest', async () => {
		const adapter = createS3Adapter(testConfig());
		const sink = batch();

		await adapter.ship(sink);

		const keys = objectKeys(sink.id, new Date(CREATED_AT));
		const manifest = await (await reader().fetch(objectUrl(keys.manifest))).json();
		expect(manifest).toMatchObject({ batch_id: sink.id, digest: sink.digest, version: 1 });
	});

	it('re-PUTs the same key on retry without error, adding a version', async () => {
		// The premise the spike verified: under object lock this adds a version
		// rather than being refused, which is what makes the retry path safe.
		const adapter = createS3Adapter(testConfig());
		const sink = batch();

		await adapter.ship(sink);
		await expect(adapter.ship(sink)).resolves.toBe(objectKeys(sink.id, new Date(CREATED_AT)).body);

		const key = objectKeys(sink.id, new Date(CREATED_AT)).body;
		const listed = await reader().fetch(
			`${process.env.TEST_S3_ENDPOINT}/${process.env.TEST_S3_BUCKET}?versions&prefix=${encodeURIComponent(key)}`
		);
		expect((await listed.text()).match(/<Version>/g)).toHaveLength(2);
	});

	it('honours the prefix, so one bucket can hold more than one deployment', async () => {
		const adapter = createS3Adapter(testConfig({ prefix: 'tenant-a' }));
		const sink = batch();

		const key = await adapter.ship(sink);

		expect(key).toMatch(/^tenant-a\/audit\//);
		expect((await reader().fetch(objectUrl(key!))).ok).toBe(true);
	});

	it('writes the attestation where an auditor can read it', async () => {
		const adapter = createS3Adapter(testConfig());
		const at = new Date().toISOString();

		await adapter.attest({
			at,
			event_count: '10',
			max_seq: '10',
			cursor: { xmin: '5', seq: '10' },
			last_batch_id: null,
			batches_since: 2
		});

		const stamp = at.replace(/[:.]/g, '-');
		const date = at.slice(0, 10).replace(/-/g, '/');
		const stored = await reader().fetch(objectUrl(`attest/${date}/${stamp}.json`));
		expect(await stored.json()).toMatchObject({ at, event_count: '10' });
	});

	it('reports not_found when the bucket does not exist', async () => {
		const adapter = createS3Adapter(testConfig({ bucket: 'does-not-exist' }));

		await expect(adapter.ship(batch())).rejects.toMatchObject({
			reason: 'not_found',
			statusCode: 404
		});
	});

	it('reports auth when the secret is wrong, and stores nothing from the response', async () => {
		const adapter = createS3Adapter(testConfig({ secretAccessKey: 'wrong' }));

		const error = await adapter.ship(batch()).catch((cause: unknown) => cause);
		expect(error).toMatchObject({ reason: 'auth' });
		expect(JSON.stringify(error)).not.toContain('SignatureDoesNotMatch');
	});

	it('reports network when nothing is listening', async () => {
		const adapter = createS3Adapter(testConfig({ endpoint: 'http://127.0.0.1:1' }));

		await expect(adapter.ship(batch())).rejects.toMatchObject({ reason: 'network' });
	});
});
