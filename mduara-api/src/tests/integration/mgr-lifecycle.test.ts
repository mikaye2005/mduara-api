import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { MerryGoRoundService } from '../../services/mgr.service';
import type { B2CPayoutRequest, B2CPayoutResult } from '../../services/mpesa.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

class FakePayoutGateway {
  readonly requests: B2CPayoutRequest[] = [];
  private sequence = 0;

  async dispatchB2CPayout(request: B2CPayoutRequest): Promise<B2CPayoutResult> {
    this.requests.push(request);
    this.sequence += 1;
    return { providerReference: `mgr-conversation-${this.sequence}` };
  }
}

test('BE-09 merry-go-round lifecycle', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `mgr_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
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

  const gateway = new FakePayoutGateway();
  const service = new MerryGoRoundService(pool, gateway, {
    resultUrl: 'https://example.test/api/v1/cycles/mpesa/b2c/result',
    timeoutUrl: 'https://example.test/api/v1/cycles/mpesa/b2c/timeout',
  });

  async function user(name: string, suffix: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1, '$2a$12$8sBAM5V4f1xFQvXtKQqS7uP8coKXZkV9g3Q1iKcYxn3VGcRJjKf6a', $2, $3, 'active')
       RETURNING id`,
      [`mgr-${suffix}-${randomUUID()}@example.test`, name, `+25471100${suffix.padStart(4, '0')}`],
    )).rows[0].id;
  }

  const chairUser = await user('Chair', '1');
  const treasurerUser = await user('Treasurer', '2');
  const memberOneUser = await user('Member One', '3');
  const memberTwoUser = await user('Member Two', '4');

  const chama = (await pool.query<{ id: string }>(
    `INSERT INTO chamas
       (name, type, status, contribution_amount, contribution_frequency, pooled_amount, created_by)
     VALUES ($1, 'merry_go_round', 'active', 500, 'weekly', 10000, $2)
     RETURNING id`,
    [`MGR ${randomUUID()}`, chairUser],
  )).rows[0].id;

  async function membership(userId: string, role: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status, approved_at)
       VALUES ($1,$2,$3::member_role,'active',CURRENT_TIMESTAMP)
       RETURNING id`,
      [chama, userId, role],
    )).rows[0].id;
  }

  const chair = await membership(chairUser, 'chairperson');
  const treasurer = await membership(treasurerUser, 'treasurer');
  const memberOne = await membership(memberOneUser, 'member');
  const memberTwo = await membership(memberTwoUser, 'member');

  await pool.query(
    `INSERT INTO chama_rules
       (chama_id, version, status, purpose_goal, contribution_amount, contribution_frequency,
        payout_policy, created_by, effective_from)
     VALUES ($1,1,'active','Weekly merry-go-round',500,'weekly',$2::jsonb,$3,CURRENT_TIMESTAMP)`,
    [chama, JSON.stringify({ queue: 'member_rotation' }), chairUser],
  );

  await t.test('manual cycle snapshots all active members exactly once and two-party swap changes queue only after target acceptance', async () => {
    const cycle = await service.createCycle(chairUser, chama, {
      mode: 'manual',
      payoutAmount: 2000n,
      firstPayoutDate: '2026-09-20',
      intervalDays: 7,
      memberOrder: [memberOne, memberTwo, treasurer, chair],
    });

    assert.equal(cycle.status, 'active');
    assert.deepEqual(cycle.queue.map((item: any) => item.memberId), [memberOne, memberTwo, treasurer, chair]);

    const requested = await service.requestSwap(memberOneUser, cycle.id, { targetMemberId: memberTwo });
    assert.equal(requested.status, 'pending');
    let unchanged = await service.getCycle(memberOneUser, cycle.id);
    assert.deepEqual(unchanged.queue.slice(0, 2).map((item: any) => item.memberId), [memberOne, memberTwo]);

    const accepted = await service.decideSwap(memberTwoUser, cycle.id, requested.id, { decision: 'accept' });
    assert.equal(accepted.status, 'accepted');
    const changed = await service.getCycle(memberOneUser, cycle.id);
    assert.deepEqual(changed.queue.slice(0, 2).map((item: any) => item.memberId), [memberTwo, memberOne]);
    assert.equal(changed.queue[0].scheduledDate, '2026-09-20');
    assert.equal(changed.queue[1].scheduledDate, '2026-09-27');
  });

  await t.test('provider-confirmed payouts journal the beneficiary and auto-advance until the cycle completes', async () => {
    const cycle = await service.getCurrentCycle(chairUser, chama);

    for (let position = 1; position <= 4; position += 1) {
      const before = await service.getCycle(chairUser, cycle.id);
      const current = before.queue.find((item: any) => item.position === before.currentPosition);
      assert.ok(current);

      const dispatched = await service.disburse(treasurerUser, cycle.id);
      assert.equal(dispatched.status, 'disbursement_pending');
      assert.equal(gateway.requests.at(-1)?.resultUrl, 'https://example.test/api/v1/cycles/mpesa/b2c/result');
      assert.equal(gateway.requests.at(-1)?.timeoutUrl, 'https://example.test/api/v1/cycles/mpesa/b2c/timeout');

      const receipt = `MGR-RCP-${position}`;
      const settled = await service.processB2CResult({
        Result: {
          ResultCode: 0,
          ConversationID: dispatched.providerReference,
          ResultParameters: {
            ResultParameter: [
              { Key: 'TransactionReceipt', Value: receipt },
              { Key: 'TransactionAmount', Value: 2000 },
            ],
          },
        },
      });
      assert.equal(settled.status, 'paid');

      const payout = await pool.query(
        `SELECT status, receipt_number, payout_ledger_transaction_id
           FROM merry_go_round_payouts WHERE id = $1`,
        [current.id],
      );
      assert.equal(payout.rows[0].status, 'paid');
      assert.equal(payout.rows[0].receipt_number, receipt);
      assert.ok(payout.rows[0].payout_ledger_transaction_id);

      const entries = await pool.query(
        `SELECT member_id, account::text AS account, side::text AS side, amount::text
           FROM ledger_entries
          WHERE ledger_transaction_id = $1
          ORDER BY side`,
        [payout.rows[0].payout_ledger_transaction_id],
      );
      assert.equal(entries.rowCount, 2);
      assert.equal(entries.rows.find((row) => row.account === 'member_payout')?.member_id, current.memberId);
    }

    const completed = await service.getCycle(chairUser, cycle.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.queue.filter((item: any) => item.status === 'paid').length, 4);
    assert.equal((await pool.query('SELECT pooled_amount::text FROM chamas WHERE id = $1', [chama])).rows[0].pooled_amount, '2000');
  });

  await t.test('bidding fails closed and a timed-out payout does not advance until a late success confirms settlement', async () => {
    await assert.rejects(
      service.createCycle(chairUser, chama, {
        mode: 'bidding',
        payoutAmount: 1000n,
        firstPayoutDate: '2026-11-01',
        intervalDays: 7,
      }),
      (error: any) => error?.code === 'MGR_BIDDING_POLICY_NOT_CONFIGURED',
    );

    const cycle = await service.createCycle(chairUser, chama, {
      mode: 'randomized',
      payoutAmount: 1000n,
      firstPayoutDate: '2026-11-01',
      intervalDays: 7,
    });
    assert.equal(new Set(cycle.queue.map((item: any) => item.memberId)).size, 4);

    const dispatched = await service.disburse(chairUser, cycle.id);
    await service.processB2CTimeout({ Result: { ConversationID: dispatched.providerReference } });
    const disputed = await service.getCycle(chairUser, cycle.id);
    assert.equal(disputed.currentPosition, 1);
    assert.equal(disputed.queue.find((item: any) => item.position === 1)?.status, 'disputed');

    const late = await service.processB2CResult({
      Result: {
        ResultCode: 0,
        ConversationID: dispatched.providerReference,
        ResultParameters: {
          ResultParameter: [
            { Key: 'TransactionReceipt', Value: 'MGR-LATE-1' },
            { Key: 'TransactionAmount', Value: 1000 },
          ],
        },
      },
    });
    assert.equal(late.status, 'paid');
    const advanced = await service.getCycle(chairUser, cycle.id);
    assert.equal(advanced.currentPosition, 2);
  });
});
