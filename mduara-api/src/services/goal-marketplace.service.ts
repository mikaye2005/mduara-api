import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { NotFoundError } from '../utils/errors';

export interface GoalMarketplaceMetricDto {
  id: string;
  code: string;
  slug: string;
  name: string;
  category: {
    id: string;
    code: string;
    slug: string;
    name: string;
  };
  membersSaving: number;
  totalTargetValue: string;
  currency: 'KES';
  partnerMerchantCount: number;
}

interface GoalMetricRow extends QueryResultRow {
  id: string;
  code: string;
  slug: string;
  name: string;
  category_id: string;
  category_code: string;
  category_slug: string;
  category_name: string;
  members_saving: number;
  total_target_value: string;
}

interface PartnershipAvailabilityRow extends QueryResultRow {
  available: boolean;
}

interface MerchantCountRow extends QueryResultRow {
  goal_id: string;
  merchant_count: number;
}

/**
 * BE-30 marketplace aggregates for public Phase 1 goal cards.
 *
 * Metric contract:
 * - only recruiting/active public or application Chamas are eligible;
 * - membersSaving counts distinct users with active memberships only;
 * - totalTargetValue sums each eligible Chama target_amount once, in KES;
 * - partnerMerchantCount reads active/current BE-33 partnerships when those
 *   tables exist, otherwise it is zero until the merchant domain is installed.
 */
export class GoalMarketplaceService {
  constructor(private readonly db: Pool = pool) {}

  async listMetrics(categoryCode?: string): Promise<GoalMarketplaceMetricDto[]> {
    const rows = await this.queryMetricRows({ categoryCode });
    return this.attachMerchantCounts(rows);
  }

  async getMetric(identifier: string): Promise<GoalMarketplaceMetricDto> {
    const normalized = identifier.trim().toLowerCase();
    const rows = await this.queryMetricRows({ identifier: normalized });
    const row = rows[0];
    if (!row) throw new NotFoundError('Saving goal not found');

    const [metric] = await this.attachMerchantCounts([row]);
    return metric;
  }

  private async queryMetricRows(filters: { categoryCode?: string; identifier?: string }): Promise<GoalMetricRow[]> {
    const values: unknown[] = [];
    const where = ['sg.is_active = TRUE', 'gc.is_active = TRUE'];

    if (filters.categoryCode) {
      values.push(filters.categoryCode);
      where.push(`gc.code = $${values.length}`);
    }

    if (filters.identifier) {
      values.push(filters.identifier);
      where.push(`(sg.id::text = $${values.length} OR sg.code = $${values.length} OR sg.slug = $${values.length})`);
    }

    const result = await this.db.query<GoalMetricRow>(
      `WITH eligible_chamas AS (
         SELECT c.id, c.goal_code, c.target_amount
         FROM chamas c
         WHERE c.goal_code IS NOT NULL
           AND c.status IN ('recruiting', 'active')
           AND c.visibility IN ('public', 'application')
           AND c.currency = 'KES'
       ),
       member_totals AS (
         SELECT ec.goal_code,
                COUNT(DISTINCT cm.user_id)::int AS members_saving
         FROM eligible_chamas ec
         JOIN chama_members cm ON cm.chama_id = ec.id
         WHERE cm.membership_status = 'active'
         GROUP BY ec.goal_code
       ),
       target_totals AS (
         SELECT ec.goal_code,
                COALESCE(SUM(ec.target_amount), 0)::text AS total_target_value
         FROM eligible_chamas ec
         GROUP BY ec.goal_code
       )
       SELECT sg.id,
              sg.code,
              sg.slug,
              sg.name,
              gc.id AS category_id,
              gc.code AS category_code,
              gc.slug AS category_slug,
              gc.name AS category_name,
              COALESCE(mt.members_saving, 0)::int AS members_saving,
              COALESCE(tt.total_target_value, '0') AS total_target_value
       FROM saving_goals sg
       JOIN goal_categories gc ON gc.id = sg.category_id
       LEFT JOIN member_totals mt ON mt.goal_code = sg.code
       LEFT JOIN target_totals tt ON tt.goal_code = sg.code
       WHERE ${where.join(' AND ')}
       ORDER BY gc.display_order ASC, sg.display_order ASC, sg.code ASC`,
      values,
    );

    return result.rows;
  }

  private async attachMerchantCounts(rows: GoalMetricRow[]): Promise<GoalMarketplaceMetricDto[]> {
    if (rows.length === 0) return [];

    const merchantCounts = await this.loadPartnerMerchantCounts(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      slug: row.slug,
      name: row.name,
      category: {
        id: row.category_id,
        code: row.category_code,
        slug: row.category_slug,
        name: row.category_name,
      },
      membersSaving: Number(row.members_saving),
      totalTargetValue: row.total_target_value,
      currency: 'KES',
      partnerMerchantCount: merchantCounts.get(row.id) ?? 0,
    }));
  }

  private async loadPartnerMerchantCounts(goalIds: string[]): Promise<Map<string, number>> {
    const availability = await this.db.query<PartnershipAvailabilityRow>(
      `SELECT (
         to_regclass('partner_merchants') IS NOT NULL
         AND to_regclass('goal_merchant_partnerships') IS NOT NULL
       ) AS available`,
    );

    if (!availability.rows[0]?.available) return new Map();

    const result = await this.db.query<MerchantCountRow>(
      `SELECT gmp.goal_id::text AS goal_id,
              COUNT(DISTINCT gmp.merchant_id)::int AS merchant_count
       FROM goal_merchant_partnerships gmp
       JOIN partner_merchants pm ON pm.id = gmp.merchant_id
       WHERE gmp.goal_id = ANY($1::uuid[])
         AND pm.status = 'active'
         AND gmp.status = 'active'
         AND (gmp.valid_from IS NULL OR gmp.valid_from <= CURRENT_TIMESTAMP)
         AND (gmp.valid_until IS NULL OR gmp.valid_until > CURRENT_TIMESTAMP)
       GROUP BY gmp.goal_id`,
      [goalIds],
    );

    return new Map(result.rows.map((row) => [row.goal_id, Number(row.merchant_count)]));
  }
}

export const goalMarketplaceService = new GoalMarketplaceService();
