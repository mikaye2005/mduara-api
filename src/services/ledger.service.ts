import type { PoolClient } from 'pg';
import {
  LedgerBusinessLogic,
  type DepositOperation,
  type LedgerEntry,
  type LedgerOperationResult,
  type LoanDisbursementOperation,
  type MemberPayoutOperation,
  type PayoutOperation,
  type TransferOperation,
  InsufficientTreasuryFundsError,
  TreasuryNotFoundError,
  IdempotencyConflictError,
} from '../shared/business-logic';

export type {
  DepositOperation,
  LedgerEntry,
  LedgerOperationResult,
  LoanDisbursementOperation,
  MemberPayoutOperation,
  PayoutOperation,
  TransferOperation,
};
export { InsufficientTreasuryFundsError, TreasuryNotFoundError, IdempotencyConflictError };

export interface ProviderTransactionRecord {
  reference: string;
  amount: bigint;
  currency?: string;
  occurredAt?: Date;
}

export type ReconciliationItemStatus =
  | 'matched'
  | 'missing_ledger'
  | 'missing_provider'
  | 'amount_mismatch'
  | 'currency_mismatch';

export interface ReconcileProviderWindowParams {
  provider: string;
  windowStart: Date;
  windowEnd: Date;
  records: readonly ProviderTransactionRecord[];
}

export interface ReconciliationResult {
  runId: string;
  matched: number;
  mismatched: number;
  items: Array<{
    reference: string;
    status: ReconciliationItemStatus;
    providerAmount?: bigint;
    ledgerAmount?: bigint;
    providerCurrency?: string;
    ledgerCurrency?: string;
  }>;
}

interface LedgerCandidateRow {
  id: string;
  reference: string;
  ledger_amount: string;
  ledger_currency: string;
}

export class LedgerService extends LedgerBusinessLogic {
  /**
   * Reconciles a provider-supplied window without coupling the ledger to a specific vendor SDK.
   * A future M-Pesa/bank adapter only needs to fetch provider records and pass them here.
   */
  async reconcileProviderWindow(params: ReconcileProviderWindowParams): Promise<ReconciliationResult> {
    if (!params.provider.trim()) throw new Error('Provider name is required');
    if (!(params.windowStart < params.windowEnd)) throw new Error('Reconciliation windowStart must be before windowEnd');

    const seen = new Set<string>();
    for (const record of params.records) {
      if (!record.reference.trim()) throw new Error('Provider transaction reference is required');
      if (record.amount <= 0n) throw new Error('Provider transaction amount must be greater than zero');
      if (seen.has(record.reference)) throw new Error(`Duplicate provider reference in reconciliation input: ${record.reference}`);
      seen.add(record.reference);
    }

    return this.transaction(async (client) => reconcileWindow(client, params), {
      isolationLevel: 'REPEATABLE READ',
      maxRetries: 2,
    });
  }
}

async function reconcileWindow(client: PoolClient, params: ReconcileProviderWindowParams): Promise<ReconciliationResult> {
  const run = await client.query<{ id: string }>(
    `INSERT INTO ledger_reconciliation_runs (provider, window_start, window_end, provider_record_count)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [params.provider.trim(), params.windowStart, params.windowEnd, params.records.length],
  );
  const runId = run.rows[0].id;

  const ledger = await client.query<LedgerCandidateRow>(
    `SELECT lt.id, lt.reference,
            SUM(CASE WHEN le.side = 'debit' THEN le.amount ELSE 0 END)::text AS ledger_amount,
            MIN(le.currency)::text AS ledger_currency
       FROM ledger_transactions lt
       JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
      WHERE lt.created_at >= $1 AND lt.created_at < $2
        AND COALESCE(lt.metadata->>'provider', '') = $3
      GROUP BY lt.id, lt.reference`,
    [params.windowStart, params.windowEnd, params.provider.trim()],
  );

  const ledgerByReference = new Map(ledger.rows.map((row) => [row.reference, row]));
  const providerByReference = new Map(params.records.map((record) => [record.reference, record]));
  const references = [...new Set([...ledgerByReference.keys(), ...providerByReference.keys()])].sort();
  const items: ReconciliationResult['items'] = [];

  for (const reference of references) {
    const ledgerRow = ledgerByReference.get(reference);
    const providerRow = providerByReference.get(reference);
    let status: ReconciliationItemStatus;

    if (!ledgerRow) status = 'missing_ledger';
    else if (!providerRow) status = 'missing_provider';
    else if (BigInt(ledgerRow.ledger_amount) !== providerRow.amount) status = 'amount_mismatch';
    else if (ledgerRow.ledger_currency !== (providerRow.currency ?? 'KES')) status = 'currency_mismatch';
    else status = 'matched';

    const item = {
      reference,
      status,
      providerAmount: providerRow?.amount,
      ledgerAmount: ledgerRow ? BigInt(ledgerRow.ledger_amount) : undefined,
      providerCurrency: providerRow?.currency ?? (providerRow ? 'KES' : undefined),
      ledgerCurrency: ledgerRow?.ledger_currency,
    };
    items.push(item);

    await client.query(
      `INSERT INTO ledger_reconciliation_items
       (run_id, ledger_transaction_id, provider_reference, status, provider_amount, ledger_amount,
        provider_currency, ledger_currency, provider_occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        runId,
        ledgerRow?.id ?? null,
        reference,
        status,
        item.providerAmount?.toString() ?? null,
        item.ledgerAmount?.toString() ?? null,
        item.providerCurrency ?? null,
        item.ledgerCurrency ?? null,
        providerRow?.occurredAt ?? null,
      ],
    );
  }

  const matched = items.filter((item) => item.status === 'matched').length;
  const mismatched = items.length - matched;
  await client.query(
    `UPDATE ledger_reconciliation_runs
        SET matched_count = $2, mismatch_count = $3, completed_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [runId, matched, mismatched],
  );

  return { runId, matched, mismatched, items };
}


export const ledgerService = new LedgerService();
