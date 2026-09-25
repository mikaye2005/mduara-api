import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import migrate from 'node-pg-migrate';
import { Pool } from 'pg';
import { ChamaRegistrationService } from '../../services/chama-registration.service';
import { ConsoleStkGateway, type StkPushGateway } from '../../services/payment.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

const fakeGateway: StkPushGateway = {
  async initiate() {
    return {
      merchantRequestId: 'registration-merchant-001',
      checkoutRequestId: 'registration-checkout-001',
      requestPayload: {},
    };
  },
};

test('Chama creation waits for a confirmed KSh 3,000 registration payment', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `chama_registration_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });
  t.after(async () => { await db.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });
  await migrate({ databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema, createSchema: true, migrationsSchema: schema, migrationsTable: 'pgmigrations', ignorePattern: '.*\\.sql', singleTransaction: true, log: () => {} });

  const founderId = randomUUID();
  await db.query(
    `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified)
     VALUES ($1, 'founder@registration.test', 'pin', 'Registration Founder', '+254700000076', 'active', TRUE)`,
    [founderId],
  );
  const service = new ChamaRegistrationService(db, fakeGateway);
  const pending = await service.initiate({
    founderId,
    phoneNumber: '+254700000076',
    creation: {
      name: 'Diani Holiday 2027',
      type: 'goal_based',
      goal_code: 'diani',
      contribution_amount: 5000,
      contribution_frequency: 'monthly',
      target_members: 20,
      recruitment_deadline: '2026-10-15',
      saving_start_date: '2026-11-01',
      saving_end_date: '2027-04-30',
      visibility: 'public',
      constitution: { purpose_goal: 'Diani holiday package' },
    },
  });
  assert.equal(pending.amount, '3000');
  assert.equal(Number((await db.query(`SELECT COUNT(*)::int AS count FROM chamas`)).rows[0].count), 0);

  const callback = {
    Body: { stkCallback: {
      CheckoutRequestID: 'registration-checkout-001', ResultCode: 0, ResultDesc: 'Success',
      CallbackMetadata: { Item: [{ Name: 'Amount', Value: 3000 }, { Name: 'MpesaReceiptNumber', Value: 'REGISTRATION001' }] },
    } },
  };
  const confirmed = await service.processStkCallback(callback);
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.chamaId);
  assert.equal((await db.query<{ name: string }>(`SELECT name FROM chamas WHERE id = $1`, [confirmed.chamaId])).rows[0].name, 'Diani Holiday 2027');
  assert.equal(Number((await db.query(`SELECT COUNT(*)::int AS count FROM chama_members WHERE chama_id = $1 AND user_id = $2 AND role = 'chairperson'`, [confirmed.chamaId, founderId])).rows[0].count), 1);
  assert.equal(Number((await db.query(`SELECT COUNT(*)::int AS count FROM ledger_entries WHERE chama_id = $1`, [confirmed.chamaId])).rows[0].count), 2);
  assert.equal((await service.processStkCallback(callback)).replayed, true);

  const simulatedFounderId = randomUUID();
  await db.query(
    `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified)
     VALUES ($1, 'simulated-founder@registration.test', 'pin', 'Simulated Founder', '+254700000077', 'active', TRUE)`,
    [simulatedFounderId],
  );
  const simulated = await new ChamaRegistrationService(db, new ConsoleStkGateway()).initiate({
    founderId: simulatedFounderId,
    phoneNumber: '+254700000077',
    creation: {
      name: 'Console Payment Chama',
      type: 'goal_based',
      goal_code: 'emergency_fund',
      contribution_amount: 2000,
      contribution_frequency: 'monthly',
      target_members: 10,
      recruitment_deadline: '2026-11-15',
      saving_start_date: '2026-12-01',
      saving_end_date: '2027-05-31',
      visibility: 'public',
      constitution: { purpose_goal: 'Exercise the complete local onboarding flow' },
    },
  });
  assert.equal(simulated.status, 'confirmed');
  assert.ok(simulated.chamaId);
  assert.match(simulated.receiptNumber ?? '', /^DEV/);
  assert.equal(Number((await db.query(
    `SELECT COUNT(*)::int AS count FROM chama_members
      WHERE chama_id = $1 AND user_id = $2 AND role = 'chairperson' AND membership_status = 'active'`,
    [simulated.chamaId, simulatedFounderId],
  )).rows[0].count), 1);
});
