import { m } from '../../paraglide/messages.js';
import { assertIsLocale } from '../../paraglide/runtime.js';
import type { MailAttachment } from './index';

export const MAIL_TEMPLATES = [
	'verify_request',
	'request_approved',
	// Split from `request_approved` rather than a clause inside it: under this
	// phase an approval sometimes means one step remains, and the two land the
	// reader in different places — the documents, or the agreement.
	'request_acceptance_required',
	'request_denied',
	'sign_in',
	'grant_expiring',
	// The nudge for an approval still waiting on a signature. Distinct from
	// `grant_expiring`: one says access is ending, the other says it never
	// started.
	'acceptance_expiring',
	'staff_new_request',
	// Carries the acceptance record as an attachment. The mail is a convenience:
	// the record itself is the stored object and the portal view, so a
	// deployment with no SMTP at all still produces the evidence.
	'nda_record',
	'subscription_confirm',
	'subscription_notice',
	'subscription_already'
] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

export interface RenderedMail {
	subject: string;
	text: string;
}

export type MailPayload = Record<string, string | number | readonly MailAttachment[]>;

/**
 * Every message function is called with an explicit `locale` option, so these
 * render outside the request's AsyncLocalStorage — which matters, because the
 * drain job runs on a timer with no request in scope. A mail rendered in the
 * ambient locale would be whatever the last HTTP request happened to be.
 */
export function renderTemplate(
	id: MailTemplate,
	locale: string,
	payload: MailPayload
): RenderedMail {
	// Narrowed rather than cast: `locale` arrives from an outbound_email row, and
	// a row naming a locale this build has no catalog for is a real problem. The
	// throw is caught by the drain loop, which retries and then marks the mail
	// failed with the reason recorded — better than silently sending the base
	// locale to someone who asked for another.
	const options = { locale: assertIsLocale(locale) };
	const url = String(payload.url ?? '');
	const documentCount = String(payload.documentCount ?? 0);
	const agreementCount = String(payload.agreementCount ?? 0);
	const expiresAt = String(payload.expiresAt ?? '');
	const agreement = String(payload.agreement ?? '');
	const dueAt = String(payload.dueAt ?? '');
	// Pre-rendered by the notify job rather than carried as a structured list
	// (P4.15): `MailPayload` admits no array of objects, and widening it would
	// be a port change for a plain-text mail.
	const items = String(payload.items ?? '');
	const count = String(payload.count ?? 0);

	switch (id) {
		case 'verify_request':
			return {
				subject: m.mail_verify_request_subject({}, options),
				text: m.mail_verify_request_body({ url }, options)
			};
		case 'request_approved':
			return {
				subject: m.mail_request_approved_subject({}, options),
				text: m.mail_request_approved_body({ url, documentCount, expiresAt }, options)
			};
		case 'request_acceptance_required':
			return {
				subject: m.mail_request_acceptance_required_subject({}, options),
				text: m.mail_request_acceptance_required_body(
					{ url, documentCount, agreementCount },
					options
				)
			};
		case 'request_denied':
			return {
				subject: m.mail_request_denied_subject({}, options),
				text: m.mail_request_denied_body({ reason: String(payload.reason ?? '') }, options)
			};
		case 'sign_in':
			return {
				subject: m.mail_sign_in_subject({}, options),
				text: m.mail_sign_in_body({ url }, options)
			};
		case 'grant_expiring':
			return {
				subject: m.mail_grant_expiring_subject({}, options),
				text: m.mail_grant_expiring_body({ documentCount, expiresAt }, options)
			};
		case 'acceptance_expiring':
			return {
				subject: m.mail_acceptance_expiring_subject({}, options),
				text: m.mail_acceptance_expiring_body({ dueAt }, options)
			};
		case 'staff_new_request':
			return {
				subject: m.mail_staff_new_request_subject({}, options),
				text: m.mail_staff_new_request_body({ url }, options)
			};
		case 'nda_record':
			return {
				subject: m.mail_nda_record_subject({ agreement }, options),
				text: m.mail_nda_record_body({ agreement }, options)
			};
		case 'subscription_confirm':
			return {
				subject: m.mail_subscription_confirm_subject({}, options),
				text: m.mail_subscription_confirm_body({ url }, options)
			};
		case 'subscription_notice':
			return {
				subject: m.mail_subscription_notice_subject({}, options),
				text: m.mail_subscription_notice_body({ url, items, count }, options)
			};
		case 'subscription_already':
			return {
				subject: m.mail_subscription_already_subject({}, options),
				text: m.mail_subscription_already_body({ url }, options)
			};
	}
}
