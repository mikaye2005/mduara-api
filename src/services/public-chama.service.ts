import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { assertMemberOnboardingAllowed } from './subscription.service';

export interface PublicChamaFilters {
  page: number;
  perPage: number;
  goalCode?: string;
  status?: 'recruiting' | 'active' | 'completed';
  visibility?: 'public' | 'application';
  type?: string;
  location?: string;
  minContribution?: number;
  maxContribution?: number;
  minDurationMonths?: number;
  maxDurationMonths?: number;
  hasCapacity?: boolean;
  minAvailableSpots?: number;
}

interface PublicListRow extends QueryResultRow {
  id: string;
  name: string;
  description: string | null;
  type: string;
  status: string;
  visibility: string;
  goal_code: string | null;
  location: string | null;
  logo_url: string | null;
  target_members: number | null;
  recruitment_deadline: string | null;
  recruitment_closed_at: string | null;
  saving_start_date: string | null;
  saving_end_date: string | null;
  purchase_window_start: string | null;
  purchase_window_end: string | null;
  contribution_amount: string;
  contribution_frequency: string;
  currency: string;
  active_member_count: string;
  occupied_count: string;
  available_spots: string | null;
  duration_months: string | null;
  commitment_amount: string | null;
  total_count: string;
}

export interface ApplyToPublicChamaInput {
  userId: string;
  chamaId: string;
  constitutionRuleId: string;
  message?: string;
  invitationId?: string;
  invitationToken?: string;
  acceptanceIp?: string | null;
  acceptanceUserAgent?: string | null;
}

export class PublicChamaService {
  constructor(private readonly db: Pool = pool) {}

  async list(filters: PublicChamaFilters) {
    const values: unknown[] = [];
    const where: string[] = ["c.visibility IN ('public', 'application')"];
    let parameter = 1;

    if (filters.status) {
      where.push(`c.status = $${parameter++}::chama_status`);
      values.push(filters.status);
    } else {
      where.push("c.status IN ('recruiting', 'active')");
    }
    if (filters.visibility) {
      where.push(`c.visibility = $${parameter++}::chama_visibility`);
      values.push(filters.visibility);
    }
    if (filters.type) {
      where.push(`c.type = $${parameter++}::chama_type`);
      values.push(filters.type);
    }
    if (filters.goalCode) {
      where.push(`c.goal_code = $${parameter++}`);
      values.push(filters.goalCode);
    }
    if (filters.location) {
      where.push(`c.location ILIKE $${parameter++}`);
      values.push(`%${filters.location}%`);
    }
    if (filters.minContribution !== undefined) {
      where.push(`c.contribution_amount >= $${parameter++}`);
      values.push(filters.minContribution);
    }
    if (filters.maxContribution !== undefined) {
      where.push(`c.contribution_amount <= $${parameter++}`);
      values.push(filters.maxContribution);
    }

    const durationExpression = `(EXTRACT(YEAR FROM age(c.saving_end_date, c.saving_start_date)) * 12
      + EXTRACT(MONTH FROM age(c.saving_end_date, c.saving_start_date))
      + CASE WHEN EXTRACT(DAY FROM age(c.saving_end_date, c.saving_start_date)) > 0 THEN 1 ELSE 0 END)`;
    if (filters.minDurationMonths !== undefined) {
      where.push(`c.saving_start_date IS NOT NULL AND c.saving_end_date IS NOT NULL AND ${durationExpression} >= $${parameter++}`);
      values.push(filters.minDurationMonths);
    }
    if (filters.maxDurationMonths !== undefined) {
      where.push(`c.saving_start_date IS NOT NULL AND c.saving_end_date IS NOT NULL AND ${durationExpression} <= $${parameter++}`);
      values.push(filters.maxDurationMonths);
    }

    if (filters.hasCapacity !== undefined) {
      where.push(filters.hasCapacity
        ? `(c.target_members IS NULL OR COALESCE(mc.occupied_count, 0) < c.target_members)`
        : `(c.target_members IS NOT NULL AND COALESCE(mc.occupied_count, 0) >= c.target_members)`);
    }
    if (filters.minAvailableSpots !== undefined) {
      where.push(`c.target_members IS NOT NULL AND GREATEST(c.target_members - COALESCE(mc.occupied_count, 0), 0) >= $${parameter++}`);
      values.push(filters.minAvailableSpots);
    }

    const countResult = await this.db.query<{ count: number }>(
      `WITH member_counts AS (
         SELECT chama_id,
                COUNT(*) FILTER (WHERE membership_status IN ('active', 'pending')) AS occupied_count
         FROM chama_members
         GROUP BY chama_id
       )
       SELECT COUNT(*)::int AS count
       FROM chamas c
       LEFT JOIN member_counts mc ON mc.chama_id = c.id
       WHERE ${where.join(' AND ')}`,
      [...values],
    );

    const limitParameter = parameter++;
    const offsetParameter = parameter++;
    values.push(filters.perPage, (filters.page - 1) * filters.perPage);

    const result = await this.db.query<PublicListRow>(
      `WITH member_counts AS (
         SELECT chama_id,
                COUNT(*) FILTER (WHERE membership_status = 'active') AS active_member_count,
                COUNT(*) FILTER (WHERE membership_status IN ('active', 'pending')) AS occupied_count
         FROM chama_members
         GROUP BY chama_id
       ),
       active_rules AS (
         SELECT chama_id, commitment_amount
         FROM chama_rules
         WHERE status = 'active'
       )
       SELECT c.id,
              c.name,
              c.description,
              c.type::text AS type,
              c.status::text AS status,
              c.visibility::text AS visibility,
              c.goal_code,
              c.location,
              c.logo_url,
              c.target_members,
              c.recruitment_deadline::text,
              c.recruitment_closed_at::text,
              c.saving_start_date::text,
              c.saving_end_date::text,
              c.purchase_window_start::text,
              c.purchase_window_end::text,
              c.contribution_amount::text,
              c.contribution_frequency,
              c.currency,
              COALESCE(mc.active_member_count, 0)::text AS active_member_count,
              COALESCE(mc.occupied_count, 0)::text AS occupied_count,
              CASE WHEN c.target_members IS NULL THEN NULL
                   ELSE GREATEST(c.target_members - COALESCE(mc.occupied_count, 0), 0)::text END AS available_spots,
              CASE WHEN c.saving_start_date IS NULL OR c.saving_end_date IS NULL THEN NULL
                   ELSE ${durationExpression}::text END AS duration_months,
              ar.commitment_amount::text,
              COUNT(*) OVER()::text AS total_count
       FROM chamas c
       LEFT JOIN member_counts mc ON mc.chama_id = c.id
       LEFT JOIN active_rules ar ON ar.chama_id = c.id
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE WHEN c.status = 'recruiting' THEN 0 ELSE 1 END,
         c.created_at DESC,
         c.id ASC
       LIMIT $${limitParameter} OFFSET $${offsetParameter}`,
      values,
    );

    const total = Number(countResult.rows[0]?.count ?? 0);
    return {
      chamas: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        type: row.type,
        status: row.status,
        visibility: row.visibility,
        goalCode: row.goal_code,
        location: row.location,
        logoUrl: row.logo_url,
        targetMembers: row.target_members,
        recruitmentDeadline: row.recruitment_deadline,
        recruitmentClosedAt: row.recruitment_closed_at,
        savingStartDate: row.saving_start_date,
        savingEndDate: row.saving_end_date,
        purchaseWindowStart: row.purchase_window_start,
        purchaseWindowEnd: row.purchase_window_end,
        durationMonths: row.duration_months === null ? null : Number(row.duration_months),
        contributionAmount: row.contribution_amount,
        contributionFrequency: row.contribution_frequency,
        currency: row.currency,
        memberCount: Number(row.active_member_count),
        occupiedCount: Number(row.occupied_count),
        availableSpots: row.available_spots === null ? null : Number(row.available_spots),
        recruitmentStatus: deriveRecruitmentStatus({
          status: row.status,
          targetMembers: row.target_members,
          occupiedCount: Number(row.occupied_count),
          recruitmentDeadline: row.recruitment_deadline,
          recruitmentClosedAt: row.recruitment_closed_at,
        }),
        commitmentAmount: row.commitment_amount,
      })),
      meta: {
        total,
        page: filters.page,
        perPage: filters.perPage,
        totalPages: total === 0 ? 0 : Math.ceil(total / filters.perPage),
      },
    };
  }

  async getPublicDetail(chamaId: string) {
    const chama = (await this.db.query(
      `WITH member_counts AS (
         SELECT chama_id,
                COUNT(*) FILTER (WHERE membership_status = 'active')::int AS active_member_count,
                COUNT(*) FILTER (WHERE membership_status IN ('active', 'pending'))::int AS occupied_count
         FROM chama_members
         WHERE chama_id = $1
         GROUP BY chama_id
       )
      SELECT c.id, c.name, c.public_join_code, c.description, c.type::text AS type, c.status::text AS status,
              c.visibility::text AS visibility, c.goal_code, c.location, c.logo_url,
              c.target_members, c.recruitment_deadline::text, c.recruitment_closed_at::text,
              c.saving_start_date::text, c.saving_end_date::text,
              c.purchase_window_start::text, c.purchase_window_end::text,
              c.contribution_amount::text, c.contribution_frequency, c.meeting_schedule,
              c.target_amount::text, c.currency,
              COALESCE(mc.active_member_count, 0) AS active_member_count,
              COALESCE(mc.occupied_count, 0) AS occupied_count
       FROM chamas c
       LEFT JOIN member_counts mc ON mc.chama_id = c.id
       WHERE c.id = $1 AND c.visibility IN ('public', 'application')`,
      [chamaId],
    )).rows[0];

    if (!chama) throw new NotFoundError('Chama not found');

    const [officialsResult, ruleResult] = await Promise.all([
      this.db.query(
        `SELECT u.full_name AS name, cm.role::text AS role
         FROM chama_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.chama_id = $1
           AND cm.membership_status = 'active'
           AND cm.role IN ('chairperson', 'secretary', 'treasurer')
         ORDER BY CASE cm.role WHEN 'chairperson' THEN 1 WHEN 'secretary' THEN 2 ELSE 3 END, u.full_name`,
        [chamaId],
      ),
      this.db.query(
        `SELECT id, version, purpose_goal, contribution_amount::text, contribution_frequency,
                contribution_due_day, late_fine_type, late_fine_amount::text,
                late_fine_percentage::text, commitment_amount::text,
                default_grace_period_days, default_after_consecutive_misses,
                quorum_threshold_pct::text, majority_threshold_pct::text,
                exit_withdrawal_policy, payout_policy, conduct_dispute_policy, dissolution_policy,
                effective_from
         FROM chama_rules
         WHERE chama_id = $1 AND status = 'active'`,
        [chamaId],
      ),
    ]);

    const rule = ruleResult.rows[0] ?? null;
    return {
      id: chama.id,
      publicJoinCode: chama.public_join_code,
      name: chama.name,
      description: chama.description,
      type: chama.type,
      status: chama.status,
      visibility: chama.visibility,
      goalCode: chama.goal_code,
      location: chama.location,
      logoUrl: chama.logo_url,
      targetMembers: chama.target_members,
      memberCount: Number(chama.active_member_count),
      availableSpots: chama.target_members == null ? null : Math.max(Number(chama.target_members) - Number(chama.occupied_count), 0),
      recruitmentStatus: deriveRecruitmentStatus({
        status: chama.status,
        targetMembers: chama.target_members,
        occupiedCount: Number(chama.occupied_count),
        recruitmentDeadline: chama.recruitment_deadline,
        recruitmentClosedAt: chama.recruitment_closed_at,
      }),
      recruitmentDeadline: chama.recruitment_deadline,
      recruitmentClosedAt: chama.recruitment_closed_at,
      savingStartDate: chama.saving_start_date,
      savingEndDate: chama.saving_end_date,
      purchaseWindowStart: chama.purchase_window_start,
      purchaseWindowEnd: chama.purchase_window_end,
      contributionAmount: chama.contribution_amount,
      contributionFrequency: chama.contribution_frequency,
      meetingSchedule: chama.meeting_schedule,
      targetAmount: chama.type === 'goal_based' ? null : chama.target_amount,
      currency: chama.currency,
      officials: officialsResult.rows.map((official) => ({ name: official.name, role: official.role })),
      constitution: rule ? {
        id: rule.id,
        version: rule.version,
        purposeGoal: rule.purpose_goal,
        contributionAmount: rule.contribution_amount,
        contributionFrequency: rule.contribution_frequency,
        contributionDueDay: rule.contribution_due_day,
        lateFine: {
          type: rule.late_fine_type,
          amount: rule.late_fine_amount,
          percentage: rule.late_fine_percentage,
        },
        commitmentAmount: rule.commitment_amount,
        defaultGracePeriodDays: rule.default_grace_period_days,
        defaultAfterConsecutiveMisses: rule.default_after_consecutive_misses,
        quorumThresholdPct: rule.quorum_threshold_pct,
        majorityThresholdPct: rule.majority_threshold_pct,
        exitWithdrawalPolicy: rule.exit_withdrawal_policy,
        payoutPolicy: rule.payout_policy,
        conductDisputePolicy: rule.conduct_dispute_policy,
        dissolutionPolicy: rule.dissolution_policy,
        effectiveFrom: rule.effective_from,
        acceptanceRequired: true,
      } : null,
    };
  }

  async getPublicDetailByJoinCode(joinCode: string) {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM chamas
        WHERE public_join_code = $1 AND visibility IN ('public', 'application')`,
      [joinCode.trim().toUpperCase()],
    );
    if (!result.rows[0]) throw new NotFoundError('Chama not found');
    return this.getPublicDetail(result.rows[0].id);
  }

  async apply(input: ApplyToPublicChamaInput) {
    return withDatabaseTransaction(
      (client) => this.applyWithinTransaction(client, input),
      {},
      this.db,
    );
  }

  private async applyWithinTransaction(client: PoolClient, input: ApplyToPublicChamaInput) {
    const chama = (await client.query(
      `SELECT id, name, status::text AS status, visibility::text AS visibility, target_members,
              recruitment_deadline, recruitment_closed_at,
              (recruitment_deadline IS NOT NULL AND recruitment_deadline < CURRENT_DATE) AS deadline_passed
       FROM chamas WHERE id = $1 FOR UPDATE`,
      [input.chamaId],
    )).rows[0];
    if (!chama) throw new NotFoundError('Chama not found');
    if (!['recruiting', 'active'].includes(chama.status)
        || chama.recruitment_closed_at
        || chama.deadline_passed) {
      throw new ConflictError('Chama recruitment is closed', 'CHAMA_RECRUITMENT_CLOSED');
    }

    const rule = (await client.query(
      `SELECT id, version, commitment_amount
       FROM chama_rules
       WHERE chama_id = $1 AND status = 'active'`,
      [input.chamaId],
    )).rows[0];
    if (!rule) throw new ConflictError('An active Constitution is required before joining', 'CONSTITUTION_NOT_AVAILABLE');
    if (rule.id !== input.constitutionRuleId) throw new ConflictError('Constitution version is no longer current', 'CONSTITUTION_VERSION_CONFLICT');

    const existingMembership = (await client.query(
      `SELECT id, membership_status::text AS membership_status
       FROM chama_members WHERE chama_id = $1 AND user_id = $2`,
      [input.chamaId, input.userId],
    )).rows[0];
    if (existingMembership) throw new ConflictError('User already has a membership for this Chama');

    const occupied = Number((await client.query(
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

    if (chama.visibility === 'application') {
      const pending = (await client.query(
        `SELECT id FROM chama_applications
         WHERE chama_id = $1 AND user_id = $2 AND status = 'pending'`,
        [input.chamaId, input.userId],
      )).rows[0];
      if (pending) throw new ConflictError('A pending application already exists');

      const application = (await client.query(
        `INSERT INTO chama_applications
           (chama_id, user_id, message, status, chama_rule_id, constitution_accepted_at,
            constitution_acceptance_ip, constitution_acceptance_user_agent)
         VALUES ($1, $2, $3, 'pending', $4, CURRENT_TIMESTAMP, $5::inet, $6)
         RETURNING id, status::text AS status, created_at`,
        [input.chamaId, input.userId, input.message ?? null, rule.id, input.acceptanceIp ?? null, input.acceptanceUserAgent ?? null],
      )).rows[0];

      return {
        outcome: 'application_pending',
        application,
        membership: null,
        commitment: {
          required: Number(rule.commitment_amount) > 0,
          amount: String(rule.commitment_amount),
          state: Number(rule.commitment_amount) > 0 ? 'awaiting_application_approval' : 'not_required',
        },
        constitution: { id: rule.id, version: rule.version, accepted: true },
      };
    }

    let invitation: any = null;
    if (chama.visibility === 'private') {
      if (!input.invitationId && !input.invitationToken) {
        throw new ForbiddenError('A valid invitation is required for this Chama', 'PRIVATE_CHAMA_INVITE_REQUIRED');
      }
      const tokenHash = input.invitationToken
        ? createHash('sha256').update(input.invitationToken).digest('hex')
        : null;
      invitation = (await client.query(
        `SELECT ci.id, ci.applicant_id, ci.recipient_phone, ci.recipient_email,
                ci.requested_role::text AS requested_role, ci.status::text AS status,
                ci.expires_at, ci.max_uses, ci.use_count
         FROM chama_invitations ci
         JOIN users u ON u.id = $4
         WHERE ci.chama_id = $1
           AND (($2::uuid IS NOT NULL AND ci.id = $2::uuid)
                OR ($3::text IS NOT NULL AND ci.invite_token_hash = $3::text))
           AND (
             ci.applicant_id = $4
             OR (ci.applicant_id IS NULL AND ci.recipient_phone = u.phone)
             OR (ci.applicant_id IS NULL AND ci.recipient_phone IS NULL AND ci.recipient_email IS NULL)
           )
         FOR UPDATE OF ci`,
        [input.chamaId, input.invitationId ?? null, tokenHash, input.userId],
      )).rows[0];
      if (!invitation || !['pending', 'sent', 'approved', 'delivery_failed'].includes(invitation.status)
          || (invitation.expires_at && new Date(invitation.expires_at).getTime() <= Date.now())
          || Number(invitation.use_count) >= Number(invitation.max_uses)) {
        throw new ForbiddenError('A valid invitation is required for this Chama', 'PRIVATE_CHAMA_INVITE_REQUIRED');
      }
      // Targeted single-use phone invitations can bind to the authenticated user.
      // Generic shareable tokens remain unbound so their configured max_uses can work.
      if (!invitation.applicant_id && invitation.recipient_phone && Number(invitation.max_uses) === 1) {
        await client.query(
          `UPDATE chama_invitations
           SET applicant_id = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [invitation.id, input.userId],
        );
        invitation.applicant_id = input.userId;
      }
    } else if (chama.visibility !== 'public') {
      throw new ForbiddenError('This Chama does not accept direct applications', 'CHAMA_ENTRY_MODE_FORBIDDEN');
    }

    const commitmentRequired = Number(rule.commitment_amount) > 0;
    const membershipStatus = commitmentRequired ? 'pending' : 'active';
    const role = invitation?.requested_role ?? 'member';
    const membership = (await client.query(
      `INSERT INTO chama_members
         (chama_id, user_id, role, membership_status, approved_at)
       VALUES ($1, $2, $3::member_role, $4::membership_status,
               CASE WHEN $4::membership_status = 'active' THEN CURRENT_TIMESTAMP ELSE NULL END)
       RETURNING id, chama_id, user_id, role::text AS role, membership_status::text AS membership_status, joined_at`,
      [input.chamaId, input.userId, role, membershipStatus],
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
         (chama_id, membership_id, chama_rule_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4::inet, $5)`,
      [input.chamaId, membership.id, rule.id, input.acceptanceIp ?? null, input.acceptanceUserAgent ?? null],
    );

    const application = (await client.query(
      `INSERT INTO chama_applications
         (chama_id, user_id, message, status, chama_rule_id, constitution_accepted_at,
          constitution_acceptance_ip, constitution_acceptance_user_agent, reviewed_at)
       VALUES ($1, $2, $3,
               CASE WHEN $5::boolean THEN 'commitment_pending'::application_status ELSE 'approved'::application_status END,
               $4, CURRENT_TIMESTAMP, $6::inet, $7,
               CASE WHEN $5::boolean THEN NULL ELSE CURRENT_TIMESTAMP END)
       RETURNING id, status::text AS status, created_at`,
      [input.chamaId, input.userId, input.message ?? null, rule.id, commitmentRequired,
       input.acceptanceIp ?? null, input.acceptanceUserAgent ?? null],
    )).rows[0];

    let commitment: { required: boolean; amount: string; state: string; id?: string } = {
      required: commitmentRequired,
      amount: String(rule.commitment_amount),
      state: commitmentRequired ? 'applied' : 'not_required',
    };

    if (commitmentRequired) {
      const deposit = (await client.query<{ id: string; state: string }>(
        `INSERT INTO commitment_deposits
           (chama_id, user_id, membership_id, application_id, chama_rule_id, amount,
            state, last_transition_source, last_transition_reference)
         VALUES ($1, $2, $3, $4, $5, $6, 'applied', 'join_flow', $4::text)
         RETURNING id, state::text AS state`,
        [input.chamaId, input.userId, membership.id, application.id, rule.id, rule.commitment_amount],
      )).rows[0];
      commitment = {
        required: true,
        amount: String(rule.commitment_amount),
        state: deposit.state,
        id: deposit.id,
      };
    }

    if (invitation) {
      await client.query(
        `UPDATE chama_invitations
            SET use_count = use_count + 1,
                status = CASE WHEN use_count + 1 >= max_uses THEN 'accepted'::invitation_status ELSE status END,
                accepted_at = CASE WHEN use_count + 1 >= max_uses THEN CURRENT_TIMESTAMP ELSE accepted_at END,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [invitation.id],
      );
    }

    return {
      outcome: commitmentRequired ? 'commitment_required' : 'joined',
      application,
      membership,
      commitment,
      constitution: { id: rule.id, version: rule.version, accepted: true },
    };
  }
}


export type RecruitmentStatus = 'OPEN' | 'ALMOST_FULL' | 'CLOSED';

/**
 * Discovery-only recruitment status. A Chama is closed when it is no longer in
 * a joinable lifecycle state, its recruitment deadline has passed, or capacity
 * is exhausted. "Almost full" starts at 90% occupied when a finite target is
 * configured; unlimited-capacity Chamas remain open while otherwise eligible.
 */
export function deriveRecruitmentStatus(input: {
  status: string;
  targetMembers: number | null;
  occupiedCount: number;
  recruitmentDeadline: string | null;
  recruitmentClosedAt?: string | null;
}, today = new Date()): RecruitmentStatus {
  if (!['recruiting', 'active'].includes(input.status) || input.recruitmentClosedAt) return 'CLOSED';
  if (input.recruitmentDeadline) {
    const deadline = new Date(`${input.recruitmentDeadline}T23:59:59.999Z`);
    if (Number.isFinite(deadline.getTime()) && deadline.getTime() < today.getTime()) return 'CLOSED';
  }
  if (input.targetMembers === null) return 'OPEN';
  if (input.occupiedCount >= input.targetMembers) return 'CLOSED';
  const occupancyPct = input.targetMembers > 0 ? input.occupiedCount / input.targetMembers : 1;
  return occupancyPct >= 0.9 ? 'ALMOST_FULL' : 'OPEN';
}

export const publicChamaService = new PublicChamaService();
