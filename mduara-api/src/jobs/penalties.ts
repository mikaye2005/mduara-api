import type { Pool, PoolClient } from 'pg';
import { contributionPenalty } from '../services/financial-math';
import { recordMemberCharge } from '../services/charge-ledger.service';
import { workerTransaction } from './database';

export const PENALTY_RECONCILIATION_PROVIDER = 'mpesa';

interface ContributionAssessmentRow {
  id: string;
  chama_id: string;
  member_id: string;
  expected_amount: string;
  currency: string;
  due_date: string;
  created_at: Date;
  rule_id: string | null;
  late_fee_type: 'flat' | 'percentage';
  late_fee: string;
  late_fee_percentage: string;
  chama_rule_id: string | null;
  default_after_consecutive_misses: number;
  reconciliation_window_start: Date;
  deadline: Date;
}

interface LiveCommitmentRow {
  id: string;
  state: 'held' | 'at_risk' | 'default_triggered';
}

/**
 * Assess one contribution after its grace deadline.
 *
 * BE-08 is intentionally fail-closed: the contribution is not marked checked,
 * penalised, or counted as a miss until a completed clean provider
 * reconciliation covers the whole due-date -> grace-deadline window.
 */
export async function assessContribution(
  pool: Pool,
  id: string,
  now: Date,
  timezone: string,
  reconciliationProvider = PENALTY_RECONCILIATION_PROVIDER,
): Promise<boolean> {
  return workerTransaction(pool, async (client) => {
    const result = await client.query<ContributionAssessmentRow>(
      `SELECT c.id, c.chama_id, c.member_id, c.expected_amount::text, c.due_date::text,
              c.created_at, g.currency,
              r.id AS rule_id, r.late_fee_type, r.late_fee::text, r.late_fee_percentage::text,
              constitution.id AS chama_rule_id,
              COALESCE(constitution.default_after_consecutive_misses, 3)::int AS default_after_consecutive_misses,
              c.due_date::timestamp AT TIME ZONE $3 AS reconciliation_window_start,
              (c.due_date + 1 + COALESCE(r.grace_period_days, 0))::timestamp AT TIME ZONE $3 AS deadline
       FROM contributions c
       JOIN chamas g ON g.id = c.chama_id AND g.status = 'active'
       JOIN chama_members m ON m.id = c.member_id AND m.chama_id = c.chama_id AND m.membership_status = 'active'
       LEFT JOIN LATERAL (
         SELECT * FROM contribution_rules r
          WHERE r.chama_id = c.chama_id AND r.effective_from <= c.due_date
            AND (r.effective_to IS NULL OR r.effective_to >= c.due_date)
          ORDER BY r.effective_from DESC, r.id DESC LIMIT 1
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT cr.id, cr.default_after_consecutive_misses
           FROM membership_constitution_acceptances a
           JOIN chama_rules cr ON cr.id = a.chama_rule_id AND cr.chama_id = a.chama_id
          WHERE a.membership_id = c.member_id AND a.chama_id = c.chama_id
          ORDER BY a.accepted_at DESC, cr.version DESC
          LIMIT 1
       ) constitution ON true
       WHERE c.id = $1 AND c.penalty_checked_at IS NULL AND c.status <> 'waived'
         AND (c.due_date + 1 + COALESCE(r.grace_period_days, 0))::timestamp AT TIME ZONE $3 <= $2
       FOR NO KEY UPDATE OF c SKIP LOCKED`,
      [id, now, timezone],
    );
    const row = result.rows[0];
    if (!row) return false;

    const reconciled = await hasCleanReconciliation(
      client,
      reconciliationProvider,
      row.reconciliation_window_start,
      row.deadline,
    );
    if (!reconciled) return false;

    const payments = await client.query<{ on_time: string; total: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE paid_at < $2), 0)::text AS on_time,
              COALESCE(SUM(amount), 0)::text AS total
         FROM contribution_payments
        WHERE contribution_id = $1 AND status = 'confirmed'`,
      [id, row.deadline],
    );

    const expected = BigInt(row.expected_amount);
    const onTime = BigInt(payments.rows[0].on_time);
    const total = BigInt(payments.rows[0].total);
    const unpaidAtDeadline = expected > onTime ? expected - onTime : 0n;
    const missed = unpaidAtDeadline > 0n;
    const missCount = missed ? await nextConsecutiveMissCount(client, row) : 0;
    const fee = row.rule_id && missed
      ? contributionPenalty(unpaidAtDeadline, row.late_fee_type, row.late_fee, row.late_fee_percentage)
      : 0n;

    if (fee > 0n) {
      const transactionId = await recordMemberCharge(client, {
        kind: 'contribution_penalty',
        reference: `contribution-penalty:${id}`,
        chamaId: row.chama_id,
        memberId: row.member_id,
        amount: fee,
        currency: row.currency,
        metadata: {
          contributionId: id,
          ruleId: row.rule_id,
          chamaRuleId: row.chama_rule_id,
          deadline: row.deadline.toISOString(),
          reconciliationProvider,
          reconciliationWindowStart: row.reconciliation_window_start.toISOString(),
          unpaidAtDeadline: unpaidAtDeadline.toString(),
          feeType: row.late_fee_type,
          flatFee: row.late_fee,
          percentage: row.late_fee_percentage,
          consecutiveMissCount: missCount,
        },
      });
      await client.query(
        `INSERT INTO penalties (chama_id, member_id, contribution_id, amount, reason, ledger_transaction_id)
         VALUES ($1, $2, $3, $4, 'Late contribution', $5)`,
        [row.chama_id, row.member_id, id, fee.toString(), transactionId],
      );
    }

    await client.query(
      `UPDATE contributions
          SET penalty_checked_at = $2,
              missed_at = CASE WHEN $4::boolean THEN $5 ELSE NULL END,
              consecutive_miss_count = $6,
              status = CASE WHEN expected_amount > $3::bigint THEN 'late'::contribution_status ELSE status END
        WHERE id = $1`,
      [id, now, total.toString(), missed, row.deadline, missCount],
    );

    if (missed) await applyMissEscalation(client, row, missCount);
    return fee > 0n;
  });
}

async function hasCleanReconciliation(
  client: PoolClient,
  provider: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
       FROM ledger_reconciliation_runs
      WHERE lower(provider) = lower($1)
        AND completed_at IS NOT NULL
        AND mismatch_count = 0
        AND window_start <= $2
        AND window_end >= $3
      ORDER BY completed_at DESC, id DESC
      LIMIT 1`,
    [provider.trim(), windowStart, windowEnd],
  );
  return result.rowCount > 0;
}

async function nextConsecutiveMissCount(client: PoolClient, row: ContributionAssessmentRow): Promise<number> {
  const previous = await client.query<{ consecutive_miss_count: number }>(
    `SELECT consecutive_miss_count
       FROM contributions
      WHERE member_id = $1
        AND penalty_checked_at IS NOT NULL
        AND (due_date, created_at, id) < ($2::date, $3::timestamptz, $4::uuid)
      ORDER BY due_date DESC, created_at DESC, id DESC
      LIMIT 1`,
    [row.member_id, row.due_date, row.created_at, row.id],
  );
  return Math.max(0, Number(previous.rows[0]?.consecutive_miss_count ?? 0)) + 1;
}

async function applyMissEscalation(
  client: PoolClient,
  row: ContributionAssessmentRow,
  missCount: number,
): Promise<void> {
  const threshold = Math.max(1, Number(row.default_after_consecutive_misses || 3));
  const referenceBase = `contribution-miss:${row.id}:${missCount}`;

  await client.query(
    `INSERT INTO audit_logs (category, action, actor_role, chama_id, entity_type, entity_id, payload)
     VALUES ('financial', 'contribution_miss_recorded', 'system', $1, 'contribution', $2,
             jsonb_build_object(
               'membershipId', $3::text,
               'consecutiveMissCount', $4::int,
               'defaultThreshold', $5::int,
               'chamaRuleId', $6::text,
               'deadline', $7::text
             ))`,
    [row.chama_id, row.id, row.member_id, missCount, threshold, row.chama_rule_id, row.deadline.toISOString()],
  );

  const commitmentResult = await client.query<LiveCommitmentRow>(
    `SELECT id, state::text AS state
       FROM commitment_deposits
      WHERE membership_id = $1
        AND state IN ('held', 'at_risk', 'default_triggered')
      ORDER BY cycle_no DESC, created_at DESC
      LIMIT 1
      FOR UPDATE`,
    [row.member_id],
  );
  let commitment = commitmentResult.rows[0];

  if (commitment?.state === 'held') {
    await client.query(
      `UPDATE commitment_deposits
          SET state = 'at_risk', at_risk_at = COALESCE(at_risk_at, CURRENT_TIMESTAMP),
              last_transition_source = 'be08_penalty_worker',
              last_transition_reference = $2,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND state = 'held'`,
      [commitment.id, `${referenceBase}:at-risk`],
    );
    commitment = { ...commitment, state: 'at_risk' };
  }

  if (missCount < threshold) return;

  if (commitment?.state === 'at_risk') {
    await client.query(
      `UPDATE commitment_deposits
          SET state = 'default_triggered', default_triggered_at = COALESCE(default_triggered_at, CURRENT_TIMESTAMP),
              last_transition_source = 'be08_penalty_worker',
              last_transition_reference = $2,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND state = 'at_risk'`,
      [commitment.id, `${referenceBase}:default`],
    );
  }

  await client.query(
    `UPDATE chama_members
        SET membership_status = 'defaulted', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND membership_status = 'active'`,
    [row.member_id],
  );

  await client.query(
    `INSERT INTO audit_logs (category, action, actor_role, chama_id, entity_type, entity_id, payload)
     VALUES ('financial', 'contribution_default_triggered', 'system', $1, 'chama_member', $2,
             jsonb_build_object(
               'contributionId', $3::text,
               'consecutiveMissCount', $4::int,
               'defaultThreshold', $5::int,
               'chamaRuleId', $6::text,
               'commitmentId', $7::text
             ))`,
    [row.chama_id, row.member_id, row.id, missCount, threshold, row.chama_rule_id, commitment?.id ?? null],
  );
}
