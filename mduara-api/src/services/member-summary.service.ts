import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { pool } from '../db/client';

interface QueryExecutor {
  query<T extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<T>>;
}

export interface MemberSummaryQuery {
  page?: number;
  perPage?: number;
}

export interface MemberContributionDue {
  contributionId: string;
  dueDate: string;
  periodLabel: string;
  expectedAmount: string;
  confirmedAmount: string;
  remainingAmount: string;
  status: string;
  isOverdue: boolean;
}

export interface MemberChamaSummary {
  membershipId: string;
  chamaId: string;
  name: string;
  logoUrl: string | null;
  membershipStatus: string;
  role: string;
  officialRole: string | null;
  joinedAt: string | null;
  confirmedContributedAmount: string;
  scheduledExpectedAmount: string;
  contributionProgressPercent: string | null;
  nextDue: MemberContributionDue | null;
}

export interface CrossChamaObligation extends MemberContributionDue {
  chamaId: string;
  chamaName: string;
  membershipId: string;
}

export interface MemberSummaryResult {
  memberships: MemberChamaSummary[];
  aggregates: {
    totalConfirmedContributions: string;
    activeChamas: number;
    nextUpcomingObligation: CrossChamaObligation | null;
  };
  meta: {
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  };
}

interface MembershipRow extends QueryResultRow {
  membership_id: string;
  chama_id: string;
  chama_name: string;
  logo_url: string | null;
  membership_status: string;
  role: string;
  joined_at: string | null;
  confirmed_contributed_amount: string;
  scheduled_expected_amount: string;
  contribution_progress_percent: string | null;
  next_contribution_id: string | null;
  next_due_date: string | null;
  next_period_label: string | null;
  next_expected_amount: string | null;
  next_confirmed_amount: string | null;
  next_remaining_amount: string | null;
  next_status: string | null;
  next_is_overdue: boolean | null;
  total_count: string;
}

interface AggregateRow extends QueryResultRow {
  total_confirmed_contributions: string;
  active_chamas: string;
  contribution_id: string | null;
  chama_id: string | null;
  chama_name: string | null;
  membership_id: string | null;
  due_date: string | null;
  period_label: string | null;
  expected_amount: string | null;
  confirmed_amount: string | null;
  remaining_amount: string | null;
  contribution_status: string | null;
  is_overdue: boolean | null;
}

/**
 * Personal dashboard read model. Every monetary join is anchored through
 * chama_members.user_id = $1, so another member's raw finances cannot enter
 * this response accidentally.
 */
export class MemberSummaryService {
  constructor(private readonly db: QueryExecutor = pool as unknown as QueryExecutor) {}

  async getSummary(userId: string, query: MemberSummaryQuery = {}): Promise<MemberSummaryResult> {
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const perPage = Math.min(50, Math.max(1, Math.trunc(query.perPage ?? 20)));
    const offset = (page - 1) * perPage;

    const [cardsResult, aggregateResult, countResult] = await Promise.all([
      this.db.query<MembershipRow>(
        `WITH memberships AS (
           SELECT cm.id AS membership_id,
                  cm.chama_id,
                  cm.role::text AS role,
                  cm.membership_status::text AS membership_status,
                  cm.joined_at,
                  c.name AS chama_name,
                  c.logo_url
           FROM chama_members cm
           JOIN chamas c ON c.id = cm.chama_id
           WHERE cm.user_id = $1
         ),
         confirmed_by_contribution AS (
           SELECT cp.contribution_id,
                  SUM(cp.amount)::bigint AS confirmed_amount
           FROM contribution_payments cp
           JOIN memberships m
             ON m.membership_id = cp.member_id
            AND m.chama_id = cp.chama_id
           WHERE cp.status = 'confirmed'
           GROUP BY cp.contribution_id
         ),
         stats AS (
           SELECT m.membership_id,
                  COALESCE(SUM(c.expected_amount), 0)::text AS scheduled_expected_amount,
                  COALESCE(SUM(COALESCE(p.confirmed_amount, 0)), 0)::text AS confirmed_contributed_amount,
                  CASE
                    WHEN COALESCE(SUM(c.expected_amount), 0) = 0 THEN NULL
                    ELSE ROUND(
                      LEAST(
                        COALESCE(SUM(COALESCE(p.confirmed_amount, 0)), 0)::numeric,
                        SUM(c.expected_amount)::numeric
                      ) * 100 / SUM(c.expected_amount)::numeric,
                      2
                    )::text
                  END AS contribution_progress_percent
           FROM memberships m
           LEFT JOIN contributions c
             ON c.member_id = m.membership_id
            AND c.chama_id = m.chama_id
           LEFT JOIN confirmed_by_contribution p ON p.contribution_id = c.id
           GROUP BY m.membership_id
         ),
         next_due AS (
           SELECT DISTINCT ON (m.membership_id)
                  m.membership_id,
                  c.id AS contribution_id,
                  c.due_date,
                  c.period_label,
                  c.expected_amount::text AS expected_amount,
                  COALESCE(p.confirmed_amount, 0)::text AS confirmed_amount,
                  GREATEST(c.expected_amount - COALESCE(p.confirmed_amount, 0), 0)::text AS remaining_amount,
                  c.status::text AS contribution_status,
                  (c.due_date < CURRENT_DATE) AS is_overdue
           FROM memberships m
           JOIN contributions c
             ON c.member_id = m.membership_id
            AND c.chama_id = m.chama_id
           LEFT JOIN confirmed_by_contribution p ON p.contribution_id = c.id
           WHERE m.membership_status = 'active'
             AND c.status NOT IN ('paid', 'waived')
             AND c.expected_amount > COALESCE(p.confirmed_amount, 0)
           ORDER BY m.membership_id, c.due_date ASC, c.id ASC
         )
         SELECT m.membership_id,
                m.chama_id,
                m.chama_name,
                m.logo_url,
                m.membership_status,
                m.role,
                m.joined_at,
                s.confirmed_contributed_amount,
                s.scheduled_expected_amount,
                s.contribution_progress_percent,
                nd.contribution_id AS next_contribution_id,
                nd.due_date::text AS next_due_date,
                nd.period_label AS next_period_label,
                nd.expected_amount AS next_expected_amount,
                nd.confirmed_amount AS next_confirmed_amount,
                nd.remaining_amount AS next_remaining_amount,
                nd.contribution_status AS next_status,
                nd.is_overdue AS next_is_overdue,
                COUNT(*) OVER()::text AS total_count
         FROM memberships m
         JOIN stats s ON s.membership_id = m.membership_id
         LEFT JOIN next_due nd ON nd.membership_id = m.membership_id
         ORDER BY
           CASE WHEN m.membership_status = 'active' THEN 0 ELSE 1 END,
           m.joined_at DESC NULLS LAST,
           m.membership_id ASC
         LIMIT $2 OFFSET $3`,
        [userId, perPage, offset],
      ),
      this.db.query<AggregateRow>(
        `WITH memberships AS (
           SELECT cm.id AS membership_id,
                  cm.chama_id,
                  cm.membership_status::text AS membership_status,
                  c.name AS chama_name
           FROM chama_members cm
           JOIN chamas c ON c.id = cm.chama_id
           WHERE cm.user_id = $1
         ),
         confirmed_by_contribution AS (
           SELECT cp.contribution_id,
                  SUM(cp.amount)::bigint AS confirmed_amount
           FROM contribution_payments cp
           JOIN memberships m
             ON m.membership_id = cp.member_id
            AND m.chama_id = cp.chama_id
           WHERE cp.status = 'confirmed'
           GROUP BY cp.contribution_id
         ),
         totals AS (
           SELECT COALESCE(SUM(COALESCE(p.confirmed_amount, 0)), 0)::text AS total_confirmed_contributions,
                  COUNT(*) FILTER (WHERE m.membership_status = 'active')::text AS active_chamas
           FROM memberships m
           LEFT JOIN contributions c
             ON c.member_id = m.membership_id
            AND c.chama_id = m.chama_id
           LEFT JOIN confirmed_by_contribution p ON p.contribution_id = c.id
         ),
         next_obligation AS (
           SELECT c.id AS contribution_id,
                  m.chama_id,
                  m.chama_name,
                  m.membership_id,
                  c.due_date,
                  c.period_label,
                  c.expected_amount::text AS expected_amount,
                  COALESCE(p.confirmed_amount, 0)::text AS confirmed_amount,
                  GREATEST(c.expected_amount - COALESCE(p.confirmed_amount, 0), 0)::text AS remaining_amount,
                  c.status::text AS contribution_status,
                  (c.due_date < CURRENT_DATE) AS is_overdue
           FROM memberships m
           JOIN contributions c
             ON c.member_id = m.membership_id
            AND c.chama_id = m.chama_id
           LEFT JOIN confirmed_by_contribution p ON p.contribution_id = c.id
           WHERE m.membership_status = 'active'
             AND c.status NOT IN ('paid', 'waived')
             AND c.expected_amount > COALESCE(p.confirmed_amount, 0)
           ORDER BY c.due_date ASC, c.id ASC
           LIMIT 1
         )
         SELECT t.total_confirmed_contributions,
                t.active_chamas,
                n.contribution_id,
                n.chama_id,
                n.chama_name,
                n.membership_id,
                n.due_date::text,
                n.period_label,
                n.expected_amount,
                n.confirmed_amount,
                n.remaining_amount,
                n.contribution_status,
                n.is_overdue
         FROM totals t
         LEFT JOIN next_obligation n ON TRUE`,
        [userId],
      ),
      this.db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM chama_members WHERE user_id = $1`,
        [userId],
      ),
    ]);

    const total = Number(countResult.rows[0]?.count ?? 0);
    const memberships = cardsResult.rows.map((row): MemberChamaSummary => ({
      membershipId: row.membership_id,
      chamaId: row.chama_id,
      name: row.chama_name,
      logoUrl: row.logo_url,
      membershipStatus: row.membership_status,
      role: row.role,
      officialRole:
        row.membership_status === 'active' && row.role !== 'member' ? row.role : null,
      joinedAt: row.joined_at,
      confirmedContributedAmount: row.confirmed_contributed_amount,
      scheduledExpectedAmount: row.scheduled_expected_amount,
      contributionProgressPercent: row.contribution_progress_percent,
      nextDue: row.next_contribution_id
        ? {
            contributionId: row.next_contribution_id,
            dueDate: row.next_due_date!,
            periodLabel: row.next_period_label!,
            expectedAmount: row.next_expected_amount!,
            confirmedAmount: row.next_confirmed_amount!,
            remainingAmount: row.next_remaining_amount!,
            status: row.next_status!,
            isOverdue: Boolean(row.next_is_overdue),
          }
        : null,
    }));

    const aggregate = aggregateResult.rows[0];
    const nextUpcomingObligation: CrossChamaObligation | null = aggregate?.contribution_id
      ? {
          contributionId: aggregate.contribution_id,
          chamaId: aggregate.chama_id!,
          chamaName: aggregate.chama_name!,
          membershipId: aggregate.membership_id!,
          dueDate: aggregate.due_date!,
          periodLabel: aggregate.period_label!,
          expectedAmount: aggregate.expected_amount!,
          confirmedAmount: aggregate.confirmed_amount!,
          remainingAmount: aggregate.remaining_amount!,
          status: aggregate.contribution_status!,
          isOverdue: Boolean(aggregate.is_overdue),
        }
      : null;

    return {
      memberships,
      aggregates: {
        totalConfirmedContributions: aggregate?.total_confirmed_contributions ?? '0',
        activeChamas: Number(aggregate?.active_chamas ?? 0),
        nextUpcomingObligation,
      },
      meta: {
        total,
        page,
        perPage,
        totalPages: total === 0 ? 0 : Math.ceil(total / perPage),
      },
    };
  }
}

export const memberSummaryService = new MemberSummaryService();
