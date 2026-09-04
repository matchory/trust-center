import { AwsClient } from 'aws4fetch';
import { SinkError } from './port';
import type { Attestation, AuditSinkAdapter, SinkBatch } from './port';

const TIMEOUT_MS = 30_000;

export interface S3SinkConfig {
	bucket: string;
	region: string;
	endpoint?: string;
	accessKeyId: string;
	secretAccessKey: string;
	prefix?: string;
	/** Injected in tests only; production passes nothing and uses global fetch. */
	fetch?: typeof fetch;
}

/** UTC, so every replica agrees which day a batch belongs to regardless of the
 * container's timezone. */
function datePath(at: Date): string {
	const yyyy = at.getUTCFullYear();
	const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(at.getUTCDate()).padStart(2, '0');

	return `${yyyy}/${mm}/${dd}`;
}

/**
 * Deterministic from the batch id, so a retry re-PUTs the same key.
 *
 * Verified against MinIO on 2026-09-04 (specs/2026-09-04-audit-sink-spike.md):
 * under object lock that adds a version rather than replacing one, which is
 * both legal and honest when a purge made the bytes differ (spec §5.2). The
 * key is therefore a shipping address, not an identity — the manifest digest
 * is what tells two versions apart.
 */
export function objectKeys(
	batchId: string,
	createdAt: Date,
	prefix?: string
): { body: string; manifest: string } {
	const base = `${prefix ? `${prefix}/` : ''}audit/${datePath(createdAt)}/${batchId}`;

	return { body: `${base}.ndjson`, manifest: `${base}.manifest.json` };
}

/**
 * The closed-set reason for a thrown transport failure (spec §5.4). Nothing
 * from the cause reaches the SinkError: `last_error` is written to a table
 * that forbids DELETE and is excluded from retention, so a provider string
 * there outlives every erasure path (issue #11).
 */
function transportReason(cause: unknown): SinkError {
	const name = cause instanceof Error ? cause.name : '';

	return new SinkError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
}

export function createS3Adapter(config: S3SinkConfig): AuditSinkAdapter {
	const client = new AwsClient({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		service: 's3',
		region: config.region
	});
	const doFetch = config.fetch ?? fetch;
	// Path-style for a configured endpoint, because an S3-compatible store on a
	// bare host or an IP has no virtual-hosted form to resolve.
	const origin = config.endpoint
		? `${config.endpoint.replace(/\/$/, '')}/${config.bucket}`
		: `https://${config.bucket}.s3.${config.region}.amazonaws.com`;

	/**
	 * No object-lock headers: the bucket's default retention applies to a plain
	 * PUT (verified 2026-09-04, spike findings), which keeps retention the
	 * operator's decision per §14 and avoids needing s3:PutObjectRetention in
	 * the write-only policy §5.2 depends on.
	 */
	async function put(
		key: string,
		body: Uint8Array<ArrayBuffer>,
		contentType: string
	): Promise<void> {
		const signed = await client.sign(`${origin}/${key}`, {
			method: 'PUT',
			body,
			headers: { 'content-type': contentType }
		});

		let response: Response;
		try {
			response = await doFetch(signed, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		} catch (cause) {
			throw transportReason(cause);
		}

		if (response.ok) return;

		// The body is read to classify and then discarded — never stored, for
		// the reason transportReason() gives.
		const text = await response.text().catch(() => '');

		if (response.status === 401) throw new SinkError('auth', 401);
		if (response.status === 403) {
			throw /Signature|InvalidAccessKeyId|TokenRefreshRequired/.test(text)
				? new SinkError('auth', 403)
				: new SinkError('permission', 403);
		}
		if (response.status === 404) throw new SinkError('not_found', 404);
		throw new SinkError('http_status', response.status);
	}

	return {
		name: 's3',
		async ship(batch: SinkBatch): Promise<string> {
			const keys = objectKeys(batch.id, new Date(batch.manifest.created_at), config.prefix);

			// Body first: the manifest is the claim that the body exists, so
			// publishing a digest for bytes that failed to land would be a lie
			// a verifier cannot distinguish from tampering.
			await put(keys.body, batch.body, 'application/x-ndjson');
			await put(
				keys.manifest,
				new TextEncoder().encode(JSON.stringify(batch.manifest, null, 2)),
				'application/json'
			);

			return keys.body;
		},
		async attest(attestation: Attestation): Promise<void> {
			const at = new Date(attestation.at);
			const stamp = at.toISOString().replace(/[:.]/g, '-');
			const key = `${config.prefix ? `${config.prefix}/` : ''}attest/${datePath(at)}/${stamp}.json`;

			await put(
				key,
				new TextEncoder().encode(JSON.stringify(attestation, null, 2)),
				'application/json'
			);
		}
	};
}
