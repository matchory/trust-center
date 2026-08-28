import { getConfig } from '$lib/server/config';
import { listPublicAnswers } from '$lib/server/content/answers';
import { listPublicCertifications } from '$lib/server/content/certifications';
import { listPublicControlGroups } from '$lib/server/content/controls';
import { listPublicDocuments } from '$lib/server/content/documents';
import { listPublicSubprocessors } from '$lib/server/content/subprocessors';
import { listPublicUpdates } from '$lib/server/content/updates';
import { getDb } from '$lib/server/db/instance';
import { localizePath } from '$lib/i18n/locale';
import type { RequestHandler } from './$types';

const escapeXml = (value: string) =>
	value.replace(/[<>&'"]/g, (char) =>
		char === '<'
			? '&lt;'
			: char === '>'
				? '&gt;'
				: char === '&'
					? '&amp;'
					: char === "'"
						? '&apos;'
						: '&quot;'
	);

export const GET: RequestHandler = async ({ setHeaders }) => {
	const { baseUrl, locales, defaultLocale } = getConfig();
	const db = getDb();
	const opts = { locale: defaultLocale, defaultLocale };

	// A section appears only when it has something published. Listing an empty
	// page invites a crawler to index nothing, and — more importantly — the
	// content queries are the same public read models the pages use, so a gated
	// document cannot reach the sitemap by a different path than it reaches the
	// page. That equivalence is what the security test relies on.
	const [documents, controls, subprocessors, answers, updates, certifications] = await Promise.all([
		listPublicDocuments(db, opts),
		listPublicControlGroups(db, opts),
		listPublicSubprocessors(db, opts),
		listPublicAnswers(db, opts),
		listPublicUpdates(db, opts),
		listPublicCertifications(db, opts)
	]);

	const paths = [
		'/',
		...(documents.length > 0 ? ['/documents'] : []),
		...(controls.length > 0 ? ['/controls'] : []),
		...(subprocessors.current.length + subprocessors.former.length > 0 ? ['/subprocessors'] : []),
		...(answers.length > 0 ? ['/faq'] : []),
		...(updates.length > 0 ? ['/updates'] : [])
	];
	void certifications; // rendered on '/', which is always listed

	const urls = paths
		.flatMap((path) =>
			locales.map((locale) => {
				const alternates = locales
					.map(
						(alternate) =>
							`\t\t<xhtml:link rel="alternate" hreflang="${alternate}" href="${escapeXml(
								`${baseUrl}${localizePath(path, alternate)}`
							)}" />`
					)
					.join('\n');

				return `\t<url>\n\t\t<loc>${escapeXml(`${baseUrl}${localizePath(path, locale)}`)}</loc>\n${alternates}\n\t</url>`;
			})
		)
		.join('\n');

	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=600, must-revalidate' });

	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`,
		{ headers: { 'content-type': 'application/xml; charset=utf-8' } }
	);
};
