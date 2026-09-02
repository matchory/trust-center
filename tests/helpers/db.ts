import { and, desc, eq } from 'drizzle-orm';
import { outboundEmail } from '../../src/lib/server/db/schema';
import type { Db } from '../../src/lib/server/db';

/**
 * Drizzle wraps driver errors: `message` is only `Failed query: <sql> params: …`,
 * so asserting on it matches the statement text rather than the database's
 * complaint — and passes whenever the phrase happens to appear in the SQL or a
 * bound parameter. The Postgres message is on `cause`.
 */
export async function rejectionCause(query: PromiseLike<unknown>): Promise<string> {
	try {
		await query;
	} catch (error) {
		const wrapped = error as Error & { cause?: Error };
		return wrapped.cause?.message ?? wrapped.message;
	}
	throw new Error('expected the query to be rejected, but it succeeded');
}

/**
 * The link out of the newest queued mail of one template. Filtered by template,
 * not just by recipient: a spec that queues several kinds of mail to one address
 * would otherwise silently follow the wrong link the moment the order changes.
 */
export async function lastMailUrl(db: Db, to: string, template: string): Promise<string> {
	const [row] = await db
		.select({ payload: outboundEmail.payload })
		.from(outboundEmail)
		.where(and(eq(outboundEmail.to, to), eq(outboundEmail.template, template)))
		.orderBy(desc(outboundEmail.createdAt));
	if (!row) throw new Error(`no ${template} mail queued for ${to}`);
	const payload = row.payload as { url?: string };
	if (!payload.url) throw new Error(`${template} mail carried no url`);
	return payload.url;
}
