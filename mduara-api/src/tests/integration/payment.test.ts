import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { PaymentService, type StkPushGateway } from '../../services/payment.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

const fakeGateway: StkPushGateway = {
  async initiate(request) {
    return {
      merchantRequestId: 'merchant-be05-001',
      checkoutRequestId: 'checkout-be05-001',
      customerMessage: 'Success. Request accepted for processing',
      requestPayload: { Amount: request.amount.toString(), PhoneNumber: request.phoneNumber },
    };
  },
};

test('BE-05 STK callback is idempotent and atomically posts contribution + ledger', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `payment_be05_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });
  t.after(async () => { await db.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });
  await migrate({ databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema, createSchema: true, migrationsSchema: schema, migrationsTable: 'pgmigrations', ignorePattern: '.*\\.sql', singleTransaction: true, log: () => {} });

  const userId = randomUUID();
  await db.query(`INSERT INTO users (id,email,pin_hash,full_name,phone,status,is_email_verified) VALUES ($1,'pay@test.local','pin','Pay Member','+254700000099','active',TRUE)`, [userId]);
  const chamaId = (await db.query<{id:string}>(`INSERT INTO chamas (name,type,status,visibility,contribution_amount,contribution_frequency,pooled_amount,currency) VALUES ('BE05 Chama','goal_based','active','public',3000,'monthly',0,'KES') RETURNING id`)).rows[0].id;
  const memberId = (await db.query<{id:string}>(`INSERT INTO chama_members (chama_id,user_id,membership_status) VALUES ($1,$2,'active') RETURNING id`, [chamaId,userId])).rows[0].id;
  const contributionId = (await db.query<{id:string}>(`INSERT INTO contributions (chama_id,member_id,expected_amount,due_date,period_label) VALUES ($1,$2,3000,CURRENT_DATE,'2026-09') RETURNING id`, [chamaId,memberId])).rows[0].id;
  await db.query(
    `INSERT INTO trust_score_formula_versions
       (subject_type,version,status,public_description,inputs,weights,levels,definition_hash,created_by,approved_by,approved_at,activated_at)
     VALUES ('member','member-v1','active','Contribution outcomes determine the member score.',
             '["on_time_contributions","missed_contributions"]','{"on_time_contributions":0.6,"missed_contributions":0.4}',
             '["needs_attention","building","highly_committed"]',$1,$2,$2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ['cf07a082ddb545d6a12451ebfdf6e4f839c8290faea785d22e992cf6ecf96775', userId],
  );

  const service = new PaymentService(db, fakeGateway);
  const pending = await service.initiateStkPush({ userId, contributionId, amount: 3000n, phoneNumber: '+254700000099' });
  assert.equal(pending.checkoutRequestId, 'checkout-be05-001');

  const payload = { Body: { stkCallback: { MerchantRequestID: 'merchant-be05-001', CheckoutRequestID: 'checkout-be05-001', ResultCode: 0, ResultDesc: 'Success', CallbackMetadata: { Item: [ { Name: 'Amount', Value: 3000 }, { Name: 'MpesaReceiptNumber', Value: 'BE05RCPT001' }, { Name: 'PhoneNumber', Value: 254700000099 } ] } } } };
  const first = await service.processStkCallback(payload);
  assert.equal(first.status, 'confirmed');
  assert.equal(first.contributionStatus, 'paid');
  const second = await service.processStkCallback(payload);
  assert.equal(second.replayed, true);

  assert.equal(Number((await db.query(`SELECT COUNT(*)::int AS count FROM contribution_payments WHERE provider_reference='BE05RCPT001'`)).rows[0].count), 1);
  assert.equal(Number((await db.query(`SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE reference='mpesa:stk:BE05RCPT001'`)).rows[0].count), 1);
  assert.equal((await db.query<{pooled_amount:string}>(`SELECT pooled_amount::text FROM chamas WHERE id=$1`, [chamaId])).rows[0].pooled_amount, '3000');
  assert.equal((await db.query<{status:string}>(`SELECT status::text FROM contributions WHERE id=$1`, [contributionId])).rows[0].status, 'paid');
  const trust = (await db.query<{score:string;level:string}>(`SELECT score::text, level FROM trust_score_snapshots WHERE membership_id = $1`, [memberId])).rows[0];
  assert.deepEqual(trust, { score: '100.00', level: 'highly_committed' });
});

test('BE-05 failed provider callback never posts money', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `payment_fail_be05_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });
  t.after(async () => { await db.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); });
  await migrate({ databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema, createSchema: true, migrationsSchema: schema, migrationsTable: 'pgmigrations', ignorePattern: '.*\\.sql', singleTransaction: true, log: () => {} });
  const userId=randomUUID();
  await db.query(`INSERT INTO users (id,email,pin_hash,full_name,phone,status) VALUES ($1,'fail@test.local','pin','Fail Member','+254700000098','active')`,[userId]);
  const chamaId=(await db.query<{id:string}>(`INSERT INTO chamas (name,type,status,visibility,contribution_amount,contribution_frequency) VALUES ('Fail Chama','goal_based','active','public',1000,'monthly') RETURNING id`)).rows[0].id;
  const memberId=(await db.query<{id:string}>(`INSERT INTO chama_members (chama_id,user_id,membership_status) VALUES ($1,$2,'active') RETURNING id`,[chamaId,userId])).rows[0].id;
  const contributionId=(await db.query<{id:string}>(`INSERT INTO contributions (chama_id,member_id,expected_amount,due_date,period_label) VALUES ($1,$2,1000,CURRENT_DATE,'2026-09') RETURNING id`,[chamaId,memberId])).rows[0].id;
  const service=new PaymentService(db,{async initiate(){return {merchantRequestId:'m-fail',checkoutRequestId:'c-fail',requestPayload:{}};}});
  await service.initiateStkPush({userId,contributionId,amount:1000n,phoneNumber:'+254700000098'});
  const result=await service.processStkCallback({Body:{stkCallback:{CheckoutRequestID:'c-fail',ResultCode:1032,ResultDesc:'Request cancelled'}}});
  assert.equal(result.status,'failed');
  assert.equal(Number((await db.query(`SELECT COUNT(*)::int AS count FROM contribution_payments`)).rows[0].count),0);
  assert.equal((await db.query<{pooled_amount:string}>(`SELECT pooled_amount::text FROM chamas WHERE id=$1`,[chamaId])).rows[0].pooled_amount,'0');
});
