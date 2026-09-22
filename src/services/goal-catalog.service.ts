import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { NotFoundError } from '../utils/errors';

export interface GoalCategoryDto {
  id: string;
  code: string;
  slug: string;
  name: string;
  displayOrder: number;
  goalCount: number;
}

export interface SavingGoalDto {
  id: string;
  code: string;
  slug: string;
  name: string;
  description: string | null;
  displayOrder: number;
  category: {
    id: string;
    code: string;
    slug: string;
    name: string;
  };
}

interface CategoryRow extends QueryResultRow {
  id: string;
  code: string;
  slug: string;
  name: string;
  display_order: number;
  goal_count: number;
}

interface GoalRow extends QueryResultRow {
  id: string;
  code: string;
  slug: string;
  name: string;
  description: string | null;
  display_order: number;
  category_id: string;
  category_code: string;
  category_slug: string;
  category_name: string;
}

/**
 * Read-only Phase 1 goal catalog backed by PostgreSQL.
 * Stable goal codes are the compatibility key used by chamas.goal_code.
 */
export class GoalCatalogService {
  constructor(private readonly db: Pool = pool) {}

  async listCategories(): Promise<GoalCategoryDto[]> {
    const result = await this.db.query<CategoryRow>(
      `SELECT gc.id,
              gc.code,
              gc.slug,
              gc.name,
              gc.display_order,
              COUNT(sg.id) FILTER (WHERE sg.is_active)::int AS goal_count
       FROM goal_categories gc
       LEFT JOIN saving_goals sg ON sg.category_id = gc.id
       WHERE gc.is_active = TRUE
       GROUP BY gc.id, gc.code, gc.slug, gc.name, gc.display_order
       ORDER BY gc.display_order ASC, gc.code ASC`,
    );

    return result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      slug: row.slug,
      name: row.name,
      displayOrder: Number(row.display_order),
      goalCount: Number(row.goal_count),
    }));
  }

  async listGoals(categoryCode?: string): Promise<SavingGoalDto[]> {
    const values: unknown[] = [];
    const where = ['sg.is_active = TRUE', 'gc.is_active = TRUE'];

    if (categoryCode) {
      values.push(categoryCode);
      where.push(`gc.code = $${values.length}`);
    }

    const result = await this.db.query<GoalRow>(
      `SELECT sg.id,
              sg.code,
              sg.slug,
              sg.name,
              sg.description,
              sg.display_order,
              gc.id AS category_id,
              gc.code AS category_code,
              gc.slug AS category_slug,
              gc.name AS category_name
       FROM saving_goals sg
       JOIN goal_categories gc ON gc.id = sg.category_id
       WHERE ${where.join(' AND ')}
       ORDER BY gc.display_order ASC, sg.display_order ASC, sg.code ASC`,
      values,
    );

    return result.rows.map(mapGoalRow);
  }

  async getGoal(identifier: string): Promise<SavingGoalDto> {
    const normalized = identifier.trim().toLowerCase();
    const result = await this.db.query<GoalRow>(
      `SELECT sg.id,
              sg.code,
              sg.slug,
              sg.name,
              sg.description,
              sg.display_order,
              gc.id AS category_id,
              gc.code AS category_code,
              gc.slug AS category_slug,
              gc.name AS category_name
       FROM saving_goals sg
       JOIN goal_categories gc ON gc.id = sg.category_id
       WHERE sg.is_active = TRUE
         AND gc.is_active = TRUE
         AND (sg.id::text = $1 OR sg.code = $1 OR sg.slug = $1)
       LIMIT 1`,
      [normalized],
    );

    const row = result.rows[0];
    if (!row) throw new NotFoundError('Saving goal not found');
    return mapGoalRow(row);
  }
}

function mapGoalRow(row: GoalRow): SavingGoalDto {
  return {
    id: row.id,
    code: row.code,
    slug: row.slug,
    name: row.name,
    description: row.description,
    displayOrder: Number(row.display_order),
    category: {
      id: row.category_id,
      code: row.category_code,
      slug: row.category_slug,
      name: row.category_name,
    },
  };
}

export const goalCatalogService = new GoalCatalogService();
