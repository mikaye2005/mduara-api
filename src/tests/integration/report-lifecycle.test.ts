import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { ReportJobWorker } from '../../jobs/report.worker';
import { ReportService } from '../../services/report.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-18 report snapshots, queued exports and reconciliation', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be18_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema},public` });

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

  async function createUser(name: string, phoneSuffix: string) {
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1,'test-pin-hash',$2,$3,'active') RETURNING id`,
      [`${randomUUID()}@example.test`, name, `+254700${phoneSuffix.padStart(6, '0')}`],
    )).rows[0].id;
  }

  const chair = await createUser('Report Chair', '1');
  const memberUser = await createUser('Report Member', '2');
  const outsider = await createUser('Report Outsider', '3');

  const chama = (await db.query<{ id: string }>(
    `INSERT INTO chamas
       (name, type, status, visibility, contribution_amount, contribution_frequency, currency, created_by)
     VALUES ('Report Chama','goal_based','active','application',1000,'monthly','KES',$1)
     RETURNING id`,
    [chair],
  )).rows[0].id;

  const chairMembership = (await db.query<{ id: string }>(
    `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
     VALUES ($1,$2,'chairperson','active') RETURNING id`, [chama, chair],
  )).rows[0].id;
  assert.ok(chairMembership);
  const member = (await db.query<{ id: string }>(
    `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
     VALUES ($1,$2,'member','active') RETURNING id`, [chama, memberUser],
  )).rows[0].id;

  // One balanced journal. Only the member_contribution side is member-attributed,
  // so an individual statement is intentionally a scoped subset of the journal.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const tx = (await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (operation_type, reference, initiated_by, metadata)
       VALUES ('deposit',$1,$2,'{}'::jsonb) RETURNING id`,
      [`be18:${randomUUID()}`, memberUser],
    )).rows[0].id;
    await client.query(
      `INSERT INTO ledger_entries
         (ledger_transaction_id, chama_id, member_id, account, side, amount, currency)
       VALUES
         ($1,$2,$3,'member_contribution','debit',2500,'KES'),
         ($1,$2,NULL,'chama_treasury','credit',2500,'KES')`,
      [tx, chama, member],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const service = new ReportService(db);
  const worker = new ReportJobWorker(db, 3);

  await t.test('Chama JSON statement is an exact balanced ledger snapshot', async () => {
    const statement = await service.getChamaFinancialStatement(chair, chama, {});
    assert.equal(statement.summary.totalDebits, '2500');
    assert.equal(statement.summary.totalCredits, '2500');
    assert.equal(statement.summary.net, '0');
    assert.equal(statement.summary.balanced, true);
    assert.equal(statement.summary.entryCount, 2);
    assert.equal(statement.summary.transactionCount, 1);
  });

  await t.test('member statement is private to owner or Chama leadership', async () => {
    const own = await service.getMemberStatement(memberUser, member, {});
    assert.equal(own.summary.entryCount, 1);
    assert.equal(own.summary.balanced, null);
    assert.equal(own.subject.membershipId, member);

    const leadership = await service.getMemberStatement(chair, member, {});
    assert.equal(leadership.summary.entryCount, 1);

    await assert.rejects(
      () => service.getMemberStatement(outsider, member, {}),
      (error: { code?: string }) => error.code === 'REPORT_MEMBER_STATEMENT_FORBIDDEN',
    );
  });

  await t.test('Excel export queues, renders outside the request, and stores integrity metadata', async () => {
    const job = await service.enqueueChamaExport(chair, chama, 'excel', {});
    assert.equal(job.status, 'queued');

    const result = await worker.runBatch(5, new Date());
    assert.equal(result.ready, 1);

    const status = await service.getJobStatus(chair, job.id);
    assert.equal(status.status, 'ready');
    assert.equal(status.contentType, 'application/vnd.ms-excel');
    assert.match(status.contentSha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal((status as { content?: unknown }).content, undefined);
    assert.equal((status.reconciliation as { balanced?: boolean }).balanced, true);

    const download = await service.getDownloadJob(chair, job.id);
    assert.ok(download.content);
    assert.match(download.content!.toString('utf8', 0, 120), /Excel\.Sheet|Workbook/);

    const audits = Number((await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_logs
        WHERE entity_id = $1 AND action IN ('report_export_requested','report_export_generated')`,
      [job.id],
    )).rows[0].count);
    assert.equal(audits, 2);
  });

  await t.test('detailed PDF requires an entitled paid plan, then renders a real PDF', async () => {
    await assert.rejects(
      () => service.enqueueChamaExport(chair, chama, 'pdf', {}),
      (error: { code?: string }) => error.code === 'SUBSCRIPTION_FEATURE_REQUIRED',
    );

    await db.query(
      `INSERT INTO platform_subscriptions
         (chama_id, plan_code, plan_name, billing_frequency, amount, status,
          current_period_start, current_period_end, grace_ends_at)
       VALUES ($1,'premium_monthly','Premium Monthly','monthly',0,'active',
               CURRENT_TIMESTAMP - interval '1 day',
               CURRENT_TIMESTAMP + interval '30 days',
               CURRENT_TIMESTAMP + interval '37 days')`,
      [chama],
    );

    const job = await service.enqueueChamaExport(chair, chama, 'pdf', {});
    await worker.runBatch(5, new Date());
    const download = await service.getDownloadJob(chair, job.id);
    assert.equal(download.status, 'ready');
    assert.equal(download.contentType, 'application/pdf');
    assert.equal(download.content?.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  await t.test('expired report bytes are removed and cannot be downloaded', async () => {
    const job = await service.enqueueChamaExport(chair, chama, 'excel', {});
    await worker.runBatch(5, new Date());
    await db.query(`UPDATE report_jobs SET expires_at = CURRENT_TIMESTAMP - interval '1 second' WHERE id = $1`, [job.id]);
    const status = await service.getJobStatus(chair, job.id);
    assert.equal(status.status, 'expired');
    const stored = (await db.query<{ content: Buffer | null }>(`SELECT content FROM report_jobs WHERE id = $1`, [job.id])).rows[0];
    assert.equal(stored.content, null);
  });
});
