import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { assertMemberOnboardingAllowed } from './subscription.service';

export interface ListChamaApplicationsInput {
  chamaId: string;
  page: number;
  perPage: number;
  status?: 'pending' | 'commitment_pending' | 'approved' | 'rejected' | 'withdrawn';
}

export interface ReviewChamaApplicationInput {
  chamaId: string;
  applicationId: string;
  actorId: string;
  decision: 'approve' | 'reject';
  rejectionReason?: string;
}

interface ApplicationRow extends QueryResultRow {
  id: string;
  chama_id: string;
  user_id: string;
  message: string | null;
  status: string;
  chama_rule_id: string | null;
  constitution_accepted_at: string | null;
  constitution_acceptance_ip: string | null;
  constitution_acceptance_user_agent: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
  full_name?: string;
  email?: string;
  phone?: string;
  rule_version?: number | null;
}

export class ChamaApplicationService {
  constructor(private readonly db: Pool = pool) {}

  async list(input: ListChamaApplicationsInput) {
    const where = ['ca.chama_id = $1'];
    const values: unknown[] = [input.chamaId];
    let parameter = 2;

    if (input.status) {
      where.push(`ca.status = $${parameter++}::application_status`);
      values.push(input.status);
    }

    const total = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM chama_applications ca
       WHERE ${where.join(' AND ')}`,
      values,
    )).rows[0]?.count ?? 0);

    const limitParameter = parameter++;
    const offsetParameter = parameter++;
    const queryValues = [...values, input.perPage, (input.page - 1) * input.perPage];
    const result = await this.db.query<ApplicationRow>(
      `SELECT ca.id, ca.chama_id, ca.user_id, ca.message,
              ca.status::text AS status, ca.chama_rule_id,
              ca.constitution_accepted_at, host(ca.constitution_acceptance_ip) AS constitution_acceptance_ip,
              ca.constitution_acceptance_user_agent, ca.reviewed_by, ca.reviewed_at,
              ca.rejection_reason, ca.created_at, ca.updated_at,
              u.full_name, u.email, u.phone,
              cr.version AS rule_version
       FROM chama_applications ca
       JOIN users u ON u.id = ca.user_id
       LEFT JOIN chama_rules cr ON cr.id = ca.chama_rule_id AND cr.chama_id = ca.chama_id
       WHERE ${where.join(' AND ')}
       ORDER BY ca.created_at DESC, ca.id ASC
       LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
      queryValues,
    );

    return {
      applications: result.rows.map((row) => ({
        id: row.id,
        chamaId: row.chama_id,
        userId: row.user_id,
        applicant: {
          fullName: row.full_name,
          email: row.email,
          phone: row.phone,
        },
        message: row.message,
        status: row.status,
        constitution: row.chama_rule_id
          ? { id: row.chama_rule_id, version: row.rule_version ?? null, acceptedAt: row.constitution_accepted_at }
          : null,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      meta: {
        total,
        page: input.page,
        perPage: input.perPage,
        totalPages: total === 0 ? 0 : Math.ceil(total / input.perPage),
      },
    };
  }

  async review(input: ReviewChamaApplicationInput) {
    return withDatabaseTransaction(async (client) => {
      const chama = (await client.query<{
        id: string;
        status: string;
        target_members: number | null;
        recruitment_closed_at: string | null;
        deadline_passed: boolean;
      }>(
        `SELECT id, status::text AS status, target_members, recruitment_closed_at,
                (recruitment_deadline IS NOT NULL AND recruitment_deadline < CURRENT_DATE) AS deadline_passed
         FROM chamas
         WHERE id = $1
         FOR UPDATE`,
        [input.chamaId],
      )).rows[0];
      if (!chama) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');

      const actorMembership = (await client.query<{ role: string; membership_status: string }>(
        `SELECT role::text AS role, membership_status::text AS membership_status
           FROM chama_members
          WHERE chama_id = $1 AND user_id = $2`,
        [input.chamaId, input.actorId],
      )).rows[0];
      if (!actorMembership
          || actorMembership.membership_status !== 'active'
          || !['chairperson', 'secretary'].includes(actorMembership.role)) {
        throw new ForbiddenError('Only the Chairperson or Secretary can review applications', 'CHAMA_APPLICATION_REVIEW_FORBIDDEN');
      }

      const application = (await client.query<ApplicationRow>(
        `SELECT id, chama_id, user_id, message, status::text AS status,
                chama_rule_id, constitution_accepted_at, host(constitution_acceptance_ip) AS constitution_acceptance_ip,
                    constitution_acceptance_user_agent, reviewed_by, reviewed_at,
                rejection_reason, created_at, updated_at
         FROM chama_applications
         WHERE id = $1 AND chama_id = $2
         FOR UPDATE`,
        [input.applicationId, input.chamaId],
      )).rows[0];
      if (!application) throw new NotFoundError('Chama application not found', 'CHAMA_APPLICATION_NOT_FOUND');
      if (application.status !== 'pending') {
        throw new ConflictError('Only pending applications can be reviewed', 'CHAMA_APPLICATION_NOT_PENDING');
      }

      if (input.decision === 'reject') {
        const rejected = (await client.query<ApplicationRow>(
          `UPDATE chama_applications
              SET status = 'rejected', reviewed_by = $2, reviewed_at = CURRENT_TIMESTAMP,
                  rejection_reason = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id, chama_id, user_id, message, status::text AS status,
                      chama_rule_id, constitution_accepted_at, host(constitution_acceptance_ip) AS constitution_acceptance_ip,
                    constitution_acceptance_user_agent, reviewed_by, reviewed_at,
                      rejection_reason, created_at, updated_at`,
          [application.id, input.actorId, input.rejectionReason ?? null],
        )).rows[0];
        return { outcome: 'rejected' as const, application: rejected, membership: null, commitment: null };
      }

      if (!['recruiting', 'active'].includes(chama.status)
          || chama.recruitment_closed_at
          || chama.deadline_passed) {
        throw new ConflictError('Chama recruitment is closed', 'CHAMA_RECRUITMENT_CLOSED');
      }
      if (!application.chama_rule_id || !application.constitution_accepted_at) {
        throw new ConflictError('Application does not contain Constitution acceptance', 'CONSTITUTION_NOT_ACCEPTED');
      }

      const rule = (await client.query<{ id: string; version: number; commitment_amount: string; status: string }>(
        `SELECT id, version, commitment_amount::text AS commitment_amount, status::text AS status
         FROM chama_rules
         WHERE id = $1 AND chama_id = $2`,
        [application.chama_rule_id, input.chamaId],
      )).rows[0];
      if (!rule || rule.status !== 'active') {
        throw new ConflictError('Applicant must accept the current Constitution before approval', 'CONSTITUTION_VERSION_CONFLICT');
      }

      const existingMembership = (await client.query<{ id: string }>(
        `SELECT id FROM chama_members WHERE chama_id = $1 AND user_id = $2`,
        [input.chamaId, application.user_id],
      )).rows[0];
      if (existingMembership) {
        throw new ConflictError('User already has a membership for this Chama', 'CHAMA_MEMBERSHIP_EXISTS');
      }

      const occupied = Number((await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM chama_members
         WHERE chama_id = $1 AND membership_status IN ('active', 'pending')`,
        [input.chamaId],
      )).rows[0]?.count ?? 0);
      await assertMemberOnboardingAllowed(client, {
        chamaId: input.chamaId,
        occupied,
        targetMembers: chama.target_members === null ? null : Number(chama.target_members),
      });

      const commitmentRequired = BigInt(rule.commitment_amount) > 0n;
      const membershipStatus = commitmentRequired ? 'pending' : 'active';
      const membership = (await client.query(
        `INSERT INTO chama_members
           (chama_id, user_id, role, membership_status, approved_by, approved_at)
         VALUES ($1, $2, 'member', $3::membership_status, $4,
                 CASE WHEN $3::membership_status = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END)
         RETURNING id, chama_id, user_id, role::text AS role,
                   membership_status::text AS membership_status, joined_at, approved_by, approved_at`,
        [input.chamaId, application.user_id, membershipStatus, input.actorId],
      )).rows[0];

      if (chama.target_members !== null && occupied + 1 >= Number(chama.target_members)) {
        await client.query(
          `UPDATE chamas
              SET recruitment_closed_at = COALESCE(recruitment_closed_at, CURRENT_TIMESTAMP),
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [input.chamaId],
        );
      }

      await client.query(
        `INSERT INTO membership_constitution_acceptances
           (chama_id, membership_id, chama_rule_id, accepted_at, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5::inet, $6)`,
        [input.chamaId, membership.id, rule.id, application.constitution_accepted_at,
         application.constitution_acceptance_ip, application.constitution_acceptance_user_agent],
      );

      const nextApplicationStatus = commitmentRequired ? 'commitment_pending' : 'approved';
      const reviewedApplication = (await client.query<ApplicationRow>(
        `UPDATE chama_applications
            SET status = $2::application_status, reviewed_by = $3,
                reviewed_at = CURRENT_TIMESTAMP, rejection_reason = NULL,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING id, chama_id, user_id, message, status::text AS status,
                    chama_rule_id, constitution_accepted_at, host(constitution_acceptance_ip) AS constitution_acceptance_ip,
                    constitution_acceptance_user_agent, reviewed_by, reviewed_at,
                    rejection_reason, created_at, updated_at`,
        [application.id, nextApplicationStatus, input.actorId],
      )).rows[0];

      let commitment: { required: boolean; amount: string; state: string; id?: string } = {
        required: commitmentRequired,
        amount: rule.commitment_amount,
        state: commitmentRequired ? 'applied' : 'not_required',
      };

      if (commitmentRequired) {
        const deposit = (await client.query<{ id: string; state: string }>(
          `INSERT INTO commitment_deposits
             (chama_id, user_id, membership_id, application_id, chama_rule_id, amount,
              state, last_transition_source, last_transition_reference)
           VALUES ($1, $2, $3, $4, $5, $6, 'applied', 'application_review', $4::text)
           RETURNING id, state::text AS state`,
          [input.chamaId, application.user_id, membership.id, application.id, rule.id, rule.commitment_amount],
        )).rows[0];
        commitment = { required: true, amount: rule.commitment_amount, state: deposit.state, id: deposit.id };
      }

      return {
        outcome: commitmentRequired ? 'commitment_required' as const : 'approved' as const,
        application: reviewedApplication,
        membership,
        commitment,
        constitution: { id: rule.id, version: rule.version, accepted: true },
      };
    }, {}, this.db);
  }

  async reviewByApplicationId(input: {
    applicationId: string;
    actorId: string;
    decision: 'approve' | 'reject';
    rejectionReason?: string;
  }) {
    const row = (await this.db.query<{ chama_id: string }>(
      `SELECT chama_id FROM chama_applications WHERE id = $1`,
      [input.applicationId],
    )).rows[0];
    if (!row) throw new NotFoundError('Chama application not found', 'CHAMA_APPLICATION_NOT_FOUND');
    return this.review({
      chamaId: row.chama_id,
      applicationId: input.applicationId,
      actorId: input.actorId,
      decision: input.decision,
      rejectionReason: input.rejectionReason,
    });
  }
}

export const chamaApplicationService = new ChamaApplicationService();
