import nodemailer from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const transport = env.EMAIL_PROVIDER === 'smtp' ? nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  requireTLS: !env.SMTP_SECURE,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 10_000,
}) : undefined;

export const emailService = {
  async send(to: string, subject: string, text: string, deliveryId: string): Promise<void> {
    if (!transport) {
      logger.info('Email (console provider)', { deliveryId, subject });
      return;
    }
    const result = await transport.sendMail({
      from: env.EMAIL_FROM, to, subject, text, messageId: `<${deliveryId}@reminders.mduara>`,
    });
    if (!result.accepted.length || result.rejected.length) throw new Error('SMTP server did not accept the recipient');
  },
  close(): void { transport?.close(); },
};
