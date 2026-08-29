import { createTransport } from 'nodemailer';
import type { MailAdapter } from './index';

export function createSmtpMailer(url: string): MailAdapter {
	const transport = createTransport(url);

	return {
		async send(mail) {
			const info = await transport.sendMail({
				to: mail.to,
				from: mail.from,
				subject: mail.subject,
				text: mail.text
			});

			return { providerId: info.messageId };
		}
	};
}
