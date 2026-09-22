import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { env } from '../config/env';
import { ConflictError, NotFoundError, BadRequestError, UnprocessableEntityError, ServiceUnavailableError } from '../utils/errors';
import { commitmentService } from './commitment.service';
import { DarajaStkGateway, type MpesaCallbackPayload, type StkPushGateway } from './payment.service';

interface AttemptRow extends QueryResultRow {
  id: string; commitment_id: string; membership_id: string; user_id: string; amount: string; currency: string;
  phone_number: string; merchant_request_id: string | null; checkout_request_id: string | null; receipt_number: string | null;
  status: 'pending' | 'confirmed' | 'failed' | 'reversed'; result_code: number | null; result_desc: string | null; completed_at: string | null;
}

export class CommitmentPaymentService {
  constructor(private readonly db: Pool = pool, private readonly gateway: StkPushGateway = new DarajaStkGateway()) {}

  async initiate(userId: string, membershipId: string, phoneNumber: string) {
    if (!env.MPESA_CALLBACK_URL) throw new ServiceUnavailableError('Commitment M-Pesa callback URL is not configured', 'COMMITMENT_MPESA_NOT_CONFIGURED');
    const context = (await this.db.query<{ commitment_id: string; amount: string }>(
      `SELECT cd.id AS commitment_id, cd.amount::text
         FROM commitment_deposits cd
         JOIN chama_members cm ON cm.id = cd.membership_id AND cm.user_id = cd.user_id
        WHERE cd.membership_id = $1 AND cm.user_id = $2 AND cd.state = 'applied'
        ORDER BY cd.cycle_no DESC LIMIT 1`,
      [membershipId, userId],
    )).rows[0];
    if (!context) throw new ConflictError('No payable commitment deposit exists for this membership', 'COMMITMENT_NOT_PAYABLE');
    const existing = await this.db.query<{ id: string }>(`SELECT id FROM commitment_payment_attempts WHERE commitment_id = $1 AND status = 'pending'`, [context.commitment_id]);
    if (existing.rows[0]) throw new ConflictError('A commitment payment is already pending', 'COMMITMENT_PAYMENT_PENDING');
    const attempt = (await this.db.query<{ id: string }>(
      `INSERT INTO commitment_payment_attempts (commitment_id, membership_id, user_id, amount, phone_number, request_payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [context.commitment_id, membershipId, userId, context.amount, normalizePhone(phoneNumber), JSON.stringify({ source: 'commitment_stk_init' })],
    )).rows[0];
    try {
      const provider = await this.gateway.initiate({ amount: BigInt(context.amount), phoneNumber: phoneNumber, accountReference: `MDC${attempt.id.replace(/-/g, '').slice(0, 9)}`, description: 'Commitment Fee', callbackUrl: env.MPESA_CALLBACK_URL });
      await this.db.query(`UPDATE commitment_payment_attempts SET merchant_request_id = $2, checkout_request_id = $3, request_payload = $4::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [attempt.id, provider.merchantRequestId, provider.checkoutRequestId, JSON.stringify(provider.requestPayload)]);
      return { paymentId: attempt.id, checkoutRequestId: provider.checkoutRequestId, merchantRequestId: provider.merchantRequestId, amount: context.amount, currency: 'KES' as const, status: 'pending' as const, customerMessage: provider.customerMessage ?? null };
    } catch (error) {
      await this.db.query(`UPDATE commitment_payment_attempts SET status = 'failed', result_desc = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $1`, [attempt.id, error instanceof Error ? error.message : 'STK initiation failed']);
      throw error;
    }
  }

  async processStkCallback(payload: MpesaCallbackPayload) {
    const callback = payload?.Body?.stkCallback;
    const checkoutId = callback?.CheckoutRequestID?.trim();
    if (!checkoutId || typeof callback?.ResultCode !== 'number') throw new BadRequestError('Invalid M-Pesa callback payload', undefined, 'MPESA_CALLBACK_INVALID');
    const attempt = (await this.db.query<AttemptRow>(`${attemptSelect()} WHERE checkout_request_id = $1`, [checkoutId])).rows[0];
    if (!attempt) throw new NotFoundError('Unknown commitment checkout request', 'COMMITMENT_CHECKOUT_UNKNOWN');
    if (attempt.status === 'confirmed') return { ...serialize(attempt), replayed: true };
    if (callback.ResultCode !== 0) {
      const failed = (await this.db.query<AttemptRow>(`UPDATE commitment_payment_attempts SET status = 'failed', result_code = $2, result_desc = $3, raw_payload = $4::jsonb, callback_verified_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [attempt.id, callback.ResultCode, callback.ResultDesc ?? null, JSON.stringify(payload)])).rows[0];
      return { ...serialize(failed), replayed: false };
    }
    const metadata = Object.fromEntries((callback.CallbackMetadata?.Item ?? []).filter((item) => item.Name).map((item) => [String(item.Name), item.Value ?? '']));
    const receipt = String(metadata.MpesaReceiptNumber ?? '').trim();
    const amount = BigInt(String(metadata.Amount ?? '0'));
    if (!receipt || amount !== BigInt(attempt.amount)) throw new UnprocessableEntityError('M-Pesa callback amount does not match the required commitment', { expectedAmount: attempt.amount, callbackAmount: amount.toString() }, 'COMMITMENT_CALLBACK_AMOUNT_MISMATCH');
    const used = await this.db.query<{ id: string }>(`SELECT id FROM commitment_payment_attempts WHERE receipt_number = $1 AND id <> $2`, [receipt, attempt.id]);
    if (used.rows[0]) throw new ConflictError('M-Pesa receipt is already linked to another commitment payment', 'MPESA_RECEIPT_CONFLICT');
    const commitment = await commitmentService.confirmHoldFromProvider({ membershipId: attempt.membership_id, provider: 'safaricom_daraja', providerReference: receipt, amount });
    const confirmed = (await this.db.query<AttemptRow>(`UPDATE commitment_payment_attempts SET status = 'confirmed', result_code = 0, result_desc = $2, receipt_number = $3, raw_payload = $4::jsonb, callback_verified_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [attempt.id, callback.ResultDesc ?? 'Success', receipt, JSON.stringify(payload)])).rows[0];
    return { ...serialize(confirmed), commitment, replayed: false };
  }
}

function attemptSelect() { return `SELECT id, commitment_id, membership_id, user_id, amount::text, currency, phone_number, merchant_request_id, checkout_request_id, receipt_number, status::text AS status, result_code, result_desc, completed_at::text FROM commitment_payment_attempts`; }
function serialize(row: AttemptRow) { return { paymentId: row.id, membershipId: row.membership_id, checkoutRequestId: row.checkout_request_id, merchantRequestId: row.merchant_request_id, amount: row.amount, currency: row.currency, status: row.status, receiptNumber: row.receipt_number, completedAt: row.completed_at }; }
function normalizePhone(phone: string) { const digits = phone.replace(/\D/g, ''); if (digits.startsWith('254') && digits.length === 12) return digits; if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`; if (digits.length === 9 && digits.startsWith('7')) return `254${digits}`; throw new BadRequestError('Phone number must be a valid Kenyan mobile number', undefined, 'PHONE_INVALID'); }

export const commitmentPaymentService = new CommitmentPaymentService();