import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { env } from '../config/env';
import { NotFoundError } from '../utils/errors';

export type AnalyticsRange = '1m' | '3m' | '6m' | '1y' | 'all';

type BucketUnit = 'day' | 'week' | 'month';

interface BucketRow extends QueryResultRow {
  bucket: string;
  value: string;
  secondary?: string;
}

export class AnalyticsService {
  constructor(private readonly db: Pool = pool) {}

  async getChamaAnalytics(chamaId: string, range: AnalyticsRange = '6m', now = new Date()) {
    const chama = (await this.db.query<{ id: string; currency: string }>(
      'SELECT id, currency FROM chamas WHERE id = $1',
      [chamaId],
    )).rows[0];
    if (!chama) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');

    const { start, bucket } = rangeWindow(range, now);
    const [growth, compliance, repayments] = await Promise.all([
      this.capitalGrowth(chamaId, start, bucket),
      this.contributionCompliance(chamaId, start, bucket),
      this.loanRepaymentRatios(chamaId, start, bucket),
    ]);

    return {
      chamaId,
      currency: chama.currency,
      range,
      bucket,
      generatedAt: now.toISOString(),
      growth,
      contributionCompliance: compliance,
      loanRepaymentRatios: repayments,
    };
  }

  private async capitalGrowth(chamaId: string, start: Date | null, bucket: BucketUnit) {
    const opening = start
      ? BigInt((await this.db.query<{ value: string }>(
          `SELECT COALESCE(SUM(CASE WHEN le.side = 'debit' THEN le.amount ELSE -le.amount END), 0)::text AS value
             FROM ledger_entries le
             JOIN ledger_transactions lt ON lt.id = le.ledger_transaction_id
            WHERE le.chama_id = $1 AND le.account = 'chama_treasury' AND lt.created_at < $2`,
          [chamaId, start],
        )).rows[0]?.value ?? '0')
      : 0n;

    const rows = await this.db.query<BucketRow>(
      `SELECT date_trunc($2, lt.created_at AT TIME ZONE $4)::date::text AS bucket,
              COALESCE(SUM(CASE WHEN le.side = 'debit' THEN le.amount ELSE -le.amount END), 0)::text AS value
         FROM ledger_entries le
         JOIN ledger_transactions lt ON lt.id = le.ledger_transaction_id
        WHERE le.chama_id = $1
          AND le.account = 'chama_treasury'
          AND ($3::timestamptz IS NULL OR lt.created_at >= $3)
        GROUP BY 1 ORDER BY 1`,
      [chamaId, bucket, start, env.SCHEDULER_TIMEZONE],
    );

    let running = opening;
    return rows.rows.map((row) => {
      running += BigInt(row.value);
      return { bucket: row.bucket, netChange: row.value, balance: running.toString() };
    });
  }

  private async contributionCompliance(chamaId: string, start: Date | null, bucket: BucketUnit) {
    const rows = await this.db.query<{ bucket: string; total: number; compliant: number }>(
      `WITH obligations AS (
         SELECT c.id, c.expected_amount, c.due_date,
                (c.due_date + 1 + COALESCE(r.grace_period_days, 0))::timestamp AT TIME ZONE $4 AS deadline
           FROM contributions c
           LEFT JOIN LATERAL (
             SELECT cr.grace_period_days
               FROM contribution_rules cr
              WHERE cr.chama_id = c.chama_id
                AND cr.effective_from <= c.due_date
                AND (cr.effective_to IS NULL OR cr.effective_to >= c.due_date)
              ORDER BY cr.effective_from DESC, cr.id DESC LIMIT 1
           ) r ON true
          WHERE c.chama_id = $1
            AND c.status <> 'waived'
            AND ($3::timestamptz IS NULL OR c.due_date >= $3::date)
       ), paid AS (
         SELECT o.id, COALESCE(SUM(cp.amount) FILTER (WHERE cp.status = 'confirmed' AND cp.paid_at < o.deadline), 0) AS paid_on_time
           FROM obligations o
           LEFT JOIN contribution_payments cp ON cp.contribution_id = o.id
          GROUP BY o.id
       )
       SELECT date_trunc($2, o.due_date::timestamp AT TIME ZONE $4)::date::text AS bucket,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE p.paid_on_time >= o.expected_amount)::int AS compliant
         FROM obligations o JOIN paid p ON p.id = o.id
        GROUP BY 1 ORDER BY 1`,
      [chamaId, bucket, start, env.SCHEDULER_TIMEZONE],
    );

    return rows.rows.map((row) => ({
      bucket: row.bucket,
      obligations: Number(row.total),
      compliant: Number(row.compliant),
      ratePct: Number(row.total) === 0 ? 0 : Number(((Number(row.compliant) * 100) / Number(row.total)).toFixed(2)),
    }));
  }

  private async loanRepaymentRatios(chamaId: string, start: Date | null, bucket: BucketUnit) {
    const rows = await this.db.query<{ bucket: string; due: string; repaid: string }>(
      `SELECT date_trunc($2, COALESCE(l.disbursed_at, l.created_at) AT TIME ZONE $4)::date::text AS bucket,
              COALESCE(SUM(l.total_due), 0)::text AS due,
              COALESCE(SUM((
                SELECT COALESCE(SUM(lr.amount), 0)
                  FROM loan_repayments lr
                 WHERE lr.loan_id = l.id AND lr.status = 'confirmed'
              )), 0)::text AS repaid
         FROM loans l
        WHERE l.chama_id = $1
          AND l.status NOT IN ('pending','awaiting_guarantors','pending_admin_approval','partially_approved','approved','rejected','cancelled')
          AND ($3::timestamptz IS NULL OR COALESCE(l.disbursed_at, l.created_at) >= $3)
        GROUP BY 1 ORDER BY 1`,
      [chamaId, bucket, start, env.SCHEDULER_TIMEZONE],
    );

    return rows.rows.map((row) => {
      const due = BigInt(row.due);
      const repaid = BigInt(row.repaid);
      return {
        bucket: row.bucket,
        totalDue: due.toString(),
        repaid: repaid.toString(),
        ratioPct: due === 0n ? 0 : Number((repaid * 10_000n) / due) / 100,
      };
    });
  }
}

function rangeWindow(range: AnalyticsRange, now: Date): { start: Date | null; bucket: BucketUnit } {
  const copy = new Date(now);
  if (range === 'all') return { start: null, bucket: 'month' };
  if (range === '1m') { copy.setUTCMonth(copy.getUTCMonth() - 1); return { start: copy, bucket: 'day' }; }
  if (range === '3m') { copy.setUTCMonth(copy.getUTCMonth() - 3); return { start: copy, bucket: 'week' }; }
  if (range === '6m') { copy.setUTCMonth(copy.getUTCMonth() - 6); return { start: copy, bucket: 'month' }; }
  copy.setUTCFullYear(copy.getUTCFullYear() - 1);
  return { start: copy, bucket: 'month' };
}

export const analyticsService = new AnalyticsService();
