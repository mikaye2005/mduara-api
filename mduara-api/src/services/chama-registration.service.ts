import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import type { CreateChamaParams } from '../shared/business_base';
import { ConflictError, NotFoundError, ServiceUnavailableError, UnprocessableEntityError, BadRequestError } from '../utils/errors';
import { DarajaStkGateway, type MpesaCallbackPayload, type StkPushGateway } from './payment.service';
import { chamaService } from './chama.service';

const REGISTRATION_FEE = 3000n;

export interface StartChamaRegistrationInput {
  founderId: string;
  phoneNumber: string;
  creation: CreateChamaParams;
}

interface RegistrationPaymentRow extends QueryResultRow {
  id: string;
  founder_id: string;
  chama_id: string | null;
  creation_payload: CreateChamaParams;
  amount: string;
  currency: string;
  phone_number: string;
  merchant_request_id: string | null;
  checkout_request_id: string | null;
  receipt_number: string | null;
  status: 'pending' | 'confirmed' | 'failed' | 'reversed';
  result_code: number | null;
  result_desc: string | null;
  paid_at: string | null;
}

export class ChamaRegistrationService {
  constructor(
    private readonly db: Pool = pool,
    private readonly gateway: StkPushGateway = new DarajaStkGateway(),
  ) {}

  async initiate(input: StartChamaRegistrationInput) {
    if (!env.MPESA_CALLBACK_URL) {
      throw new ServiceUnavailableError('Chama registration M-Pesa callback URL is not configured', 'CHAMA_REGISTRATION_MPESA_NOT_CONFIGURED');
    }
    const prepared = await withDatabaseTransaction(async (client) => {
      const pending = await client.query<{ id: string }>(
        `SELECT id FROM chama_registration_payments
          WHERE founder_id = $1 AND status = 'pending'
          FOR UPDATE`,
        [input.founderId],
      );
      if (pending.rows[0]) {
        throw new ConflictError('You already have a pending Chama registration payment', 'CHAMA_REGISTRATION_PAYMENT_PENDING');
      }
      const payment = (await client.query<{ id: string }>(
        `INSERT INTO chama_registration_payments
           (founder_id, creation_payload, amount, phone_number, status, request_payload)
         VALUES ($1,$2::jsonb,$3,$4,'pending',$5::jsonb)
         RETURNING id`,
        [
          input.founderId,
          JSON.stringify(input.creation),
          REGISTRATION_FEE.toString(),
          normalizeKenyanPhone(input.phoneNumber),
          JSON.stringify({ source: 'chama_registration_stk_init' }),
        ],
      )).rows[0];
      return { paymentId: payment.id, phoneNumber: normalizeKenyanPhone(input.phoneNumber) };
    }, {}, this.db);

    try {
      const provider = await this.gateway.initiate({
        amount: REGISTRATION_FEE,
        phoneNumber: prepared.phoneNumber,
        accountReference: `MDR${prepared.paymentId.replace(/-/g, '').slice(0, 9)}`,
        description: 'Chama Registration',
        callbackUrl: env.MPESA_CALLBACK_URL,
      });
      await this.db.query(
        `UPDATE chama_registration_payments
            SET merchant_request_id = $2, checkout_request_id = $3, request_payload = $4::jsonb, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'pending'`,
        [prepared.paymentId, provider.merchantRequestId, provider.checkoutRequestId, JSON.stringify(provider.requestPayload)],
      );
      return {
        paymentId: prepared.paymentId,
        checkoutRequestId: provider.checkoutRequestId,
        merchantRequestId: provider.merchantRequestId,
        amount: REGISTRATION_FEE.toString(),
        currency: 'KES' as const,
        status: 'pending' as const,
        customerMessage: provider.customerMessage ?? null,
      };
    } catch (error) {
      await this.db.query(
        `UPDATE chama_registration_payments
            SET status = 'failed', result_desc = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'pending'`,
        [prepared.paymentId, error instanceof Error ? error.message : 'STK initiation failed'],
      );
      throw error;
    }
  }

  async getStatus(founderId: string, checkoutRequestId: string) {
    const result = await this.db.query<RegistrationPaymentRow>(
      `${registrationPaymentSelect()} WHERE checkout_request_id = $1 AND founder_id = $2`,
      [checkoutRequestId, founderId],
    );
    if (!result.rows[0]) throw new NotFoundError('Chama registration payment not found', 'CHAMA_REGISTRATION_PAYMENT_NOT_FOUND');
    return serializeRegistrationPayment(result.rows[0]);
  }

  async processStkCallback(payload: MpesaCallbackPayload) {
    const callback = payload?.Body?.stkCallback;
    const checkoutRequestId = callback?.CheckoutRequestID?.trim();
    if (!checkoutRequestId || typeof callback?.ResultCode !== 'number') {
      throw new BadRequestError('Invalid M-Pesa callback payload', undefined, 'MPESA_CALLBACK_INVALID');
    }

    return withDatabaseTransaction(async (client) => {
      const payment = (await client.query<RegistrationPaymentRow>(
        `${registrationPaymentSelect()} WHERE checkout_request_id = $1 FOR UPDATE`,
        [checkoutRequestId],
      )).rows[0];
      if (!payment) throw new NotFoundError('Unknown Chama registration checkout request', 'CHAMA_REGISTRATION_CHECKOUT_UNKNOWN');
      if (payment.status === 'confirmed') return { ...serializeRegistrationPayment(payment), replayed: true };

      if (callback.ResultCode !== 0) {
        const failed = (await client.query<RegistrationPaymentRow>(
          `UPDATE chama_registration_payments
              SET status = 'failed', result_code = $2, result_desc = $3, raw_payload = $4::jsonb,
                  callback_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id, founder_id, chama_id, creation_payload, amount::text, currency, phone_number,
                      merchant_request_id, checkout_request_id, receipt_number, status::text AS status,
                      result_code, result_desc, paid_at::text`,
          [payment.id, callback.ResultCode, callback.ResultDesc ?? null, JSON.stringify(payload)],
        )).rows[0];
        return { ...serializeRegistrationPayment(failed), replayed: false };
      }

      const metadata = callbackMetadata(callback.CallbackMetadata?.Item ?? []);
      const receipt = String(metadata.MpesaReceiptNumber ?? '').trim();
      const amount = BigInt(String(metadata.Amount ?? '0'));
      if (!receipt || amount !== REGISTRATION_FEE || amount !== BigInt(payment.amount)) {
        throw new UnprocessableEntityError(
          'M-Pesa callback amount does not match the KSh 3,000 Chama registration fee',
          { expectedAmount: REGISTRATION_FEE.toString(), callbackAmount: amount.toString() },
          'CHAMA_REGISTRATION_CALLBACK_AMOUNT_MISMATCH',
        );
      }
      const existingReceipt = await client.query<{ id: string }>(
        `SELECT id FROM chama_registration_payments WHERE receipt_number = $1 AND id <> $2`,
        [receipt, payment.id],
      );
      if (existingReceipt.rows[0]) throw new ConflictError('M-Pesa receipt is already linked to another Chama registration', 'MPESA_RECEIPT_CONFLICT');

      const chama = await chamaService.createChamaWithinTransaction(client, {
        ...payment.creation_payload,
        created_by: payment.founder_id,
      });
      const ledgerReference = `mpesa:chama-registration:${receipt}`;
      const ledger = (await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (operation_type, reference, initiated_by, metadata)
         VALUES ('platform_fee',$1,$2,$3::jsonb) RETURNING id`,
        [ledgerReference, payment.founder_id, JSON.stringify({ provider: 'safaricom_daraja', receipt, checkoutRequestId, registrationPaymentId: payment.id })],
      )).rows[0];
      await client.query(
        `INSERT INTO ledger_entries (ledger_transaction_id, chama_id, account, side, amount, currency)
         VALUES ($1,$2,'external_clearing','debit',$3,'KES'),
                ($1,$2,'platform_fee_revenue','credit',$3,'KES')`,
        [ledger.id, chama.id, amount.toString()],
      );
      const confirmed = (await client.query<RegistrationPaymentRow>(
        `UPDATE chama_registration_payments
            SET chama_id = $2, status = 'confirmed', result_code = 0, result_desc = $3,
                receipt_number = $4, raw_payload = $5::jsonb, callback_verified_at = CURRENT_TIMESTAMP,
                paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING id, founder_id, chama_id, creation_payload, amount::text, currency, phone_number,
                    merchant_request_id, checkout_request_id, receipt_number, status::text AS status,
                    result_code, result_desc, paid_at::text`,
        [payment.id, chama.id, callback.ResultDesc ?? 'Success', receipt, JSON.stringify(payload)],
      )).rows[0];
      await client.query(
        `INSERT INTO audit_logs (category, action, actor_role, chama_id, entity_type, entity_id, payload)
         VALUES ('financial','chama_registration_payment_confirmed','system',$1,'chama_registration_payment',$2,$3::jsonb)`,
        [chama.id, payment.id, JSON.stringify({ receipt, checkoutRequestId, amount: amount.toString(), ledgerTransactionId: ledger.id })],
      );
      return {
        ...serializeRegistrationPayment(confirmed),
        chamaId: chama.id,
        joinCode: chama.public_join_code,
        joinUrl: `${env.FRONTEND_URL ?? 'https://app.mduara.example.com'}/join/${chama.public_join_code}`,
        ledgerTransactionId: ledger.id,
        replayed: false,
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }
}

function registrationPaymentSelect() {
  return `SELECT id, founder_id, chama_id, creation_payload, amount::text, currency, phone_number,
                 merchant_request_id, checkout_request_id, receipt_number, status::text AS status,
                 result_code, result_desc, paid_at::text
            FROM chama_registration_payments`;
}

function serializeRegistrationPayment(row: RegistrationPaymentRow) {
  return {
    paymentId: row.id,
    chamaId: row.chama_id,
    checkoutRequestId: row.checkout_request_id,
    merchantRequestId: row.merchant_request_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    resultCode: row.result_code,
    resultDescription: row.result_desc,
    receiptNumber: row.receipt_number,
    paidAt: row.paid_at,
  };
}

function callbackMetadata(items: Array<{ Name?: string; Value?: string | number }>): Record<string, string | number> {
  return Object.fromEntries(items.filter((item) => item.Name).map((item) => [String(item.Name), item.Value ?? '']));
}

function normalizeKenyanPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `254${digits.slice(1)}`;
  if (digits.length === 9 && digits.startsWith('7')) return `254${digits}`;
  throw new BadRequestError('Phone number must be a valid Kenyan mobile number', undefined, 'PHONE_INVALID');
}

export const chamaRegistrationService = new ChamaRegistrationService();