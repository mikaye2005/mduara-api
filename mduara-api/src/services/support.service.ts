import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import type { CreateSupportTicketInput, UpdateSupportTicketInput } from '../validation/support.validation';

type TicketStatus = 'open' | 'in_progress' | 'escalated' | 'resolved' | 'closed';
type TicketCategory = 'payment_issue' | 'account_issue' | 'refund_issue' | 'chama_issue';
type RoutingTarget = 'platform_admin' | 'chama_chair';

interface TicketRow extends QueryResultRow {
  id: string;
  ticket_code: string;
  user_id: string;
  chama_id: string | null;
  category: TicketCategory;
  subject: string;
  message: string;
  status: TicketStatus;
  routing_target: RoutingTarget;
  assigned_to: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  context_snapshot: Record<string, unknown>;
  resolution_notes: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  assignee_name?: string | null;
}

interface TicketContext {
  chamaId: string | null;
  routingTarget: RoutingTarget;
  assignedTo: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  snapshot: Record<string, unknown>;
}

const STATUS_TRANSITIONS: Record<TicketStatus, ReadonlySet<TicketStatus>> = {
  open: new Set(['in_progress', 'escalated', 'resolved']),
  in_progress: new Set(['escalated', 'resolved']),
  escalated: new Set(['in_progress', 'resolved']),
  resolved: new Set(['closed', 'in_progress']),
  closed: new Set(['in_progress']),
};

export class SupportService {
  constructor(private readonly db: Pool = pool) {}

  async createTicket(userId: string, input: CreateSupportTicketInput) {
    // Public ticket codes are intentionally short, but uniqueness must never be
    // left to probability. Retry the whole transaction if the random public code
    // collides; the UUID remains the internal primary key.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const ticketCode = `MD-${randomBytes(3).toString('hex').toUpperCase()}`;
      try {
        return await withDatabaseTransaction(async (client) => {
          const context = await this.resolveContext(client, userId, input);
          const row = (await client.query<TicketRow>(
            `INSERT INTO support_tickets
               (ticket_code, user_id, chama_id, category, subject, message, routing_target, assigned_to,
                related_entity_type, related_entity_id, context_snapshot)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
             RETURNING id, ticket_code, user_id, chama_id, category::text AS category,
                       subject, message, status::text AS status, routing_target, assigned_to,
                       related_entity_type, related_entity_id, context_snapshot,
                       resolution_notes, resolved_by, resolved_at::text, created_at::text, updated_at::text`,
            [
              ticketCode,
              userId,
              context.chamaId,
              input.category,
              input.subject,
              input.message,
              context.routingTarget,
              context.assignedTo,
              context.relatedEntityType,
              context.relatedEntityId,
              JSON.stringify(context.snapshot),
            ],
          )).rows[0];

          await client.query(
            `INSERT INTO audit_logs
               (category, action, actor_id, chama_id, entity_type, entity_id, payload)
             VALUES ('moderation','support_ticket_created',$1,$2,'support_ticket',$3,$4::jsonb)`,
            [userId, context.chamaId, row.id, JSON.stringify({
              ticketCode: row.ticket_code,
              category: input.category,
              routingTarget: context.routingTarget,
              relatedEntityType: context.relatedEntityType,
              relatedEntityId: context.relatedEntityId,
            })],
          );
          return serializeTicket(row);
        }, {}, this.db);
      } catch (error) {
        if (attempt < 4 && isTicketCodeCollision(error)) continue;
        throw error;
      }
    }
    throw new ConflictError('Unable to allocate a unique support ticket code', 'SUPPORT_TICKET_CODE_EXHAUSTED');
  }

  async getTicket(actorId: string, identifier: string) {
    const row = await this.loadTicket(this.db, identifier);
    await this.assertCanView(this.db, actorId, row);
    const ticket = serializeTicket(await this.loadTicketWithAssignee(this.db, row.id));
    return { ...ticket, attachments: await this.loadCleanAttachments(row.id) };
  }

  async listUserTickets(actorId: string, userId: string, input: { page: number; perPage: number; status?: TicketStatus; category?: TicketCategory }) {
    if (actorId !== userId) {
      const admin = await this.db.query(`SELECT 1 FROM users WHERE id = $1 AND is_platform_admin = TRUE AND status = 'active'`, [actorId]);
      if (!admin.rowCount) throw new ForbiddenError('Ticket history is private to the user and platform administrators', 'SUPPORT_TICKET_LIST_FORBIDDEN');
    }
    const where = ['st.user_id = $1'];
    const values: unknown[] = [userId];
    if (input.status) { values.push(input.status); where.push(`st.status = $${values.length}::support_ticket_status`); }
    if (input.category) { values.push(input.category); where.push(`st.category = $${values.length}::support_ticket_category`); }
    const total = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM support_tickets st WHERE ${where.join(' AND ')}`,
      values,
    )).rows[0]?.count ?? 0);
    values.push(input.perPage, (input.page - 1) * input.perPage);
    const rows = await this.db.query<TicketRow>(
      `${ticketSelectSql()} WHERE ${where.join(' AND ')}
       ORDER BY st.created_at DESC, st.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      tickets: rows.rows.map(serializeTicket),
      meta: { total, page: input.page, perPage: input.perPage, totalPages: total ? Math.ceil(total / input.perPage) : 0 },
    };
  }

  async updateTicket(actorId: string, identifier: string, input: UpdateSupportTicketInput) {
    return withDatabaseTransaction(async (client) => {
      const current = await this.loadTicket(client, identifier, true);
      const manager = await this.requireManager(client, actorId, current);
      const nextStatus = input.status ?? current.status;

      if (input.status && input.status !== current.status && !STATUS_TRANSITIONS[current.status].has(input.status)) {
        throw new ConflictError(`Invalid support ticket transition: ${current.status} -> ${input.status}`, 'SUPPORT_TICKET_STATUS_TRANSITION_INVALID');
      }

      const nextResolution = input.resolutionNotes === undefined ? current.resolution_notes : input.resolutionNotes;
      if (['resolved', 'closed'].includes(nextStatus) && !nextResolution?.trim()) {
        throw new ConflictError('Resolution notes are required before resolving or closing a ticket', 'SUPPORT_TICKET_RESOLUTION_REQUIRED');
      }

      let assignedTo = input.assignedTo === undefined ? current.assigned_to : input.assignedTo;
      if (input.assignedTo !== undefined) {
        assignedTo = await this.validateAssignment(
          client,
          manager.role,
          current.routing_target,
          current.chama_id,
          input.assignedTo,
        );
      }
      // Escalating a Chama-owned issue is an actual hand-off, not just a label.
      // Move assignment to platform support atomically with the status change.
      if (input.status === 'escalated' && current.routing_target === 'chama_chair' && current.status !== 'escalated') {
        assignedTo = await findPlatformAdmin(client);
      }

      const reopening = ['resolved', 'closed'].includes(current.status) && nextStatus === 'in_progress';
      const resolving = nextStatus === 'resolved' && current.status !== 'resolved';
      const row = (await client.query<TicketRow>(
        `UPDATE support_tickets
            SET status = $2::support_ticket_status,
                assigned_to = $3,
                resolution_notes = $4,
                resolved_by = CASE
                  WHEN $5::boolean THEN $6::uuid
                  WHEN $7::boolean THEN NULL
                  ELSE resolved_by
                END,
                resolved_at = CASE
                  WHEN $5::boolean THEN CURRENT_TIMESTAMP
                  WHEN $7::boolean THEN NULL
                  ELSE resolved_at
                END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING id, ticket_code, user_id, chama_id, category::text AS category,
                    subject, message, status::text AS status, routing_target, assigned_to,
                    related_entity_type, related_entity_id, context_snapshot,
                    resolution_notes, resolved_by, resolved_at::text, created_at::text, updated_at::text`,
        [current.id, nextStatus, assignedTo, nextResolution, resolving, actorId, reopening],
      )).rows[0];

      if (input.status && input.status !== current.status) {
        await client.query(
          `INSERT INTO audit_logs
             (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
           VALUES ('moderation','support_ticket_status_changed',$1,$2::audit_actor_role,$3,'support_ticket',$4,$5::jsonb)`,
          [actorId, manager.role, current.chama_id, current.id, JSON.stringify({
            ticketCode: current.ticket_code,
            from: current.status,
            to: nextStatus,
            resolutionNotesChanged: input.resolutionNotes !== undefined,
          })],
        );
      }
      if (assignedTo !== current.assigned_to) {
        await client.query(
          `INSERT INTO audit_logs
             (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
           VALUES ('moderation','support_ticket_assignment_changed',$1,$2::audit_actor_role,$3,'support_ticket',$4,$5::jsonb)`,
          [actorId, manager.role, current.chama_id, current.id, JSON.stringify({ from: current.assigned_to, to: assignedTo })],
        );
      }
      return serializeTicket(row);
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  private async resolveContext(client: PoolClient, userId: string, input: CreateSupportTicketInput): Promise<TicketContext> {
    if (input.category === 'payment_issue') return this.resolvePaymentContext(client, userId, input.paymentReference!);
    if (input.category === 'refund_issue') return this.resolveRefundContext(client, userId, input.commitmentDepositId!);
    if (input.category === 'chama_issue') return this.resolveChamaContext(client, userId, input.chamaId!);

    const user = (await client.query<{ id: string; status: string; is_platform_admin: boolean }>(
      `SELECT id, status::text AS status, is_platform_admin FROM users WHERE id = $1`, [userId],
    )).rows[0];
    if (!user) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
    const admin = await findPlatformAdmin(client);
    return {
      chamaId: null,
      routingTarget: 'platform_admin',
      assignedTo: admin,
      relatedEntityType: 'user',
      relatedEntityId: user.id,
      snapshot: { userId: user.id, accountStatus: user.status },
    };
  }

  private async resolvePaymentContext(client: PoolClient, userId: string, reference: string): Promise<TicketContext> {
    const payment = (await client.query<{
      id: string; contribution_id: string | null; chama_id: string | null; member_id: string | null;
      merchant_request_id: string | null; checkout_request_id: string | null; amount: string; currency: string;
      status: string; result_code: number | null; result_desc: string | null; receipt_number: string | null;
      callback_verified_at: string | null; completed_at: string | null; created_at: string;
    }>(
      `SELECT id, contribution_id, chama_id, member_id, merchant_request_id, checkout_request_id,
              amount::text, currency, status::text AS status, result_code, result_desc, receipt_number,
              callback_verified_at::text, completed_at::text, created_at::text
         FROM payment_provider_logs
        WHERE user_id = $1
          AND (id::text = $2 OR checkout_request_id = $2 OR merchant_request_id = $2 OR receipt_number = $2)
        ORDER BY created_at DESC LIMIT 1`,
      [userId, reference],
    )).rows[0];
    if (!payment) throw new NotFoundError('M-Pesa transaction not found for this user', 'SUPPORT_PAYMENT_NOT_FOUND');
    const admin = await findPlatformAdmin(client);
    return {
      chamaId: payment.chama_id,
      routingTarget: 'platform_admin',
      assignedTo: admin,
      relatedEntityType: 'payment_provider_log',
      relatedEntityId: payment.id,
      snapshot: {
        provider: 'safaricom_daraja',
        paymentProviderLogId: payment.id,
        contributionId: payment.contribution_id,
        memberId: payment.member_id,
        merchantRequestId: payment.merchant_request_id,
        checkoutRequestId: payment.checkout_request_id,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        resultCode: payment.result_code,
        resultDescription: payment.result_desc,
        receiptNumber: payment.receipt_number,
        callbackVerifiedAt: payment.callback_verified_at,
        completedAt: payment.completed_at,
        createdAt: payment.created_at,
      },
    };
  }

  private async resolveRefundContext(client: PoolClient, userId: string, commitmentDepositId: string): Promise<TicketContext> {
    const deposit = (await client.query<{
      id: string; chama_id: string; membership_id: string; application_id: string; amount: string; state: string;
      provider: string | null; provider_reference: string | null; terminal_provider: string | null;
      terminal_provider_reference: string | null; forfeited_amount: string; refunded_amount: string;
      refund_requested_at: string | null; refunded_at: string | null;
    }>(
      `SELECT id, chama_id, membership_id, application_id, amount::text, state::text AS state,
              provider, provider_reference, terminal_provider, terminal_provider_reference,
              forfeited_amount::text, refunded_amount::text,
              refund_requested_at::text, refunded_at::text
         FROM commitment_deposits WHERE id = $1 AND user_id = $2`,
      [commitmentDepositId, userId],
    )).rows[0];
    if (!deposit) throw new NotFoundError('Commitment deposit not found for this user', 'SUPPORT_REFUND_NOT_FOUND');
    const admin = await findPlatformAdmin(client);
    return {
      chamaId: deposit.chama_id,
      routingTarget: 'platform_admin',
      assignedTo: admin,
      relatedEntityType: 'commitment_deposit',
      relatedEntityId: deposit.id,
      snapshot: {
        commitmentDepositId: deposit.id,
        membershipId: deposit.membership_id,
        applicationId: deposit.application_id,
        amount: deposit.amount,
        state: deposit.state,
        provider: deposit.provider,
        providerReference: deposit.provider_reference,
        terminalProvider: deposit.terminal_provider,
        terminalProviderReference: deposit.terminal_provider_reference,
        forfeitedAmount: deposit.forfeited_amount,
        refundedAmount: deposit.refunded_amount,
        refundRequestedAt: deposit.refund_requested_at,
        refundedAt: deposit.refunded_at,
      },
    };
  }

  private async resolveChamaContext(client: PoolClient, userId: string, chamaId: string): Promise<TicketContext> {
    const membership = (await client.query<{
      id: string; role: string; membership_status: string; joined_at: string;
    }>(
      `SELECT id, role::text AS role, membership_status::text AS membership_status, joined_at::text
         FROM chama_members WHERE chama_id = $1 AND user_id = $2`,
      [chamaId, userId],
    )).rows[0];
    if (!membership) throw new ForbiddenError('You must have a membership history in this Chama to open a Chama issue', 'SUPPORT_CHAMA_MEMBERSHIP_REQUIRED');
    const chair = await findChamaChair(client, chamaId);
    return {
      chamaId,
      routingTarget: 'chama_chair',
      assignedTo: chair,
      relatedEntityType: 'membership',
      relatedEntityId: membership.id,
      snapshot: {
        membershipId: membership.id,
        role: membership.role,
        membershipStatus: membership.membership_status,
        joinedAt: membership.joined_at,
      },
    };
  }

  private async loadTicket(db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, identifier: string, forUpdate = false) {
    const row = (await db.query<TicketRow>(
      `SELECT id, ticket_code, user_id, chama_id, category::text AS category,
              subject, message, status::text AS status, routing_target, assigned_to,
              related_entity_type, related_entity_id, context_snapshot,
              resolution_notes, resolved_by, resolved_at::text, created_at::text, updated_at::text
         FROM support_tickets
        WHERE id::text = $1 OR ticket_code = upper($1)
        ${forUpdate ? 'FOR UPDATE' : ''}
        LIMIT 1`,
      [identifier],
    )).rows[0];
    if (!row) throw new NotFoundError('Support ticket not found', 'SUPPORT_TICKET_NOT_FOUND');
    return row;
  }

  private async loadTicketWithAssignee(db: Pick<Pool, 'query'>, id: string) {
    const row = (await db.query<TicketRow>(`${ticketSelectSql()} WHERE st.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundError('Support ticket not found', 'SUPPORT_TICKET_NOT_FOUND');
    return row;
  }

  private async loadCleanAttachments(ticketId: string) {
    const rows = await this.db.query<{
      id: string; original_filename: string; detected_mime_type: string; size_bytes: string; content_sha256: string; scanned_at: string;
    }>(
      `SELECT id, original_filename, detected_mime_type, size_bytes::text, content_sha256, scanned_at::text
         FROM media_uploads
        WHERE support_ticket_id = $1
          AND purpose = 'support_ticket_attachment'
          AND state = 'clean'
        ORDER BY created_at ASC, id ASC`,
      [ticketId],
    );
    return rows.rows.map((item) => ({
      id: item.id,
      fileName: item.original_filename,
      mimeType: item.detected_mime_type,
      sizeBytes: Number(item.size_bytes),
      sha256: item.content_sha256,
      scannedAt: item.scanned_at,
      contentPath: `/api/v1/uploads/${item.id}/content`,
    }));
  }

  private async assertCanView(db: Pick<Pool, 'query'>, actorId: string, ticket: TicketRow) {
    if (ticket.user_id === actorId || ticket.assigned_to === actorId) return;
    const admin = await db.query(`SELECT 1 FROM users WHERE id = $1 AND is_platform_admin = TRUE AND status = 'active'`, [actorId]);
    if (admin.rowCount) return;
    if (ticket.routing_target === 'chama_chair' && ticket.chama_id) {
      const chair = await db.query(
        `SELECT 1 FROM chama_members WHERE chama_id = $1 AND user_id = $2
          AND role = 'chairperson' AND membership_status = 'active'`,
        [ticket.chama_id, actorId],
      );
      if (chair.rowCount) return;
    }
    throw new ForbiddenError('Support ticket access denied', 'SUPPORT_TICKET_FORBIDDEN');
  }

  private async requireManager(client: PoolClient, actorId: string, ticket: TicketRow) {
    const admin = await client.query(`SELECT 1 FROM users WHERE id = $1 AND is_platform_admin = TRUE AND status = 'active'`, [actorId]);
    if (admin.rowCount) return { role: 'platform_admin' as const };
    if (ticket.routing_target === 'chama_chair' && ticket.status !== 'escalated' && ticket.chama_id) {
      const chair = await client.query(
        `SELECT 1 FROM chama_members WHERE chama_id = $1 AND user_id = $2
          AND role = 'chairperson' AND membership_status = 'active'`,
        [ticket.chama_id, actorId],
      );
      if (chair.rowCount) return { role: 'chairperson' as const };
    }
    throw new ForbiddenError('Only the Chama Chairperson or a platform administrator may manage this ticket', 'SUPPORT_TICKET_MANAGE_FORBIDDEN');
  }

  private async validateAssignment(
    client: PoolClient,
    actorRole: 'chairperson' | 'platform_admin',
    routingTarget: RoutingTarget,
    chamaId: string | null,
    assignee: string | null,
  ) {
    if (assignee === null) {
      if (actorRole !== 'platform_admin') {
        throw new ForbiddenError('Only a platform administrator may unassign a ticket', 'SUPPORT_TICKET_UNASSIGN_FORBIDDEN');
      }
      return null;
    }

    if (actorRole === 'chairperson') {
      if (routingTarget !== 'chama_chair' || !chamaId) {
        throw new ForbiddenError('Chairpersons cannot reassign platform-support tickets', 'SUPPORT_TICKET_ASSIGNEE_INVALID');
      }
      const sameChamaChair = await client.query(
        `SELECT 1 FROM chama_members cm
          JOIN users u ON u.id = cm.user_id
         WHERE cm.user_id = $1 AND cm.chama_id = $2
           AND cm.role = 'chairperson' AND cm.membership_status = 'active'
           AND u.status = 'active'`,
        [assignee, chamaId],
      );
      if (!sameChamaChair.rowCount) {
        throw new ForbiddenError('Chairpersons may assign only to an active Chairperson of the same Chama', 'SUPPORT_TICKET_ASSIGNEE_INVALID');
      }
      return assignee;
    }

    const platformAdmin = await client.query(
      `SELECT 1 FROM users WHERE id = $1 AND is_platform_admin = TRUE AND status = 'active'`,
      [assignee],
    );
    if (platformAdmin.rowCount) return assignee;

    // Platform admins may hand a Chama-owned issue back to an active Chair,
    // but platform-only financial/account evidence must never be reassigned there.
    if (routingTarget === 'chama_chair' && chamaId) {
      const chair = await client.query(
        `SELECT 1 FROM chama_members cm
          JOIN users u ON u.id = cm.user_id
         WHERE cm.user_id = $1 AND cm.chama_id = $2
           AND cm.role = 'chairperson' AND cm.membership_status = 'active'
           AND u.status = 'active'`,
        [assignee, chamaId],
      );
      if (chair.rowCount) return assignee;
    }
    throw new ForbiddenError('Selected assignee is not eligible for this ticket', 'SUPPORT_TICKET_ASSIGNEE_INVALID');
  }

}


interface DatabaseError extends Error {
  code?: string;
  constraint?: string;
}

function isTicketCodeCollision(error: unknown) {
  const dbError = error as DatabaseError;
  return dbError?.code === '23505' && String(dbError.constraint ?? '').includes('ticket_code');
}

async function findPlatformAdmin(db: Pick<PoolClient, 'query'>) {
  return (await db.query<{ id: string }>(
    `SELECT id FROM users WHERE is_platform_admin = TRUE AND status = 'active' ORDER BY created_at, id LIMIT 1`,
  )).rows[0]?.id ?? null;
}

async function findChamaChair(db: Pick<PoolClient, 'query'>, chamaId: string) {
  return (await db.query<{ user_id: string }>(
    `SELECT user_id FROM chama_members
      WHERE chama_id = $1 AND role = 'chairperson' AND membership_status = 'active'
      ORDER BY joined_at, id LIMIT 1`,
    [chamaId],
  )).rows[0]?.user_id ?? null;
}

function ticketSelectSql() {
  return `SELECT st.id, st.ticket_code, st.user_id, st.chama_id,
                 st.category::text AS category, st.subject, st.message,
                 st.status::text AS status, st.routing_target, st.assigned_to,
                 st.related_entity_type, st.related_entity_id, st.context_snapshot,
                 st.resolution_notes, st.resolved_by, st.resolved_at::text,
                 st.created_at::text, st.updated_at::text,
                 assignee.full_name AS assignee_name
            FROM support_tickets st
            LEFT JOIN users assignee ON assignee.id = st.assigned_to`;
}

function serializeTicket(row: TicketRow) {
  return {
    id: row.id,
    ticketCode: row.ticket_code,
    userId: row.user_id,
    chamaId: row.chama_id,
    category: row.category,
    subject: row.subject,
    message: row.message,
    status: row.status,
    routingTarget: row.routing_target,
    assignedTo: row.assigned_to,
    assigneeName: row.assignee_name ?? null,
    relatedEntity: row.related_entity_type && row.related_entity_id
      ? { type: row.related_entity_type, id: row.related_entity_id }
      : null,
    context: row.context_snapshot ?? {},
    resolutionNotes: row.resolution_notes,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const supportService = new SupportService();
