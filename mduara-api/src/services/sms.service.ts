import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface SmsProvider {
  send(phone: string, message: string): Promise<void>;
}

/** Sends SMS via the Africa's Talking messaging REST API. */
class AfricasTalkingSmsProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<void> {
    const body = new URLSearchParams({
      username: env.AFRICASTALKING_USERNAME ?? '',
      to: phone,
      message,
      ...(env.AFRICASTALKING_SENDER_ID ? { from: env.AFRICASTALKING_SENDER_ID } : {}),
    });

    const response = await fetch(env.AFRICASTALKING_BASE_URL ?? 'https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        apiKey: env.AFRICASTALKING_API_KEY ?? '',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Africa's Talking SMS request failed with status ${response.status}: ${text}`);
    }

    const payload = (await response.json().catch(() => null)) as {
      SMSMessageData?: { Recipients?: Array<{ status: string; statusCode: number }> };
    } | null;

    const recipient = payload?.SMSMessageData?.Recipients?.[0];
    if (!recipient || recipient.statusCode !== 101) {
      throw new Error('Africa\'s Talking did not accept the SMS recipient');
    }
  }
}

/** Development fallback that logs instead of dispatching a real SMS. */
class ConsoleSmsProvider implements SmsProvider {
  async send(phone: string, message: string): Promise<void> {
    logger.info('SMS (console provider)', { phone, message });
  }
}

const provider: SmsProvider =
  env.SMS_PROVIDER === 'africastalking' ? new AfricasTalkingSmsProvider() : new ConsoleSmsProvider();

export class SmsService {
  async sendMessage(phone: string, message: string): Promise<void> {
    await provider.send(phone, message);
  }

  async sendOtp(phone: string, code: string, expiresMinutes: number): Promise<void> {
    const message = `Your M-Duara verification code is ${code}. It expires in ${expiresMinutes} minutes. Do not share this code.`;
    await provider.send(phone, message);
  }
}

export const smsService = new SmsService();
