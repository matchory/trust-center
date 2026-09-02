import { localizePath, pickTranslation } from '../../i18n/locale';
import { m } from '../../paraglide/messages.js';
import { assertIsLocale } from '../../paraglide/runtime.js';

export interface NoticePost {
	id: string;
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
		payload: { url: string; items: string; count: number };
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

		// The stored locale can name one the operator has since removed from
		// LOCALES. The mail would still render — `assertIsLocale` validates
		// against the compiled catalogs, not the enabled ones — but the manage
		// link it carries would 404, because `classifyPath` rejects a disabled
		// prefix. A dead unsubscribe link is the defect §4.2 is about (P4.20).
		const locale = options.enabledLocales.includes(item.locale)
			? item.locale
			: options.defaultLocale;
		const messageOptions = { locale: assertIsLocale(locale) };

		const lines: string[] = [];
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

			const label = title.isFallback
				? ` (${m.mail_subscription_notice_fallback({}, messageOptions)})`
				: '';
			const url = `${options.baseUrl}${localizePath('/updates', locale)}#${post.slug}`;
			lines.push(`${title.value}${label}\n${url}`);
		}

		plans.push({
			subscriptionId: item.id,
			cursor,
			mail:
				lines.length === 0
					? null
					: {
							to: item.email,
							locale,
							payload: {
								// Pre-rendered rather than structured (P4.15): MailPayload admits
								// no array of objects, and widening it would be a port change.
								items: lines.join('\n\n'),
								count: lines.length,
								url: `${options.baseUrl}${localizePath(
									`/subscribe/manage?token=${encodeURIComponent(item.manageToken)}`,
									locale
								)}`
							}
						}
		});
	}

	return plans;
}
