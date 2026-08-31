import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { localizePath } from '$lib/i18n/locale';
import { parseAgreementBody } from '$lib/markdown/subset';
import { recordEvent } from '$lib/server/audit';
import { getConfig } from '$lib/server/config';
import { getDb } from '$lib/server/db/instance';
import { ndaTemplate, ndaTemplateTranslation } from '$lib/server/db/schema';
import { clientIp } from '$lib/server/http/client-ip';
import { recordAcceptance, VersionMoved } from '$lib/server/nda/acceptance';
import { effectiveVersion } from '$lib/server/nda/templates';
import { consumeRateLimit, rateLimitKey } from '$lib/server/ratelimit';
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
		try {
			({ acceptanceId } = await recordAcceptance(db, {
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
