import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { GoalMarketplaceService } from '../../services/goal-marketplace.service';
import { MerchantRewardService } from '../../services/merchant-reward.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-33 merchant marketplace and reward state are server-owned and treasury-isolated', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `merchant_reward_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

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
    singleTransaction: true,
    log: () => {},
  });

  const merchantService = new MerchantRewardService(pool);
  const marketplaceService = new GoalMarketplaceService(pool);

  const publicList = await merchantService.listGoalMerchants('washing-machine');
  assert.equal(publicList.merchants.length, 3);
  assert.equal(publicList.merchants.every((item) => item.merchant.isDemo), true);
  assert.equal(publicList.merchants.every((item) => item.reward.state === 'locked'), true);
  const metric = await marketplaceService.getMetric('washing_machine');
  assert.equal(metric.partnerMerchantCount, 3);

  const washingGoalId = '20000000-0000-4000-8000-000000000001';
  const inactiveMerchantId = '70000000-0000-4000-8000-000000000099';
  const expiredMerchantId = '70000000-0000-4000-8000-000000000098';
  const pausedMerchantId = '70000000-0000-4000-8000-000000000097';
  await pool.query(
    `INSERT INTO partner_merchants (id, code, name, status)
     VALUES ($1, 'inactive_test_partner', 'Inactive Test Partner', 'inactive'),
            ($2, 'expired_test_partner', 'Expired Test Partner', 'active'),
            ($3, 'paused_test_partner', 'Paused Test Partner', 'active')`,
    [inactiveMerchantId, expiredMerchantId, pausedMerchantId],
  );
  await pool.query(
    `INSERT INTO goal_merchant_partnerships
       (goal_id, merchant_id, status, offer_title, offer_summary, valid_from, valid_until)
     VALUES
       ($1, $2, 'active', 'Inactive merchant offer', 'Should not be visible', CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '30 days'),
       ($1, $3, 'active', 'Expired offer', 'Should not be visible', CURRENT_TIMESTAMP - INTERVAL '30 days', CURRENT_TIMESTAMP - INTERVAL '1 day'),
       ($1, $4, 'paused', 'Paused offer', 'Should not be visible', CURRENT_TIMESTAMP - INTERVAL '1 day', CURRENT_TIMESTAMP + INTERVAL '30 days')
     RETURNING id, merchant_id`,
    [washingGoalId, inactiveMerchantId, expiredMerchantId, pausedMerchantId],
  );
  assert.equal((await merchantService.listGoalMerchants('washing_machine')).merchants.length, 3);
  assert.equal((await marketplaceService.getMetric('washing_machine')).partnerMerchantCount, 3);

  const pausedPartnershipId = (await pool.query<{ id: string }>(
    `SELECT id FROM goal_merchant_partnerships WHERE merchant_id = $1`,
    [pausedMerchantId],
  )).rows[0].id;
  await pool.query(`UPDATE goal_merchant_partnerships SET status = 'active' WHERE id = $1`, [pausedPartnershipId]);
  await pool.query(`UPDATE goal_merchant_partnerships SET status = 'paused' WHERE id = $1`, [pausedPartnershipId]);

  const ownerId = '30000000-0000-4000-8000-000000000051';
  const otherId = '30000000-0000-4000-8000-000000000052';
  await pool.query(
    `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified)
     VALUES
       ($1, 'merchant-owner@example.test', 'pin', 'Merchant Owner', '+254700000051', 'active', TRUE),
       ($2, 'merchant-other@example.test', 'pin', 'Merchant Other', '+254700000052', 'active', TRUE)`,
    [ownerId, otherId],
  );
  const chama = await pool.query<{ id: string; pooled_amount: string }>(
    `INSERT INTO chamas
       (name, type, status, visibility, goal_code, contribution_amount, contribution_frequency, pooled_amount, currency)
     VALUES ('Merchant Reward Chama', 'goal_based', 'active', 'public', 'washing_machine', 5000, 'monthly', 25000, 'KES')
     RETURNING id, pooled_amount::text`,
  );
  const chamaId = chama.rows[0].id;
  const pooledBefore = chama.rows[0].pooled_amount;
  const membershipId = (await pool.query<{ id: string }>(
    `INSERT INTO chama_members (chama_id, user_id, membership_status)
     VALUES ($1, $2, 'active') RETURNING id`,
    [chamaId, ownerId],
  )).rows[0].id;

  await assert.rejects(
    merchantService.listGoalMerchants('washing_machine', { membershipId }),
    /Authentication is required/,
  );
  await assert.rejects(
    merchantService.listGoalMerchants('washing_machine', { membershipId, userId: otherId }),
    /private to the membership owner/,
  );

  const ownedLocked = await merchantService.listGoalMerchants('washing_machine', { membershipId, userId: ownerId });
  assert.equal(ownedLocked.merchants.length, 3);
  assert.equal(ownedLocked.merchants.every((item) => item.reward.state === 'locked'), true);

  const partnershipId = ownedLocked.merchants[0].partnershipId;
  const eligible = await merchantService.grantEligibility({
    membershipId,
    partnershipId,
    source: 'goal_progress_job',
    reference: 'eligibility-event-000000000051',
    fingerprint: 'a'.repeat(64),
  });
  assert.equal(eligible.state, 'eligible');

  const ownedEligible = await merchantService.listGoalMerchants('washing_machine', { membershipId, userId: ownerId });
  const eligibleCard = ownedEligible.merchants.find((item) => item.partnershipId === partnershipId);
  assert.equal(eligibleCard?.reward.state, 'eligible');
  assert.equal(eligibleCard?.reward.serverConfirmed, true);

  const redeemed = await merchantService.recordRedemption({
    rewardId: eligible.id,
    source: 'merchant_confirmation',
    reference: 'merchant-redemption-000000000051',
    fingerprint: 'b'.repeat(64),
  });
  assert.equal(redeemed.state, 'redeemed');

  const pooledAfter = (await pool.query<{ pooled_amount: string }>(
    `SELECT pooled_amount::text FROM chamas WHERE id = $1`,
    [chamaId],
  )).rows[0].pooled_amount;
  assert.equal(pooledAfter, pooledBefore);

  const audit = await pool.query<{ action: string }>(
    `SELECT action FROM audit_logs
     WHERE entity_type IN ('goal_merchant_partnership', 'member_merchant_reward')
     ORDER BY created_at, id`,
  );
  assert.ok(audit.rows.some((row) => row.action === 'merchant_partnership_created'));
  assert.ok(audit.rows.some((row) => row.action === 'merchant_partnership_status_changed'));
  assert.ok(audit.rows.some((row) => row.action === 'merchant_reward_created'));
  assert.ok(audit.rows.some((row) => row.action === 'merchant_reward_state_changed'));

  await assert.rejects(
    merchantService.recordRedemption({
      rewardId: eligible.id,
      source: 'merchant_confirmation',
      reference: 'different-redemption-reference',
      fingerprint: 'c'.repeat(64),
    }),
    /already|redeemed|not eligible/i,
  );
});
