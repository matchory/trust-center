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
				text: mail.text,
				attachments: mail.attachments?.map((attachment) => ({
					filename: attachment.filename,
					contentType: attachment.contentType,
					content: Buffer.from(attachment.content)
				}))
			});

			return { providerId: info.messageId };
		}
	};
}
