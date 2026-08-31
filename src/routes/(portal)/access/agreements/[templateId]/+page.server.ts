import { fail, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { localizePath } from '$lib/i18n/locale';
import { parseAgreementBody } from '$lib/markdown/subset';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { ndaTemplate, ndaTemplateTranslation } from '$lib/server/db/schema';
import { clientIp } from '$lib/server/http/client-ip';
import { enqueueEmail } from '$lib/server/mail/queue';
import { recordAcceptance, VersionMoved } from '$lib/server/nda/acceptance';
import { activateGrants } from '$lib/server/nda/activation';
import { acceptanceScope } from '$lib/server/nda/settings';
import { renderRecord, storeRecord } from '$lib/server/nda/record';
import { effectiveVersion } from '$lib/server/nda/templates';
import type { EffectiveVersion } from '$lib/server/nda/templates';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
import { getStorage } from '$lib/server/storage';
import type { Actions, PageServerLoad } from './$types';

type AcceptFailure = { failed: true; moved?: true; nameRequired?: true };

export const load: PageServerLoad = async ({ params, locals }) => {
	const requester = locals.requester;
	if (!requester) redirect(303, localizePath('/request', locals.locale));

	const db = getDb();
	const config = getConfig();

	const [template] = await db
		.select({ id: ndaTemplate.id, slug: ndaTemplate.slug })
		.from(ndaTemplate)
		.where(eq(ndaTemplate.id, params.templateId))
		.limit(1);

	// Not a 404 with a reason: which agreements exist is not this reader's
	// business, and an id that names nothing looks the same as one they were
	// never asked for.
	if (!template) redirect(303, localizePath('/access/agreements', locals.locale));

	const [name] = await db
		.select({ name: ndaTemplateTranslation.name })
		.from(ndaTemplateTranslation)
		.where(eq(ndaTemplateTranslation.templateId, template.id))
		.limit(1);

	const effective = await effectiveVersion(db, template.id, config.locales);
	const body = effective?.bodies[locals.locale];

	// §5.2: the page refuses to render rather than falling back to another
	// locale. Presenting somebody a contract in a language they did not choose
	// is worse than telling them the page is unavailable.
	if (!effective || !body) {
		return { slug: template.slug, name: name?.name ?? template.slug, agreement: null };
	}

	return {
		slug: template.slug,
		name: name?.name ?? template.slug,
		agreement: {
			versionId: effective.versionId,
			sha256: body.sha256,
			root: parseAgreementBody(body.bodyMd)
		}
	};
};

export const actions: Actions = {
	default: async (event) => {
		const requester = event.locals.requester;
		if (!requester) redirect(303, localizePath('/request', event.locals.locale));

		const db = getDb();
		const config = getConfig();
		const ip = clientIp(event);

		// A missing client address falls back to a shared bucket rather than
		// skipping the check — the same choice every other requester-facing
		// endpoint makes.
		const limited = await consumeRateLimit(db, {
			key: rateLimitKey('accept:ip', ip ?? 'unknown'),
			limit: 20,
			windowSeconds: 3600
		});
		if (!limited.allowed) return fail<AcceptFailure>(429, { failed: true });

		const form = await event.request.formData();
		const typedName = String(form.get('typedName') ?? '').trim();
		const versionId = String(form.get('versionId') ?? '');
		const sha256 = String(form.get('sha256') ?? '');

		// A signature needs a name on it. Refused here rather than by a database
		// constraint, so the reader is told which field to fix.
		if (!typedName) return fail<AcceptFailure>(400, { failed: true, nameRequired: true });

		let acceptanceId: string;
		let created: boolean;
		let effective: EffectiveVersion;
		try {
			({ acceptanceId, created, effective } = await recordAcceptance(db, {
				requesterId: requester.id,
				versionId,
				typedName,
				sha256,
				ip,
				ua: event.request.headers.get('user-agent'),
				locales: config.locales
			}));
		} catch (cause) {
			// The version moved while they were reading. Re-rendering is the whole
			// remedy: they read the current text and accept that instead.
			if (cause instanceof VersionMoved) {
				return fail<AcceptFailure>(409, { failed: true, moved: true });
			}
			throw cause;
		}

		// Rendered inside this response rather than by a job (§12 deviation 12): a
		// job would leave a window in which the acceptance exists as a row with no
		// evidence behind it, while the requester has already been told otherwise.
		// A re-submit is the same acceptance, so it renders nothing — a second
		// render would orphan the first object and restamp the record's own date.
		if (created) {
			// The version `recordAcceptance` resolved inside its transaction, not a
			// second lookup: it validated the submitted hash against exactly these
			// bytes, and asking again out here invites a different answer.
			const body = effective.bodies[event.locals.locale];

			if (body) {
				const [name] = await db
					.select({ name: ndaTemplateTranslation.name })
					.from(ndaTemplateTranslation)
					.where(
						and(
							eq(ndaTemplateTranslation.templateId, event.params.templateId),
							eq(ndaTemplateTranslation.locale, event.locals.locale)
						)
					)
					.limit(1);

				const agreement = name?.name ?? event.params.templateId;
				const storageKey = await storeRecord(
					db,
					getStorage(),
					acceptanceId,
					await renderRecord({
						fontDir: config.ndaFontDir,
						title: agreement,
						version: effective.version,
						bodyMd: body.bodyMd,
						typedName,
						email: requester.email,
						company: requester.company,
						acceptedAt: new Date(),
						ip,
						sha256: body.sha256,
						locale: event.locals.locale
					})
				);

				const attachments = [
					{ filename: 'acceptance.pdf', contentType: 'application/pdf', storageKey }
				];

				// §9.5: an unset STAFF_NOTIFICATION_EMAIL is a valid deployment. "Both
				// parties get a copy" then degrades to one, and the operator's copy is
				// the stored object and the admin view — the record never depends on
				// mail having been configured. Each copy renders in its own reader's
				// locale, which is why the operator's is not simply a second address.
				const copies = [{ to: requester.email, locale: event.locals.locale }];
				if (config.mail.staffNotificationEmail) {
					copies.push({
						to: config.mail.staffNotificationEmail,
						locale: config.defaultLocale
					});
				}

				for (const copy of copies) {
					await enqueueEmail(db, {
						...copy,
						template: 'nda_record',
						payload: { agreement, attachments }
					});
				}
			}
		}

		// One acceptance can complete several grants — a prospect who asked twice
		// before signing once — so this is a set operation, not a call about the
		// grant that happened to send them here.
		await activateGrants(db, requester.id, {
			scope: await acceptanceScope(db),
			locales: config.locales
		});

		// The typed name and the address are the requester's own data, so neither
		// reaches `meta` — §10 keeps that to the identifiers a reader needs.
		await recordEvent(db, {
			action: 'nda_acceptance.recorded',
			actor: { type: 'requester', id: requester.id },
			subjectType: 'nda_acceptance',
			subjectId: acceptanceId,
			ip: ip ?? undefined,
			ua: event.request.headers.get('user-agent') ?? undefined,
			meta: { templateId: event.params.templateId, versionId }
		});

		redirect(303, localizePath('/access/agreements', event.locals.locale));
	}
};
