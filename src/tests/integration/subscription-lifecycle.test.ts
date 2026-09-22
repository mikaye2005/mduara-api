import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import {
  SubscriptionService,
  assertActiveLoanCapacity,
  assertMemberOnboardingAllowed,
  releaseSmsQuotaSlot,
  reserveSmsQuotaSlot,
  assertSubscriptionFeature,
  assertSubscriptionWriteAccess,
  resolveSubscriptionEntitlements,
} from '../../services/subscription.service';
import type { StkPushGateway, StkPushProviderRequest } from '../../services/payment.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

class FakeStkGateway implements StkPushGateway {
  requests: StkPushProviderRequest[] = [];
  private counter = 0;

  async initiate(request: StkPushProviderRequest) {
    this.requests.push(request);
    this.counter += 1;
    return {
      merchantRequestId: `merchant-${this.counter}`,
      checkoutRequestId: `checkout-${this.counter}`,
      responseCode: '0',
      responseDescription: 'Accepted',
      customerMessage: 'Enter PIN',
      requestPayload: { test: true, callbackUrl: request.callbackUrl, amount: request.amount.toString() },
    };
  }
}

test('BE-10 subscription lifecycle against PostgreSQL', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `subscription_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });
  const gateway = new FakeStkGateway();
  const service = new SubscriptionService(pool, gateway, 'https://example.test/api/v1/subscriptions/mpesa/callback');

  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  await migrate({
    databaseUrl: databaseUrl!,
    dir: 'migrations',
    direction: 'up',
    schema,
    createSchema: true,
    migrationsSchema: schema,
    migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql',
    singleTransaction: false,
    log: () => {},
  });

  t.beforeEach(async () => {
    // Ledger/audit history is immutable, so each test creates fresh Chamas instead of deleting prior financial rows.
    await pool.query(`UPDATE subscription_plans SET max_members = NULL, max_active_loans = NULL, sms_quota_monthly = NULL, updated_at = CURRENT_TIMESTAMP`);
    await pool.query(`UPDATE subscription_plans SET price_amount = NULL WHERE tier = 'premium'`);
    gateway.requests.length = 0;
  });

  async function fixture() {
    const user = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1,'$2a$12$8sBAM5V4f1xFQvXtKQqS7uP8coKXZkV9g3Q1iKcYxn3VGcRJjKf6a','Chair',$2,'active')
       RETURNING id`,
      [`${randomUUID()}@example.test`, `+2547${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`],
    )).rows[0].id;
    const chama = (await pool.query<{ id: string }>(
      `INSERT INTO chamas (name, type, contribution_amount, contribution_frequency, status, created_by)
       VALUES ('Billing Test','goal_based',1000,'monthly','active',$1) RETURNING id`,
      [user],
    )).rows[0].id;
    const member = (await pool.query<{ id: string }>(
      `INSERT INTO chama_members (chama_id,user_id,role,membership_status,approved_at)
       VALUES ($1,$2,'chairperson','active',CURRENT_TIMESTAMP) RETURNING id`,
      [chama, user],
    )).rows[0].id;
    return { user, chama, member };
  }

  await t.test('free tier member and loan limits are enforced when configured', async () => {
    const f = await fixture();
    await pool.query(`UPDATE subscription_plans SET max_members = 1, max_active_loans = 1, sms_quota_monthly = 5 WHERE code = 'free'`);

    await assert.rejects(
      assertMemberOnboardingAllowed(pool, { chamaId: f.chama, occupied: 1, targetMembers: null }),
      (error: any) => error?.code === 'SUBSCRIPTION_MEMBER_LIMIT_REACHED',
    );

    await pool.query(
      `INSERT INTO loans (chama_id, member_id, principal_amount, interest_rate, total_due, status)
       VALUES ($1,$2,1000,10,1100,'active')`,
      [f.chama, f.member],
    );
    await assert.rejects(
      assertActiveLoanCapacity(pool, f.chama),
      (error: any) => error?.code === 'SUBSCRIPTION_LOAN_LIMIT_REACHED',
    );
  });

  await t.test('paid checkout uses server plan price and provider callback activates Premium exactly once', async () => {
    const f = await fixture();
    await pool.query(
      `UPDATE subscription_plans
          SET price_amount = 2500, max_members = 50, max_active_loans = 10, sms_quota_monthly = 1000
        WHERE code = 'premium_monthly'`,
    );

    const initiated = await service.initiatePayment(f.user, {
      chamaId: f.chama,
      planCode: 'premium_monthly',
      phoneNumber: '+254700000001',
    });
    assert.equal(initiated.amount, '2500');
    assert.equal(gateway.requests.length, 1);
    assert.equal(gateway.requests[0].amount, 2500n);
    assert.equal(gateway.requests[0].callbackUrl, 'https://example.test/api/v1/subscriptions/mpesa/callback');

    const paidAt = new Date('2026-09-17T12:00:00.000Z');
    const payload = {
      Body: {
        stkCallback: {
          MerchantRequestID: initiated.merchantRequestId,
          CheckoutRequestID: initiated.checkoutRequestId,
          ResultCode: 0,
          ResultDesc: 'Success',
          CallbackMetadata: { Item: [
            { Name: 'Amount', Value: 2500 },
            { Name: 'MpesaReceiptNumber', Value: 'SUBREC001' },
          ] },
        },
      },
    };
    const confirmed = await service.processStkCallback(payload, paidAt);
    assert.equal(confirmed.replayed, false);
    assert.equal(confirmed.subscription.plan.code, 'premium_monthly');
    assert.equal(confirmed.subscription.accessMode, 'active');

    const subscription = (await pool.query(
      `SELECT plan_code, current_period_start, current_period_end, grace_ends_at FROM platform_subscriptions WHERE chama_id = $1`,
      [f.chama],
    )).rows[0];
    assert.equal(subscription.plan_code, 'premium_monthly');
    assert.equal(new Date(subscription.current_period_start).toISOString(), paidAt.toISOString());
    assert.equal(new Date(subscription.grace_ends_at).getTime() - new Date(subscription.current_period_end).getTime(), 7 * 86_400_000);

    const ledger = await pool.query(
      `SELECT lt.id, lt.operation_type, le.account::text, le.side::text, le.amount::text
         FROM ledger_transactions lt JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
        WHERE lt.reference = 'mpesa:subscription:SUBREC001' ORDER BY le.side, le.account`,
    );
    assert.equal(ledger.rowCount, 2);
    assert.ok(ledger.rows.every((row) => row.operation_type === 'platform_fee' && row.amount === '2500'));
    assert.deepEqual(new Set(ledger.rows.map((row) => row.account)), new Set(['external_clearing', 'platform_fee_revenue']));
    assert.equal((await pool.query('SELECT pooled_amount FROM chamas WHERE id = $1', [f.chama])).rows[0].pooled_amount, '0');

    const replay = await service.processStkCallback(payload, paidAt);
    assert.equal(replay.replayed, true);
    assert.equal((await pool.query(`SELECT id FROM ledger_transactions WHERE reference = 'mpesa:subscription:SUBREC001'`)).rowCount, 1);
    assert.equal((await assertSubscriptionFeature(pool, f.chama, 'detailed_pdf_export')).plan.code, 'premium_monthly');
  });

  await t.test('SMS quota slots are transactionally reserved and released', async () => {
    const f = await fixture();
    await pool.query(`UPDATE subscription_plans SET sms_quota_monthly = 1 WHERE code = 'free'`);
    const first = await reserveSmsQuotaSlot(pool, f.chama, new Date('2026-09-17T12:00:00Z'));
    assert.equal(first.allowed, true);
    assert.equal(first.reserved, true);
    const second = await reserveSmsQuotaSlot(pool, f.chama, new Date('2026-09-17T12:01:00Z'));
    assert.equal(second.allowed, false);
    await releaseSmsQuotaSlot(pool, f.chama, first.periodMonth);
    const retry = await reserveSmsQuotaSlot(pool, f.chama, new Date('2026-09-17T12:02:00Z'));
    assert.equal(retry.allowed, true);
  });

  await t.test('Premium access has an exact seven-day grace boundary then becomes read-only', async () => {
    const f = await fixture();
    await pool.query(`UPDATE subscription_plans SET price_amount = 100, max_members = 50, max_active_loans = 5, sms_quota_monthly = 100 WHERE code = 'premium_monthly'`);
    const payment = await service.initiatePayment(f.user, { chamaId: f.chama, planCode: 'premium_monthly', phoneNumber: '+254700000002' });
    const start = new Date('2026-01-10T00:00:00.000Z');
    await service.processStkCallback({ Body: { stkCallback: {
      CheckoutRequestID: payment.checkoutRequestId,
      ResultCode: 0,
      ResultDesc: 'Success',
      CallbackMetadata: { Item: [
        { Name: 'Amount', Value: 100 },
        { Name: 'MpesaReceiptNumber', Value: 'SUBREC002' },
      ] },
    } } }, start);

    const dates = (await pool.query(`SELECT current_period_end, grace_ends_at FROM platform_subscriptions WHERE chama_id = $1`, [f.chama])).rows[0];
    const periodEnd = new Date(dates.current_period_end);
    const graceEnd = new Date(dates.grace_ends_at);
    assert.equal((await resolveSubscriptionEntitlements(pool, f.chama, periodEnd)).accessMode, 'active');
    assert.equal((await resolveSubscriptionEntitlements(pool, f.chama, new Date(periodEnd.getTime() + 1))).accessMode, 'grace_period');
    assert.equal((await resolveSubscriptionEntitlements(pool, f.chama, graceEnd)).accessMode, 'grace_period');
    const afterGrace = new Date(graceEnd.getTime() + 1);
    assert.equal((await resolveSubscriptionEntitlements(pool, f.chama, afterGrace)).accessMode, 'read_only');
    await assert.rejects(assertSubscriptionWriteAccess(pool, f.chama, afterGrace), (error: any) => error?.code === 'SUBSCRIPTION_READ_ONLY');
  });

  await t.test('detailed PDF entitlement is plan-gated and unconfigured Premium price fails closed', async () => {
    const free = await fixture();
    await assert.rejects(
      assertSubscriptionFeature(pool, free.chama, 'detailed_pdf_export'),
      (error: any) => error?.code === 'SUBSCRIPTION_FEATURE_REQUIRED',
    );

    const premium = await fixture();
    await assert.rejects(
      service.initiatePayment(premium.user, { chamaId: premium.chama, planCode: 'premium_annual', phoneNumber: '+254700000003' }),
      (error: any) => error?.code === 'SUBSCRIPTION_PRICE_NOT_CONFIGURED',
    );
    assert.equal(gateway.requests.length, 0);
  });

  await t.test('failed provider callback never upgrades the Free subscription', async () => {
    const f = await fixture();
    await pool.query(`UPDATE subscription_plans SET price_amount = 500 WHERE code = 'premium_monthly'`);
    const payment = await service.initiatePayment(f.user, { chamaId: f.chama, planCode: 'premium_monthly', phoneNumber: '+254700000004' });
    const failed = await service.processStkCallback({ Body: { stkCallback: {
      CheckoutRequestID: payment.checkoutRequestId,
      ResultCode: 1032,
      ResultDesc: 'Request cancelled by user',
    } } });
    assert.equal(failed.status, 'failed');
    const access = await resolveSubscriptionEntitlements(pool, f.chama);
    assert.equal(access.plan.code, 'free');
    assert.equal(access.accessMode, 'active');
  });
});
