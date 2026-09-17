import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { ConflictError, NotFoundError } from '../utils/errors';

export type InvitationStatus =
  | 'pending'
  | 'sent'
  | 'approved'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'delivery_failed';

export interface ListChamaInvitationsInput {
  chamaId: string;
  page: number;
  perPage: number;
  status?: InvitationStatus;
}

interface InvitationRow extends QueryResultRow {
  id: string;
  chama_id: string;
  applicant_id: string | null;
  recipient_phone: string | null;
  recipient_email: string | null;
  requested_role: string;
  message: string | null;
  status: InvitationStatus;
  max_uses: number;
  use_count: number;
  expires_at: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
  applicant_name?: string | null;
  applicant_phone?: string | null;
}

export class ChamaInvitationService {
  constructor(private readonly db: Pool = pool) {}

  async list(input: ListChamaInvitationsInput) {
    const where = ['ci.chama_id = $1'];
    const values: unknown[] = [input.chamaId];
    let parameter = 2;
    if (input.status) {
      where.push(`ci.status = $${parameter++}::invitation_status`);
      values.push(input.status);
    }

    const total = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM chama_invitations ci
       WHERE ${where.join(' AND ')}`,
      values,
    )).rows[0]?.count ?? 0);

    const limitParameter = parameter++;
    const offsetParameter = parameter++;
    const rows = await this.db.query<InvitationRow>(
      `SELECT ci.id, ci.chama_id, ci.applicant_id, ci.recipient_phone, ci.recipient_email,
              ci.requested_role::text AS requested_role, ci.message,
              ci.status::text AS status, ci.max_uses, ci.use_count,
              ci.expires_at, ci.sent_at, ci.accepted_at,
              ci.reviewed_by, ci.reviewed_at, ci.created_at, ci.updated_at,
              u.full_name AS applicant_name, u.phone AS applicant_phone
       FROM chama_invitations ci
       LEFT JOIN users u ON u.id = ci.applicant_id
       WHERE ${where.join(' AND ')}
       ORDER BY ci.created_at DESC, ci.id ASC
       LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
      [...values, input.perPage, (input.page - 1) * input.perPage],
    );

    return {
      invitations: rows.rows.map((row) => this.mapInvitation(row)),
      meta: {
        total,
        page: input.page,
        perPage: input.perPage,
        totalPages: total === 0 ? 0 : Math.ceil(total / input.perPage),
      },
    };
  }

  async getForResend(chamaId: string, invitationId: string) {
    const row = (await this.db.query<InvitationRow>(
      `SELECT ci.id, ci.chama_id, ci.applicant_id, ci.recipient_phone, ci.recipient_email,
              ci.requested_role::text AS requested_role, ci.message,
              ci.status::text AS status, ci.max_uses, ci.use_count,
              ci.expires_at, ci.sent_at, ci.accepted_at,
              ci.reviewed_by, ci.reviewed_at, ci.created_at, ci.updated_at,
              u.full_name AS applicant_name, u.phone AS applicant_phone
       FROM chama_invitations ci
       LEFT JOIN users u ON u.id = ci.applicant_id
       WHERE ci.id = $1 AND ci.chama_id = $2`,
      [invitationId, chamaId],
    )).rows[0];
    if (!row) throw new NotFoundError('Invitation not found', 'CHAMA_INVITATION_NOT_FOUND');
    if (!['pending', 'sent', 'delivery_failed'].includes(row.status)) {
      throw new ConflictError(`Invitation cannot be resent from status ${row.status}`, 'CHAMA_INVITATION_NOT_RESENDABLE');
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      throw new ConflictError('Invitation has expired', 'CHAMA_INVITATION_EXPIRED');
    }
    const phone = row.recipient_phone ?? row.applicant_phone ?? null;
    if (!phone) throw new ConflictError('Invitation has no SMS recipient', 'CHAMA_INVITATION_PHONE_REQUIRED');
    return { invitation: this.mapInvitation(row), phone };
  }

  async markSent(chamaId: string, invitationId: string) {
    const row = (await this.db.query<InvitationRow>(
      `UPDATE chama_invitations
          SET status = 'sent', sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND chama_id = $2
          AND status IN ('pending', 'sent', 'delivery_failed')
        RETURNING id, chama_id, applicant_id, recipient_phone, recipient_email,
                  requested_role::text AS requested_role, message, status::text AS status,
                  max_uses, use_count, expires_at, sent_at, accepted_at,
                  reviewed_by, reviewed_at, created_at, updated_at`,
      [invitationId, chamaId],
    )).rows[0];
    if (!row) throw new ConflictError('Invitation is no longer resendable', 'CHAMA_INVITATION_NOT_RESENDABLE');
    return this.mapInvitation(row);
  }

  async cancel(chamaId: string, invitationId: string, actorId: string) {
    return withDatabaseTransaction(async (client) => {
      const invitation = (await client.query<InvitationRow>(
        `SELECT id, chama_id, applicant_id, recipient_phone, recipient_email,
                requested_role::text AS requested_role, message, status::text AS status,
                max_uses, use_count, expires_at, sent_at, accepted_at,
                reviewed_by, reviewed_at, created_at, updated_at
         FROM chama_invitations
         WHERE id = $1 AND chama_id = $2
         FOR UPDATE`,
        [invitationId, chamaId],
      )).rows[0];
      if (!invitation) throw new NotFoundError('Invitation not found', 'CHAMA_INVITATION_NOT_FOUND');
      if (!['pending', 'sent', 'approved', 'delivery_failed'].includes(invitation.status)) {
        throw new ConflictError(`Invitation cannot be cancelled from status ${invitation.status}`, 'CHAMA_INVITATION_NOT_CANCELLABLE');
      }
      const updated = (await client.query<InvitationRow>(
        `UPDATE chama_invitations
            SET status = 'cancelled', reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING id, chama_id, applicant_id, recipient_phone, recipient_email,
                    requested_role::text AS requested_role, message, status::text AS status,
                    max_uses, use_count, expires_at, sent_at, accepted_at,
                    reviewed_by, reviewed_at, created_at, updated_at`,
        [invitation.id, actorId],
      )).rows[0];
      return this.mapInvitation(updated);
    }, {}, this.db);
  }

  async reject(chamaId: string, invitationId: string, userId: string) {
    return withDatabaseTransaction(async (client) => {
      const invitation = (await client.query<InvitationRow>(
        `SELECT ci.id, ci.chama_id, ci.applicant_id, ci.recipient_phone, ci.recipient_email,
                ci.requested_role::text AS requested_role, ci.message,
                ci.status::text AS status, ci.max_uses, ci.use_count,
                ci.expires_at, ci.sent_at, ci.accepted_at,
                ci.reviewed_by, ci.reviewed_at, ci.created_at, ci.updated_at
         FROM chama_invitations ci
         JOIN users u ON u.id = $3
         WHERE ci.id = $1 AND ci.chama_id = $2
           AND (ci.applicant_id = $3 OR (ci.applicant_id IS NULL AND ci.recipient_phone = u.phone))
         FOR UPDATE OF ci`,
        [invitationId, chamaId, userId],
      )).rows[0];
      if (!invitation) throw new NotFoundError('Invitation not found', 'CHAMA_INVITATION_NOT_FOUND');
      if (!['pending', 'sent', 'approved', 'delivery_failed'].includes(invitation.status)) {
        throw new ConflictError(`Invitation cannot be rejected from status ${invitation.status}`, 'CHAMA_INVITATION_NOT_REJECTABLE');
      }

      const updated = (await client.query<InvitationRow>(
        `UPDATE chama_invitations
            SET status = 'rejected', applicant_id = COALESCE(applicant_id, $2),
                reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING id, chama_id, applicant_id, recipient_phone, recipient_email,
                    requested_role::text AS requested_role, message, status::text AS status,
                    max_uses, use_count, expires_at, sent_at, accepted_at,
                    reviewed_by, reviewed_at, created_at, updated_at`,
        [invitation.id, userId],
      )).rows[0];
      return this.mapInvitation(updated);
    }, {}, this.db);
  }

  private mapInvitation(row: InvitationRow) {
    return {
      id: row.id,
      chamaId: row.chama_id,
      applicantId: row.applicant_id,
      recipientPhone: row.recipient_phone ?? row.applicant_phone ?? null,
      recipientEmail: row.recipient_email,
      applicantName: row.applicant_name ?? null,
      requestedRole: row.requested_role,
      message: row.message,
      status: row.status,
      maxUses: row.max_uses,
      useCount: row.use_count,
      expiresAt: row.expires_at,
      sentAt: row.sent_at,
      acceptedAt: row.accepted_at,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export const chamaInvitationService = new ChamaInvitationService();
