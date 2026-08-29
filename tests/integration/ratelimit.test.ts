import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../../src/lib/server/db';
import { consumeRateLimit, rateLimitKey } from '../../src/lib/server/ratelimit';
import type { Db } from '../../src/lib/server/db';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
	({ db, close } = createDb(process.env.TEST_DATABASE_URL!));
});

afterAll(async () => {
	await close();
});

describe('consumeRateLimit', () => {
	it('allows up to the limit and refuses past it', async () => {
		const key = randomUUID();

		for (let i = 0; i < 3; i++) {
			expect((await consumeRateLimit(db, { key, limit: 3, windowSeconds: 60 })).allowed).toBe(true);
		}

		const refused = await consumeRateLimit(db, { key, limit: 3, windowSeconds: 60 });
		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterSeconds).toBeGreaterThan(0);
		expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
	});

	it('keeps separate keys separate', async () => {
		const a = randomUUID();
		const b = randomUUID();

		await consumeRateLimit(db, { key: a, limit: 1, windowSeconds: 60 });

		expect((await consumeRateLimit(db, { key: a, limit: 1, windowSeconds: 60 })).allowed).toBe(
			false
		);
		expect((await consumeRateLimit(db, { key: b, limit: 1, windowSeconds: 60 })).allowed).toBe(
			true
		);
	});

	it('starts a fresh window once the old one has passed', async () => {
		const key = randomUUID();

		expect((await consumeRateLimit(db, { key, limit: 1, windowSeconds: 1 })).allowed).toBe(true);
		expect((await consumeRateLimit(db, { key, limit: 1, windowSeconds: 1 })).allowed).toBe(false);

		await new Promise((resolve) => setTimeout(resolve, 1100));

		expect((await consumeRateLimit(db, { key, limit: 1, windowSeconds: 1 })).allowed).toBe(true);
	});

	it('counts concurrent attempts exactly once each', async () => {
		// A read-then-write limiter lets several callers all observe "under the
		// limit" and all proceed. One upsert cannot.
		const key = randomUUID();

		const results = await Promise.all(
			Array.from({ length: 10 }, () => consumeRateLimit(db, { key, limit: 4, windowSeconds: 60 }))
		);

		expect(results.filter((r) => r.allowed)).toHaveLength(4);
	});

	it('does not store the identifier it limits on', async () => {
		const key = rateLimitKey('request', 'someone@acme.example');

		expect(key).not.toContain('someone');
		expect(key).not.toContain('acme.example');
		expect(key.startsWith('request:')).toBe(true);
	});

	it('keys the same identifier consistently regardless of case or padding', async () => {
		expect(rateLimitKey('request', 'Someone@Acme.example ')).toBe(
			rateLimitKey('request', 'someone@acme.example')
		);
	});
});
