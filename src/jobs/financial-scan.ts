import type { Pool } from 'pg';
import { logger } from '../utils/logger';
import { assessContribution } from './penalties';
import { processLoanInterest } from './interest';
import { refreshMemberCommitmentStatuses } from './member-commitment-status';

export interface ScanOptions { timezone: string; batchSize: number; isStopping?: () => boolean; }

/** Keyset pages avoid OFFSET scans and never hold locks across the whole group. */
export async function runFinancialScan(pool: Pool, options: ScanOptions, now = new Date()) {
  const totals = { penalties: 0, interestCycles: 0, commitmentStatuses: 0, errors: 0 };
  for (const kind of ['contribution', 'loan'] as const) {
    let cursorDate = '0001-01-01';
    let cursorId = '00000000-0000-0000-0000-000000000000';
    while (!options.isStopping?.()) {
      const result = kind === 'contribution'
        ? await pool.query<{ id: string; date: string }>(
          `SELECT c.id, c.due_date::text AS date FROM contributions c
           JOIN chamas g ON g.id = c.chama_id AND g.status = 'active'
           JOIN chama_members m ON m.id = c.member_id AND m.chama_id = c.chama_id AND m.membership_status = 'active'
           WHERE c.penalty_checked_at IS NULL AND c.status <> 'waived'
             AND c.due_date < ($1::timestamptz AT TIME ZONE $2)::date
             AND (c.due_date, c.id) > ($3::date, $4::uuid)
           ORDER BY c.due_date, c.id LIMIT $5`, [now, options.timezone, cursorDate, cursorId, options.batchSize])
        : await pool.query<{ id: string; date: string }>(
          `SELECT l.id, l.next_interest_date::text AS date FROM loans l
           JOIN chamas g ON g.id = l.chama_id AND g.status = 'active'
           WHERE l.status IN ('active', 'partially_repaid') AND l.interest_cycle_days IS NOT NULL
             AND l.next_interest_date <= ($1::timestamptz AT TIME ZONE $2)::date
             AND (l.due_date IS NULL OR l.next_interest_date <= l.due_date)
             AND (l.next_interest_date, l.id) > ($3::date, $4::uuid)
           ORDER BY l.next_interest_date, l.id LIMIT $5`, [now, options.timezone, cursorDate, cursorId, options.batchSize]);
      if (!result.rows.length) break;
      for (const row of result.rows) {
        if (options.isStopping?.()) break;
        try {
          if (kind === 'contribution') totals.penalties += Number(await assessContribution(pool, row.id, now, options.timezone));
          else {
            // Catch up every elapsed cycle, releasing the row lock after each one.
            while (!options.isStopping?.()) {
              const cycles = await processLoanInterest(pool, row.id, now, options.timezone);
              totals.interestCycles += cycles;
              if (!cycles) break;
            }
          }
        } catch (error) {
          totals.errors += 1;
          logger.error('Financial assessment failed; next scan will retry', { kind, entityId: row.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const last = result.rows[result.rows.length - 1];
      cursorDate = last.date;
      cursorId = last.id;
    }
  }
  try {
    const statusRefresh = await refreshMemberCommitmentStatuses(pool);
    totals.commitmentStatuses = statusRefresh.updated;
  } catch (error) {
    totals.errors += 1;
    logger.error('Member commitment-status refresh failed; next BE-08 scan will retry', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return totals;
}
