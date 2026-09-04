import { describe, expect, it } from 'vitest';
import {
	AUDIT_COLUMNS,
	SERIALIZATION_VERSION,
	buildManifest,
	serializeBatch
} from '../../src/lib/server/auditsink/serialize';
import type { AuditRowText } from '../../src/lib/server/auditsink/serialize';

function row(overrides: Partial<AuditRowText> = {}): AuditRowText {
	return {
		id: '00000000-0000-4000-8000-000000000001',
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

describe('serializeBatch', () => {
	it('emits one LF-terminated JSON object per row, keys in declared order', () => {
		const { body } = serializeBatch([row()]);
		const text = new TextDecoder().decode(body);

		expect(text.endsWith('\n')).toBe(true);
		expect(text.trimEnd().split('\n')).toHaveLength(1);
		expect(Object.keys(JSON.parse(text))).toEqual([...AUDIT_COLUMNS]);
	});

	it('embeds meta verbatim, preserving a numeric that exceeds 2^53', () => {
		// Plan correction C1: JSON.parse -> stringify would render this
		// 12345678901234567000. jsonb already normalizes key order, so the text
		// is both deterministic and exact.
		const big = '{"n": 12345678901234567890}';
		const { body } = serializeBatch([row({ meta: big })]);

		expect(new TextDecoder().decode(body)).toContain('12345678901234567890');
	});

	it('preserves microsecond precision in `at`', () => {
		const { body } = serializeBatch([row({ at: '2026-09-04T12:00:00.123456Z' })]);
		expect(new TextDecoder().decode(body)).toContain('12:00:00.123456Z');
	});

	it('emits seq as a JSON number, not a string', () => {
		const { body } = serializeBatch([row({ seq: '42' })]);
		expect(new TextDecoder().decode(body)).toContain('"seq":42');
	});

	it('emits a null column as JSON null', () => {
		const { body } = serializeBatch([row({ ip: null, meta: null })]);
		const parsed = JSON.parse(new TextDecoder().decode(body));
		expect(parsed.ip).toBeNull();
		expect(parsed.meta).toBeNull();
	});

	it('is byte-identical for the same rows and differs when one byte changes', () => {
		const a = serializeBatch([row(), row({ seq: '43' })]);
		const b = serializeBatch([row(), row({ seq: '43' })]);
		const c = serializeBatch([row(), row({ seq: '44' })]);

		expect(a.digest).toBe(b.digest);
		expect(a.digest).not.toBe(c.digest);
		expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it('digests exactly the bytes of the body, so sha256sum reproduces it', async () => {
		const { body, digest } = serializeBatch([row()]);
		const expected = Buffer.from(
			await crypto.subtle.digest('SHA-256', body as unknown as ArrayBuffer)
		).toString('hex');

		expect(digest).toBe(expected);
	});
});

describe('buildManifest', () => {
	it('carries both cursor positions, the counts and the digest', () => {
		const manifest = buildManifest({
			id: 'batch-1',
			createdAt: '2026-09-04T12:00:00.000000Z',
			prevCursor: { xmin: 10n, seq: 5n },
			cursor: { xmin: 20n, seq: 9n },
			rowCount: 2,
			minSeq: 5n,
			maxSeq: 9n,
			byteCount: 400,
			digest: 'a'.repeat(64)
		});

		expect(manifest.version).toBe(SERIALIZATION_VERSION);
		expect(manifest.cursor).toEqual({ xmin: '20', seq: '9' });
		expect(manifest.prev_cursor).toEqual({ xmin: '10', seq: '5' });
		expect(manifest.digest_algorithm).toBe('sha256');
		expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
	});
});
