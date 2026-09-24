import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import type { NextFunction, Request, Response } from 'express';
import { AdminService } from '../../services/admin.service';
import { runTrackedBackgroundJob } from '../../services/background-job.service';
import { createAdminAccessAudit } from '../../middlewares/admin.middleware';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-21 platform administration, telemetry and audit boundaries', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be21_${randomUUID().replace(/-/g, '')}`;
  const adminDb = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await db.end();
    await adminDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminDb.end();
  });

  await migrate({
    databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema,
    createSchema: true, migrationsSchema: schema, migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql', singleTransaction: true, log: () => {},
  });

  async function user(name: string, suffix: string, platformAdmin = false) {
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email,pin_hash,full_name,phone,status,is_platform_admin,is_email_verified)
       VALUES ($1,'hash',$2,$3,'active',$4,TRUE) RETURNING id`,
      [`${randomUUID()}@example.test`, name, `+254799${suffix.padStart(6, '0')}`, platformAdmin],
    )).rows[0].id;
  }

  const admin = await user('Platform Admin', '1', true);
  const peerAdmin = await user('Peer Admin', '2', true);
  const member = await user('Member One', '3');
  const memberTwo = await user('Member Two', '4');
  const service = new AdminService(db);

  const chama = (await db.query<{ id: string }>(
    `INSERT INTO chamas (name,type,status,visibility,contribution_amount,contribution_frequency,created_by)
     VALUES ('Admin Test Chama','goal_based','active','application',1000,'monthly',$1) RETURNING id`, [member],
  )).rows[0].id;
  await db.query(`INSERT INTO chama_members (chama_id,user_id,role,membership_status) VALUES ($1,$2,'member','active')`, [chama, member]);
  await db.query(`INSERT INTO chama_applications (chama_id,user_id,status) VALUES ($1,$2,'pending')`, [chama, memberTwo]);
  const ticket = (await db.query<{ id: string }>(
    `INSERT INTO support_tickets (ticket_code,user_id,chama_id,category,subject,message,status,routing_target)
     VALUES ($1,$2,$3,'payment_issue','Payment concern','Please inspect','open','platform_admin') RETURNING id`,
    [`MD-${randomUUID().replace(/-/g,'').slice(0,6).toUpperCase()}`, member, chama],
  )).rows[0].id;

  await t.test('overview uses live counts and exposes no cached prototype figures', async () => {
    const overview = await service.overview(new Date());
    assert.ok(overview.users.total >= 4);
    assert.ok(overview.chamas.active >= 1);
    assert.ok(overview.pendingApplications >= 1);
    assert.ok(overview.support.open_tickets >= 1);
  });

  await t.test('user moderation revokes sessions, audits the transition, and cannot target admins/self', async () => {
    const before = (await db.query<{ session_version: number }>('SELECT session_version FROM users WHERE id=$1',[member])).rows[0].session_version;
    const suspended = await service.moderateUser(admin, member, { action: 'suspend', reason: 'Confirmed account security review' });
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.sessionVersion, before + 1);
    const reactivated = await service.moderateUser(admin, member, { action: 'reactivate', reason: 'Security review completed successfully' });
    assert.equal(reactivated.status, 'active');
    assert.equal(reactivated.sessionVersion, before + 2);

    await assert.rejects(() => service.moderateUser(admin, admin, { action: 'suspend', reason: 'Should never be permitted' }), (e:{code?:string}) => e.code === 'ADMIN_SELF_MODERATION_FORBIDDEN');
    await assert.rejects(() => service.moderateUser(admin, peerAdmin, { action: 'suspend', reason: 'Should never be permitted' }), (e:{code?:string}) => e.code === 'ADMIN_PEER_MODERATION_FORBIDDEN');

    const auditCount = Number((await db.query<{count:number}>(
      `SELECT COUNT(*)::int AS count FROM audit_logs WHERE actor_id=$1 AND entity_id=$2 AND action='platform_admin_user_status_changed'`,[admin,member],
    )).rows[0].count);
    assert.equal(auditCount, 2);
  });

  await t.test('platform search, membership and role operations are scoped and audited', async () => {
    const search = await service.search('Member Two');
    assert.ok(search.users.some((row: { id: string }) => row.id === memberTwo));

    const membership = await service.addMembership(admin, chama, {
      userId: memberTwo, role: 'member', membershipStatus: 'active', reason: 'Approved assisted onboarding request',
    });
    assert.equal(membership.status, 'active');
    const changed = await service.changeRole(admin, chama, memberTwo, {
      role: 'secretary', reason: 'Approved leadership assignment correction',
    });
    assert.equal(changed.role, 'secretary');
    const events = Number((await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_logs WHERE actor_id=$1 AND entity_id=$2`, [admin, membership.id],
    )).rows[0].count);
    assert.equal(events, 2);
  });

  await t.test('ticket notes and broadcasts preserve operational evidence', async () => {
    const note = await service.addTicketComment(admin, ticket, { body: 'Provider evidence verified.', internal: true });
    assert.equal(note.is_internal, true);
    const comments = await service.listTicketComments(ticket);
    assert.equal(comments.length, 1);

    const queued = await service.broadcast(admin, {
      audience: 'platform_admins', channels: ['in_app'], title: 'Operations review',
      body: 'Please review the current platform operations queue.', reason: 'Coordinate the scheduled access review',
    });
    assert.ok(Number(queued.recipientCount) >= 2);
    assert.equal(queued.notificationCount, Number(queued.recipientCount));
  });

  await t.test('revenue reads the platform revenue ledger rather than provider rows', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const tx = (await client.query<{id:string}>(
        `INSERT INTO ledger_transactions(operation_type,reference,initiated_by,metadata)
         VALUES('platform_fee',$1,$2,$3::jsonb) RETURNING id`,
        [`be21:${randomUUID()}`,admin,JSON.stringify({source:'be10_subscription'})],
      )).rows[0].id;
      await client.query(
        `INSERT INTO ledger_entries(ledger_transaction_id,chama_id,account,side,amount,currency)
         VALUES($1,$2,'external_clearing','debit',1500,'KES'),($1,$2,'platform_fee_revenue','credit',1500,'KES')`,[tx,chama],
      );
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    const revenue = await service.revenue('all');
    assert.equal(revenue.total, '1500');
    assert.equal(revenue.subscriptions, '1500');
  });

  await t.test('Chama admin list deliberately excludes private financial totals', async () => {
    const result = await service.listChamas({page:1,perPage:10});
    const row = result.chamas.find((item) => item.id === chama)!;
    assert.equal(row.financialDetailsIncluded, false);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'pooledAmount'), false);
  });

  await t.test('background executions persist success/failure for system-health', async () => {
    const ok = await runTrackedBackgroundJob('reports', async () => ({processed:2}), db);
    assert.deepEqual(ok, {processed:2});
    await assert.rejects(() => runTrackedBackgroundJob('meetings', async () => { throw new Error('synthetic worker failure'); }, db), /synthetic worker failure/);
    const health = await service.systemHealth(new Date());
    assert.ok(health.backgroundJobs.latest.some((run) => run.jobName === 'reports' && run.status === 'succeeded'));
    assert.ok(health.backgroundJobs.failedLast24h >= 1);
    assert.equal(health.status, 'degraded');
  });

  await t.test('every admin route access can be fail-closed audit logged without query values', async () => {
    const middleware = createAdminAccessAudit(db);
    let nextError: unknown;
    await new Promise<void>((resolve) => {
      const req = {
        user: { id: admin, isPlatformAdmin: true }, method: 'GET', originalUrl: '/api/v1/admin/users?q=secret',
        query: { q: 'secret' }, ip: '127.0.0.1', get: (name:string) => name.toLowerCase()==='user-agent'?'be21-test-agent':undefined,
      } as unknown as Request;
      const next: NextFunction = (error?: unknown) => { nextError = error; resolve(); };
      void middleware(req, {} as Response, next);
    });
    assert.equal(nextError, undefined);
    const event = (await db.query<{payload:{path:string;queryKeys:string[]};user_agent:string|null}>(
      `SELECT payload,user_agent FROM audit_logs WHERE actor_id=$1 AND action='platform_admin_access' ORDER BY created_at DESC LIMIT 1`,[admin],
    )).rows[0];
    assert.equal(event.payload.path, '/api/v1/admin/users');
    assert.deepEqual(event.payload.queryKeys, ['q']);
    assert.equal(JSON.stringify(event.payload).includes('secret'), false);
    assert.equal(event.user_agent, 'be21-test-agent');
  });
});
