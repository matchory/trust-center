/**
 * The SQLSTATE a failed query carried, wherever it ended up.
 *
 * Drizzle wraps a driver error rather than rethrowing it: what reaches a caller
 * is `{ query, params, cause }`, and postgres-js's own error — the one with
 * `code` on it — is that `cause`. So a check written as `cause.code === '23505'`
 * compiles, reads correctly, and never matches once, which is how
 * `deleteGroup`'s 23503 handler shipped in 3a while a group a live grant named
 * still 500'd on delete.
 *
 * Both levels are read rather than only the nested one, so this keeps working
 * if a future Drizzle stops wrapping.
 */
export function pgErrorCode(cause: unknown): string | undefined {
	for (const candidate of [cause, (cause as { cause?: unknown })?.cause]) {
		if (typeof candidate !== 'object' || candidate === null) continue;
		const code = (candidate as { code?: unknown }).code;
		if (typeof code === 'string') return code;
	}

	return undefined;
}
