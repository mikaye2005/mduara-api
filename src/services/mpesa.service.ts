import { env } from '../config/env';
import { ServiceUnavailableError } from '../utils/errors';

export interface B2CPayoutRequest {
	amount: bigint;
	phoneNumber: string;
	reference: string;
	remarks: string;
	resultUrl?: string;
	timeoutUrl?: string;
}

export interface B2CPayoutResult {
	providerReference: string;
}

/** Minimal Daraja B2C boundary; provider callbacks remain the source of final settlement truth. */
export class MpesaService {
	async dispatchB2CPayout(request: B2CPayoutRequest): Promise<B2CPayoutResult> {
		const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_B2C_INITIATOR_NAME, MPESA_B2C_SECURITY_CREDENTIAL } = env;
		const resultUrl = request.resultUrl ?? env.MPESA_B2C_RESULT_URL;
		const timeoutUrl = request.timeoutUrl ?? env.MPESA_B2C_TIMEOUT_URL;
		if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_B2C_INITIATOR_NAME || !MPESA_B2C_SECURITY_CREDENTIAL || !resultUrl || !timeoutUrl) {
			throw new ServiceUnavailableError('M-Pesa B2C payout is not configured');
		}

		const baseUrl = env.MPESA_ENVIRONMENT === 'production'
			? 'https://api.safaricom.co.ke'
			: 'https://sandbox.safaricom.co.ke';
		const tokenResponse = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
			headers: { Authorization: `Basic ${Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64')}` },
		});
		if (!tokenResponse.ok) throw new ServiceUnavailableError('Unable to authenticate with M-Pesa');
		const token = (await tokenResponse.json() as { access_token?: string }).access_token;
		if (!token) throw new ServiceUnavailableError('M-Pesa did not return an access token');

		const response = await fetch(`${baseUrl}/mpesa/b2c/v1/paymentrequest`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				InitiatorName: MPESA_B2C_INITIATOR_NAME,
				SecurityCredential: MPESA_B2C_SECURITY_CREDENTIAL,
				CommandID: 'BusinessPayment',
				Amount: request.amount.toString(),
				PartyA: MPESA_SHORTCODE,
				PartyB: normalizePhone(request.phoneNumber),
				Remarks: request.remarks,
				QueueTimeOutURL: timeoutUrl,
				ResultURL: resultUrl,
				Occasion: request.reference,
			}),
		});
		const body = await response.json() as { ConversationID?: string; errorMessage?: string };
		if (!response.ok || !body.ConversationID) {
			throw new ServiceUnavailableError(body.errorMessage ?? 'M-Pesa rejected the payout request');
		}
		return { providerReference: body.ConversationID };
	}
}

function normalizePhone(phone: string): string {
	const digits = phone.replace(/\D/g, '');
	return digits.startsWith('0') ? `254${digits.slice(1)}` : digits;
}

export const mpesaService = new MpesaService();
