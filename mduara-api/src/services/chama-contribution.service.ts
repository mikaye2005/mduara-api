import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { NotFoundError } from '../utils/errors';

interface ContributionRow extends QueryResultRow {
  contribution_id: string;
  period_label: string;
  due_date: string;
  expected_amount: string;
  confirmed_amount: string;
  status: string;
  missed_at: string | null;
  member_id: string;
  member_name: string;
  total_count: string;
}

export class ChamaContributionService {
  constructor(private readonly db: Pool = pool) {}

  async list(input: { chamaId: string; period?: string; page: number; perPage: number }) {
    const exists = await this.db.query(`SELECT 1 FROM chamas WHERE id = $1`, [input.chamaId]);
    if (!exists.rows[0]) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');
    const offset = (input.page - 1) * input.perPage;
    const result = await this.db.query<ContributionRow>(
      `WITH payments AS (
         SELECT contribution_id, COALESCE(SUM(amount) FILTER (WHERE status = 'confirmed'), 0)::bigint AS confirmed_amount
           FROM contribution_payments
          GROUP BY contribution_id
       )
       SELECT c.id AS contribution_id, c.period_label, c.due_date::text, c.expected_amount::text,
              COALESCE(p.confirmed_amount, 0)::text AS confirmed_amount,
              c.status::text AS status, c.missed_at::text,
              cm.id AS member_id, u.full_name AS member_name,
              COUNT(*) OVER()::text AS total_count
         FROM contributions c
         JOIN chama_members cm ON cm.id = c.member_id AND cm.chama_id = c.chama_id
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN payments p ON p.contribution_id = c.id
        WHERE c.chama_id = $1
          AND ($2::text IS NULL OR c.period_label = $2)
        ORDER BY c.due_date DESC, c.period_label DESC, u.full_name ASC, c.id ASC
        LIMIT $3 OFFSET $4`,
      [input.chamaId, input.period ?? null, input.perPage, offset],
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      contributions: result.rows.map((row) => ({
        contributionId: row.contribution_id,
        periodLabel: row.period_label,
        dueDate: row.due_date,
        expectedAmount: row.expected_amount,
        confirmedAmount: row.confirmed_amount,
        status: row.status,
        missed: Boolean(row.missed_at),
        member: { membershipId: row.member_id, fullName: row.member_name },
      })),
      meta: { total, page: input.page, perPage: input.perPage, totalPages: total ? Math.ceil(total / input.perPage) : 0 },
    };
  }
}

export const chamaContributionService = new ChamaContributionService();