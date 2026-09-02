import { sql } from 'drizzle-orm';
import { localizePath, pickTranslation } from '../../i18n/locale';
import { managePath, subscriptionLocale } from './index';
import { outboundEmail } from '../db/schema';
import type { Db } from '../db';
import type { MailNoticeItem, MailTemplate } from '../mail/templates';

export interface NoticePost {
	slug: string;
	publishedAt: Date;
	translations: readonly { locale: string; title: string; body: string }[];
}

export interface NoticeSubscription {
	id: string;
	email: string;
	locale: string;
	manageToken: string;
	/** Already filtered by cursor and topics by the query; ordered oldest first. */
	posts: readonly NoticePost[];
}

export interface NoticePlan {
	subscriptionId: string;
	/** Always the maximum `publishedAt` included, never `now()` (P4.7). */
	cursor: Date;
	mail: {
		to: string;
		locale: string;
		payload: { url: string; items: readonly MailNoticeItem[] };
	} | null;
}

/**
 * Every decision a notice involves, with no database in the way: which posts
 * survive the translation rules, what the cursor becomes, which locale is used,
 * and whether there is anything left to send.
 *
 * A subscription with posts always yields a plan, even when the mail is null —
 * the cursor must advance either way, or unsendable posts would be reconsidered
 * every fifteen minutes forever (§6.4).
 */
export function planNotices(
	subscriptions: readonly NoticeSubscription[],
	options: {
		baseUrl: string;
		enabledLocales: readonly string[];
		defaultLocale: string;
	}
): NoticePlan[] {
	const plans: NoticePlan[] = [];

	for (const item of subscriptions) {
		if (item.posts.length === 0) continue;

		const locale = subscriptionLocale(item.locale, options.enabledLocales, options.defaultLocale);

		const items: MailNoticeItem[] = [];
		let cursor = item.posts[0]!.publishedAt;

		for (const post of item.posts) {
			// Per subscription, not per tick: two subscribers with different topic
			// sets legitimately end the same tick at different cursors.
			if (post.publishedAt > cursor) cursor = post.publishedAt;

			const title = pickTranslation(
				post.translations.map((row) => ({ locale: row.locale, value: row.title })),
				locale,
				options.defaultLocale
			);
			const body = pickTranslation(
				post.translations.map((row) => ({ locale: row.locale, value: row.body })),
				locale,
				options.defaultLocale
			);
			// The same two rules the portal applies, for the same reason.
			if (!title || !body) continue;

			items.push({
				title: title.value,
				url: `${options.baseUrl}${localizePath('/updates', locale)}#${post.slug}`,
				isFallback: title.isFallback
			});
		}

		plans.push({
			subscriptionId: item.id,
			cursor,
			mail:
				items.length === 0
					? null
					: {
							to: item.email,
							locale,
							payload: {
								items,
								url: `${options.baseUrl}${managePath(item.manageToken, locale)}`
							}
						}
		});
	}

	return plans;
}

/** The tick's bound. `drainOutbox` is bounded for the same reason: `runJob`
 * holds a transaction-scoped advisory lock for the whole run, so an unbounded
 * tick holds it for an unbounded time. */
const DEFAULT_LIMIT = 500;

/** The grouping builder's view of a post, before it is handed to planNotices
 * as readonly. */
type MutablePost = Omit<NoticePost, 'translations'> & {
	translations: { locale: string; title: string; body: string }[];
};

/**
 * One select, rendering in memory, then one transaction of two statements
 * (P4.19). Not one transaction per subscriber — that is the N+1 the select was
 * shaped to avoid, reintroduced on the write side.
 *
 * The transaction makes queueing and advancing atomic, which makes the job
 * at-least-once rather than at-most-once: a crash before the commit re-sends
 * rather than skips.
 */
export async function notifySubscribers(
	db: Db,
	options: {
		baseUrl: string;
		enabledLocales: readonly string[];
		defaultLocale: string;
		limit?: number;
	}
): Promise<{ queued: number; advanced: number }> {
	const limit = options.limit ?? DEFAULT_LIMIT;

	// One query, joining subscription → subscription_topic → update_post →
	// update_post_translation. The subscriptions are bounded and ordered by
	// last_notified_at ascending so the most overdue go first; the posts and
	// translations ride along, so the tick costs one round trip regardless of
	// how many subscribers it serves.
	const rows = (await db.execute(sql`
		WITH due AS (
			SELECT s.id, s.email, s.locale, s.manage_token, s.last_notified_at
			FROM subscription s
			WHERE s.confirmed_at IS NOT NULL
			  AND EXISTS (
				SELECT 1
				FROM subscription_topic t
				JOIN update_post p ON p.kind = t.topic
				WHERE t.subscription_id = s.id
				  AND p.published_at > s.last_notified_at
				  AND p.published_at <= now()
			  )
			ORDER BY s.last_notified_at ASC
			LIMIT ${limit}
		)
		SELECT
			due.id            AS subscription_id,
			due.email         AS email,
			due.locale        AS locale,
			due.manage_token  AS manage_token,
			p.id              AS post_id,
			p.slug            AS slug,
			p.published_at    AS published_at,
			tr.locale         AS translation_locale,
			tr.title          AS title,
			tr.body           AS body
		FROM due
		JOIN subscription_topic t ON t.subscription_id = due.id
		JOIN update_post p
			ON p.kind = t.topic
		 AND p.published_at > due.last_notified_at
		 AND p.published_at <= now()
		LEFT JOIN update_post_translation tr ON tr.post_id = p.id
		ORDER BY due.id, p.published_at ASC
	`)) as unknown as {
		subscription_id: string;
		email: string;
		locale: string;
		manage_token: string;
		post_id: string;
		slug: string;
		published_at: Date;
		translation_locale: string | null;
		title: string | null;
		body: string | null;
	}[];

	if (rows.length === 0) return { queued: 0, advanced: 0 };

	// Group the flat result back into the shape planNotices takes. Built in
	// mutable locals rather than casting the readonly arrays away: the readonly
	// on the interface is for planNotices' callers, and the builder is not one.
	type Building = Omit<NoticeSubscription, 'posts'> & { posts: MutablePost[] };
	const bySubscription = new Map<string, Building>();
	const byPost = new Map<string, MutablePost>();

	for (const row of rows) {
		let item = bySubscription.get(row.subscription_id);
		if (!item) {
			item = {
				id: row.subscription_id,
				email: row.email,
				locale: row.locale,
				manageToken: row.manage_token,
				posts: []
			};
			bySubscription.set(row.subscription_id, item);
		}

		const key = `${row.subscription_id}:${row.post_id}`;
		let post = byPost.get(key);
		if (!post) {
			post = {
				slug: row.slug,
				publishedAt: new Date(row.published_at),
				translations: []
			};
			byPost.set(key, post);
			item.posts.push(post);
		}

		// LEFT JOIN, so a post with no translation at all arrives with nulls and
		// is skipped by planNotices rather than vanishing from the cursor.
		if (row.translation_locale && row.title !== null && row.body !== null) {
			post.translations.push({
				locale: row.translation_locale,
				title: row.title,
				body: row.body
			});
		}
	}

	const plans = planNotices([...bySubscription.values()], options);
	if (plans.length === 0) return { queued: 0, advanced: 0 };

	const mails = plans.filter((plan) => plan.mail !== null);

	await db.transaction(async (tx) => {
		if (mails.length > 0) {
			await tx.insert(outboundEmail).values(
				mails.map((plan) => ({
					to: plan.mail!.to,
					template: 'subscription_notice' satisfies MailTemplate,
					locale: plan.mail!.locale,
					payload: plan.mail!.payload
				}))
			);
		}

		// One UPDATE … FROM (VALUES …) for every cursor, including the ones whose
		// mail came back empty: those posts were considered and found unsendable,
		// and reconsidering them every fifteen minutes forever would be a slow
		// loop that never terminates (§6.4).
		const values = sql.join(
			plans.map(
				(plan) => sql`(${plan.subscriptionId}::uuid, ${plan.cursor.toISOString()}::timestamptz)`
			),
			sql`, `
		);
		await tx.execute(sql`
			UPDATE subscription
			SET last_notified_at = v.cursor
			FROM (VALUES ${values}) AS v(id, cursor)
			WHERE subscription.id = v.id
		`);
	});

	return { queued: mails.length, advanced: plans.length };
}
