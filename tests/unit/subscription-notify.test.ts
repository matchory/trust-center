import { describe, expect, it } from 'vitest';
import { planNotices } from '../../src/lib/server/subscriptions/notify';
import type { NoticePost, NoticeSubscription } from '../../src/lib/server/subscriptions/notify';

const OPTIONS = {
	baseUrl: 'https://trust.example',
	enabledLocales: ['de', 'en'],
	defaultLocale: 'de'
};

function post(seed: Partial<NoticePost> & { id: string; publishedAt: Date }): NoticePost {
	const { id, ...rest } = seed;
	return {
		...rest,
		slug: seed.slug ?? id,
		translations: seed.translations ?? [
			{ locale: 'de', title: `Titel ${id}`, body: 'Rumpf' },
			{ locale: 'en', title: `Title ${id}`, body: 'Body' }
		]
	};
}

function subscriber(posts: NoticePost[], locale = 'de'): NoticeSubscription {
	return { id: 'sub-1', email: 'a@example.test', locale, manageToken: 'tok', posts };
}

describe('planNotices', () => {
	it('builds one mail with an item per post', () => {
		const plan = planNotices(
			[
				subscriber([
					post({ id: 'a', slug: 'alpha', publishedAt: new Date('2026-03-01T10:00:00Z') }),
					post({ id: 'b', slug: 'beta', publishedAt: new Date('2026-03-02T10:00:00Z') })
				])
			],
			OPTIONS
		)[0]!;

		expect(plan.mail?.payload.items).toHaveLength(2);
		expect(plan.mail?.payload.items[0]).toEqual({
			title: 'Titel a',
			url: 'https://trust.example/de/updates#alpha',
			isFallback: false
		});
		expect(plan.mail?.payload.url).toBe('https://trust.example/de/subscribe/manage?token=tok');
	});

	// P4.7: never now(). A post going live between the select and the update
	// would otherwise be stepped over and never sent.
	it('advances the cursor to the maximum publishedAt actually included', () => {
		const plan = planNotices(
			[
				subscriber([
					post({ id: 'a', publishedAt: new Date('2026-03-01T10:00:00Z') }),
					post({ id: 'b', publishedAt: new Date('2026-03-02T10:00:00Z') })
				])
			],
			OPTIONS
		)[0]!;

		expect(plan.cursor.toISOString()).toBe('2026-03-02T10:00:00.000Z');
	});

	it('gives two subscribers with different posts different cursors', () => {
		const early = post({ id: 'a', publishedAt: new Date('2026-03-01T10:00:00Z') });
		const late = post({ id: 'b', publishedAt: new Date('2026-03-05T10:00:00Z') });

		const plans = planNotices(
			[
				{ ...subscriber([early]), id: 'sub-1' },
				{ ...subscriber([early, late]), id: 'sub-2' }
			],
			OPTIONS
		);

		expect(plans[0]!.cursor.toISOString()).toBe('2026-03-01T10:00:00.000Z');
		expect(plans[1]!.cursor.toISOString()).toBe('2026-03-05T10:00:00.000Z');
	});

	// §6.4: a post with no usable translation is skipped, and the cursor still
	// advances — reconsidering it every fifteen minutes forever would be a slow
	// loop that never terminates.
	it('skips a post with no title in the requested or default locale, and still advances', () => {
		const plan = planNotices(
			[
				subscriber([
					post({
						id: 'a',
						publishedAt: new Date('2026-03-01T10:00:00Z'),
						translations: [{ locale: 'fr', title: 'Titre', body: 'Corps' }]
					})
				])
			],
			OPTIONS
		)[0]!;

		expect(plan.mail).toBeNull();
		expect(plan.cursor.toISOString()).toBe('2026-03-01T10:00:00.000Z');
	});

	// The cursor must advance past a post that was SKIPPED, not only past ones
	// that were sent (§6.4). A single-post subscription can't distinguish this
	// from the pre-loop seed at notify.ts — this needs a usable post and a
	// later, unsendable one in the same subscription.
	it('advances past a skipped post that is later than the last usable one', () => {
		const plan = planNotices(
			[
				subscriber([
					post({ id: 'a', publishedAt: new Date('2026-03-01T10:00:00Z') }),
					post({
						id: 'b',
						publishedAt: new Date('2026-03-05T10:00:00Z'),
						translations: [{ locale: 'fr', title: 'Titre', body: 'Corps' }]
					})
				])
			],
			OPTIONS
		)[0]!;

		// One item in the mail — post 'b' was skipped …
		expect(plan.mail?.payload.items).toHaveLength(1);
		// … but the cursor still moved past it, so it is never reconsidered.
		expect(plan.cursor.toISOString()).toBe('2026-03-05T10:00:00.000Z');
	});

	it('skips a post with no translations at all', () => {
		const plan = planNotices(
			[
				subscriber([
					post({ id: 'a', publishedAt: new Date('2026-03-01T10:00:00Z'), translations: [] })
				])
			],
			OPTIONS
		)[0]!;

		expect(plan.mail).toBeNull();
		expect(plan.cursor.toISOString()).toBe('2026-03-01T10:00:00.000Z');
	});

	it('labels a title that resolved by fallback', () => {
		const plan = planNotices(
			[
				subscriber(
					[
						post({
							id: 'a',
							publishedAt: new Date('2026-03-01T10:00:00Z'),
							translations: [{ locale: 'de', title: 'Nur Deutsch', body: 'Rumpf' }]
						})
					],
					'en'
				)
			],
			OPTIONS
		)[0]!;

		expect(plan.mail?.payload.items[0]?.title).toBe('Nur Deutsch');
		// The reader asked for English and got German; saying so is the rule the
		// portal already applies, and a mail must not silently swap languages.
		// The wording itself is `renderTemplate`'s, and pinned there.
		expect(plan.mail?.payload.items[0]?.isFallback).toBe(true);
	});

	// P4.20. `assertIsLocale` validates against the COMPILED catalogs, so a mail
	// in a disabled locale renders fine — and carries a manage link that 404s,
	// because classifyPath deliberately rejects a disabled prefix.
	it('falls back to the default locale when the subscriber locale was disabled', () => {
		const plan = planNotices(
			[subscriber([post({ id: 'a', publishedAt: new Date('2026-03-01T10:00:00Z') })], 'en')],
			{ ...OPTIONS, enabledLocales: ['de'] }
		)[0]!;

		expect(plan.mail?.locale).toBe('de');
		expect(plan.mail?.payload.url).toBe('https://trust.example/de/subscribe/manage?token=tok');
	});

	it('returns no plan at all for a subscriber with no posts', () => {
		expect(planNotices([subscriber([])], OPTIONS)).toEqual([]);
	});
});
