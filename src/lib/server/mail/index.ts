import { getConfig } from '../config';
import { createSmtpMailer } from './smtp';

/**
 * What a queue row records about a file it carries: the storage key, never the
 * bytes.
 *
 * `outbound_email.payload` is jsonb, it is retained until `redactDeliveredMail`
 * clears it, and `purgeRequester` must be able to blank it. A base64 PDF in
 * that column would make every purge and every retention sweep move megabytes,
 * and would put a second full copy of a signed record somewhere with its own
 * lifetime. The drain loop resolves the key at send time instead — which is
 * also why no migration is needed here.
 */
export interface MailAttachment {
	filename: string;
	contentType: string;
	storageKey: string;
}

export interface OutgoingMail {
	to: string;
	from: string;
	subject: string;
	text: string;
	/** Resolved bytes, not keys: by this point storage has already been read. */
	attachments?: readonly { filename: string; contentType: string; content: Uint8Array }[];
}

/** The mail boundary (spec §6.4). SMTP today; Resend or Postmark later. */
export interface MailAdapter {
	send(mail: OutgoingMail): Promise<{ providerId: string | undefined }>;
}

export class MailNotConfigured extends Error {
	constructor() {
		super('SMTP_URL is not set; no mail can be sent.');
		this.name = 'MailNotConfigured';
	}
}

let cached: MailAdapter | undefined;

/**
 * Lazy, like getConfig() and getDb(): importing this must not require config.
 * A deployment with no SMTP_URL is valid — `pnpm build` and the unit suite both
 * run that way — so the absence surfaces when a send is attempted rather than
 * preventing the application from starting.
 */
export function getMailer(): MailAdapter {
	const { mail } = getConfig();
	if (!mail.smtpUrl) throw new MailNotConfigured();
	return (cached ??= createSmtpMailer(mail.smtpUrl));
}

export { createSmtpMailer };
