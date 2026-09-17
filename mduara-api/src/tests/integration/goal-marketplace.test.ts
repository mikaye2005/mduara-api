import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { GoalMarketplaceService } from '../../services/goal-marketplace.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-30 goal marketplace metrics are data-driven, deduplicated and lifecycle-safe', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `goal_metrics_${randomUUID().replace(/-/g, '')}`;
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

  const users = [
    ['30000000-0000-4000-8000-000000000001', 'Asha One', '+254700000001', 'asha1@example.test'],
    ['30000000-0000-4000-8000-000000000002', 'Asha Two', '+254700000002', 'asha2@example.test'],
    ['30000000-0000-4000-8000-000000000003', 'Pending Member', '+254700000003', 'pending@example.test'],
    ['30000000-0000-4000-8000-000000000004', 'Closed Member', '+254700000004', 'closed@example.test'],
  ];

  for (const [id, fullName, phone, email] of users) {
    await pool.query(
      `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified)
       VALUES ($1, $2, 'test-pin-hash', $3, $4, 'active', TRUE)`,
      [id, email, fullName, phone],
    );
  }

  const chamaRows = await pool.query<{ id: string; name: string }>(
    `INSERT INTO chamas
       (name, type, status, visibility, goal_code, contribution_amount, contribution_frequency, target_amount, currency)
     VALUES
       ('WM Active', 'goal_based', 'active', 'public', 'washing_machine', 5000, 'monthly', 2000000, 'KES'),
       ('WM Recruiting', 'goal_based', 'recruiting', 'application', 'washing_machine', 5000, 'monthly', 1800000, 'KES'),
       ('WM Completed', 'goal_based', 'completed', 'public', 'washing_machine', 5000, 'monthly', 9000000, 'KES'),
       ('WM Private', 'goal_based', 'active', 'private', 'washing_machine', 5000, 'monthly', 8000000, 'KES'),
       ('WM USD', 'goal_based', 'active', 'public', 'washing_machine', 5000, 'monthly', 500000, 'USD'),
       ('Fridge Active', 'goal_based', 'active', 'public', 'fridge', 4000, 'monthly', 700000, 'KES')
     RETURNING id, name`,
  );
  const chamaId = new Map(chamaRows.rows.map((row) => [row.name, row.id]));

  await pool.query(
    `INSERT INTO chama_members (chama_id, user_id, membership_status)
     VALUES
       ($1, $5, 'active'),
       ($2, $5, 'active'),
       ($2, $6, 'active'),
       ($1, $7, 'pending'),
       ($3, $8, 'active'),
       ($4, $8, 'active'),
       ($9, $8, 'active')`,
    [
      chamaId.get('WM Active'),
      chamaId.get('WM Recruiting'),
      chamaId.get('WM Completed'),
      chamaId.get('WM Private'),
      users[0][0],
      users[1][0],
      users[2][0],
      users[3][0],
      chamaId.get('WM USD'),
    ],
  );

  const service = new GoalMarketplaceService(pool);
  const washingBeforeMerchants = await service.getMetric('washing_machine');
  assert.equal(washingBeforeMerchants.membersSaving, 2);
  assert.equal(washingBeforeMerchants.totalTargetValue, '3800000');
  assert.equal(washingBeforeMerchants.currency, 'KES');
  assert.equal(washingBeforeMerchants.partnerMerchantCount, 0);

  const homeMetrics = await service.listMetrics('home_appliances');
  assert.equal(homeMetrics.length, 4);
  assert.equal(homeMetrics.find((goal) => goal.code === 'fridge')?.totalTargetValue, '700000');

  await pool.query(`
    CREATE TABLE partner_merchants (
      id UUID PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE goal_merchant_partnerships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      goal_id UUID NOT NULL REFERENCES saving_goals(id) ON DELETE CASCADE,
      merchant_id UUID NOT NULL REFERENCES partner_merchants(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ
    );
  `);

  await pool.query(
    `INSERT INTO partner_merchants (id, status) VALUES
       ('40000000-0000-4000-8000-000000000001', 'active'),
       ('40000000-0000-4000-8000-000000000002', 'active'),
       ('40000000-0000-4000-8000-000000000003', 'active'),
       ('40000000-0000-4000-8000-000000000004', 'inactive'),
       ('40000000-0000-4000-8000-000000000005', 'active')`,
  );

  await pool.query(
    `INSERT INTO goal_merchant_partnerships (goal_id, merchant_id, status, valid_from, valid_until) VALUES
       ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'active', CURRENT_TIMESTAMP - INTERVAL '1 day', NULL),
       ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', 'active', NULL, CURRENT_TIMESTAMP + INTERVAL '1 day'),
       ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000003', 'active', NULL, NULL),
       ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000004', 'active', NULL, NULL),
       ('20000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000005', 'active', NULL, CURRENT_TIMESTAMP - INTERVAL '1 day'),
       ('20000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000005', 'inactive', NULL, NULL)`,
  );

  const washingWithMerchants = await service.getMetric('washing_machine');
  assert.equal(washingWithMerchants.partnerMerchantCount, 3);

  await assert.rejects(service.getMetric('not_a_real_goal'), /Saving goal not found/);
});
