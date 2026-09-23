import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { NotFoundError } from '../utils/errors';

export interface GoalMatchInput {
  savingGoalId?: string;
  goalCode?: string;
  targetAmount: number;
  contributionCapacity: number;
  contributionFrequency: string;
  durationMonths: number;
  location?: string;
  preferredVisibility?: 'public' | 'application';
  invitationId?: string;
  userId?: string;
  limit?: number;
}

interface GoalIdentityRow extends QueryResultRow {
  id: string;
  code: string;
  slug: string;
  name: string;
  category_id: string;
  category_code: string;
  category_slug: string;
  category_name: string;
}

interface CandidateRow extends QueryResultRow {
  id: string;
  name: string;
  description: string | null;
  status: 'recruiting' | 'active';
  visibility: 'public' | 'application' | 'private';
  location: string | null;
  logo_url: string | null;
  target_members: number | null;
  occupied_count: number;
  available_spots: number | null;
  contribution_amount: string;
  contribution_frequency: string;
  target_amount: string | null;
  saving_start_date: string | null;
  saving_end_date: string | null;
  duration_months: number | null;
  currency: string;
  invited: boolean;
}

export interface GoalChamaMatchDto {
  rank: number;
  score: number;
  joinable: true;
  entryMode: 'public' | 'application' | 'private_invite';
  matchReasons: string[];
  chama: {
    id: string;
    name: string;
    description: string | null;
    status: 'recruiting' | 'active';
    visibility: 'public' | 'application' | 'private';
    location: string | null;
    logoUrl: string | null;
    targetMembers: number | null;
    occupiedCount: number;
    availableSpots: number | null;
    contributionAmount: string;
    contributionFrequency: string;
    targetAmount: string | null;
    savingStartDate: string | null;
    savingEndDate: string | null;
    durationMonths: number | null;
    currency: string;
  };
}

/**
 * BE-31 deterministic goal-to-Chama matcher.
 *
 * Hard eligibility rules are deliberately separate from ranking:
 * - exact active canonical goal;
 * - goal-based, recruiting/active KES Chama;
 * - contribution amount is within the user's capacity at the same frequency;
 * - known Chama saving duration does not exceed the user's requested duration;
 * - active + pending occupancy must be below target_members when capacity is set;
 * - public/application Chamas are eligible; private requires an authenticated,
 *   applicant-specific, live invitation.
 */
export class GoalMatchingService {
  constructor(private readonly db: Pool = pool) {}

  async findMatches(input: GoalMatchInput) {
    const goal = await this.resolveGoal(input);
    const candidates = await this.loadCandidates(goal.code, input);
    const ranked = candidates
      .map((row) => this.rankCandidate(row, input))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const contributionDelta = Number(a.chama.contributionAmount) - Number(b.chama.contributionAmount);
        if (contributionDelta !== 0) return contributionDelta;
        const aDuration = a.chama.durationMonths ?? Number.MAX_SAFE_INTEGER;
        const bDuration = b.chama.durationMonths ?? Number.MAX_SAFE_INTEGER;
        const aDistance = Math.abs(aDuration - input.durationMonths);
        const bDistance = Math.abs(bDuration - input.durationMonths);
        if (aDistance !== bDistance) return aDistance - bDistance;
        return a.chama.id.localeCompare(b.chama.id);
      })
      .slice(0, input.limit ?? 10)
      .map((match, index) => ({ ...match, rank: index + 1 }));

    return {
      goal: {
        id: goal.id,
        code: goal.code,
        slug: goal.slug,
        name: goal.name,
        category: {
          id: goal.category_id,
          code: goal.category_code,
          slug: goal.category_slug,
          name: goal.category_name,
        },
      },
      request: {
        targetAmount: String(input.targetAmount),
        contributionCapacity: String(input.contributionCapacity),
        contributionFrequency: input.contributionFrequency,
        durationMonths: input.durationMonths,
        location: input.location ?? null,
        preferredVisibility: input.preferredVisibility ?? null,
      },
      matches: ranked,
      meta: {
        count: ranked.length,
        scoringVersion: 'goal-match-v2.1',
        targetAmountScoring: 'context_only',
      },
    };
  }

  private async resolveGoal(input: GoalMatchInput): Promise<GoalIdentityRow> {
    const values: unknown[] = [];
    const where = ['sg.is_active = TRUE', 'gc.is_active = TRUE'];

    if (input.savingGoalId) {
      values.push(input.savingGoalId);
      where.push(`sg.id = $${values.length}::uuid`);
    }
    if (input.goalCode) {
      values.push(input.goalCode);
      where.push(`sg.code = $${values.length}`);
    }

    const result = await this.db.query<GoalIdentityRow>(
      `SELECT sg.id, sg.code, sg.slug, sg.name,
              gc.id AS category_id, gc.code AS category_code,
              gc.slug AS category_slug, gc.name AS category_name
       FROM saving_goals sg
       JOIN goal_categories gc ON gc.id = sg.category_id
       WHERE ${where.join(' AND ')}
       LIMIT 1`,
      values,
    );

    const goal = result.rows[0];
    if (!goal) throw new NotFoundError('Saving goal not found or goal identifiers conflict');
    return goal;
  }

  private async loadCandidates(goalCode: string, input: GoalMatchInput): Promise<CandidateRow[]> {
    const durationExpression = `(EXTRACT(YEAR FROM age(c.saving_end_date, c.saving_start_date)) * 12
      + EXTRACT(MONTH FROM age(c.saving_end_date, c.saving_start_date))
      + CASE WHEN EXTRACT(DAY FROM age(c.saving_end_date, c.saving_start_date)) > 0 THEN 1 ELSE 0 END)`;

    const result = await this.db.query<CandidateRow>(
      `WITH member_counts AS (
         SELECT chama_id,
                COUNT(*) FILTER (WHERE membership_status IN ('active', 'pending'))::int AS occupied_count
         FROM chama_members
         GROUP BY chama_id
       )
       SELECT c.id,
              c.name,
              c.description,
              c.status::text AS status,
              c.visibility::text AS visibility,
              c.location,
              c.logo_url,
              c.target_members,
              COALESCE(mc.occupied_count, 0)::int AS occupied_count,
              CASE WHEN c.target_members IS NULL THEN NULL
                   ELSE GREATEST(c.target_members - COALESCE(mc.occupied_count, 0), 0)::int END AS available_spots,
              c.contribution_amount::text,
              c.contribution_frequency,
              c.target_amount::text,
              c.saving_start_date::text,
              c.saving_end_date::text,
              CASE WHEN c.saving_start_date IS NULL OR c.saving_end_date IS NULL THEN NULL
                   ELSE ${durationExpression}::int END AS duration_months,
              c.currency,
              CASE WHEN c.visibility = 'private' THEN TRUE ELSE FALSE END AS invited
       FROM chamas c
       LEFT JOIN member_counts mc ON mc.chama_id = c.id
       WHERE c.goal_code = $1
         AND c.type = 'goal_based'
         AND c.status IN ('recruiting', 'active')
         AND c.recruitment_closed_at IS NULL
         AND (c.recruitment_deadline IS NULL OR c.recruitment_deadline >= CURRENT_DATE)
         AND c.currency = 'KES'
         AND LOWER(c.contribution_frequency) = $2
         AND c.contribution_amount <= $3
         AND (c.target_members IS NULL OR COALESCE(mc.occupied_count, 0) < c.target_members)
         AND (
           c.saving_start_date IS NULL
           OR c.saving_end_date IS NULL
           OR ${durationExpression} <= $4
         )
         AND (
           c.visibility IN ('public', 'application')
           OR (
             c.visibility = 'private'
             AND $5::uuid IS NOT NULL
             AND $6::uuid IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM chama_invitations ci
               WHERE ci.id = $5::uuid
                 AND ci.chama_id = c.id
                 AND ci.applicant_id = $6::uuid
                 AND ci.status IN ('pending', 'sent', 'approved', 'delivery_failed')
                 AND (ci.expires_at IS NULL OR ci.expires_at > CURRENT_TIMESTAMP)
                 AND ci.use_count < ci.max_uses
             )
           )
         )
       ORDER BY c.id ASC`,
      [
        goalCode,
        input.contributionFrequency.toLowerCase(),
        input.contributionCapacity,
        input.durationMonths,
        input.invitationId ?? null,
        input.userId ?? null,
      ],
    );

    return result.rows;
  }

  private rankCandidate(row: CandidateRow, input: GoalMatchInput): Omit<GoalChamaMatchDto, 'rank'> {
    const contributionAmount = Number(row.contribution_amount);
    const affordabilityRatio = Math.min(contributionAmount / input.contributionCapacity, 1);
    const affordabilityScore = Math.round((1 - affordabilityRatio) * 25);

    let timelineScore = 0;
    if (row.duration_months !== null) {
      const distance = Math.abs(row.duration_months - input.durationMonths);
      timelineScore = Math.round(Math.max(0, 1 - distance / input.durationMonths) * 10);
    }

    const locationMatch = Boolean(
      input.location
      && row.location
      && row.location.toLowerCase().includes(input.location.toLowerCase()),
    );
    const visibilityMatch = Boolean(input.preferredVisibility && row.visibility === input.preferredVisibility);
    const score = 55 + affordabilityScore + timelineScore + (locationMatch ? 5 : 0) + (visibilityMatch ? 5 : 0);

    const reasons = [
      'Exact canonical saving-goal match',
      `${row.contribution_frequency} contribution of KES ${row.contribution_amount} is within your KES ${input.contributionCapacity} capacity`,
    ];

    if (row.duration_months !== null) {
      reasons.push(`${row.duration_months}-month saving period fits within your ${input.durationMonths}-month timeline`);
    } else {
      reasons.push('Chama has no fixed saving-end date; timeline fit is not scored');
    }
    if (locationMatch) reasons.push(`Location matches your ${input.location} preference`);
    if (visibilityMatch) reasons.push(`Entry mode matches your ${input.preferredVisibility} preference`);
    if (row.visibility === 'private' && row.invited) reasons.push('Valid applicant-specific invitation unlocks this private Chama');

    return {
      score,
      joinable: true,
      entryMode: row.visibility === 'private' ? 'private_invite' : row.visibility,
      matchReasons: reasons,
      chama: {
        id: row.id,
        name: row.name,
        description: row.description,
        status: row.status,
        visibility: row.visibility,
        location: row.location,
        logoUrl: row.logo_url,
        targetMembers: row.target_members,
        occupiedCount: Number(row.occupied_count),
        availableSpots: row.available_spots === null ? null : Number(row.available_spots),
        contributionAmount: row.contribution_amount,
        contributionFrequency: row.contribution_frequency,
        targetAmount: row.target_amount,
        savingStartDate: row.saving_start_date,
        savingEndDate: row.saving_end_date,
        durationMonths: row.duration_months === null ? null : Number(row.duration_months),
        currency: row.currency,
      },
    };
  }
}

export const goalMatchingService = new GoalMatchingService();
