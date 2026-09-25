import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { writeAuditEvent } from './audit.service';
import { hashSecret } from '../utils/crypto.util';
import type { AdminRange } from '../validation/admin.validation';

type PageInput = { page: number; perPage: number };

type UserStatus = 'pending' | 'active' | 'suspended' | 'deleted';

export class AdminService {
  constructor(private readonly db: Pool = pool) {}

  async provisionUser(actorId: string, input: { fullName: string; phone: string; email: string; temporaryPassword: string }, context?: { ip?: string | null; userAgent?: string | null }) {
    const passwordHash = await hashSecret(input.temporaryPassword);
    return withDatabaseTransaction(async (client) => {
      try {
        const row = (await client.query<{ id: string; full_name: string; phone: string; email: string; status: string }>(
          `INSERT INTO users (full_name, phone, email, pin_hash, status, is_email_verified, must_change_password)
           VALUES ($1, $2, $3, $4, 'active', FALSE, TRUE)
           RETURNING id, full_name, phone, email, status::text AS status`,
          [input.fullName, input.phone, input.email, passwordHash],
        )).rows[0];
        await writeAuditEvent(client, {
          category: 'security', action: 'platform_admin_user_provisioned', actorId, actorRole: 'platform_admin',
          entityType: 'user', entityId: row.id, ipAddress: context?.ip, userAgent: context?.userAgent,
          payload: { email: input.email, phone: input.phone, mustChangePassword: true },
        });
        return { id: row.id, fullName: row.full_name, phone: row.phone, email: row.email, status: row.status, mustChangePassword: true };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ConflictError('An account with this phone number or email already exists');
        throw error;
      }
    }, { isolationLevel: 'READ COMMITTED', maxRetries: 1 }, this.db);
  }

  async overview(now = new Date()) {
    const [users, chamas, applications, tickets, payments] = await Promise.all([
      this.db.query<{ total: number; active: number; pending: number; suspended: number; deleted: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
                COUNT(*) FILTER (WHERE status = 'deleted')::int AS deleted
           FROM users`,
      ),
      this.db.query<{ total: number; active: number; recruiting: number; completed: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                COUNT(*) FILTER (WHERE status = 'recruiting' AND recruitment_closed_at IS NULL)::int AS recruiting,
                COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
           FROM chamas`,
      ),
      this.db.query<{ pending: number }>(
        `SELECT COUNT(*)::int AS pending
           FROM chama_applications
          WHERE status IN ('pending','commitment_pending')`,
      ),
      this.db.query<{ open_tickets: number; payment_issues: number }>(
        `SELECT COUNT(*) FILTER (WHERE status IN ('open','in_progress','escalated'))::int AS open_tickets,
                COUNT(*) FILTER (WHERE category = 'payment_issue' AND status IN ('open','in_progress','escalated'))::int AS payment_issues
           FROM support_tickets`,
      ),
      this.db.query<{ provider_count: number; provider_amount: string; subscription_count: number; subscription_amount: string }>(
        `WITH boundary AS (
           SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS day_start
         )
         SELECT
           (SELECT COUNT(*)::int FROM payment_provider_logs p, boundary b
             WHERE p.status = 'confirmed' AND COALESCE(p.completed_at, p.created_at) >= b.day_start) AS provider_count,
           (SELECT COALESCE(SUM(p.amount),0)::text FROM payment_provider_logs p, boundary b
             WHERE p.status = 'confirmed' AND COALESCE(p.completed_at, p.created_at) >= b.day_start) AS provider_amount,
           (SELECT COUNT(*)::int FROM subscription_payments sp, boundary b
             WHERE sp.status = 'paid' AND COALESCE(sp.paid_at, sp.created_at) >= b.day_start) AS subscription_count,
           (SELECT COALESCE(SUM(sp.amount),0)::text FROM subscription_payments sp, boundary b
             WHERE sp.status = 'paid' AND COALESCE(sp.paid_at, sp.created_at) >= b.day_start) AS subscription_amount`,
        [now, env.SCHEDULER_TIMEZONE],
      ),
    ]);

    const p = payments.rows[0];
    return {
      generatedAt: now.toISOString(),
      timezone: env.SCHEDULER_TIMEZONE,
      users: users.rows[0],
      chamas: chamas.rows[0],
      pendingApplications: Number(applications.rows[0]?.pending ?? 0),
      support: tickets.rows[0],
      paymentsToday: {
        currency: 'KES',
        confirmedCount: Number(p?.provider_count ?? 0) + Number(p?.subscription_count ?? 0),
        confirmedAmount: (BigInt(p?.provider_amount ?? '0') + BigInt(p?.subscription_amount ?? '0')).toString(),
        contributionOrCommitmentCount: Number(p?.provider_count ?? 0),
        subscriptionCount: Number(p?.subscription_count ?? 0),
      },
    };
  }

  async revenue(range: AdminRange = '6m', now = new Date()) {
    const { start, bucket } = rangeWindow(range, now);
    const rows = await this.db.query<{ bucket: string; total: string; subscriptions: string; other: string }>(
      `SELECT date_trunc($1, lt.created_at AT TIME ZONE $4)::date::text AS bucket,
              COALESCE(SUM(CASE WHEN le.side = 'credit' THEN le.amount ELSE -le.amount END),0)::text AS total,
              COALESCE(SUM(CASE WHEN COALESCE(lt.metadata->>'source','') = 'be10_subscription'
                                THEN CASE WHEN le.side = 'credit' THEN le.amount ELSE -le.amount END ELSE 0 END),0)::text AS subscriptions,
              COALESCE(SUM(CASE WHEN COALESCE(lt.metadata->>'source','') <> 'be10_subscription'
                                THEN CASE WHEN le.side = 'credit' THEN le.amount ELSE -le.amount END ELSE 0 END),0)::text AS other
         FROM ledger_entries le
         JOIN ledger_transactions lt ON lt.id = le.ledger_transaction_id
        WHERE le.account = 'platform_fee_revenue'
          AND ($2::timestamptz IS NULL OR lt.created_at >= $2)
          AND lt.created_at <= $3
        GROUP BY 1 ORDER BY 1`,
      [bucket, start, now, env.SCHEDULER_TIMEZONE],
    );
    const total = rows.rows.reduce((sum, row) => sum + BigInt(row.total), 0n);
    const subscriptions = rows.rows.reduce((sum, row) => sum + BigInt(row.subscriptions), 0n);
    return {
      currency: 'KES', range, bucket, generatedAt: now.toISOString(),
      total: total.toString(),
      subscriptions: subscriptions.toString(),
      otherPlatformFees: (total - subscriptions).toString(),
      series: rows.rows,
    };
  }

  async listUsers(input: PageInput & { status?: UserStatus; q?: string }) {
    const offset = (input.page - 1) * input.perPage;
    const values: unknown[] = [input.status ?? null, input.q ?? null];
    const where = `($1::text IS NULL OR u.status::text = $1)
       AND ($2::text IS NULL OR u.full_name ILIKE '%' || $2 || '%' OR u.phone ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%' OR u.id::text = $2)`;
    const total = Number((await this.db.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users u WHERE ${where}`, values)).rows[0]?.count ?? 0);
    const rows = await this.db.query<{
      id: string; full_name: string; phone: string; email: string; status: UserStatus; is_email_verified: boolean;
      is_platform_admin: boolean; last_login_at: string | null; created_at: string; chama_count: number; contexts: unknown;
    }>(
      `SELECT u.id, u.full_name, u.phone, u.email, u.status::text AS status,
              u.is_email_verified, u.is_platform_admin, u.last_login_at::text, u.created_at::text,
              (SELECT COUNT(*)::int FROM chama_members cm WHERE cm.user_id = u.id AND cm.membership_status = 'active') AS chama_count,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('chamaId', cm.chama_id, 'chamaName', c.name, 'role', cm.role::text)
                                         ORDER BY c.name, cm.chama_id)
                          FROM chama_members cm JOIN chamas c ON c.id = cm.chama_id
                         WHERE cm.user_id = u.id AND cm.membership_status = 'active'), '[]'::jsonb) AS contexts
         FROM users u
        WHERE ${where}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT $3 OFFSET $4`,
      [...values, input.perPage, offset],
    );
    return { users: rows.rows.map((row) => ({
      id: row.id, fullName: row.full_name, phone: row.phone, email: row.email, status: row.status,
      isEmailVerified: row.is_email_verified, isPlatformAdmin: row.is_platform_admin,
      lastLoginAt: iso(row.last_login_at), createdAt: iso(row.created_at), chamaCount: Number(row.chama_count), contexts: row.contexts,
    })), meta: pageMeta(total, input) };
  }

  async moderateUser(actorId: string, userId: string, input: { action: 'suspend' | 'reactivate' | 'delete'; reason: string }, context?: { ip?: string | null; userAgent?: string | null }) {
    if (actorId === userId) throw new ForbiddenError('Platform administrators cannot moderate their own account through this endpoint', 'ADMIN_SELF_MODERATION_FORBIDDEN');
    return withDatabaseTransaction(async (client) => {
      const current = (await client.query<{ id: string; status: UserStatus; is_platform_admin: boolean; session_version: number }>(
        `SELECT id, status::text AS status, is_platform_admin, session_version FROM users WHERE id = $1 FOR UPDATE`, [userId],
      )).rows[0];
      if (!current) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
      if (current.is_platform_admin) throw new ForbiddenError('Platform-admin accounts require a separate administrator-governance process', 'ADMIN_PEER_MODERATION_FORBIDDEN');

      let next: UserStatus;
      if (input.action === 'suspend') {
        if (current.status !== 'active') throw new ConflictError('Only active users can be suspended through moderation', 'ADMIN_USER_STATE_INVALID');
        next = 'suspended';
      } else if (input.action === 'reactivate') {
        if (current.status !== 'suspended') throw new ConflictError('Only suspended users can be reactivated through moderation', 'ADMIN_USER_STATE_INVALID');
        next = 'active';
      } else {
        if (current.status === 'deleted') throw new ConflictError('User is already deleted', 'ADMIN_USER_ALREADY_DELETED');
        next = 'deleted';
      }

      const row = (await client.query<{ id: string; full_name: string; phone: string; email: string; status: UserStatus; session_version: number; status_reason: string | null }>(
        `UPDATE users SET
           status = $2::user_status,
           status_reason = $3,
           suspended_at = CASE WHEN $2 = 'suspended' THEN CURRENT_TIMESTAMP WHEN $2 = 'active' THEN NULL ELSE suspended_at END,
           suspended_by = CASE WHEN $2 = 'suspended' THEN $4::uuid WHEN $2 = 'active' THEN NULL ELSE suspended_by END,
           deleted_at = CASE WHEN $2 = 'deleted' THEN CURRENT_TIMESTAMP ELSE deleted_at END,
           deleted_by = CASE WHEN $2 = 'deleted' THEN $4::uuid ELSE deleted_by END,
           session_version = session_version + 1,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, full_name, phone, email, status::text AS status, session_version, status_reason`,
        [userId, next, input.reason, actorId],
      )).rows[0];

      await writeAuditEvent(client, {
        category: 'moderation', action: 'platform_admin_user_status_changed', actorId, actorRole: 'platform_admin',
        entityType: 'user', entityId: userId, ipAddress: context?.ip, userAgent: context?.userAgent,
        payload: { from: current.status, to: next, action: input.action, reason: input.reason, sessionVersionBefore: current.session_version, sessionVersionAfter: row.session_version },
      });
      return { id: row.id, fullName: row.full_name, phone: row.phone, email: row.email, status: row.status, statusReason: row.status_reason, sessionVersion: row.session_version };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async listChamas(input: PageInput & { status?: string; q?: string }) {
    const params = [input.status ?? null, input.q ?? null] as unknown[];
    const where = `($1::text IS NULL OR c.status::text = $1)
      AND ($2::text IS NULL OR c.name ILIKE '%' || $2 || '%' OR COALESCE(c.location,'') ILIKE '%' || $2 || '%' OR COALESCE(sg.name,'') ILIKE '%' || $2 || '%' OR c.id::text = $2)`;
    const total = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM chamas c LEFT JOIN saving_goals sg ON sg.code = c.goal_code WHERE ${where}`, params,
    )).rows[0]?.count ?? 0);
    const rows = await this.db.query<{
      id: string; name: string; type: string; status: string; visibility: string; goal_code: string | null; goal_name: string | null;
      location: string | null; target_members: number | null; recruitment_deadline: string | null; recruitment_closed_at: string | null;
      created_at: string; active_members: number;
    }>(
      `SELECT c.id, c.name, c.type::text AS type, c.status::text AS status, c.visibility::text AS visibility,
              c.goal_code, sg.name AS goal_name, c.location, c.target_members, c.recruitment_deadline::text,
              c.recruitment_closed_at::text, c.created_at::text,
              (SELECT COUNT(*)::int FROM chama_members cm WHERE cm.chama_id = c.id AND cm.membership_status = 'active') AS active_members
         FROM chamas c LEFT JOIN saving_goals sg ON sg.code = c.goal_code
        WHERE ${where}
        ORDER BY c.created_at DESC, c.id DESC LIMIT $3 OFFSET $4`,
      [...params, input.perPage, (input.page - 1) * input.perPage],
    );
    return { chamas: rows.rows.map((row) => ({
      id: row.id, name: row.name, type: row.type, status: row.status, visibility: row.visibility,
      goalCode: row.goal_code, goalName: row.goal_name, location: row.location, targetMembers: row.target_members,
      activeMembers: Number(row.active_members), recruitmentDeadline: row.recruitment_deadline,
      recruitmentClosedAt: iso(row.recruitment_closed_at), createdAt: iso(row.created_at),
      financialDetailsIncluded: false,
    })), meta: pageMeta(total, input) };
  }

  async listPayments(input: PageInput & { status?: string; from?: string; to?: string; q?: string }) {
    const values = [input.status ?? null, input.from ?? null, input.to ?? null, input.q ?? null, env.SCHEDULER_TIMEZONE] as unknown[];
    const where = `($1::text IS NULL OR p.status::text = $1)
      AND ($2::date IS NULL OR p.created_at >= ($2::date::timestamp AT TIME ZONE $5))
      AND ($3::date IS NULL OR p.created_at < (($3::date + INTERVAL '1 day') AT TIME ZONE $5))
      AND ($4::text IS NULL OR p.id::text = $4 OR COALESCE(p.checkout_request_id,'') ILIKE '%' || $4 || '%' OR COALESCE(p.receipt_number,'') ILIKE '%' || $4 || '%' OR COALESCE(u.full_name,'') ILIKE '%' || $4 || '%' OR COALESCE(c.name,'') ILIKE '%' || $4 || '%')`;
    const total = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM payment_provider_logs p LEFT JOIN users u ON u.id=p.user_id LEFT JOIN chamas c ON c.id=p.chama_id WHERE ${where}`, values,
    )).rows[0]?.count ?? 0);
    const rows = await this.db.query<{
      id: string; checkout_request_id: string | null; receipt_number: string | null; amount: string; currency: string; status: string;
      result_code: number | null; result_desc: string | null; callback_verified_at: string | null; completed_at: string | null; created_at: string;
      user_id: string | null; user_name: string | null; chama_id: string | null; chama_name: string | null; contribution_id: string | null;
    }>(
      `SELECT p.id, p.checkout_request_id, p.receipt_number, p.amount::text, p.currency, p.status::text AS status,
              p.result_code, p.result_desc, p.callback_verified_at::text, p.completed_at::text, p.created_at::text,
              p.user_id, u.full_name AS user_name, p.chama_id, c.name AS chama_name, p.contribution_id
         FROM payment_provider_logs p LEFT JOIN users u ON u.id=p.user_id LEFT JOIN chamas c ON c.id=p.chama_id
        WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT $6 OFFSET $7`,
      [...values, input.perPage, (input.page - 1) * input.perPage],
    );
    return { payments: rows.rows.map((row) => ({
      id: row.id, checkoutRequestId: row.checkout_request_id, receiptNumber: row.receipt_number,
      amount: row.amount, currency: row.currency, status: row.status, resultCode: row.result_code,
      resultDescription: row.result_desc, callbackVerifiedAt: iso(row.callback_verified_at), completedAt: iso(row.completed_at), createdAt: iso(row.created_at),
      user: row.user_id ? { id: row.user_id, name: row.user_name } : null,
      chama: row.chama_id ? { id: row.chama_id, name: row.chama_name } : null,
      contributionId: row.contribution_id,
    })), meta: pageMeta(total, input) };
  }

  async getPayment(paymentId:string){
    const payment=(await this.db.query(`SELECT p.*,p.amount::text,p.status::text AS status,u.full_name AS user_name,
      c.name AS chama_name,cm.role::text AS member_role FROM payment_provider_logs p
      LEFT JOIN users u ON u.id=p.user_id LEFT JOIN chamas c ON c.id=p.chama_id LEFT JOIN chama_members cm ON cm.id=p.member_id
      WHERE p.id=$1`,[paymentId])).rows[0];
    if(!payment) throw new NotFoundError('Payment not found','PAYMENT_NOT_FOUND');
    const references=[payment.receipt_number,payment.checkout_request_id,payment.merchant_request_id].filter(Boolean);
    const [reconciliation,audit,ledger]=await Promise.all([
      this.db.query(`SELECT lri.id,lri.status::text AS status,lri.provider_reference,lri.provider_amount::text,lri.ledger_amount::text,
        lri.provider_currency,lri.ledger_currency,lri.provider_occurred_at::text,lrr.provider,lrr.window_start::text,lrr.window_end::text
        FROM ledger_reconciliation_items lri JOIN ledger_reconciliation_runs lrr ON lrr.id=lri.run_id
        WHERE lri.provider_reference=ANY($1::text[]) ORDER BY lri.created_at DESC`,[references]),
      this.db.query(`SELECT id,category::text AS category,action,actor_id,actor_role::text,payload,created_at::text
        FROM audit_logs WHERE entity_type='payment_provider_log' AND entity_id=$1 ORDER BY created_at`,[paymentId]),
      this.db.query(`SELECT lt.id,lt.operation_type,lt.reference,lt.metadata,lt.created_at::text,
        COALESCE(jsonb_agg(jsonb_build_object('account',le.account::text,'side',le.side::text,'amount',le.amount::text,'currency',le.currency)
          ORDER BY le.id) FILTER(WHERE le.id IS NOT NULL),'[]'::jsonb) AS entries
        FROM ledger_transactions lt LEFT JOIN ledger_entries le ON le.ledger_transaction_id=lt.id
        WHERE lt.reference=ANY($1::text[]) OR lt.metadata->>'paymentProviderLogId'=$2
        GROUP BY lt.id ORDER BY lt.created_at`,[references,paymentId]),
    ]);
    return{...payment,raw_payload:undefined,request_payload:undefined,providerEvidence:{requestPayload:payment.request_payload,rawPayload:payment.raw_payload},
      reconciliation:reconciliation.rows,ledgerTransactions:ledger.rows,auditEvents:audit.rows};
  }

  async listRefunds(input: PageInput & { state?: string; q?: string }) {
    return this.listCommitments('refund', input);
  }

  async listDefaults(input: PageInput & { state?: string; q?: string }) {
    return this.listCommitments('default', input);
  }

  private async listCommitments(kind: 'refund' | 'default', input: PageInput & { state?: string; q?: string }) {
    const allowed = kind === 'refund'
      ? ['eligible_for_refund', 'refund_requested', 'refunded', 'partial_forfeit']
      : ['default_triggered', 'forfeited', 'partial_forfeit'];
    const values: unknown[] = [allowed, input.state ?? null, input.q ?? null];
    const where = `cd.state::text = ANY($1::text[])
      AND ($2::text IS NULL OR cd.state::text = $2)
      AND ($3::text IS NULL OR cd.id::text = $3 OR u.full_name ILIKE '%' || $3 || '%' OR c.name ILIKE '%' || $3 || '%')`;
    const total = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM commitment_deposits cd JOIN users u ON u.id=cd.user_id JOIN chamas c ON c.id=cd.chama_id WHERE ${where}`, values,
    )).rows[0]?.count ?? 0);
    const rows = await this.db.query<{
      id: string; state: string; user_id: string; user_name: string; chama_id: string; chama_name: string; membership_id: string;
      refund_requested_at: string | null; refunded_at: string | null; default_triggered_at: string | null; forfeited_at: string | null;
      provider: string | null; provider_reference: string | null; terminal_provider: string | null; terminal_provider_reference: string | null; updated_at: string;
    }>(
      `SELECT cd.id, cd.state::text AS state, cd.user_id, u.full_name AS user_name,
              cd.chama_id, c.name AS chama_name, cd.membership_id,
              cd.refund_requested_at::text, cd.refunded_at::text, cd.default_triggered_at::text, cd.forfeited_at::text,
              cd.provider, cd.provider_reference, cd.terminal_provider, cd.terminal_provider_reference, cd.updated_at::text
         FROM commitment_deposits cd JOIN users u ON u.id=cd.user_id JOIN chamas c ON c.id=cd.chama_id
        WHERE ${where} ORDER BY cd.updated_at DESC, cd.id DESC LIMIT $4 OFFSET $5`,
      [...values, input.perPage, (input.page - 1) * input.perPage],
    );
    return { items: rows.rows.map((row) => ({
      id: row.id, state: row.state, membershipId: row.membership_id,
      user: { id: row.user_id, name: row.user_name }, chama: { id: row.chama_id, name: row.chama_name },
      refundRequestedAt: iso(row.refund_requested_at), refundedAt: iso(row.refunded_at), defaultTriggeredAt: iso(row.default_triggered_at), forfeitedAt: iso(row.forfeited_at),
      provider: row.provider, providerReference: row.provider_reference, terminalProvider: row.terminal_provider, terminalProviderReference: row.terminal_provider_reference,
      updatedAt: iso(row.updated_at), amountIncluded: false,
    })), meta: pageMeta(total, input) };
  }

  async listApplications(input: PageInput & { status?: string; q?: string }) {
    const values = [input.status ?? null, input.q ?? null] as unknown[];
    const where = `($1::text IS NULL OR ca.status::text = $1)
      AND ($2::text IS NULL OR ca.id::text = $2 OR u.full_name ILIKE '%' || $2 || '%' OR c.name ILIKE '%' || $2 || '%')`;
    const total = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM chama_applications ca JOIN users u ON u.id=ca.user_id JOIN chamas c ON c.id=ca.chama_id WHERE ${where}`, values,
    )).rows[0]?.count ?? 0);
    const rows = await this.db.query<{
      id:string; status:string; user_id:string; user_name:string; chama_id:string; chama_name:string; constitution_accepted_at:string|null; reviewed_by:string|null; reviewed_at:string|null; rejection_reason:string|null; created_at:string;
    }>(
      `SELECT ca.id, ca.status::text AS status, ca.user_id, u.full_name AS user_name, ca.chama_id, c.name AS chama_name,
              ca.constitution_accepted_at::text, ca.reviewed_by, ca.reviewed_at::text, ca.rejection_reason, ca.created_at::text
         FROM chama_applications ca JOIN users u ON u.id=ca.user_id JOIN chamas c ON c.id=ca.chama_id
        WHERE ${where} ORDER BY ca.created_at DESC, ca.id DESC LIMIT $3 OFFSET $4`,
      [...values, input.perPage, (input.page - 1) * input.perPage],
    );
    return { applications: rows.rows.map((r) => ({
      id:r.id,status:r.status,user:{id:r.user_id,name:r.user_name},chama:{id:r.chama_id,name:r.chama_name},
      constitutionAcceptedAt:iso(r.constitution_accepted_at),reviewedBy:r.reviewed_by,reviewedAt:iso(r.reviewed_at),rejectionReason:r.rejection_reason,createdAt:iso(r.created_at),
      moderationMode:'chama_governed' as const,
    })), meta: pageMeta(total,input) };
  }

  async listTickets(input: PageInput & { status?: string; category?: string; q?: string }) {
    const values = [input.status ?? null, input.category ?? null, input.q ?? null] as unknown[];
    const where = `($1::text IS NULL OR st.status::text=$1) AND ($2::text IS NULL OR st.category::text=$2)
      AND ($3::text IS NULL OR st.ticket_code ILIKE '%'||$3||'%' OR st.subject ILIKE '%'||$3||'%' OR u.full_name ILIKE '%'||$3||'%' OR COALESCE(c.name,'') ILIKE '%'||$3||'%')`;
    const total = Number((await this.db.query<{count:number}>(
      `SELECT COUNT(*)::int AS count FROM support_tickets st JOIN users u ON u.id=st.user_id LEFT JOIN chamas c ON c.id=st.chama_id WHERE ${where}`,values,
    )).rows[0]?.count??0);
    const rows=await this.db.query<{
      id:string;ticket_code:string;category:string;subject:string;status:string;routing_target:string;assigned_to:string|null;user_id:string;user_name:string;chama_id:string|null;chama_name:string|null;created_at:string;updated_at:string;
    }>(
      `SELECT st.id,st.ticket_code,st.category::text AS category,st.subject,st.status::text AS status,st.routing_target,st.assigned_to,
              st.user_id,u.full_name AS user_name,st.chama_id,c.name AS chama_name,st.created_at::text,st.updated_at::text
         FROM support_tickets st JOIN users u ON u.id=st.user_id LEFT JOIN chamas c ON c.id=st.chama_id
        WHERE ${where} ORDER BY st.created_at DESC,st.id DESC LIMIT $4 OFFSET $5`,
      [...values,input.perPage,(input.page-1)*input.perPage],
    );
    return {tickets:rows.rows.map(r=>({id:r.id,ticketCode:r.ticket_code,category:r.category,subject:r.subject,status:r.status,routingTarget:r.routing_target,assignedTo:r.assigned_to,user:{id:r.user_id,name:r.user_name},chama:r.chama_id?{id:r.chama_id,name:r.chama_name}:null,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at)})),meta:pageMeta(total,input)};
  }

  async search(query: string, limit = 10) {
    const pattern = `%${query}%`;
    const [users, chamas, payments, tickets] = await Promise.all([
      this.db.query(`SELECT id, full_name AS label, phone, email, status::text AS status FROM users
        WHERE full_name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1 OR id::text = $2 ORDER BY full_name LIMIT $3`, [pattern, query, limit]),
      this.db.query(`SELECT id, name AS label, type::text AS type, status::text AS status FROM chamas
        WHERE name ILIKE $1 OR id::text = $2 ORDER BY name LIMIT $3`, [pattern, query, limit]),
      this.db.query(`SELECT p.id, COALESCE(p.receipt_number,p.checkout_request_id,p.id::text) AS label,
          p.amount::text, p.currency, p.status::text AS status, p.user_id, p.chama_id
        FROM payment_provider_logs p WHERE p.id::text=$2 OR COALESCE(p.receipt_number,'') ILIKE $1
          OR COALESCE(p.checkout_request_id,'') ILIKE $1 OR COALESCE(p.merchant_request_id,'') ILIKE $1
        ORDER BY p.created_at DESC LIMIT $3`, [pattern, query, limit]),
      this.db.query(`SELECT id, ticket_code AS label, subject, status::text AS status, user_id, chama_id FROM support_tickets
        WHERE ticket_code ILIKE $1 OR subject ILIKE $1 OR id::text=$2 ORDER BY created_at DESC LIMIT $3`, [pattern, query, limit]),
    ]);
    return { query, users: users.rows, chamas: chamas.rows, payments: payments.rows, tickets: tickets.rows };
  }

  async getUser(userId: string) {
    const user = (await this.db.query<{
      id:string;full_name:string;phone:string;email:string;status:string;status_reason:string|null;is_email_verified:boolean;
      is_platform_admin:boolean;last_login_at:string|null;created_at:string;updated_at:string;
    }>(`SELECT id,full_name,phone,email,status::text AS status,status_reason,is_email_verified,is_platform_admin,
              last_login_at::text,created_at::text,updated_at::text FROM users WHERE id=$1`,[userId])).rows[0];
    if (!user) throw new NotFoundError('User not found','USER_NOT_FOUND');
    const [memberships,tickets,payments,audit] = await Promise.all([
      this.db.query(`SELECT cm.id,cm.chama_id,c.name AS chama_name,cm.role::text AS role,
        cm.membership_status::text AS status,cm.commitment_status::text AS commitment_status,cm.joined_at::text
        FROM chama_members cm JOIN chamas c ON c.id=cm.chama_id WHERE cm.user_id=$1 ORDER BY cm.joined_at DESC`,[userId]),
      this.db.query(`SELECT id,ticket_code,category::text AS category,subject,status::text AS status,created_at::text
        FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,[userId]),
      this.db.query(`SELECT id,amount::text,currency,status::text AS status,receipt_number,checkout_request_id,chama_id,created_at::text
        FROM payment_provider_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,[userId]),
      this.db.query(`SELECT id,category::text AS category,action,actor_id,payload,created_at::text FROM audit_logs
        WHERE entity_id=$1 OR actor_id=$1 ORDER BY created_at DESC LIMIT 20`,[userId]),
    ]);
    return { id:user.id,fullName:user.full_name,phone:user.phone,email:user.email,status:user.status,statusReason:user.status_reason,
      isEmailVerified:user.is_email_verified,isPlatformAdmin:user.is_platform_admin,lastLoginAt:iso(user.last_login_at),
      createdAt:iso(user.created_at),updatedAt:iso(user.updated_at),memberships:memberships.rows,tickets:tickets.rows,payments:payments.rows,auditEvents:audit.rows };
  }

  async getChama(chamaId: string) {
    const chama=(await this.db.query(`SELECT c.*,c.type::text AS type,c.status::text AS status,c.visibility::text AS visibility,
      sg.name AS goal_name FROM chamas c LEFT JOIN saving_goals sg ON sg.code=c.goal_code WHERE c.id=$1`,[chamaId])).rows[0];
    if(!chama) throw new NotFoundError('Chama not found','CHAMA_NOT_FOUND');
    const [members,rules,tickets,loans,applications] = await Promise.all([
      this.db.query(`SELECT cm.id,cm.user_id,u.full_name,u.phone,u.email,cm.role::text AS role,
        cm.membership_status::text AS status,cm.commitment_status::text AS commitment_status,cm.joined_at::text
        FROM chama_members cm JOIN users u ON u.id=cm.user_id WHERE cm.chama_id=$1
        ORDER BY CASE cm.role WHEN 'chairperson' THEN 1 WHEN 'secretary' THEN 2 WHEN 'treasurer' THEN 3 ELSE 4 END,u.full_name`,[chamaId]),
      this.db.query(`SELECT id,version,status::text AS status,template_code,purpose_goal,contribution_amount::text,
        contribution_frequency,commitment_amount::text,default_grace_period_days,default_after_consecutive_misses,
        quorum_threshold_pct::text,majority_threshold_pct::text,effective_from::text,amendment_summary,created_at::text
        FROM chama_rules WHERE chama_id=$1 ORDER BY version DESC`,[chamaId]),
      this.db.query(`SELECT id,ticket_code,category::text AS category,subject,status::text AS status,created_at::text
        FROM support_tickets WHERE chama_id=$1 ORDER BY created_at DESC LIMIT 25`,[chamaId]),
      this.db.query(`SELECT l.id,l.member_id,u.full_name AS member_name,l.principal_amount::text,l.total_due::text,
        l.status::text AS status,l.application_date::text,l.due_date::text FROM loans l JOIN chama_members cm ON cm.id=l.member_id
        JOIN users u ON u.id=cm.user_id WHERE l.chama_id=$1 ORDER BY l.application_date DESC LIMIT 25`,[chamaId]),
      this.db.query(`SELECT ca.id,ca.user_id,u.full_name AS user_name,ca.status::text AS status,ca.created_at::text
        FROM chama_applications ca JOIN users u ON u.id=ca.user_id WHERE ca.chama_id=$1 ORDER BY ca.created_at DESC LIMIT 25`,[chamaId]),
    ]);
    return { ...chama,contribution_amount:String(chama.contribution_amount),target_amount:chama.target_amount===null?null:String(chama.target_amount),
      pooled_amount:String(chama.pooled_amount),members:members.rows,rules:rules.rows,tickets:tickets.rows,loans:loans.rows,applications:applications.rows };
  }

  async addMembership(actorId:string,chamaId:string,input:{userId:string;role:string;membershipStatus:string;reason:string},context?:{ip?:string|null;userAgent?:string|null}){
    return withDatabaseTransaction(async(client)=>{
      const chama=(await client.query<{id:string}>(`SELECT id FROM chamas WHERE id=$1 FOR UPDATE`,[chamaId])).rows[0];
      if(!chama) throw new NotFoundError('Chama not found','CHAMA_NOT_FOUND');
      const user=(await client.query<{id:string;status:string}>(`SELECT id,status::text AS status FROM users WHERE id=$1`,[input.userId])).rows[0];
      if(!user) throw new NotFoundError('User not found','USER_NOT_FOUND');
      if(user.status==='deleted') throw new ConflictError('Deleted users cannot be added to a Chama','ADMIN_MEMBERSHIP_USER_INVALID');
      const existing=(await client.query(`SELECT id FROM chama_members WHERE chama_id=$1 AND user_id=$2`,[chamaId,input.userId])).rows[0];
      if(existing) throw new ConflictError('This user already has a membership in the Chama','ADMIN_MEMBERSHIP_EXISTS');
      const row=(await client.query(`INSERT INTO chama_members(chama_id,user_id,role,membership_status,approved_by,approved_at)
        VALUES($1,$2,$3::member_role,$4::membership_status,$5,CASE WHEN $4='active' THEN CURRENT_TIMESTAMP ELSE NULL END)
        RETURNING id,chama_id,user_id,role::text AS role,membership_status::text AS status,joined_at::text`,[chamaId,input.userId,input.role,input.membershipStatus,actorId])).rows[0];
      await writeAuditEvent(client,{category:'moderation',action:'platform_admin_membership_created',actorId,actorRole:'platform_admin',chamaId,
        entityType:'membership',entityId:row.id,ipAddress:context?.ip,userAgent:context?.userAgent,payload:{userId:input.userId,role:input.role,status:input.membershipStatus,reason:input.reason}});
      return row;
    },{isolationLevel:'SERIALIZABLE',maxRetries:2},this.db);
  }

  async changeRole(actorId:string,chamaId:string,userId:string,input:{role:string;reason:string},context?:{ip?:string|null;userAgent?:string|null}){
    return withDatabaseTransaction(async(client)=>{
      const current=(await client.query<{id:string;role:string;status:string}>(`SELECT id,role::text AS role,membership_status::text AS status
        FROM chama_members WHERE chama_id=$1 AND user_id=$2 FOR UPDATE`,[chamaId,userId])).rows[0];
      if(!current) throw new NotFoundError('Chama membership not found','MEMBERSHIP_NOT_FOUND');
      if(current.role===input.role) throw new ConflictError('The membership already has this role','ADMIN_ROLE_UNCHANGED');
      if(current.role==='chairperson'&&current.status==='active'&&input.role!=='chairperson'){
        const otherChairs=Number((await client.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM chama_members
          WHERE chama_id=$1 AND user_id<>$2 AND role='chairperson' AND membership_status='active'`,[chamaId,userId])).rows[0]?.count??0);
        if(otherChairs===0) throw new ConflictError('Assign another active chairperson before demoting the current chairperson','LAST_ACTIVE_CHAIRPERSON');
      }
      const row=(await client.query(`UPDATE chama_members SET role=$3::member_role,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND chama_id=$2 RETURNING id,chama_id,user_id,role::text AS role,membership_status::text AS status,updated_at::text`,[current.id,chamaId,input.role])).rows[0];
      await writeAuditEvent(client,{category:'security',action:'platform_admin_chama_role_changed',actorId,actorRole:'platform_admin',chamaId,
        entityType:'membership',entityId:current.id,ipAddress:context?.ip,userAgent:context?.userAgent,payload:{userId,from:current.role,to:input.role,reason:input.reason}});
      return row;
    },{isolationLevel:'SERIALIZABLE',maxRetries:2},this.db);
  }

  async listLoans(input:PageInput&{status?:string;q?:string}){
    const values:unknown[]=[input.status??null,input.q??null];
    const where=`($1::text IS NULL OR l.status::text=$1) AND ($2::text IS NULL OR l.id::text=$2 OR u.full_name ILIKE '%'||$2||'%' OR c.name ILIKE '%'||$2||'%')`;
    const total=Number((await this.db.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM loans l JOIN chama_members cm ON cm.id=l.member_id JOIN users u ON u.id=cm.user_id JOIN chamas c ON c.id=l.chama_id WHERE ${where}`,values)).rows[0]?.count??0);
    const rows=await this.db.query(`SELECT l.id,l.chama_id,c.name AS chama_name,l.member_id,u.id AS user_id,u.full_name AS user_name,
      l.principal_amount::text,l.interest_rate::text,l.total_due::text,l.purpose,l.application_date::text,l.due_date::text,l.status::text AS status,
      COALESCE((SELECT SUM(lg.guaranteed_amount) FROM loan_guarantors lg WHERE lg.loan_id=l.id),0)::text AS guaranteed_amount,
      (SELECT COUNT(*)::int FROM loan_guarantors lg WHERE lg.loan_id=l.id) AS guarantor_count
      FROM loans l JOIN chama_members cm ON cm.id=l.member_id JOIN users u ON u.id=cm.user_id JOIN chamas c ON c.id=l.chama_id
      WHERE ${where} ORDER BY l.application_date DESC,l.id DESC LIMIT $3 OFFSET $4`,[...values,input.perPage,(input.page-1)*input.perPage]);
    return{loans:rows.rows,meta:pageMeta(total,input)};
  }

  async addTicketComment(actorId:string,identifier:string,input:{body:string;internal:boolean},context?:{ip?:string|null;userAgent?:string|null}){
    return withDatabaseTransaction(async(client)=>{
      const ticket=(await client.query<{id:string;chama_id:string|null}>(`SELECT id,chama_id FROM support_tickets WHERE id::text=$1 OR ticket_code=$1 FOR UPDATE`,[identifier])).rows[0];
      if(!ticket) throw new NotFoundError('Support ticket not found','SUPPORT_TICKET_NOT_FOUND');
      const row=(await client.query(`INSERT INTO support_ticket_comments(ticket_id,author_id,body,is_internal) VALUES($1,$2,$3,$4)
        RETURNING id,ticket_id,author_id,body,is_internal,created_at::text`,[ticket.id,actorId,input.body,input.internal])).rows[0];
      await writeAuditEvent(client,{category:'moderation',action:'platform_admin_ticket_comment_added',actorId,actorRole:'platform_admin',chamaId:ticket.chama_id,
        entityType:'support_ticket',entityId:ticket.id,ipAddress:context?.ip,userAgent:context?.userAgent,payload:{commentId:row.id,internal:input.internal}});
      return row;
    },{isolationLevel:'READ COMMITTED'},this.db);
  }

  async listTicketComments(identifier:string){
    const ticket=(await this.db.query<{id:string}>(`SELECT id FROM support_tickets WHERE id::text=$1 OR ticket_code=$1`,[identifier])).rows[0];
    if(!ticket) throw new NotFoundError('Support ticket not found','SUPPORT_TICKET_NOT_FOUND');
    const rows=await this.db.query(`SELECT stc.id,stc.author_id,u.full_name AS author_name,stc.body,stc.is_internal,stc.created_at::text
      FROM support_ticket_comments stc LEFT JOIN users u ON u.id=stc.author_id WHERE stc.ticket_id=$1 ORDER BY stc.created_at,stc.id`,[ticket.id]);
    return rows.rows;
  }

  async listNotifications(input:PageInput&{status?:string;channel?:string}){
    const values:unknown[]=[input.status??null,input.channel??null];
    const where=`($1::text IS NULL OR n.status::text=$1) AND ($2::text IS NULL OR n.channel::text=$2)`;
    const total=Number((await this.db.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM notifications n WHERE ${where}`,values)).rows[0]?.count??0);
    const rows=await this.db.query(`SELECT n.id,n.user_id,u.full_name AS user_name,n.chama_id,c.name AS chama_name,n.event_type,n.channel::text AS channel,
      n.title,n.body,n.status::text AS status,n.sent_at::text,n.read_at::text,n.failed_at::text,n.failure_reason,n.created_at::text
      FROM notifications n JOIN users u ON u.id=n.user_id LEFT JOIN chamas c ON c.id=n.chama_id WHERE ${where}
      ORDER BY n.created_at DESC,n.id DESC LIMIT $3 OFFSET $4`,[...values,input.perPage,(input.page-1)*input.perPage]);
    return{notifications:rows.rows,meta:pageMeta(total,input)};
  }

  async broadcast(actorId:string,input:{audience:string;chamaId?:string;channels:string[];title:string;body:string;reason:string},context?:{ip?:string|null;userAgent?:string|null}){
    return withDatabaseTransaction(async(client)=>{
      if(input.chamaId){const exists=(await client.query(`SELECT 1 FROM chamas WHERE id=$1`,[input.chamaId])).rowCount;if(!exists)throw new NotFoundError('Chama not found','CHAMA_NOT_FOUND');}
      const audienceSql=input.audience==='platform_admins'
        ? `SELECT id FROM users WHERE status='active' AND is_platform_admin=TRUE`
        : input.audience==='chama'
          ? `SELECT u.id FROM users u JOIN chama_members cm ON cm.user_id=u.id WHERE cm.chama_id=$1 AND cm.membership_status='active' AND u.status='active'`
          : `SELECT id FROM users WHERE status='active'`;
      const recipients=await client.query<{id:string}>(audienceSql,input.audience==='chama'?[input.chamaId]:[]);
      let queued=0;
      for(const channel of input.channels){
        const result=await client.query(`INSERT INTO notifications(user_id,chama_id,event_type,channel,title,body,status,payload)
          SELECT r.id,$1,'platform_broadcast',$2::notification_channel,$3,$4,'pending',$5::jsonb FROM unnest($6::uuid[]) AS r(id)`,
          [input.chamaId??null,channel,input.title,input.body,JSON.stringify({audience:input.audience,createdBy:actorId}),recipients.rows.map(r=>r.id)]);
        queued+=result.rowCount??0;
      }
      await writeAuditEvent(client,{category:'system',action:'platform_admin_broadcast_queued',actorId,actorRole:'platform_admin',chamaId:input.chamaId,
        entityType:'broadcast',ipAddress:context?.ip,userAgent:context?.userAgent,payload:{audience:input.audience,channels:input.channels,title:input.title,reason:input.reason,recipientCount:recipients.rowCount,notificationCount:queued}});
      return{audience:input.audience,chamaId:input.chamaId??null,recipientCount:recipients.rowCount,notificationCount:queued,channels:input.channels,status:'queued'};
    },{isolationLevel:'READ COMMITTED'},this.db);
  }

  async listAdministrators(){
    const rows=await this.db.query(`SELECT u.id,u.full_name,u.email,u.phone,u.status::text AS status,u.is_email_verified,u.last_login_at::text,u.created_at::text,
      COUNT(rt.id) FILTER(WHERE rt.revoked_at IS NULL AND rt.expires_at>CURRENT_TIMESTAMP)::int AS active_sessions
      FROM users u LEFT JOIN refresh_tokens rt ON rt.user_id=u.id WHERE u.is_platform_admin=TRUE
      GROUP BY u.id ORDER BY u.full_name`);
    return rows.rows;
  }

  async suspiciousActivity(now = new Date()) {
    const rapidJoinThreshold = 4;
    const failedPaymentThreshold = 3;
    const refundThreshold = 2;
    const [joins, failedPayments, refunds] = await Promise.all([
      this.db.query<{user_id:string;full_name:string;count:number}>(
        `SELECT cm.user_id,u.full_name,COUNT(*)::int AS count
           FROM chama_members cm JOIN users u ON u.id=cm.user_id
          WHERE cm.joined_at >= $1::timestamptz - INTERVAL '24 hours'
          GROUP BY cm.user_id,u.full_name HAVING COUNT(*) >= $2 ORDER BY count DESC,cm.user_id`,[now,rapidJoinThreshold]),
      this.db.query<{user_id:string;full_name:string;count:number}>(
        `SELECT p.user_id,u.full_name,COUNT(*)::int AS count
           FROM payment_provider_logs p JOIN users u ON u.id=p.user_id
          WHERE p.status='failed' AND p.created_at >= $1::timestamptz - INTERVAL '24 hours'
          GROUP BY p.user_id,u.full_name HAVING COUNT(*) >= $2 ORDER BY count DESC,p.user_id`,[now,failedPaymentThreshold]),
      this.db.query<{user_id:string;full_name:string;count:number}>(
        `SELECT cd.user_id,u.full_name,COUNT(*)::int AS count
           FROM commitment_deposits cd JOIN users u ON u.id=cd.user_id
          WHERE (cd.refund_requested_at >= $1::timestamptz - INTERVAL '30 days' OR cd.refunded_at >= $1::timestamptz - INTERVAL '30 days')
          GROUP BY cd.user_id,u.full_name HAVING COUNT(*) >= $2 ORDER BY count DESC,cd.user_id`,[now,refundThreshold]),
    ]);
    const signals = [
      ...joins.rows.map(r=>signal('rapid_chama_joins','user',r.user_id,r.full_name,r.count,`At least ${rapidJoinThreshold} Chama joins in 24 hours`)),
      ...failedPayments.rows.map(r=>signal('repeated_failed_payments','user',r.user_id,r.full_name,r.count,`At least ${failedPaymentThreshold} failed provider payments in 24 hours`)),
      ...refunds.rows.map(r=>signal('unusual_refund_frequency','user',r.user_id,r.full_name,r.count,`At least ${refundThreshold} refund requests/completions in 30 days`)),
    ];
    return { generatedAt: now.toISOString(), signals, rules: {
      rapid_chama_joins:{threshold:rapidJoinThreshold,window:'24h'}, repeated_failed_payments:{threshold:failedPaymentThreshold,window:'24h'}, unusual_refund_frequency:{threshold:refundThreshold,window:'30d'},
    }, disclaimer:'Operational heuristics only; signals require human review and are not fraud determinations.' };
  }

  async systemHealth(now = new Date()) {
    const [latestJobs, jobFailures, staleJobs, reports, reminders, meetings, notifications, payments, reconciliation] = await Promise.all([
      this.db.query<{job_name:string;status:string;started_at:string;completed_at:string|null;duration_ms:string|null;failure_reason:string|null}>(
        `SELECT DISTINCT ON (job_name) job_name,status,started_at::text,completed_at::text,duration_ms::text,failure_reason
           FROM background_job_runs ORDER BY job_name,started_at DESC`),
      this.db.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM background_job_runs WHERE status='failed' AND started_at >= $1::timestamptz - INTERVAL '24 hours'`,[now]),
      this.db.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM background_job_runs WHERE status='running' AND started_at < $1::timestamptz - INTERVAL '15 minutes'`,[now]),
      this.db.query<{queued:number;processing:number;failed:number}>(
        `SELECT COUNT(*) FILTER(WHERE status='queued')::int AS queued,COUNT(*) FILTER(WHERE status='processing')::int AS processing,COUNT(*) FILTER(WHERE status='failed' AND updated_at >= $1::timestamptz-INTERVAL '24 hours')::int AS failed FROM report_jobs`,[now]),
      this.db.query<{failed:number;stale:number}>(
        `SELECT COUNT(*) FILTER(WHERE status='failed' AND created_at >= $1::timestamptz-INTERVAL '24 hours')::int AS failed,
                COUNT(*) FILTER(WHERE status='processing' AND locked_until < $1)::int AS stale FROM reminder_deliveries`,[now]),
      this.db.query<{failed:number;due_unclaimed:number}>(
        `SELECT COUNT(*) FILTER(WHERE reminder_failed_at IS NOT NULL AND reminder_failed_at >= $1::timestamptz-INTERVAL '24 hours')::int AS failed,
                COUNT(*) FILTER(WHERE reminder_dispatched_at IS NULL AND reminder_failed_at IS NULL AND reminder_at <= $1 AND starts_at > $1 AND (reminder_claimed_until IS NULL OR reminder_claimed_until < $1))::int AS due_unclaimed FROM chama_meetings`,[now]),
      this.db.query<{failed:number}>(`SELECT COUNT(*)::int AS failed FROM notifications WHERE status='failed' AND failed_at >= $1::timestamptz-INTERVAL '24 hours'`,[now]),
      this.db.query<{failed:number;stale_pending:number}>(
        `SELECT COUNT(*) FILTER(WHERE status='failed' AND created_at >= $1::timestamptz-INTERVAL '24 hours')::int AS failed,
                COUNT(*) FILTER(WHERE status='pending' AND created_at < $1::timestamptz-INTERVAL '15 minutes')::int AS stale_pending FROM payment_provider_logs`,[now]),
      this.db.query<{id:string;provider:string;window_end:string;mismatch_count:number;completed_at:string|null}|never>(
        `SELECT id,provider,window_end::text,mismatch_count,completed_at::text FROM ledger_reconciliation_runs ORDER BY started_at DESC LIMIT 1`),
    ]);
    const latest = reconciliation.rows[0] ?? null;
    const degraded = Number(jobFailures.rows[0]?.count??0)>0 || Number(staleJobs.rows[0]?.count??0)>0 || Number(reports.rows[0]?.failed??0)>0 || Number(reminders.rows[0]?.failed??0)>0 || Number(meetings.rows[0]?.failed??0)>0 || Number(payments.rows[0]?.stale_pending??0)>0 || Number(latest?.mismatch_count??0)>0;
    return {
      status: degraded ? 'degraded' : 'operational', generatedAt: now.toISOString(), timezone:env.SCHEDULER_TIMEZONE,
      backgroundJobs:{latest:latestJobs.rows.map(r=>({jobName:r.job_name,status:r.status,startedAt:iso(r.started_at),completedAt:iso(r.completed_at),durationMs:r.duration_ms===null?null:Number(r.duration_ms),failureReason:r.failure_reason})),failedLast24h:Number(jobFailures.rows[0]?.count??0),staleRunning:Number(staleJobs.rows[0]?.count??0)},
      reports:reports.rows[0], reminders:reminders.rows[0], meetingReminders:meetings.rows[0], notifications:{failedLast24h:Number(notifications.rows[0]?.failed??0)},
      paymentWebhooks:{failedLast24h:Number(payments.rows[0]?.failed??0),stalePending:Number(payments.rows[0]?.stale_pending??0)},
      reconciliation:latest?{id:latest.id,provider:latest.provider,windowEnd:iso(latest.window_end),mismatchCount:Number(latest.mismatch_count),completedAt:iso(latest.completed_at)}:null,
    };
  }

  async auditLogs(input: PageInput & { category?: string; action?: string; actorId?: string }) {
    const values=[input.category??null,input.action??null,input.actorId??null] as unknown[];
    const where=`($1::text IS NULL OR al.category::text=$1) AND ($2::text IS NULL OR al.action=$2) AND ($3::uuid IS NULL OR al.actor_id=$3)`;
    const total=Number((await this.db.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM audit_logs al WHERE ${where}`,values)).rows[0]?.count??0);
    const rows=await this.db.query<{id:string;category:string;action:string;actor_id:string|null;actor_role:string|null;chama_id:string|null;entity_type:string|null;entity_id:string|null;ip_address:string|null;user_agent:string|null;payload:unknown;created_at:string;actor_name:string|null}>(
      `SELECT al.id,al.category::text AS category,al.action,al.actor_id,al.actor_role::text,al.chama_id,al.entity_type,al.entity_id,al.ip_address::text,al.user_agent,al.payload,al.created_at::text,u.full_name AS actor_name
         FROM audit_logs al LEFT JOIN users u ON u.id=al.actor_id WHERE ${where} ORDER BY al.created_at DESC,al.id DESC LIMIT $4 OFFSET $5`,
      [...values,input.perPage,(input.page-1)*input.perPage]);
    return {logs:rows.rows.map(r=>({id:r.id,category:r.category,action:r.action,actor:r.actor_id?{id:r.actor_id,name:r.actor_name,role:r.actor_role}:null,chamaId:r.chama_id,entityType:r.entity_type,entityId:r.entity_id,ipAddress:r.ip_address,userAgent:r.user_agent,payload:r.payload,createdAt:iso(r.created_at)})),meta:pageMeta(total,input)};
  }
}

function pageMeta(total:number,input:PageInput){return{total,page:input.page,perPage:input.perPage,totalPages:total?Math.ceil(total/input.perPage):0};}
function iso(value:string|null|undefined){return value?new Date(value).toISOString():null;}
function signal(rule:string,subjectType:string,subjectId:string,subjectName:string,count:number,reason:string){return{rule,subjectType,subjectId,subjectName,count,reason};}
function rangeWindow(range:AdminRange,now:Date):{start:Date|null;bucket:'day'|'week'|'month'}{
  const copy=new Date(now); if(range==='all')return{start:null,bucket:'month'};
  if(range==='1m'){copy.setUTCMonth(copy.getUTCMonth()-1);return{start:copy,bucket:'day'};}
  if(range==='3m'){copy.setUTCMonth(copy.getUTCMonth()-3);return{start:copy,bucket:'week'};}
  if(range==='6m'){copy.setUTCMonth(copy.getUTCMonth()-6);return{start:copy,bucket:'month'};}
  copy.setUTCFullYear(copy.getUTCFullYear()-1);return{start:copy,bucket:'month'};
}

export const adminService = new AdminService();
