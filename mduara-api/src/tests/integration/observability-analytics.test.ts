import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { ChamaService } from '../../services/chama.service';
import { AnalyticsService } from '../../services/analytics.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-11 audit and analytics against PostgreSQL', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be11_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });
  await migrate({ databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema, createSchema: true,
    migrationsSchema: schema, migrationsTable: 'pgmigrations', ignorePattern: '.*\\.sql', singleTransaction: false, log: () => {} });

  const users: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    users.push((await pool.query(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1, '$2a$12$8sBAM5V4f1xFQvXtKQqS7uP8coKXZkV9g3Q1iKcYxn3VGcRJjKf6a', $2, $3, 'active') RETURNING id`,
      [`${randomUUID()}@example.test`, `Member ${i}`, `+254700${String(Date.now() + i).slice(-6)}`],
    )).rows[0].id);
  }
  const chama = (await pool.query(
    `INSERT INTO chamas (name, type, contribution_amount, contribution_frequency, status, pooled_amount)
     VALUES ('BE11 Chama', 'table_banking', 1000, 'monthly', 'active', 0) RETURNING id`,
  )).rows[0].id as string;
  const chairMembership = (await pool.query(
    `INSERT INTO chama_members (chama_id, user_id, role, membership_status) VALUES ($1,$2,'chairperson','active') RETURNING id`,
    [chama, users[0]],
  )).rows[0].id as string;
  const memberMembership = (await pool.query(
    `INSERT INTO chama_members (chama_id, user_id, role, membership_status) VALUES ($1,$2,'member','active') RETURNING id`,
    [chama, users[1]],
  )).rows[0].id as string;

  await t.test('role/status administration commits an immutable contextual audit row', async () => {
    const service = new ChamaService(pool);
    await service.updateMember({
      chamaId: chama,
      userId: users[1],
      updates: { role: 'secretary' },
      actorId: users[0],
      actorIp: '127.0.0.1',
      actorUserAgent: 'be11-test-agent',
    });
    const audit = (await pool.query(
      `SELECT actor_id, actor_role::text, ip_address::text, user_agent, payload
         FROM audit_logs WHERE action = 'chama.member_updated' ORDER BY created_at DESC LIMIT 1`,
    )).rows[0];
    assert.equal(audit.actor_id, users[0]);
    assert.equal(audit.actor_role, 'chairperson');
    assert.equal(audit.ip_address, '127.0.0.1/32');
    assert.equal(audit.user_agent, 'be11-test-agent');
    assert.equal(audit.payload.after.role, 'secretary');
    await assert.rejects(pool.query(`UPDATE audit_logs SET action = 'tampered' WHERE action = 'chama.member_updated'`));
    await assert.rejects(pool.query(`DELETE FROM audit_logs WHERE action = 'chama.member_updated'`));
  });

  await t.test('analytics are pre-bucketed for chart consumption', async () => {
    const depositTx = (await pool.query(
      `INSERT INTO ledger_transactions (operation_type, reference, initiated_by, created_at)
       VALUES ('deposit',$1,$2,'2026-08-05T10:00:00Z') RETURNING id`,
      [`be11-deposit-${randomUUID()}`, users[0]],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO ledger_entries (ledger_transaction_id, chama_id, member_id, account, side, amount, currency)
       VALUES ($1,$2,$3,'chama_treasury','debit',1000,'KES'),
              ($1,$2,$3,'member_contribution','credit',1000,'KES')`,
      [depositTx, chama, memberMembership],
    );
    const contribution = (await pool.query(
      `INSERT INTO contributions (chama_id, member_id, expected_amount, due_date, period_label, status)
       VALUES ($1,$2,1000,'2026-08-31','Aug','paid') RETURNING id`,
      [chama, memberMembership],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO contribution_payments (contribution_id, chama_id, member_id, amount, payment_method, status, paid_at)
       VALUES ($1,$2,$3,1000,'cash','confirmed','2026-08-31T12:00:00Z')`,
      [contribution, chama, memberMembership],
    );
    const loan = (await pool.query(
      `INSERT INTO loans (chama_id, member_id, principal_amount, interest_rate, total_due, status, disbursed_at, created_at)
       VALUES ($1,$2,500,10,550,'active','2026-08-10T10:00:00Z','2026-08-09T10:00:00Z') RETURNING id`,
      [chama, memberMembership],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO loan_repayments (loan_id, amount, payment_method, status, paid_at)
       VALUES ($1,275,'cash','confirmed','2026-08-20T10:00:00Z')`, [loan],
    );

    const analytics = await new AnalyticsService(pool).getChamaAnalytics(chama, '6m', new Date('2026-09-17T12:00:00Z'));
    assert.equal(analytics.bucket, 'month');
    assert.ok(analytics.growth.some((x) => x.bucket === '2026-08-01' && x.balance === '1000'));
    assert.ok(analytics.contributionCompliance.some((x) => x.bucket === '2026-08-01' && x.ratePct === 100));
    assert.ok(analytics.loanRepaymentRatios.some((x) => x.bucket === '2026-08-01' && x.ratioPct === 50));
    assert.equal('events' in (analytics as any), false);
  });
});
