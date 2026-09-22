import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { PublicChamaService } from '../../services/public-chama.service';
import { CommitmentService } from '../../services/commitment.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-34 commitment join gating is traceable, idempotent, audited and treasury-isolated', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `commitment_be34_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await db.end();
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
    singleTransaction: true,
    log: () => {},
  });

  const ownerId = '30000000-0000-4000-8000-000000000061';
  const otherId = '30000000-0000-4000-8000-000000000062';
  const defaultingId = '30000000-0000-4000-8000-000000000063';
  await db.query(
    `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified)
     VALUES
       ($1, 'commit-owner@example.test', 'pin', 'Commit Owner', '+254700000061', 'active', TRUE),
       ($2, 'commit-other@example.test', 'pin', 'Commit Other', '+254700000062', 'active', TRUE),
       ($3, 'commit-default@example.test', 'pin', 'Commit Default', '+254700000063', 'active', TRUE)`,
    [ownerId, otherId, defaultingId],
  );

  const publicChamaId = '40000000-0000-4000-8000-000000000061';
  const publicRuleId = '50000000-0000-4000-8000-000000000061';
  await db.query(
    `INSERT INTO chamas
       (id, name, type, status, visibility, goal_code, target_members, contribution_amount,
        contribution_frequency, pooled_amount, currency)
     VALUES ($1, 'Commitment Public Chama', 'goal_based', 'recruiting', 'public',
             'washing_machine', 20, 5000, 'monthly', 25000, 'KES')`,
    [publicChamaId],
  );
  await db.query(
    `INSERT INTO chama_rules
       (id, chama_id, version, status, purpose_goal, contribution_amount,
        contribution_frequency, commitment_amount, effective_from)
     VALUES ($1, $2, 1, 'active', 'Washing machine', 5000, 'monthly', 500, CURRENT_TIMESTAMP)`,
    [publicRuleId, publicChamaId],
  );

  const publicService = new PublicChamaService(db);
  const commitmentService = new CommitmentService(db);
  const joined = await publicService.apply({
    userId: ownerId,
    chamaId: publicChamaId,
    constitutionRuleId: publicRuleId,
  });

  assert.equal(joined.outcome, 'commitment_required');
  assert.equal(joined.membership.membership_status, 'pending');
  assert.equal(joined.commitment.required, true);
  assert.equal(joined.commitment.amount, '500');
  assert.equal(joined.commitment.state, 'applied');
  assert.ok(joined.commitment.id);

  const trace = (await db.query<{
    user_id: string; application_id: string; membership_id: string; chama_rule_id: string; application_status: string;
  }>(
    `SELECT cd.user_id, cd.application_id, cd.membership_id, cd.chama_rule_id,
            ca.status::text AS application_status
       FROM commitment_deposits cd
       JOIN chama_applications ca ON ca.id = cd.application_id
      WHERE cd.id = $1`,
    [joined.commitment.id],
  )).rows[0];
  assert.equal(trace.user_id, ownerId);
  assert.equal(trace.membership_id, joined.membership.id);
  assert.equal(trace.application_id, joined.application.id);
  assert.equal(trace.chama_rule_id, publicRuleId);
  assert.equal(trace.application_status, 'commitment_pending');

  const beforeHold = await commitmentService.getOwnCommitment(joined.membership.id, ownerId);
  assert.equal(beforeHold.state, 'applied');
  assert.equal(beforeHold.canStartSaving, false);
  await assert.rejects(commitmentService.getOwnCommitment(joined.membership.id, otherId), /private to the membership owner/i);

  await assert.rejects(
    commitmentService.confirmHoldFromProvider({
      membershipId: joined.membership.id,
      provider: 'mpesa',
      providerReference: 'MD-COMMIT-WRONG-AMOUNT-61',
      amount: 499n,
    }),
    /does not match/i,
  );
  assert.equal(
    (await db.query(`SELECT membership_status::text AS status FROM chama_members WHERE id = $1`, [joined.membership.id])).rows[0].status,
    'pending',
  );

  const held = await commitmentService.confirmHoldFromProvider({
    membershipId: joined.membership.id,
    provider: 'mpesa',
    providerReference: 'MD-COMMIT-HOLD-61',
    amount: 500n,
  });
  assert.equal(held.state, 'held');
  assert.equal(held.membershipStatus, 'active');
  assert.equal(held.applicationStatus, 'approved');
  assert.equal(held.canStartSaving, true);
  assert.equal(held.replayed, false);

  const replay = await commitmentService.confirmHoldFromProvider({
    membershipId: joined.membership.id,
    provider: 'mpesa',
    providerReference: 'MD-COMMIT-HOLD-61',
    amount: 500n,
  });
  assert.equal(replay.replayed, true);
  assert.equal(
    Number((await db.query(`SELECT COUNT(*) FROM ledger_transactions WHERE operation_type = 'commitment_hold' AND reference = 'commitment:hold:mpesa:MD-COMMIT-HOLD-61'`)).rows[0].count),
    1,
  );

  const holdEntries = await db.query<{ account: string; side: string; amount: string }>(
    `SELECT le.account::text AS account, le.side::text AS side, le.amount::text AS amount
       FROM ledger_entries le
       JOIN ledger_transactions lt ON lt.id = le.ledger_transaction_id
      WHERE lt.reference = 'commitment:hold:mpesa:MD-COMMIT-HOLD-61'
      ORDER BY le.side, le.account`,
  );
  assert.deepEqual(
    holdEntries.rows.map((row) => [row.account, row.side, row.amount]).sort(),
    [['commitment_escrow', 'credit', '500'], ['external_clearing', 'debit', '500']].sort(),
  );

  await commitmentService.markEligibleForRefund({
    membershipId: joined.membership.id,
    source: 'goal_completion_job',
    reference: 'goal-complete-61',
  });
  await assert.rejects(commitmentService.requestRefund(joined.membership.id, otherId), /private to the membership owner/i);
  const refundRequested = await commitmentService.requestRefund(joined.membership.id, ownerId);
  assert.equal(refundRequested.state, 'refund_requested');

  const refunded = await commitmentService.confirmRefundFromProvider({
    membershipId: joined.membership.id,
    provider: 'mpesa_b2c',
    providerReference: 'MD-COMMIT-REFUND-61',
    amount: 500n,
  });
  assert.equal(refunded.state, 'refunded');
  assert.equal(refunded.replayed, false);
  const refundReplay = await commitmentService.confirmRefundFromProvider({
    membershipId: joined.membership.id,
    provider: 'mpesa_b2c',
    providerReference: 'MD-COMMIT-REFUND-61',
    amount: 500n,
  });
  assert.equal(refundReplay.replayed, true);

  const applicationChamaId = '40000000-0000-4000-8000-000000000062';
  const applicationRuleId = '50000000-0000-4000-8000-000000000062';
  await db.query(
    `INSERT INTO chamas
       (id, name, type, status, visibility, goal_code, target_members, contribution_amount,
        contribution_frequency, pooled_amount, currency)
     VALUES ($1, 'Approval First Chama', 'goal_based', 'recruiting', 'application',
             'washing_machine', 20, 5000, 'monthly', 0, 'KES')`,
    [applicationChamaId],
  );
  await db.query(
    `INSERT INTO chama_rules
       (id, chama_id, version, status, purpose_goal, contribution_amount,
        contribution_frequency, commitment_amount, effective_from)
     VALUES ($1, $2, 1, 'active', 'Washing machine', 5000, 'monthly', 500, CURRENT_TIMESTAMP)`,
    [applicationRuleId, applicationChamaId],
  );
  const pendingApplication = await publicService.apply({
    userId: otherId,
    chamaId: applicationChamaId,
    constitutionRuleId: applicationRuleId,
  });
  assert.equal(pendingApplication.outcome, 'application_pending');
  assert.equal(pendingApplication.membership, null);
  assert.equal(pendingApplication.commitment.state, 'awaiting_application_approval');
  assert.equal(
    Number((await db.query(`SELECT COUNT(*) FROM commitment_deposits WHERE chama_id = $1 AND user_id = $2`, [applicationChamaId, otherId])).rows[0].count),
    0,
  );

  const defaulting = await publicService.apply({
    userId: defaultingId,
    chamaId: publicChamaId,
    constitutionRuleId: publicRuleId,
  });
  await commitmentService.confirmHoldFromProvider({
    membershipId: defaulting.membership.id,
    provider: 'mpesa',
    providerReference: 'MD-COMMIT-HOLD-63',
    amount: 500n,
  });
  await commitmentService.markAtRisk({
    membershipId: defaulting.membership.id,
    source: 'missed_contribution_job',
    reference: 'missed-cycle-63-1',
  });
  await commitmentService.markDefaultTriggered({
    membershipId: defaulting.membership.id,
    source: 'missed_contribution_job',
    reference: 'missed-cycle-63-3',
  });
  await assert.rejects(commitmentService.requestRefund(defaulting.membership.id, defaultingId), /not eligible|default/i);
  await assert.rejects(
    commitmentService.forfeitFromRule({
      membershipId: defaulting.membership.id,
      source: 'constitution_rule_engine',
      reference: 'partial-forfeit-rule-event-63',
      amount: 250n,
    }),
    /Partial commitment forfeiture is not enabled/i,
  );
  const forfeited = await commitmentService.forfeitFromRule({
    membershipId: defaulting.membership.id,
    source: 'constitution_rule_engine',
    reference: 'forfeit-rule-event-63',
    amount: 500n,
  });
  assert.equal(forfeited.state, 'forfeited');
  assert.equal(
    (await db.query(`SELECT membership_status::text AS status FROM chama_members WHERE id = $1`, [defaulting.membership.id])).rows[0].status,
    'defaulted',
  );

  const pooledAfter = (await db.query<{ pooled_amount: string }>(
    `SELECT pooled_amount::text FROM chamas WHERE id = $1`,
    [publicChamaId],
  )).rows[0].pooled_amount;
  assert.equal(pooledAfter, '25000');

  const operations = await db.query<{ operation_type: string }>(
    `SELECT operation_type FROM ledger_transactions
      WHERE operation_type IN ('commitment_hold', 'commitment_refund', 'commitment_forfeiture')
      ORDER BY created_at, id`,
  );
  assert.equal(operations.rows.filter((r) => r.operation_type === 'commitment_hold').length, 2);
  assert.equal(operations.rows.filter((r) => r.operation_type === 'commitment_refund').length, 1);
  assert.equal(operations.rows.filter((r) => r.operation_type === 'commitment_forfeiture').length, 1);

  const audit = await db.query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE entity_type = 'commitment_deposit' ORDER BY created_at, id`,
  );
  assert.ok(audit.rows.some((row) => row.action === 'commitment_deposit_created'));
  assert.ok(audit.rows.some((row) => row.action === 'commitment_state_changed'));
  assert.ok(audit.rows.length >= 9);
  await t.test('membership contribution progress is owner-scoped and reports paid/remaining against scheduled obligations', async () => {
    const contributionId = (await db.query(
      `INSERT INTO contributions (chama_id, member_id, expected_amount, due_date, period_label, status)
       VALUES ($1, $2, 1000, CURRENT_DATE + 1, 'Cycle 1', 'partially_paid') RETURNING id`,
      [publicChamaId, joined.membership.id],
    )).rows[0].id;
    await db.query(
      `INSERT INTO contribution_payments
       (contribution_id, chama_id, member_id, amount, payment_method, status, paid_at)
       VALUES ($1, $2, $3, 400, 'mpesa', 'confirmed', CURRENT_TIMESTAMP),
              ($1, $2, $3, 600, 'mpesa', 'pending', CURRENT_TIMESTAMP)`,
      [contributionId, publicChamaId, joined.membership.id],
    );

    const progress = await commitmentService.getOwnContributions(joined.membership.id, ownerId);
    assert.deepEqual(progress.summary, { scheduledTarget: '1000', paid: '400', remaining: '600' });
    assert.equal(progress.contributions[0].remainingAmount, '600');
    await assert.rejects(commitmentService.getOwnContributions(joined.membership.id, otherId));
  });

});
