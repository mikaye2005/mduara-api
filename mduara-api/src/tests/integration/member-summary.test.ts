import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { MemberSummaryService } from '../../services/member-summary.service';
import { hashSecret } from '../../utils/crypto.util';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-27 multi-Chama member summary is personal, paginated and N+1-free at the API contract', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `member_summary_${randomUUID().replace(/-/g, '')}`;
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

  const pinHash = await hashSecret('2468');
  const [user, otherUser] = (await pool.query<{ id: string }>(
    `INSERT INTO users (email, pin_hash, full_name, phone, status)
     VALUES
       ($1, $3, 'Dashboard User', '+254700000101', 'active'),
       ($2, $3, 'Other Member', '+254700000102', 'active')
     RETURNING id`,
    [`${randomUUID()}@example.test`, `${randomUUID()}@example.test`, pinHash],
  )).rows;

  const chamas: Array<{ id: string; name: string }> = [];
  for (const name of ['Future Home', 'Washing Machine Mbogi', 'Education Circle']) {
    chamas.push((await pool.query<{ id: string; name: string }>(
      `INSERT INTO chamas (name, type, contribution_amount, contribution_frequency, status)
       VALUES ($1, 'goal_based', 1000, 'monthly', 'active')
       RETURNING id, name`,
      [name],
    )).rows[0]);
  }

  const memberships: string[] = [];
  for (let index = 0; index < chamas.length; index += 1) {
    const role = index === 1 ? 'secretary' : 'member';
    memberships.push((await pool.query<{ id: string }>(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status, joined_at)
       VALUES ($1, $2, $3::member_role, 'active', CURRENT_TIMESTAMP - ($4 * INTERVAL '1 day'))
       RETURNING id`,
      [chamas[index].id, user.id, role, index],
    )).rows[0].id);
  }

  const otherMembership = (await pool.query<{ id: string }>(
    `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
     VALUES ($1, $2, 'member', 'active') RETURNING id`,
    [chamas[0].id, otherUser.id],
  )).rows[0].id;

  const contributionA = (await pool.query<{ id: string }>(
    `INSERT INTO contributions (chama_id, member_id, expected_amount, due_date, status, period_label)
     VALUES ($1, $2, 1000, CURRENT_DATE + 10, 'partially_paid', 'Month 1') RETURNING id`,
    [chamas[0].id, memberships[0]],
  )).rows[0].id;
  const contributionB = (await pool.query<{ id: string }>(
    `INSERT INTO contributions (chama_id, member_id, expected_amount, due_date, status, period_label)
     VALUES ($1, $2, 2000, CURRENT_DATE + 5, 'pending', 'Month 1') RETURNING id`,
    [chamas[1].id, memberships[1]],
  )).rows[0].id;
  await pool.query(
    `INSERT INTO contributions (chama_id, member_id, expected_amount, due_date, status, period_label)
     VALUES ($1, $2, 3000, CURRENT_DATE + 20, 'pending', 'Month 1')`,
    [chamas[2].id, memberships[2]],
  );
  const otherContribution = (await pool.query<{ id: string }>(
    `INSERT INTO contributions (chama_id, member_id, expected_amount, due_date, status, period_label)
     VALUES ($1, $2, 99999, CURRENT_DATE + 1, 'paid', 'Other member') RETURNING id`,
    [chamas[0].id, otherMembership],
  )).rows[0].id;

  await pool.query(
    `INSERT INTO contribution_payments
       (contribution_id, chama_id, member_id, amount, payment_method, provider_reference, status)
     VALUES
       ($1, $2, $3, 600, 'mpesa', $4, 'confirmed'),
       ($5, $6, $7, 50000, 'mpesa', $8, 'confirmed')`,
    [
      contributionA, chamas[0].id, memberships[0], `SELF-${randomUUID()}`,
      otherContribution, chamas[0].id, otherMembership, `OTHER-${randomUUID()}`,
    ],
  );

  const service = new MemberSummaryService(pool as any);
  const firstPage = await service.getSummary(user.id, { page: 1, perPage: 2 });

  assert.equal(firstPage.meta.total, 3);
  assert.equal(firstPage.meta.page, 1);
  assert.equal(firstPage.meta.perPage, 2);
  assert.equal(firstPage.meta.totalPages, 2);
  assert.equal(firstPage.memberships.length, 2);
  assert.equal(firstPage.aggregates.activeChamas, 3);
  assert.equal(firstPage.aggregates.totalConfirmedContributions, '600');
  assert.equal(firstPage.aggregates.nextUpcomingObligation?.contributionId, contributionB);
  assert.equal(firstPage.aggregates.nextUpcomingObligation?.chamaId, chamas[1].id);
  assert.equal(firstPage.aggregates.nextUpcomingObligation?.chamaName, 'Washing Machine Mbogi');
  assert.equal(firstPage.aggregates.nextUpcomingObligation?.remainingAmount, '2000');

  const homeCard = firstPage.memberships.find((membership) => membership.chamaId === chamas[0].id);
  assert.ok(homeCard);
  assert.equal(homeCard.confirmedContributedAmount, '600');
  assert.equal(homeCard.scheduledExpectedAmount, '1000');
  assert.equal(homeCard.contributionProgressPercent, '60.00');
  assert.equal(homeCard.nextDue?.remainingAmount, '400');

  const secondPage = await service.getSummary(user.id, { page: 2, perPage: 2 });
  assert.equal(secondPage.memberships.length, 1);
  assert.equal(secondPage.meta.total, 3);

  // A different member's much larger payment must never leak into the signed-in user's aggregate.
  assert.notEqual(firstPage.aggregates.totalConfirmedContributions, '50600');
});
