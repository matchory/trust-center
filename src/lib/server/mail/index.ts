import { getConfig } from '../config';
import { createSmtpMailer } from './smtp';

export interface OutgoingMail {
	to: string;
	from: string;
	subject: string;
	text: string;
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
