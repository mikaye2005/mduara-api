import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from '../utils/errors';
import {
  DarajaStkGateway,
  type MpesaCallbackPayload,
  type StkPushGateway,
} from './payment.service';

type Queryable = Pick<PoolClient, 'query'> | Pick<Pool, 'query'>;
export type SubscriptionAccessMode = 'active' | 'grace_period' | 'read_only';
export type SubscriptionFeature = 'detailed_pdf_export';

interface PlanRow extends QueryResultRow {
  code: string;
  name: string;
  tier: 'free' | 'premium';
  billing_frequency: 'monthly' | 'annual';
  price_amount: string | null;
  currency: string;
  max_members: number | null;
  max_active_loans: number | null;
  sms_quota_monthly: number | null;
  allows_detailed_pdf: boolean;
  is_active: boolean;
}

interface SubscriptionRow extends PlanRow {
  subscription_id: string | null;
  chama_id: string;
  subscription_status: 'active' | 'paused' | 'cancelled';
  subscription_amount: string;
  started_at: string | null;
  renewed_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  grace_ends_at: string | null;
}

interface PaymentRow extends QueryResultRow {
  id: string;
  subscription_id: string;
  chama_id: string;
  plan_code: string;
  billing_frequency: 'monthly' | 'annual';
  amount: string;
  currency: string;
  initiated_by: string | null;
  phone_number: string;
  merchant_request_id: string | null;
  checkout_request_id: string | null;
  provider: string;
  provider_reference: string | null;
  receipt_number: string | null;
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  result_code: number | null;
  result_desc: string | null;
  paid_at: string | null;
}

export interface StartSubscriptionPaymentInput {
  chamaId: string;
  planCode: string;
  phoneNumber: string;
}

export interface SubscriptionEntitlements {
  chamaId: string;
  subscriptionId: string | null;
  plan: {
    code: string;
    name: string;
    tier: 'free' | 'premium';
    billingFrequency: 'monthly' | 'annual';
    priceAmount: string | null;
    currency: string;
    priceConfigured: boolean;
  };
  limits: {
    maxMembers: number | null;
    maxActiveLoans: number | null;
    smsQuotaMonthly: number | null;
    commercialLimitsConfigured: boolean;
  };
  features: { detailedPdfExport: boolean };
  accessMode: SubscriptionAccessMode;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
}

export class SubscriptionService {
  constructor(
    private readonly db: Pool = pool,
    private readonly gateway: StkPushGateway = new DarajaStkGateway(),
    private readonly callbackUrl: string | undefined = env.MPESA_SUBSCRIPTION_CALLBACK_URL,
  ) {}

  async listPlans() {
    const result = await this.db.query<PlanRow>(
      `SELECT code, name, tier, billing_frequency, price_amount::text, currency,
              max_members, max_active_loans, sms_quota_monthly, allows_detailed_pdf, is_active
         FROM subscription_plans
        WHERE is_active = TRUE
        ORDER BY CASE tier WHEN 'free' THEN 0 ELSE 1 END, billing_frequency, code`,
    );
    return result.rows.map(serializePlan);
  }

  async getForChama(actorId: string, chamaId: string, now = new Date()) {
    await assertActiveMembership(this.db, actorId, chamaId);
    const access = await resolveSubscriptionEntitlements(this.db, chamaId, now);
    const [members, loans, sms] = await Promise.all([
      this.db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM chama_members
          WHERE chama_id = $1 AND membership_status IN ('active','pending')`,
        [chamaId],
      ),
      this.db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM loans
          WHERE chama_id = $1 AND status NOT IN ('repaid','rejected','cancelled')`,
        [chamaId],
      ),
      getSmsQuotaStatus(this.db, chamaId, now),
    ]);
    return {
      ...access,
      usage: {
        members: Number(members.rows[0]?.count ?? 0),
        openLoans: Number(loans.rows[0]?.count ?? 0),
        smsThisMonth: sms.used,
        smsRemaining: sms.remaining,
      },
    };
  }

  async initiatePayment(actorId: string, input: StartSubscriptionPaymentInput) {
    const prepared = await withDatabaseTransaction(async (client) => {
      await assertLeadership(client, actorId, input.chamaId);
      const plan = await requirePlan(client, input.planCode, true);
      if (plan.tier !== 'premium') {
        throw new BadRequestError('Only paid Premium plans use the subscription payment endpoint', undefined, 'SUBSCRIPTION_PLAN_NOT_PAYABLE');
      }
      if (plan.price_amount === null || BigInt(plan.price_amount) <= 0n) {
        throw new ServiceUnavailableError(
          'Subscription pricing has not been approved/configured for this plan',
          'SUBSCRIPTION_PRICE_NOT_CONFIGURED',
        );
      }
      if (!this.callbackUrl) {
        throw new ServiceUnavailableError('Subscription M-Pesa callback URL is not configured', 'SUBSCRIPTION_MPESA_NOT_CONFIGURED');
      }

      const subscriptionId = await ensureSubscriptionRow(client, input.chamaId);
      const pending = await client.query<{ id: string; checkout_request_id: string | null }>(
        `SELECT id, checkout_request_id FROM subscription_payments
          WHERE chama_id = $1 AND status = 'pending'
          ORDER BY created_at DESC LIMIT 1`,
        [input.chamaId],
      );
      if (pending.rows[0]) {
        throw new ConflictError(
          'This Chama already has a pending subscription payment',
          'SUBSCRIPTION_PAYMENT_PENDING',
        );
      }
      const phone = normalizeKenyanPhone(input.phoneNumber);
      const payment = (await client.query<{ id: string }>(
        `INSERT INTO subscription_payments
           (subscription_id, chama_id, plan_code, billing_frequency, amount, currency,
            initiated_by, phone_number, provider, status, request_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'safaricom_daraja','pending',$9::jsonb)
         RETURNING id`,
        [
          subscriptionId,
          input.chamaId,
          plan.code,
          plan.billing_frequency,
          plan.price_amount,
          plan.currency,
          actorId,
          phone,
          JSON.stringify({ source: 'be10_subscription_stk_init', planCode: plan.code }),
        ],
      )).rows[0];
      return { paymentId: payment.id, plan, phone };
    }, {}, this.db);

    try {
      const provider = await this.gateway.initiate({
        amount: BigInt(prepared.plan.price_amount!),
        phoneNumber: prepared.phone,
        accountReference: `MDS${prepared.paymentId.replace(/-/g, '').slice(0, 9)}`,
        description: 'M-Duara Sub',
        callbackUrl: this.callbackUrl,
      });
      await this.db.query(
        `UPDATE subscription_payments
            SET merchant_request_id = $2, checkout_request_id = $3,
                request_payload = $4::jsonb, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'pending'`,
        [prepared.paymentId, provider.merchantRequestId, provider.checkoutRequestId, JSON.stringify(provider.requestPayload)],
      );
      return {
        paymentId: prepared.paymentId,
        checkoutRequestId: provider.checkoutRequestId,
        merchantRequestId: provider.merchantRequestId,
        status: 'pending' as const,
        planCode: prepared.plan.code,
        amount: prepared.plan.price_amount,
        currency: prepared.plan.currency,
        customerMessage: provider.customerMessage ?? null,
      };
    } catch (error) {
      await this.db.query(
        `UPDATE subscription_payments
            SET status = 'failed', result_desc = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'pending'`,
        [prepared.paymentId, error instanceof Error ? error.message : 'STK initiation failed'],
      );
      throw error;
    }
  }

  async getPaymentStatus(actorId: string, checkoutRequestId: string) {
    const result = await this.db.query<PaymentRow>(
      `${paymentSelectSql()}
        WHERE sp.checkout_request_id = $1
          AND EXISTS (
            SELECT 1 FROM chama_members cm
             WHERE cm.chama_id = sp.chama_id AND cm.user_id = $2 AND cm.membership_status = 'active'
          )`,
      [checkoutRequestId, actorId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Subscription payment not found', 'SUBSCRIPTION_PAYMENT_NOT_FOUND');
    return serializePayment(row);
  }

  async processStkCallback(payload: MpesaCallbackPayload, now = new Date()) {
    const callback = payload?.Body?.stkCallback;
    const checkoutRequestId = callback?.CheckoutRequestID?.trim();
    if (!checkoutRequestId || typeof callback?.ResultCode !== 'number') {
      throw new BadRequestError('Invalid M-Pesa callback payload', undefined, 'MPESA_CALLBACK_INVALID');
    }

    return withDatabaseTransaction(async (client) => {
      const result = await client.query<PaymentRow>(
        `${paymentSelectSql()} WHERE sp.checkout_request_id = $1 FOR UPDATE`,
        [checkoutRequestId],
      );
      const payment = result.rows[0];
      if (!payment) throw new NotFoundError('Unknown subscription checkout request', 'SUBSCRIPTION_CHECKOUT_UNKNOWN');
      if (payment.status === 'paid') return { ...serializePayment(payment), replayed: true };

      if (callback.ResultCode !== 0) {
        const failed = (await client.query<PaymentRow>(
          `UPDATE subscription_payments
              SET status = 'failed', result_code = $2, result_desc = $3,
                  raw_payload = $4::jsonb, callback_verified_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *`,
          [payment.id, callback.ResultCode, callback.ResultDesc ?? null, JSON.stringify(payload)],
        )).rows[0];
        return { ...serializePayment(failed), replayed: false };
      }

      const metadata = callbackMetadata(callback.CallbackMetadata?.Item ?? []);
      const receipt = String(metadata.MpesaReceiptNumber ?? '').trim();
      const amount = BigInt(String(metadata.Amount ?? '0'));
      if (!receipt || amount <= 0n) {
        throw new BadRequestError('Successful M-Pesa callback is missing receipt/amount', undefined, 'MPESA_CALLBACK_METADATA_INVALID');
      }
      if (amount !== BigInt(payment.amount)) {
        throw new UnprocessableEntityError(
          'M-Pesa callback amount does not match the subscription charge',
          { expectedAmount: payment.amount, callbackAmount: amount.toString() },
          'SUBSCRIPTION_CALLBACK_AMOUNT_MISMATCH',
        );
      }

      // The payment row is the immutable price/frequency snapshot for an in-flight checkout.
      // A later catalog price edit must not invalidate money the provider already collected.
      const plan = await requirePlan(client, payment.plan_code, false);

      const existingReceipt = await client.query<{ id: string; chama_id: string; amount: string }>(
        `SELECT id, chama_id, amount::text FROM subscription_payments WHERE receipt_number = $1 AND id <> $2`,
        [receipt, payment.id],
      );
      if (existingReceipt.rows[0]) {
        throw new ConflictError('M-Pesa receipt is already linked to a different subscription payment', 'MPESA_RECEIPT_CONFLICT');
      }

      const subscription = (await client.query<{
        id: string; current_period_end: string | null;
      }>(
        `SELECT id, current_period_end::text FROM platform_subscriptions WHERE id = $1 FOR UPDATE`,
        [payment.subscription_id],
      )).rows[0];
      if (!subscription) throw new NotFoundError('Subscription not found', 'SUBSCRIPTION_NOT_FOUND');

      const periodStart = subscription.current_period_end && new Date(subscription.current_period_end) > now
        ? new Date(subscription.current_period_end)
        : now;
      const periodEnd = addBillingPeriod(periodStart, payment.billing_frequency);
      const graceEndsAt = new Date(periodEnd.getTime() + 7 * 86_400_000);

      const ledgerReference = `mpesa:subscription:${receipt}`;
      const existingLedger = await client.query<{ id: string }>(
        `SELECT id FROM ledger_transactions WHERE reference = $1`,
        [ledgerReference],
      );
      let ledgerTransactionId = existingLedger.rows[0]?.id;
      if (!ledgerTransactionId) {
        ledgerTransactionId = (await client.query<{ id: string }>(
          `INSERT INTO ledger_transactions (operation_type, reference, initiated_by, metadata)
           VALUES ('platform_fee',$1,$2,$3::jsonb) RETURNING id`,
          [
            ledgerReference,
            payment.initiated_by,
            JSON.stringify({
              provider: payment.provider,
              receipt,
              checkoutRequestId,
              source: 'be10_subscription',
              subscriptionPaymentId: payment.id,
              planCode: payment.plan_code,
              billingFrequency: payment.billing_frequency,
            }),
          ],
        )).rows[0].id;
        await client.query(
          `INSERT INTO ledger_entries (ledger_transaction_id, chama_id, member_id, account, side, amount, currency)
           VALUES ($1,$2,NULL,'external_clearing','debit',$3,$4),
                  ($1,$2,NULL,'platform_fee_revenue','credit',$3,$4)`,
          [ledgerTransactionId, payment.chama_id, amount.toString(), payment.currency],
        );
      }

      await client.query(
        `UPDATE platform_subscriptions
            SET plan_code = $2, plan_name = $3, billing_frequency = $4, amount = $5,
                status = 'active', renewed_at = CURRENT_TIMESTAMP,
                current_period_start = $6, current_period_end = $7, grace_ends_at = $8,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [
          subscription.id,
          plan.code,
          plan.name,
          payment.billing_frequency,
          amount.toString(),
          periodStart,
          periodEnd,
          graceEndsAt,
        ],
      );

      const updated = (await client.query<PaymentRow>(
        `UPDATE subscription_payments
            SET status = 'paid', result_code = 0, result_desc = $2,
                provider_reference = $3, receipt_number = $3,
                raw_payload = $4::jsonb, callback_verified_at = CURRENT_TIMESTAMP,
                paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [payment.id, callback.ResultDesc ?? 'Success', receipt, JSON.stringify(payload)],
      )).rows[0];

      await client.query(
        `INSERT INTO audit_logs (category, action, actor_role, chama_id, entity_type, entity_id, payload)
         VALUES ('financial','subscription_payment_confirmed','system',$1,'subscription_payment',$2,$3::jsonb)`,
        [payment.chama_id, payment.id, JSON.stringify({ receipt, checkoutRequestId, planCode: plan.code, amount: amount.toString(), ledgerTransactionId })],
      );

      return {
        ...serializePayment(updated),
        subscription: await resolveSubscriptionEntitlements(client, payment.chama_id, now),
        ledgerTransactionId,
        replayed: false,
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }
}

export async function resolveSubscriptionEntitlements(
  db: Queryable,
  chamaId: string,
  now = new Date(),
): Promise<SubscriptionEntitlements> {
  const chama = await db.query<{ id: string }>('SELECT id FROM chamas WHERE id = $1', [chamaId]);
  if (!chama.rows[0]) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');

  const result = await db.query<SubscriptionRow>(
    `SELECT ps.id AS subscription_id, $1::uuid AS chama_id,
            p.code, p.name, p.tier, p.billing_frequency, p.price_amount::text,
            p.currency, p.max_members, p.max_active_loans, p.sms_quota_monthly,
            p.allows_detailed_pdf, p.is_active,
            COALESCE(ps.status::text, 'active') AS subscription_status,
            COALESCE(ps.amount, 0)::text AS subscription_amount,
            ps.started_at::text, ps.renewed_at::text,
            ps.current_period_start::text, ps.current_period_end::text, ps.grace_ends_at::text
       FROM subscription_plans p
       LEFT JOIN platform_subscriptions ps ON ps.chama_id = $1 AND ps.plan_code = p.code
      WHERE p.code = COALESCE((SELECT plan_code FROM platform_subscriptions WHERE chama_id = $1), 'free')
      LIMIT 1`,
    [chamaId],
  );
  const row = result.rows[0];
  if (!row) throw new ServiceUnavailableError('Default subscription plan is not configured', 'SUBSCRIPTION_DEFAULT_PLAN_MISSING');
  return serializeEntitlements(row, now);
}

export async function assertSubscriptionWriteAccess(db: Queryable, chamaId: string, now = new Date()) {
  const access = await resolveSubscriptionEntitlements(db, chamaId, now);
  if (access.accessMode === 'read_only') {
    throw new ForbiddenError(
      'This Chama is read-only because its paid subscription grace period has ended',
      'SUBSCRIPTION_READ_ONLY',
    );
  }
  return access;
}

export async function assertSubscriptionFeature(
  db: Queryable,
  chamaId: string,
  feature: SubscriptionFeature,
  now = new Date(),
) {
  const access = await resolveSubscriptionEntitlements(db, chamaId, now);
  if (access.accessMode === 'read_only') {
    throw new ForbiddenError('This Chama is read-only because its subscription grace period has ended', 'SUBSCRIPTION_READ_ONLY');
  }
  const allowed = feature === 'detailed_pdf_export' && access.features.detailedPdfExport;
  if (!allowed) throw new ForbiddenError('Your current subscription plan does not include this feature', 'SUBSCRIPTION_FEATURE_REQUIRED');
  return access;
}

export async function assertMemberOnboardingAllowed(
  db: Queryable,
  input: { chamaId: string; occupied: number; targetMembers: number | null; now?: Date },
) {
  const access = await assertSubscriptionWriteAccess(db, input.chamaId, input.now);
  const configuredPlanCap = access.limits.maxMembers;
  const caps = [env.CHAMA_MAX_MEMBERS];
  if (input.targetMembers !== null) caps.push(input.targetMembers);
  if (configuredPlanCap !== null) caps.push(configuredPlanCap);
  const capacity = Math.min(...caps);
  if (input.occupied >= capacity) {
    const code = configuredPlanCap !== null && configuredPlanCap === capacity
      ? 'SUBSCRIPTION_MEMBER_LIMIT_REACHED'
      : 'CHAMA_CAPACITY_REACHED';
    throw new ConflictError('Chama has reached its current member capacity', code);
  }
  return { access, capacity };
}

export async function assertActiveLoanCapacity(db: Queryable, chamaId: string, now = new Date()) {
  const access = await assertSubscriptionWriteAccess(db, chamaId, now);
  const limit = access.limits.maxActiveLoans;
  if (limit === null) return access;
  const count = Number((await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM loans
      WHERE chama_id = $1
        AND status NOT IN ('repaid','rejected','cancelled')`,
    [chamaId],
  )).rows[0]?.count ?? 0);
  if (count >= limit) {
    throw new ConflictError('Chama has reached its subscription loan limit', 'SUBSCRIPTION_LOAN_LIMIT_REACHED');
  }
  return access;
}

export async function getSmsQuotaStatus(db: Queryable, chamaId: string, now = new Date()) {
  const access = await resolveSubscriptionEntitlements(db, chamaId, now);
  const limit = access.limits.smsQuotaMonthly;
  const result = await db.query<{ used_count: number }>(
    `SELECT COALESCE((
       SELECT used_count FROM subscription_sms_usage
        WHERE chama_id = $1
          AND period_month = date_trunc('month', $2::timestamptz AT TIME ZONE $3)::date
     ), 0)::int AS used_count`,
    [chamaId, now, env.SCHEDULER_TIMEZONE],
  );
  const usage = Number(result.rows[0]?.used_count ?? 0);
  return { limit, used: usage, remaining: limit === null ? null : Math.max(limit - usage, 0), configured: limit !== null };
}

export async function reserveSmsQuotaSlot(db: Pool, chamaId: string, now = new Date()) {
  return withDatabaseTransaction(async (client) => {
    const access = await resolveSubscriptionEntitlements(client, chamaId, now);
    const limit = access.limits.smsQuotaMonthly;
    const month = (await client.query<{ period_month: string }>(
      `SELECT date_trunc('month', $1::timestamptz AT TIME ZONE $2)::date::text AS period_month`,
      [now, env.SCHEDULER_TIMEZONE],
    )).rows[0].period_month;
    if (limit === null) return { allowed: true as const, reserved: false as const, periodMonth: month, limit: null, used: null };
    if (limit === 0) return { allowed: false as const, reserved: false as const, periodMonth: month, limit, used: 0 };

    const reservation = await client.query<{ used_count: number }>(
      `INSERT INTO subscription_sms_usage (chama_id, period_month, used_count)
       VALUES ($1,$2::date,1)
       ON CONFLICT (chama_id, period_month) DO UPDATE
          SET used_count = subscription_sms_usage.used_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE subscription_sms_usage.used_count < $3
       RETURNING used_count`,
      [chamaId, month, limit],
    );
    const row = reservation.rows[0];
    if (!row) {
      const used = Number((await client.query<{ used_count: number }>(
        `SELECT used_count FROM subscription_sms_usage WHERE chama_id = $1 AND period_month = $2::date`,
        [chamaId, month],
      )).rows[0]?.used_count ?? limit);
      return { allowed: false as const, reserved: false as const, periodMonth: month, limit, used };
    }
    return { allowed: true as const, reserved: true as const, periodMonth: month, limit, used: Number(row.used_count) };
  }, {}, db);
}

export async function releaseSmsQuotaSlot(db: Pool, chamaId: string, periodMonth: string): Promise<void> {
  await db.query(
    `UPDATE subscription_sms_usage
        SET used_count = GREATEST(used_count - 1, 0), updated_at = CURRENT_TIMESTAMP
      WHERE chama_id = $1 AND period_month = $2::date`,
    [chamaId, periodMonth],
  );
}

async function ensureSubscriptionRow(client: PoolClient, chamaId: string): Promise<string> {
  const chama = await client.query<{ id: string }>('SELECT id FROM chamas WHERE id = $1 FOR UPDATE', [chamaId]);
  if (!chama.rows[0]) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');
  const row = (await client.query<{ id: string }>(
    `INSERT INTO platform_subscriptions (chama_id, plan_code, plan_name, billing_frequency, amount, status)
     VALUES ($1,'free','Free','monthly',0,'active')
     ON CONFLICT (chama_id) DO UPDATE SET chama_id = EXCLUDED.chama_id
     RETURNING id`,
    [chamaId],
  )).rows[0];
  return row.id;
}

async function requirePlan(db: Queryable, code: string, requireActive: boolean): Promise<PlanRow> {
  const result = await db.query<PlanRow>(
    `SELECT code, name, tier, billing_frequency, price_amount::text, currency,
            max_members, max_active_loans, sms_quota_monthly, allows_detailed_pdf, is_active
       FROM subscription_plans WHERE code = $1`,
    [code],
  );
  const plan = result.rows[0];
  if (!plan) throw new NotFoundError('Subscription plan not found', 'SUBSCRIPTION_PLAN_NOT_FOUND');
  if (requireActive && !plan.is_active) throw new ConflictError('Subscription plan is not available', 'SUBSCRIPTION_PLAN_INACTIVE');
  return plan;
}

async function assertActiveMembership(db: Queryable, userId: string, chamaId: string) {
  const result = await db.query<{ role: string }>(
    `SELECT role::text AS role FROM chama_members
      WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
    [chamaId, userId],
  );
  if (!result.rows[0]) throw new ForbiddenError('Active Chama membership is required', 'CHAMA_MEMBERSHIP_INACTIVE');
  return result.rows[0].role;
}

async function assertLeadership(db: Queryable, userId: string, chamaId: string) {
  const role = await assertActiveMembership(db, userId, chamaId);
  if (!['chairperson', 'secretary', 'treasurer'].includes(role)) {
    throw new ForbiddenError('Chama leadership is required to manage subscription billing', 'CHAMA_ROLE_FORBIDDEN');
  }
}

function serializePlan(plan: PlanRow) {
  return {
    code: plan.code,
    name: plan.name,
    tier: plan.tier,
    billingFrequency: plan.billing_frequency,
    priceAmount: plan.price_amount,
    currency: plan.currency,
    priceConfigured: plan.tier === 'free' || (plan.price_amount !== null && BigInt(plan.price_amount) > 0n),
    limits: {
      maxMembers: plan.max_members,
      maxActiveLoans: plan.max_active_loans,
      smsQuotaMonthly: plan.sms_quota_monthly,
      commercialLimitsConfigured: plan.max_members !== null && plan.max_active_loans !== null && plan.sms_quota_monthly !== null,
    },
    features: { detailedPdfExport: plan.allows_detailed_pdf },
  };
}

function serializeEntitlements(row: SubscriptionRow, now: Date): SubscriptionEntitlements {
  let accessMode: SubscriptionAccessMode = 'active';
  if (row.tier === 'premium') {
    if (row.subscription_status !== 'active' || !row.current_period_end) accessMode = 'read_only';
    else if (now <= new Date(row.current_period_end)) accessMode = 'active';
    else if (row.grace_ends_at && now <= new Date(row.grace_ends_at)) accessMode = 'grace_period';
    else accessMode = 'read_only';
  }
  return {
    chamaId: row.chama_id,
    subscriptionId: row.subscription_id,
    plan: {
      code: row.code,
      name: row.name,
      tier: row.tier,
      billingFrequency: row.billing_frequency,
      priceAmount: row.price_amount,
      currency: row.currency,
      priceConfigured: row.tier === 'free' || (row.price_amount !== null && BigInt(row.price_amount) > 0n),
    },
    limits: {
      maxMembers: row.max_members,
      maxActiveLoans: row.max_active_loans,
      smsQuotaMonthly: row.sms_quota_monthly,
      commercialLimitsConfigured: row.max_members !== null && row.max_active_loans !== null && row.sms_quota_monthly !== null,
    },
    features: { detailedPdfExport: row.allows_detailed_pdf },
    accessMode,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    graceEndsAt: row.grace_ends_at,
  };
}

function paymentSelectSql() {
  return `SELECT sp.id, sp.subscription_id, sp.chama_id, sp.plan_code,
                 sp.billing_frequency, sp.amount::text, sp.currency, sp.initiated_by,
                 sp.phone_number, sp.merchant_request_id, sp.checkout_request_id,
                 sp.provider, sp.provider_reference, sp.receipt_number,
                 sp.status::text AS status, sp.result_code, sp.result_desc, sp.paid_at::text
            FROM subscription_payments sp`;
}

function serializePayment(row: PaymentRow) {
  return {
    paymentId: row.id,
    subscriptionId: row.subscription_id,
    chamaId: row.chama_id,
    planCode: row.plan_code,
    billingFrequency: row.billing_frequency,
    amount: row.amount,
    currency: row.currency,
    checkoutRequestId: row.checkout_request_id,
    merchantRequestId: row.merchant_request_id,
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

function addBillingPeriod(start: Date, frequency: 'monthly' | 'annual'): Date {
  const original = new Date(start);
  const day = original.getUTCDate();
  const next = new Date(original);
  next.setUTCDate(1);
  if (frequency === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCFullYear(next.getUTCFullYear() + 1);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function normalizeKenyanPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (/^2547\d{8}$/.test(digits) || /^2541\d{8}$/.test(digits)) return digits;
  if (/^07\d{8}$/.test(digits) || /^01\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^7\d{8}$/.test(digits) || /^1\d{8}$/.test(digits)) return `254${digits}`;
  throw new BadRequestError('A valid Kenyan M-Pesa phone number is required', undefined, 'MPESA_PHONE_INVALID');
}

export const subscriptionService = new SubscriptionService();
