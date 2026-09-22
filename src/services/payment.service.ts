import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, UnprocessableEntityError } from '../utils/errors';

export interface StkPushInput {
  userId: string;
  contributionId: string;
  amount: bigint;
  phoneNumber: string;
}

export interface StkPushProviderRequest {
  amount: bigint;
  phoneNumber: string;
  accountReference: string;
  description: string;
  /** Optional dedicated callback URL for non-contribution STK flows (for example BE-10 subscriptions). */
  callbackUrl?: string;
}

export interface StkPushProviderResult {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseCode?: string;
  responseDescription?: string;
  customerMessage?: string;
  requestPayload: Record<string, unknown>;
}

export interface StkPushGateway {
  initiate(request: StkPushProviderRequest): Promise<StkPushProviderResult>;
}

interface ContributionContext extends QueryResultRow {
  contribution_id: string;
  chama_id: string;
  member_id: string;
  expected_amount: string;
  contribution_status: string;
  membership_status: string;
  user_id: string;
  confirmed_amount: string;
}

interface ProviderLogRow extends QueryResultRow {
  id: string;
  user_id: string | null;
  contribution_id: string | null;
  chama_id: string | null;
  member_id: string | null;
  merchant_request_id: string | null;
  checkout_request_id: string | null;
  amount: string;
  currency: string;
  phone_number: string;
  status: 'pending' | 'confirmed' | 'failed' | 'reversed';
  result_code: number | null;
  result_desc: string | null;
  receipt_number: string | null;
  completed_at: string | null;
}

export interface MpesaCallbackPayload {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: {
        Item?: Array<{ Name?: string; Value?: string | number }>;
      };
    };
  };
}

export interface CallbackVerificationInput {
  ipAddress?: string;
  signature?: string;
  payload: unknown;
  environment?: 'sandbox' | 'production';
  allowedIps?: string;
  hmacSecret?: string;
}

export class DarajaStkGateway implements StkPushGateway {
  async initiate(request: StkPushProviderRequest): Promise<StkPushProviderResult> {
    if (!env.MPESA_STK_ENABLED) throw new ServiceUnavailableError('M-Pesa STK Push is disabled', 'MPESA_STK_DISABLED');
    const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY, MPESA_CALLBACK_URL } = env;
    const callbackUrl = request.callbackUrl ?? MPESA_CALLBACK_URL;
    if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_PASSKEY || !callbackUrl) {
      throw new ServiceUnavailableError('M-Pesa STK Push is not fully configured', 'MPESA_STK_NOT_CONFIGURED');
    }

    const token = await this.accessToken(MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET);
    const timestamp = darajaTimestamp(new Date());
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
    const phone = normalizeKenyanPhone(request.phoneNumber);
    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: request.amount.toString(),
      PartyA: phone,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: request.accountReference.slice(0, 12),
      TransactionDesc: request.description.slice(0, 13),
    };

    const response = await fetch(`${darajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(env.MPESA_REQUEST_TIMEOUT_MS),
    });
    const body = await response.json() as {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResponseCode?: string;
      ResponseDescription?: string;
      CustomerMessage?: string;
      errorMessage?: string;
    };
    if (!response.ok || !body.CheckoutRequestID || !body.MerchantRequestID) {
      throw new ServiceUnavailableError(body.errorMessage ?? body.ResponseDescription ?? 'M-Pesa rejected STK Push request', 'MPESA_STK_REJECTED');
    }
    return {
      merchantRequestId: body.MerchantRequestID,
      checkoutRequestId: body.CheckoutRequestID,
      responseCode: body.ResponseCode,
      responseDescription: body.ResponseDescription,
      customerMessage: body.CustomerMessage,
      requestPayload: payload,
    };
  }

  private async accessToken(key: string, secret: string): Promise<string> {
    const response = await fetch(`${darajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
      signal: AbortSignal.timeout(env.MPESA_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new ServiceUnavailableError('Unable to authenticate with M-Pesa', 'MPESA_AUTH_FAILED');
    const body = await response.json() as { access_token?: string };
    if (!body.access_token) throw new ServiceUnavailableError('M-Pesa did not return an access token', 'MPESA_AUTH_FAILED');
    return body.access_token;
  }
}

export class PaymentService {
  constructor(private readonly db: Pool = pool, private readonly gateway: StkPushGateway = new DarajaStkGateway()) {}

  async initiateStkPush(input: StkPushInput) {
    if (input.amount <= 0n) throw new BadRequestError('Payment amount must be greater than zero', undefined, 'PAYMENT_AMOUNT_INVALID');
    const context = await this.loadContributionContext(input.contributionId, input.userId);
    if (context.membership_status !== 'active') throw new ForbiddenError('Contribution payment requires an active Chama membership', 'CHAMA_MEMBERSHIP_INACTIVE');
    if (!['pending', 'partially_paid', 'late'].includes(context.contribution_status)) {
      throw new ConflictError('Contribution is not accepting payments', 'CONTRIBUTION_NOT_PAYABLE');
    }
    const remaining = BigInt(context.expected_amount) - BigInt(context.confirmed_amount);
    if (remaining <= 0n) throw new ConflictError('Contribution is already fully paid', 'CONTRIBUTION_ALREADY_PAID');
    if (input.amount > remaining) {
      throw new UnprocessableEntityError('Payment exceeds the remaining contribution amount', { remainingAmount: remaining.toString() }, 'PAYMENT_EXCEEDS_REMAINING');
    }

    const attempt = (await this.db.query<{ id: string }>(
      `INSERT INTO payment_provider_logs
         (user_id, contribution_id, chama_id, member_id, amount, phone_number, status, request_payload)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb)
       RETURNING id`,
      [input.userId, context.contribution_id, context.chama_id, context.member_id, input.amount.toString(), normalizeKenyanPhone(input.phoneNumber), JSON.stringify({ source: 'be05_stk_init', contributionId: input.contributionId })],
    )).rows[0];

    try {
      const provider = await this.gateway.initiate({
        amount: input.amount,
        phoneNumber: input.phoneNumber,
        accountReference: `MD${attempt.id.replace(/-/g, '').slice(0, 10)}`,
        description: 'M-Duara Pay',
      });
      await this.db.query(
        `UPDATE payment_provider_logs
            SET merchant_request_id = $2, checkout_request_id = $3,
                request_payload = $4::jsonb, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [attempt.id, provider.merchantRequestId, provider.checkoutRequestId, JSON.stringify(provider.requestPayload)],
      );
      return {
        paymentId: attempt.id,
        checkoutRequestId: provider.checkoutRequestId,
        merchantRequestId: provider.merchantRequestId,
        status: 'pending' as const,
        amount: input.amount.toString(),
        currency: 'KES' as const,
        customerMessage: provider.customerMessage ?? null,
      };
    } catch (error) {
      await this.db.query(
        `UPDATE payment_provider_logs
            SET status = 'failed', result_desc = $2, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [attempt.id, error instanceof Error ? error.message : 'STK initiation failed'],
      );
      throw error;
    }
  }

  async getStatus(checkoutRequestId: string, userId: string) {
    const result = await this.db.query<ProviderLogRow>(
      `SELECT id, user_id, contribution_id, chama_id, member_id, merchant_request_id, checkout_request_id,
              amount::text, currency, phone_number, status::text AS status, result_code, result_desc,
              receipt_number, completed_at::text
         FROM payment_provider_logs
        WHERE checkout_request_id = $1 AND user_id = $2`,
      [checkoutRequestId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Payment request not found', 'PAYMENT_NOT_FOUND');
    return serializeProviderLog(row);
  }

  async processStkCallback(payload: MpesaCallbackPayload) {
    const callback = payload?.Body?.stkCallback;
    const checkoutRequestId = callback?.CheckoutRequestID?.trim();
    if (!checkoutRequestId || typeof callback?.ResultCode !== 'number') {
      throw new BadRequestError('Invalid M-Pesa callback payload', undefined, 'MPESA_CALLBACK_INVALID');
    }

    return withDatabaseTransaction(async (client) => {
      const result = await client.query<ProviderLogRow>(
        `SELECT id, user_id, contribution_id, chama_id, member_id, merchant_request_id, checkout_request_id,
                amount::text, currency, phone_number, status::text AS status, result_code, result_desc,
                receipt_number, completed_at::text
           FROM payment_provider_logs WHERE checkout_request_id = $1 FOR UPDATE`,
        [checkoutRequestId],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError('Unknown M-Pesa checkout request', 'MPESA_CHECKOUT_UNKNOWN');
      if (row.status === 'confirmed') return { ...serializeProviderLog(row), replayed: true };

      if (callback.ResultCode !== 0) {
        const failed = await client.query<ProviderLogRow>(
          `UPDATE payment_provider_logs
              SET status = 'failed', result_code = $2, result_desc = $3, raw_payload = $4::jsonb,
                  callback_verified_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id, user_id, contribution_id, chama_id, member_id, merchant_request_id, checkout_request_id,
                      amount::text, currency, phone_number, status::text AS status, result_code, result_desc,
                      receipt_number, completed_at::text`,
          [row.id, callback.ResultCode, callback.ResultDesc ?? null, JSON.stringify(payload)],
        );
        return { ...serializeProviderLog(failed.rows[0]), replayed: false };
      }

      if (!row.contribution_id || !row.chama_id || !row.member_id) {
        throw new ConflictError('Payment request is not linked to a contribution', 'PAYMENT_CONTEXT_MISSING');
      }
      const metadata = callbackMetadata(callback.CallbackMetadata?.Item ?? []);
      const receipt = String(metadata.MpesaReceiptNumber ?? '').trim();
      const callbackAmount = BigInt(String(metadata.Amount ?? '0'));
      if (!receipt || callbackAmount <= 0n) throw new BadRequestError('Successful M-Pesa callback is missing receipt/amount', undefined, 'MPESA_CALLBACK_METADATA_INVALID');
      if (callbackAmount !== BigInt(row.amount)) {
        await writeSecurityAudit(client, 'mpesa_callback_amount_mismatch', row.chama_id, row.id, {
          checkoutRequestId, expectedAmount: row.amount, callbackAmount: callbackAmount.toString(), receipt,
        });
        throw new UnprocessableEntityError('M-Pesa callback amount does not match the initiated payment', undefined, 'MPESA_CALLBACK_AMOUNT_MISMATCH');
      }

      const contribution = await client.query<{ expected_amount: string; status: string }>(
        `SELECT expected_amount::text, status::text AS status FROM contributions WHERE id = $1 FOR UPDATE`,
        [row.contribution_id],
      );
      if (!contribution.rows[0]) throw new NotFoundError('Contribution not found', 'CONTRIBUTION_NOT_FOUND');

      const existingReceipt = await client.query<{ id: string; contribution_id: string; amount: string }>(
        `SELECT id, contribution_id, amount::text FROM contribution_payments WHERE provider_reference = $1`, [receipt],
      );
      let paymentId: string;
      if (existingReceipt.rows[0]) {
        const existing = existingReceipt.rows[0];
        if (existing.contribution_id !== row.contribution_id || BigInt(existing.amount) !== callbackAmount) {
          throw new ConflictError('M-Pesa receipt is already linked to a different payment', 'MPESA_RECEIPT_CONFLICT');
        }
        paymentId = existing.id;
      } else {
        paymentId = (await client.query<{ id: string }>(
          `INSERT INTO contribution_payments
             (contribution_id, chama_id, member_id, amount, payment_method, provider, provider_reference, receipt_number, status, paid_at)
           VALUES ($1,$2,$3,$4,'mpesa','safaricom_daraja',$5,$5,'confirmed',CURRENT_TIMESTAMP)
           RETURNING id`,
          [row.contribution_id, row.chama_id, row.member_id, callbackAmount.toString(), receipt],
        )).rows[0].id;

        const ledgerReference = `mpesa:stk:${receipt}`;
        const ledger = await client.query<{ id: string }>(
          `INSERT INTO ledger_transactions (operation_type, reference, initiated_by, metadata)
           VALUES ('deposit',$1,$2,$3::jsonb) RETURNING id`,
          [ledgerReference, row.user_id, JSON.stringify({ provider: 'safaricom_daraja', checkoutRequestId, receipt, paymentId })],
        );
        const ledgerId = ledger.rows[0].id;
        await client.query(
          `INSERT INTO ledger_entries (ledger_transaction_id, chama_id, member_id, account, side, amount, currency)
           VALUES ($1,$2,NULL,'chama_treasury','debit',$4,'KES'),
                  ($1,$2,$3,'member_contribution','credit',$4,'KES')`,
          [ledgerId, row.chama_id, row.member_id, callbackAmount.toString()],
        );
        await client.query("SELECT set_config('app.ledger_transaction_id', $1, true)", [ledgerId]);
        await client.query(`UPDATE chamas SET pooled_amount = pooled_amount + $2 WHERE id = $1`, [row.chama_id, callbackAmount.toString()]);
      }

      const confirmed = BigInt((await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount),0)::text AS total FROM contribution_payments WHERE contribution_id = $1 AND status = 'confirmed'`,
        [row.contribution_id],
      )).rows[0].total);
      const expected = BigInt(contribution.rows[0].expected_amount);
      if (confirmed > expected) throw new ConflictError('Confirmed contribution payments exceed expected amount', 'CONTRIBUTION_OVERPAID');
      const contributionStatus = confirmed === expected ? 'paid' : 'partially_paid';
      await client.query(`UPDATE contributions SET status = $2::contribution_status WHERE id = $1`, [row.contribution_id, contributionStatus]);

      const updated = await client.query<ProviderLogRow>(
        `UPDATE payment_provider_logs
            SET status = 'confirmed', result_code = 0, result_desc = $2, receipt_number = $3,
                raw_payload = $4::jsonb, callback_verified_at = CURRENT_TIMESTAMP,
                completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING id, user_id, contribution_id, chama_id, member_id, merchant_request_id, checkout_request_id,
                    amount::text, currency, phone_number, status::text AS status, result_code, result_desc,
                    receipt_number, completed_at::text`,
        [row.id, callback.ResultDesc ?? 'Success', receipt, JSON.stringify(payload)],
      );
      await client.query(
        `INSERT INTO audit_logs (category, action, actor_role, chama_id, entity_type, entity_id, payload)
         VALUES ('financial','mpesa_stk_payment_confirmed','system',$1,'payment_provider_log',$2,$3::jsonb)`,
        [row.chama_id, row.id, JSON.stringify({ checkoutRequestId, receipt, contributionId: row.contribution_id, paymentId, amount: callbackAmount.toString() })],
      );
      return { ...serializeProviderLog(updated.rows[0]), paymentId, contributionStatus, replayed: Boolean(existingReceipt.rows[0]) };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async recordRejectedCallback(input: { ipAddress?: string; reason: string; payload?: unknown }) {
    await this.db.query(
      `INSERT INTO audit_logs (category, action, actor_role, entity_type, payload)
       VALUES ('security','mpesa_callback_rejected','system','mpesa_callback',$1::jsonb)`,
      [JSON.stringify({ ipAddress: input.ipAddress ?? null, reason: input.reason, payload: input.payload ?? null })],
    );
  }

  private async loadContributionContext(contributionId: string, userId: string): Promise<ContributionContext> {
    const result = await this.db.query<ContributionContext>(
      `SELECT c.id AS contribution_id, c.chama_id, c.member_id, c.expected_amount::text,
              c.status::text AS contribution_status, cm.membership_status::text AS membership_status,
              cm.user_id,
              COALESCE(SUM(cp.amount) FILTER (WHERE cp.status = 'confirmed'),0)::text AS confirmed_amount
         FROM contributions c
         JOIN chama_members cm ON cm.id = c.member_id AND cm.chama_id = c.chama_id
         LEFT JOIN contribution_payments cp ON cp.contribution_id = c.id
        WHERE c.id = $1 AND cm.user_id = $2
        GROUP BY c.id, c.chama_id, c.member_id, c.expected_amount, c.status, cm.membership_status, cm.user_id`,
      [contributionId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Contribution not found for this member', 'CONTRIBUTION_NOT_FOUND');
    return row;
  }
}

export function verifyMpesaCallbackRequest(input: CallbackVerificationInput): { ok: true } | { ok: false; reason: string } {
  const allowed = (input.allowedIps ?? env.MPESA_CALLBACK_ALLOWED_IPS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const secret = input.hmacSecret ?? env.MPESA_WEBHOOK_HMAC_SECRET;
  const environment = input.environment ?? env.MPESA_ENVIRONMENT;
  if (environment === 'production' && allowed.length === 0 && !secret) return { ok: false, reason: 'callback verification is not configured' };
  if (allowed.length > 0 && (!input.ipAddress || !allowed.includes(normalizeIp(input.ipAddress)))) return { ok: false, reason: 'source IP is not allowed' };
  if (secret) {
    const signature = input.signature?.replace(/^sha256=/i, '').trim();
    if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return { ok: false, reason: 'callback signature is missing or invalid' };
    const expected = createHmac('sha256', secret).update(JSON.stringify(input.payload)).digest('hex');
    const actualBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return { ok: false, reason: 'callback signature mismatch' };
  }
  return { ok: true };
}

function callbackMetadata(items: Array<{ Name?: string; Value?: string | number }>): Record<string, string | number> {
  return Object.fromEntries(items.filter((item) => item.Name).map((item) => [String(item.Name), item.Value ?? '']));
}

function serializeProviderLog(row: ProviderLogRow) {
  return {
    paymentId: row.id,
    checkoutRequestId: row.checkout_request_id,
    merchantRequestId: row.merchant_request_id,
    contributionId: row.contribution_id,
    chamaId: row.chama_id,
    membershipId: row.member_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    resultCode: row.result_code,
    resultDescription: row.result_desc,
    receiptNumber: row.receipt_number,
    completedAt: row.completed_at,
  };
}

async function writeSecurityAudit(client: PoolClient, action: string, chamaId: string | null, entityId: string, payload: Record<string, unknown>) {
  await client.query(
    `INSERT INTO audit_logs (category, action, actor_role, chama_id, entity_type, entity_id, payload)
     VALUES ('security',$1,'system',$2,'payment_provider_log',$3,$4::jsonb)`,
    [action, chamaId, entityId, JSON.stringify(payload)],
  );
}

function normalizeKenyanPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (/^2547\d{8}$/.test(digits) || /^2541\d{8}$/.test(digits)) return digits;
  if (/^07\d{8}$/.test(digits) || /^01\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^7\d{8}$/.test(digits) || /^1\d{8}$/.test(digits)) return `254${digits}`;
  throw new BadRequestError('A valid Kenyan M-Pesa phone number is required', undefined, 'MPESA_PHONE_INVALID');
}

function normalizeIp(ip: string): string { return ip.replace(/^::ffff:/, ''); }
function darajaBaseUrl(): string { return env.MPESA_ENVIRONMENT === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'; }
function darajaTimestamp(date: Date): string {
  const part = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
}

export const paymentService = new PaymentService();
