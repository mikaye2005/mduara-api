import type { PoolClient } from 'pg';
import { BusinessBase } from './business_base';

type LedgerAccount =
	| 'chama_treasury'
	| 'member_contribution'
	| 'member_payout'
	| 'external_clearing'
	| 'member_penalty_receivable'
	| 'penalty_income'
	| 'member_interest_receivable'
	| 'interest_income'
	| 'commitment_escrow'
	| 'commitment_forfeiture'
	| 'member_loan_principal'
	| 'loan_default_recovery'
	| 'platform_fee_revenue';
type LedgerSide = 'debit' | 'credit';
type OperationType = 'deposit' | 'payout' | 'transfer';

export interface LedgerEntry {
	chamaId: string;
	account: LedgerAccount;
	side: LedgerSide;
	amount: bigint;
}

export interface LedgerOperationResult {
	ledgerTransactionId: string;
	balances: Record<string, bigint>;
	/** True when the exact same idempotency reference was already committed. */
	replayed: boolean;
}

interface BaseOperation {
	reference: string;
	initiatedBy?: string;
	currency?: string;
	metadata?: Record<string, unknown>;
}

export interface DepositOperation extends BaseOperation {
	chamaId: string;
	amount: bigint;
}

export interface PayoutOperation extends BaseOperation {
	chamaId: string;
	amount: bigint;
}

export interface MemberPayoutOperation extends BaseOperation {
	chamaId: string;
	memberId: string;
	amount: bigint;
}

export interface TransferOperation extends BaseOperation {
	fromChamaId: string;
	toChamaId: string;
	amount: bigint;
}

export class InsufficientTreasuryFundsError extends Error {
	constructor(chamaId: string) {
		super(`Chama ${chamaId} has insufficient treasury funds`);
		this.name = 'InsufficientTreasuryFundsError';
	}
}

export class TreasuryNotFoundError extends Error {
	constructor(chamaId: string) {
		super(`Chama ${chamaId} was not found`);
		this.name = 'TreasuryNotFoundError';
	}
}

export class IdempotencyConflictError extends Error {
	constructor(reference: string) {
		super(`Ledger reference ${reference} was already used for a different financial instruction`);
		this.name = 'IdempotencyConflictError';
	}
}

interface TreasuryRow {
	id: string;
	pooled_amount: string;
}

interface PreparedOperation {
	type: OperationType;
	reference: string;
	initiatedBy?: string;
	currency: string;
	metadata?: Record<string, unknown>;
	deltas: Map<string, bigint>;
	entries: LedgerEntry[];
}

export class LedgerBusinessLogic extends BusinessBase {
	async recordDeposit(operation: DepositOperation): Promise<LedgerOperationResult> {
		assertPositiveAmount(operation.amount);

		return this.execute({
			type: 'deposit',
			reference: operation.reference,
			initiatedBy: operation.initiatedBy,
			currency: operation.currency ?? 'KES',
			metadata: operation.metadata,
			deltas: new Map([[operation.chamaId, operation.amount]]),
			entries: [
				treasuryEntry(operation.chamaId, 'debit', operation.amount),
				counterEntry(operation.chamaId, 'member_contribution', 'credit', operation.amount),
			],
		});
	}

	async recordPayout(operation: PayoutOperation): Promise<LedgerOperationResult> {
		assertPositiveAmount(operation.amount);

		return this.execute({
			type: 'payout',
			reference: operation.reference,
			initiatedBy: operation.initiatedBy,
			currency: operation.currency ?? 'KES',
			metadata: operation.metadata,
			deltas: new Map([[operation.chamaId, -operation.amount]]),
			entries: [
				counterEntry(operation.chamaId, 'member_payout', 'debit', operation.amount),
				treasuryEntry(operation.chamaId, 'credit', operation.amount),
			],
		});
	}

	async recordMemberPayoutWithinTransaction(
		client: PoolClient,
		operation: MemberPayoutOperation,
	): Promise<LedgerOperationResult> {
		assertPositiveAmount(operation.amount);
		return this.executeWithinTransaction(client, {
			type: 'payout',
			reference: operation.reference,
			initiatedBy: operation.initiatedBy,
			currency: operation.currency ?? 'KES',
			metadata: operation.metadata,
			deltas: new Map([[operation.chamaId, -operation.amount]]),
			entries: [
				memberCounterEntry(operation.chamaId, operation.memberId, 'member_payout', 'debit', operation.amount),
				treasuryEntry(operation.chamaId, 'credit', operation.amount),
			],
		});
	}

	async recordTransfer(operation: TransferOperation): Promise<LedgerOperationResult> {
		assertPositiveAmount(operation.amount);
		if (operation.fromChamaId === operation.toChamaId) {
			throw new Error('A transfer requires two different chamas');
		}

		return this.execute({
			type: 'transfer',
			reference: operation.reference,
			initiatedBy: operation.initiatedBy,
			currency: operation.currency ?? 'KES',
			metadata: operation.metadata,
			deltas: new Map([
				[operation.fromChamaId, -operation.amount],
				[operation.toChamaId, operation.amount],
			]),
			entries: [
				treasuryEntry(operation.fromChamaId, 'credit', operation.amount),
				treasuryEntry(operation.toChamaId, 'debit', operation.amount),
			],
		});
	}

	private async execute(operation: PreparedOperation): Promise<LedgerOperationResult> {
		validateReference(operation.reference);

		return this.transaction(async (client) => {
			// Serialize all attempts using the same idempotency key, including concurrent requests.
			// pg_advisory_xact_lock is released automatically on commit/rollback.
			await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [operation.reference]);

			const replay = await findExistingOperation(client, operation);
			if (replay) return replay;

			const treasuries = await lockTreasuries(client, [...operation.deltas.keys()]);
			const balances = calculateBalances(treasuries, operation.deltas);
			const ledgerTransactionId = await insertLedgerTransaction(client, operation);

			await insertLedgerEntries(client, ledgerTransactionId, operation.entries, operation.currency);
			await client.query("SELECT set_config('app.ledger_transaction_id', $1, true)", [ledgerTransactionId]);

			for (const [chamaId, balance] of balances) {
				await client.query('UPDATE chamas SET pooled_amount = $1 WHERE id = $2', [balance.toString(), chamaId]);
			}

			return {
				ledgerTransactionId,
				balances: Object.fromEntries(balances),
				replayed: false,
			};
		});
	}
}

function treasuryEntry(chamaId: string, side: LedgerSide, amount: bigint): LedgerEntry {
	return { chamaId, account: 'chama_treasury', side, amount };
}

function counterEntry(
	chamaId: string,
	account: Exclude<LedgerAccount, 'chama_treasury'>,
	side: LedgerSide,
	amount: bigint,
): LedgerEntry {
	return { chamaId, account, side, amount };
}

function assertPositiveAmount(amount: bigint): void {
	if (amount <= 0n) throw new Error('Amount must be greater than zero');
}

function validateReference(reference: string): void {
	if (!reference.trim()) throw new Error('A non-empty idempotency reference is required');
}

async function lockTreasuries(client: PoolClient, chamaIds: string[]): Promise<TreasuryRow[]> {
	const uniqueIds = [...new Set(chamaIds)].sort();
	const result = await client.query<TreasuryRow>(
		`SELECT id, pooled_amount
		 FROM chamas
		 WHERE id = ANY($1::uuid[])
		 ORDER BY id
		 FOR UPDATE`,
		[uniqueIds],
	);

	if (result.rowCount !== uniqueIds.length) {
		const found = new Set(result.rows.map((row) => row.id));
		throw new TreasuryNotFoundError(uniqueIds.find((id) => !found.has(id))!);
	}

	return result.rows;
}

function calculateBalances(
	treasuries: TreasuryRow[],
	deltas: Map<string, bigint>,
): Map<string, bigint> {
	const balances = new Map<string, bigint>();

	for (const treasury of treasuries) {
		const newBalance = BigInt(treasury.pooled_amount) + (deltas.get(treasury.id) ?? 0n);
		if (newBalance < 0n) throw new InsufficientTreasuryFundsError(treasury.id);
		balances.set(treasury.id, newBalance);
	}

	return balances;
}

async function insertLedgerTransaction(
	client: PoolClient,
	operation: PreparedOperation,
): Promise<string> {
	const result = await client.query<{ id: string }>(
		`INSERT INTO ledger_transactions (operation_type, reference, initiated_by, metadata)
		 VALUES ($1, $2, $3, $4::jsonb)
		 RETURNING id`,
		[operation.type, operation.reference, operation.initiatedBy ?? null, JSON.stringify(operation.metadata ?? {})],
	);
	return result.rows[0].id;
}

async function insertLedgerEntries(
	client: PoolClient,
	ledgerTransactionId: string,
	entries: LedgerEntry[],
	currency: string,
): Promise<void> {
	for (const entry of entries) {
		await client.query(
			`INSERT INTO ledger_entries
				 (ledger_transaction_id, chama_id, account, side, amount, currency)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[ledgerTransactionId, entry.chamaId, entry.account, entry.side, entry.amount.toString(), currency],
		);
	}
}


interface ExistingLedgerTransactionRow {
	id: string;
	operation_type: string;
}

interface ExistingLedgerEntryRow {
	chama_id: string;
	account: LedgerAccount;
	side: LedgerSide;
	amount: string;
	currency: string;
}

async function findExistingOperation(
	client: PoolClient,
	operation: PreparedOperation,
): Promise<LedgerOperationResult | null> {
	const transaction = await client.query<ExistingLedgerTransactionRow>(
		`SELECT id, operation_type FROM ledger_transactions WHERE reference = $1`,
		[operation.reference],
	);
	if (!transaction.rowCount) return null;

	const existing = transaction.rows[0];
	const entries = await client.query<ExistingLedgerEntryRow>(
		`SELECT chama_id, account, side, amount, currency
		 FROM ledger_entries
		 WHERE ledger_transaction_id = $1
		 ORDER BY chama_id, account, side, amount, currency`,
		[existing.id],
	);

	if (existing.operation_type !== operation.type || !sameEntries(entries.rows, operation.entries, operation.currency)) {
		throw new IdempotencyConflictError(operation.reference);
	}

	const chamaIds = [...new Set(entries.rows.map((entry) => entry.chama_id))].sort();
	const balanceRows = chamaIds.length
		? await client.query<{ id: string; pooled_amount: string }>(
			`SELECT id, pooled_amount FROM chamas WHERE id = ANY($1::uuid[]) ORDER BY id`,
			[chamaIds],
		)
		: { rows: [] as { id: string; pooled_amount: string }[] };

	return {
		ledgerTransactionId: existing.id,
		balances: Object.fromEntries(balanceRows.rows.map((row) => [row.id, BigInt(row.pooled_amount)])),
		replayed: true,
	};
}

function sameEntries(existing: ExistingLedgerEntryRow[], expected: LedgerEntry[], currency: string): boolean {
	const normalizeExisting = existing
		.map((entry) => `${entry.chama_id}|${entry.account}|${entry.side}|${entry.amount}|${entry.currency}`)
		.sort();
	const normalizeExpected = expected
		.map((entry) => `${entry.chamaId}|${entry.account}|${entry.side}|${entry.amount.toString()}|${currency}`)
		.sort();
	return normalizeExisting.length === normalizeExpected.length
		&& normalizeExisting.every((value, index) => value === normalizeExpected[index]);
}
