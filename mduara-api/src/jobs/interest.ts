import type { Pool, PoolClient } from 'pg';
import { percentageFee } from '../services/financial-math';
import { recordMemberCharge } from '../services/charge-ledger.service';
import { workerTransaction } from './database';

/** Caller must hold the loan row lock. Also used before a repayment can close a loan. */
export async function accrueLoanInterest(client: PoolClient, loanId: string, now: Date, timezone: string, maxCycles = 100): Promise<number> {
  let processed = 0;
  while (processed < maxCycles) {
    const result = await client.query<{
      chama_id: string; member_id: string; principal_amount: string; interest_rate: string;
      next_interest_date: string; interest_cycle_days: number; currency: string; outstanding: string;
    }>(
      `SELECT l.chama_id, l.member_id, l.principal_amount::text, l.interest_rate::text,
              l.next_interest_date::text, l.interest_cycle_days, g.currency,
              (l.total_due - COALESCE((SELECT SUM(amount) FROM loan_repayments
                WHERE loan_id = l.id AND status = 'confirmed'), 0))::text AS outstanding
       FROM loans l JOIN chamas g ON g.id = l.chama_id AND g.status = 'active'
       WHERE l.id = $1 AND l.status IN ('active', 'partially_repaid') AND l.interest_cycle_days IS NOT NULL
         AND l.next_interest_date <= ($2::timestamptz AT TIME ZONE $3)::date
         AND (l.due_date IS NULL OR l.next_interest_date <= l.due_date)`, [loanId, now, timezone],
    );
    const loan = result.rows[0];
    if (!loan || BigInt(loan.outstanding) <= 0n) break;
    const fee = percentageFee(BigInt(loan.principal_amount), loan.interest_rate);
    const claim = await client.query(
      `INSERT INTO loan_interest_accruals (loan_id, cycle_date, amount) VALUES ($1, $2, $3)
       ON CONFLICT (loan_id, cycle_date) DO NOTHING RETURNING id`, [loanId, loan.next_interest_date, fee.toString()],
    );
    if (claim.rowCount && fee > 0n) {
      const transactionId = await recordMemberCharge(client, {
        kind: 'loan_interest', reference: `loan-interest:${loanId}:${loan.next_interest_date}`,
        chamaId: loan.chama_id, memberId: loan.member_id, amount: fee, currency: loan.currency,
        metadata: { loanId, cycleDate: loan.next_interest_date, principal: loan.principal_amount,
          interestRate: loan.interest_rate, cycleDays: loan.interest_cycle_days, method: 'simple' },
      });
      await client.query('UPDATE loan_interest_accruals SET ledger_transaction_id = $2 WHERE id = $1', [claim.rows[0].id, transactionId]);
    }
    await client.query(
      `UPDATE loans SET total_due = total_due + $2::bigint,
         next_interest_date = CASE WHEN due_date IS NOT NULL AND next_interest_date + interest_cycle_days > due_date
           THEN NULL ELSE next_interest_date + interest_cycle_days END WHERE id = $1`,
      [loanId, claim.rowCount ? fee.toString() : '0'],
    );
    processed += 1;
  }
  return processed;
}

export async function processLoanInterest(pool: Pool, id: string, now: Date, timezone: string): Promise<number> {
  return workerTransaction(pool, async (client) => {
    const lock = await client.query('SELECT id FROM loans WHERE id = $1 FOR NO KEY UPDATE SKIP LOCKED', [id]);
    return lock.rowCount ? accrueLoanInterest(client, id, now, timezone, 1) : 0;
  });
}
