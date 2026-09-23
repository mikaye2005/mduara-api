import type { PoolClient } from 'pg';

interface Charge {
  kind: 'contribution_penalty' | 'loan_interest';
  reference: string;
  chamaId: string;
  memberId: string;
  amount: bigint;
  currency: string;
  metadata: Record<string, unknown>;
}

/** Accrued charges are receivables, not cash. Use the caller's transaction. */
export async function recordMemberCharge(client: PoolClient, charge: Charge): Promise<string> {
  if (charge.amount <= 0n) throw new Error('A ledger charge must be positive');
  const journal = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions (operation_type, reference, metadata)
     VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [charge.kind, charge.reference, JSON.stringify(charge.metadata)],
  );
  const accounts = charge.kind === 'contribution_penalty'
    ? ['member_penalty_receivable', 'penalty_income'] : ['member_interest_receivable', 'interest_income'];
  await client.query(
    `INSERT INTO ledger_entries (ledger_transaction_id, chama_id, member_id, account, side, amount, currency)
     VALUES ($1, $2, $3, $4, 'debit', $6, $7), ($1, $2, NULL, $5, 'credit', $6, $7)`,
    [journal.rows[0].id, charge.chamaId, charge.memberId, ...accounts, charge.amount.toString(), charge.currency],
  );
  return journal.rows[0].id;
}
