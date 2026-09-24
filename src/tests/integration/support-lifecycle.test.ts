import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { SupportService } from '../../services/support.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-19 support ticket routing, evidence and audit lifecycle', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be19_${randomUUID().replace(/-/g, '')}`;
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

  async function user(name: string, suffix: string, isPlatformAdmin = false) {
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email,pin_hash,full_name,phone,status,is_platform_admin)
       VALUES ($1,'hash',$2,$3,'active',$4) RETURNING id`,
      [`${randomUUID()}@example.test`, name, `+254711${suffix.padStart(6, '0')}`, isPlatformAdmin],
    )).rows[0].id;
  }

  const owner = await user('Ticket Owner', '1');
  const chair = await user('Ticket Chair', '2');
  const platformAdmin = await user('Platform Admin', '3', true);
  const outsider = await user('Ticket Outsider', '4');

  const chama = (await db.query<{ id: string }>(
    `INSERT INTO chamas (name,type,status,visibility,contribution_amount,contribution_frequency,created_by)
     VALUES ('Support Chama','goal_based','active','application',1000,'monthly',$1) RETURNING id`, [chair],
  )).rows[0].id;
  const chairMembership = (await db.query<{ id: string }>(
    `INSERT INTO chama_members (chama_id,user_id,role,membership_status)
     VALUES ($1,$2,'chairperson','active') RETURNING id`, [chama, chair],
  )).rows[0].id;
  assert.ok(chairMembership);
  const ownerMembership = (await db.query<{ id: string }>(
    `INSERT INTO chama_members (chama_id,user_id,role,membership_status)
     VALUES ($1,$2,'member','active') RETURNING id`, [chama, owner],
  )).rows[0].id;

  const contribution = (await db.query<{ id: string }>(
    `INSERT INTO contributions (chama_id,member_id,expected_amount,due_date,status)
     VALUES ($1,$2,1000,CURRENT_DATE,'pending') RETURNING id`, [chama, ownerMembership],
  )).rows[0].id;
  const checkout = `ws_CO_${randomUUID()}`;
  const payment = (await db.query<{ id: string }>(
    `INSERT INTO payment_provider_logs
       (user_id,contribution_id,chama_id,member_id,merchant_request_id,checkout_request_id,
        amount,currency,phone_number,status,result_code,result_desc,receipt_number,callback_verified_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,1000,'KES','254711000001','failed',1032,'Cancelled by user',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     RETURNING id`,
    [owner, contribution, chama, ownerMembership, `merchant-${randomUUID()}`, checkout],
  )).rows[0].id;

  const service = new SupportService(db);

  await t.test('payment issue auto-attaches the owner M-Pesa evidence and routes to platform admin', async () => {
    const ticket = await service.createTicket(owner, {
      category: 'payment_issue', subject: 'M-Pesa payment failed', message: 'The STK request failed but I need help.', paymentReference: checkout,
    });
    assert.match(ticket.ticketCode, /^MD-[0-9A-F]{6}$/);
    assert.equal(ticket.routingTarget, 'platform_admin');
    assert.equal(ticket.assignedTo, platformAdmin);
    assert.equal(ticket.relatedEntity?.type, 'payment_provider_log');
    assert.equal(ticket.relatedEntity?.id, payment);
    assert.equal((ticket.context as { checkoutRequestId?: string }).checkoutRequestId, checkout);
    assert.equal((ticket.context as { amount?: string }).amount, '1000');

    await assert.rejects(
      () => service.getTicket(outsider, ticket.id),
      (error: { code?: string }) => error.code === 'SUPPORT_TICKET_FORBIDDEN',
    );
    await assert.rejects(
      () => service.getTicket(chair, ticket.id),
      (error: { code?: string }) => error.code === 'SUPPORT_TICKET_FORBIDDEN',
    );
    await assert.rejects(
      () => service.updateTicket(platformAdmin, ticket.id, { assignedTo: chair }),
      (error: { code?: string }) => error.code === 'SUPPORT_TICKET_ASSIGNEE_INVALID',
    );
    const own = await service.getTicket(owner, ticket.ticketCode.toLowerCase());
    assert.equal(own.id, ticket.id);
  });

  await t.test('Chama issue snapshots membership and routes to active Chairperson', async () => {
    const ticket = await service.createTicket(owner, {
      category: 'chama_issue', subject: 'Chama governance concern', message: 'I need the Chairperson to review this matter.', chamaId: chama,
    });
    assert.equal(ticket.routingTarget, 'chama_chair');
    assert.equal(ticket.assignedTo, chair);
    assert.equal(ticket.relatedEntity?.type, 'membership');
    assert.equal(ticket.relatedEntity?.id, ownerMembership);
  });

  await t.test('Chair/Super Admin transitions are constrained and every status change is audited', async () => {
    const ticket = await service.createTicket(owner, {
      category: 'chama_issue', subject: 'Contribution governance issue', message: 'Please review this Chama-level issue.', chamaId: chama,
    });

    await assert.rejects(
      () => service.updateTicket(owner, ticket.id, { status: 'in_progress' }),
      (error: { code?: string }) => error.code === 'SUPPORT_TICKET_MANAGE_FORBIDDEN',
    );

    const inProgress = await service.updateTicket(chair, ticket.id, { status: 'in_progress', assignedTo: chair });
    assert.equal(inProgress.status, 'in_progress');

    await assert.rejects(
      () => service.updateTicket(chair, ticket.id, { status: 'closed' }),
      (error: { code?: string }) => error.code === 'SUPPORT_TICKET_STATUS_TRANSITION_INVALID',
    );

    const resolved = await service.updateTicket(chair, ticket.id, { status: 'resolved', resolutionNotes: 'Reviewed and agreed corrective action.' });
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolvedAt);
    const closed = await service.updateTicket(platformAdmin, ticket.id, { status: 'closed' });
    assert.equal(closed.status, 'closed');

    const auditCount = Number((await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_logs
        WHERE entity_id = $1 AND action = 'support_ticket_status_changed'`, [ticket.id],
    )).rows[0].count);
    assert.equal(auditCount, 3);
  });

  await t.test('Chama escalation atomically hands the ticket to platform support', async () => {
    const ticket = await service.createTicket(owner, {
      category: 'chama_issue', subject: 'Escalation required', message: 'This issue needs platform-level review.', chamaId: chama,
    });
    assert.equal(ticket.assignedTo, chair);
    const escalated = await service.updateTicket(chair, ticket.id, { status: 'escalated' });
    assert.equal(escalated.status, 'escalated');
    assert.equal(escalated.assignedTo, platformAdmin);

    await assert.rejects(
      () => service.updateTicket(chair, ticket.id, { status: 'in_progress' }),
      (error: { code?: string }) => error.code === 'SUPPORT_TICKET_MANAGE_FORBIDDEN',
    );
    const accepted = await service.updateTicket(platformAdmin, ticket.id, { status: 'in_progress' });
    assert.equal(accepted.status, 'in_progress');
  });

  await t.test('ticket evidence context cannot be rewritten after creation', async () => {
    const ticket = await service.createTicket(owner, {
      category: 'payment_issue', subject: 'Another payment issue', message: 'Please inspect this provider result.', paymentReference: checkout,
    });
    await assert.rejects(
      () => db.query(`UPDATE support_tickets SET context_snapshot = '{"tampered":true}'::jsonb WHERE id = $1`, [ticket.id]),
      /immutable/i,
    );
    await assert.rejects(
      () => db.query(`UPDATE support_tickets SET routing_target = 'chama_chair' WHERE id = $1`, [ticket.id]),
      /immutable/i,
    );
  });

  await t.test('user ticket history is private to self and platform administrators', async () => {
    const own = await service.listUserTickets(owner, owner, { page: 1, perPage: 25 });
    assert.ok(own.tickets.length >= 4);
    const adminView = await service.listUserTickets(platformAdmin, owner, { page: 1, perPage: 25 });
    assert.equal(adminView.meta.total, own.meta.total);
    await assert.rejects(
      () => service.listUserTickets(outsider, owner, { page: 1, perPage: 25 }),
      (error: { code?: string }) => error.code === 'SUPPORT_TICKET_LIST_FORBIDDEN',
    );
  });
});
