import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/client';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableEntityError } from '../utils/errors';

interface CommitmentRow extends QueryResultRow {
  id: string;
  chama_id: string;
  user_id: string;
  membership_id: string;
  application_id: string;
  chama_rule_id: string;
  rule_version: number;
  amount: string;
  state: CommitmentState;
  provider: string | null;
  provider_reference: string | null;
  terminal_provider: string | null;
  terminal_provider_reference: string | null;
  last_transition_source: string;
  last_transition_reference: string;
  forfeited_amount: string;
  refunded_amount: string;
  hold_ledger_transaction_id: string | null;
  terminal_ledger_transaction_id: string | null;
  held_at: string | null;
  at_risk_at: string | null;
  default_triggered_at: string | null;
  eligible_for_refund_at: string | null;
  refund_requested_at: string | null;
  refunded_at: string | null;
  forfeited_at: string | null;
  membership_status: string;
  application_status: string;
  constitution_accepted: boolean;
}

interface MembershipRow extends QueryResultRow {
  id: string;
  chama_id: string;
  user_id: string;
  membership_status: string;
  chama_rule_id: string | null;
  rule_version: number | null;
  commitment_amount: string | null;
}

export type CommitmentState =
  | 'applied'
  | 'held'
  | 'at_risk'
  | 'default_triggered'
  | 'forfeited'
  | 'partial_forfeit'
  | 'eligible_for_refund'
  | 'refund_requested'
  | 'refunded';

export interface ProviderHoldConfirmation {
  membershipId: string;
  provider: string;
  providerReference: string;
  amount: bigint;
  currency?: string;
  occurredAt?: Date;
}

export interface ProviderRefundConfirmation {
  membershipId: string;
  provider: string;
  providerReference: string;
  amount: bigint;
  currency?: string;
  occurredAt?: Date;
}

export interface CommitmentTransitionEvidence {
  membershipId: string;
  source: string;
  reference: string;
}

export interface CommitmentForfeitureInput extends CommitmentTransitionEvidence {
  amount: bigint;
}

/**
 * BE-34 commitment lifecycle.
 *
 * Commitment money is custody money, not Chama pooled savings. Financial
 * journals use external_clearing <-> commitment_escrow/commitment_forfeiture
 * only and never update chamas.pooled_amount.
 */
export class CommitmentService {
  constructor(private readonly db: Pool = pool) {}

  async getOwnCommitment(membershipId: string, userId: string) {
    const membership = await this.loadMembership(membershipId);
    this.assertOwner(membership.user_id, userId);

    const commitment = await this.findLatestCommitment(membershipId);
    if (!commitment) {
      const expectedAmount = BigInt(membership.commitment_amount ?? '0');
      return {
        membershipId,
        chamaId: membership.chama_id,
        required: expectedAmount > 0n,
        amount: expectedAmount.toString(),
        currency: 'KES' as const,
        state: expectedAmount > 0n ? 'not_initialized' : 'not_required',
        membershipStatus: membership.membership_status,
        applicationStatus: null,
        canStartSaving: membership.membership_status === 'active' && expectedAmount === 0n,
        constitution: membership.chama_rule_id
          ? { id: membership.chama_rule_id, version: Number(membership.rule_version) }
          : null,
        ledger: { holdTransactionId: null, terminalTransactionId: null },
      };
    }
    return this.mapStatus(commitment);
  }

  async getOwnContributions(membershipId: string, userId: string) {
    const membership = await this.loadMembership(membershipId);
    this.assertOwner(membership.user_id, userId);

    const rows = await this.db.query<{
      id: string;
      period_label: string;
      due_date: string;
      expected_amount: string;
      status: string;
      confirmed_paid: string;
    }>(
      `SELECT c.id, c.period_label, c.due_date::text, c.expected_amount::text,
              c.status::text,
              COALESCE(SUM(cp.amount) FILTER (WHERE cp.status = 'confirmed'), 0)::text AS confirmed_paid
         FROM contributions c
         LEFT JOIN contribution_payments cp ON cp.contribution_id = c.id
        WHERE c.member_id = $1 AND c.chama_id = $2
        GROUP BY c.id
        ORDER BY c.due_date ASC, c.created_at ASC, c.id ASC`,
      [membershipId, membership.chama_id],
    );

    let scheduledTarget = 0n;
    let paid = 0n;
    const contributions = rows.rows.map((row) => {
      const expected = BigInt(row.expected_amount);
      const confirmed = BigInt(row.confirmed_paid);
      const applied = confirmed > expected ? expected : confirmed;
      const remaining = expected > applied ? expected - applied : 0n;
      scheduledTarget += expected;
      paid += applied;
      return {
        id: row.id,
        periodLabel: row.period_label,
        dueDate: row.due_date,
        expectedAmount: expected.toString(),
        paidAmount: applied.toString(),
        remainingAmount: remaining.toString(),
        status: row.status,
      };
    });

    return {
      membershipId,
      chamaId: membership.chama_id,
      currency: 'KES' as const,
      summary: {
        scheduledTarget: scheduledTarget.toString(),
        paid: paid.toString(),
        remaining: (scheduledTarget > paid ? scheduledTarget - paid : 0n).toString(),
      },
      contributions,
    };
  }

  /** Provider/webhook/reconciliation boundary; never expose this as a client "I paid" route. */
  async confirmHoldFromProvider(input: ProviderHoldConfirmation) {
    this.assertProviderEvidence(input.provider, input.providerReference, input.amount, input.currency);
    return this.transaction(async (client) => {
      await advisoryLock(client, `commitment:hold:${input.provider}:${input.providerReference}`);
      const row = await this.requireCommitment(client, input.membershipId, true);

      if (row.state === 'held') {
        if (row.provider === input.provider && row.provider_reference === input.providerReference && BigInt(row.amount) === input.amount) {
          return { ...this.mapStatus(row), replayed: true };
        }
        throw new ConflictError('Commitment has already been confirmed by a different provider transaction');
      }
      if (row.state !== 'applied') throw new ConflictError(`Commitment cannot be held from state ${row.state}`);
      if (row.application_status !== 'commitment_pending') throw new ConflictError('Application must be commitment-pending before payment confirmation', 'COMMITMENT_NOT_PENDING');
      if (!row.constitution_accepted) throw new ConflictError('Current commitment is not backed by Constitution acceptance', 'CONSTITUTION_NOT_ACCEPTED');
      if (row.membership_status !== 'pending') throw new ConflictError('Membership must remain pending until commitment is confirmed', 'COMMITMENT_MEMBERSHIP_STATE_INVALID');
      if (BigInt(row.amount) !== input.amount) throw new UnprocessableEntityError('Provider amount does not match the required commitment');

      const reference = commitmentLedgerReference('hold', input.provider, input.providerReference);
      const ledgerId = await insertCommitmentJournal(client, {
        operationType: 'commitment_hold',
        reference,
        chamaId: row.chama_id,
        memberId: row.membership_id,
        amount: input.amount,
        debitAccount: 'external_clearing',
        creditAccount: 'commitment_escrow',
        metadata: commitmentMetadata(row, input.provider, input.providerReference),
      });

      const updated = (await client.query<CommitmentRow>(
        `UPDATE commitment_deposits
            SET state = 'held', provider = $2, provider_reference = $3,
                hold_ledger_transaction_id = $4,
                held_at = COALESCE($5, CURRENT_TIMESTAMP),
                last_transition_source = 'provider_confirmation',
                last_transition_reference = $3,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [row.id, input.provider.trim(), input.providerReference.trim(), ledgerId, input.occurredAt ?? null],
      )).rows[0];

      await client.query(
        `UPDATE chama_members
            SET membership_status = 'active', approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND membership_status = 'pending'`,
        [row.membership_id],
      );
      await client.query(
        `UPDATE chama_applications
            SET status = 'approved', reviewed_at = COALESCE(reviewed_at, CURRENT_TIMESTAMP),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'commitment_pending'`,
        [row.application_id],
      );

      return {
        ...this.mapStatus({ ...row, ...updated, membership_status: 'active', application_status: 'approved' }),
        replayed: false,
      };
    });
  }

  async markAtRisk(input: CommitmentTransitionEvidence) {
    this.assertTransitionEvidence(input.source, input.reference);
    return this.transitionNonFinancial(input, ['held'], 'at_risk', 'at_risk_at');
  }

  async markDefaultTriggered(input: CommitmentTransitionEvidence) {
    this.assertTransitionEvidence(input.source, input.reference);
    return this.transaction(async (client) => {
      const row = await this.requireCommitment(client, input.membershipId, true);
      if (row.state === 'default_triggered' && row.last_transition_reference === input.reference) return this.mapStatus(row);
      if (row.state !== 'at_risk') throw new ConflictError(`Default cannot be triggered from state ${row.state}`);

      await client.query(
        `UPDATE commitment_deposits
            SET state = 'default_triggered', default_triggered_at = CURRENT_TIMESTAMP,
                last_transition_source = $2, last_transition_reference = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.id, input.source.trim(), input.reference.trim()],
      );
      await client.query(
        `UPDATE chama_members
            SET membership_status = 'defaulted', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.membership_id],
      );
      return this.mapStatus(await this.requireCommitment(client, input.membershipId, false));
    });
  }

  async markEligibleForRefund(input: CommitmentTransitionEvidence) {
    this.assertTransitionEvidence(input.source, input.reference);
    return this.transaction(async (client) => {
      const row = await this.requireCommitment(client, input.membershipId, true);
      if (row.state === 'eligible_for_refund' && row.last_transition_reference === input.reference) return this.mapStatus(row);
      if (!['held', 'at_risk'].includes(row.state)) throw new ConflictError(`Refund eligibility cannot be granted from state ${row.state}`);
      if (row.membership_status === 'defaulted') throw new ConflictError('Refund eligibility is blocked by an unresolved default');

      await client.query(
        `UPDATE commitment_deposits
            SET state = 'eligible_for_refund', eligible_for_refund_at = CURRENT_TIMESTAMP,
                last_transition_source = $2, last_transition_reference = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.id, input.source.trim(), input.reference.trim()],
      );
      return this.mapStatus(await this.requireCommitment(client, input.membershipId, false));
    });
  }

  async requestRefund(membershipId: string, userId: string) {
    return this.transaction(async (client) => {
      const row = await this.requireCommitment(client, membershipId, true);
      this.assertOwner(row.user_id, userId);
      if (row.state === 'refund_requested') return this.mapStatus(row);
      if (row.state !== 'eligible_for_refund') throw new ConflictError('Commitment is not eligible for refund');
      if (row.membership_status === 'defaulted') throw new ConflictError('Refund is blocked by an unresolved default');

      const reference = `member-refund-request:${randomUUID()}`;
      await client.query(
        `UPDATE commitment_deposits
            SET state = 'refund_requested', refund_requested_at = CURRENT_TIMESTAMP,
                last_transition_source = 'member_request', last_transition_reference = $2,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.id, reference],
      );
      return this.mapStatus(await this.requireCommitment(client, membershipId, false));
    });
  }

  /** Provider/B2C confirmation boundary after a server-approved refund request. */
  async confirmRefundFromProvider(input: ProviderRefundConfirmation) {
    this.assertProviderEvidence(input.provider, input.providerReference, input.amount, input.currency);
    return this.transaction(async (client) => {
      await advisoryLock(client, `commitment:refund:${input.provider}:${input.providerReference}`);
      const row = await this.requireCommitment(client, input.membershipId, true);

      if (row.state === 'refunded') {
        if (row.terminal_provider === input.provider && row.terminal_provider_reference === input.providerReference && BigInt(row.refunded_amount) === input.amount) {
          return { ...this.mapStatus(row), replayed: true };
        }
        throw new ConflictError('Commitment has already been refunded using a different provider transaction');
      }
      if (row.state !== 'refund_requested') throw new ConflictError(`Commitment cannot be refunded from state ${row.state}`);
      if (row.membership_status === 'defaulted') throw new ConflictError('Refund is blocked by an unresolved default');

      const remaining = BigInt(row.amount) - BigInt(row.refunded_amount) - BigInt(row.forfeited_amount);
      if (input.amount !== remaining) throw new UnprocessableEntityError('Provider refund amount does not match the refundable commitment balance');

      const reference = commitmentLedgerReference('refund', input.provider, input.providerReference);
      const ledgerId = await insertCommitmentJournal(client, {
        operationType: 'commitment_refund',
        reference,
        chamaId: row.chama_id,
        memberId: row.membership_id,
        amount: input.amount,
        debitAccount: 'commitment_escrow',
        creditAccount: 'external_clearing',
        metadata: commitmentMetadata(row, input.provider, input.providerReference),
      });

      await client.query(
        `UPDATE commitment_deposits
            SET state = 'refunded', refunded_amount = refunded_amount + $2,
                terminal_provider = $3, terminal_provider_reference = $4,
                terminal_ledger_transaction_id = $5,
                refunded_at = COALESCE($6, CURRENT_TIMESTAMP),
                last_transition_source = 'provider_refund_confirmation',
                last_transition_reference = $4,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.id, input.amount.toString(), input.provider.trim(), input.providerReference.trim(), ledgerId, input.occurredAt ?? null],
      );

      return { ...this.mapStatus(await this.requireCommitment(client, input.membershipId, false)), replayed: false };
    });
  }

  /** Rule-engine boundary. No member/client route may invoke forfeiture directly. */
  async forfeitFromRule(input: CommitmentForfeitureInput) {
    this.assertTransitionEvidence(input.source, input.reference);
    if (input.amount <= 0n) throw new UnprocessableEntityError('Forfeiture amount must be positive');

    return this.transaction(async (client) => {
      await advisoryLock(client, `commitment:forfeit:${input.reference}`);
      const row = await this.requireCommitment(client, input.membershipId, true);
      if (['forfeited', 'partial_forfeit'].includes(row.state) && row.last_transition_reference === input.reference) {
        return { ...this.mapStatus(row), replayed: true };
      }
      if (row.state !== 'default_triggered') throw new ConflictError(`Commitment cannot be forfeited from state ${row.state}`);

      const remaining = BigInt(row.amount) - BigInt(row.refunded_amount) - BigInt(row.forfeited_amount);
      if (input.amount !== remaining) {
        throw new UnprocessableEntityError('Partial commitment forfeiture is not enabled until remainder-settlement policy is approved');
      }
      const nextState: CommitmentState = 'forfeited';
      const provider = 'rules_engine';
      const reference = commitmentLedgerReference('forfeit', provider, input.reference);
      const ledgerId = await insertCommitmentJournal(client, {
        operationType: 'commitment_forfeiture',
        reference,
        chamaId: row.chama_id,
        memberId: row.membership_id,
        amount: input.amount,
        debitAccount: 'commitment_escrow',
        creditAccount: 'commitment_forfeiture',
        metadata: commitmentMetadata(row, provider, input.reference),
      });

      await client.query(
        `UPDATE commitment_deposits
            SET state = $2::commitment_state, forfeited_amount = forfeited_amount + $3,
                terminal_provider = $4, terminal_provider_reference = $5,
                terminal_ledger_transaction_id = $6, forfeited_at = CURRENT_TIMESTAMP,
                last_transition_source = $7, last_transition_reference = $5,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.id, nextState, input.amount.toString(), provider, input.reference.trim(), ledgerId, input.source.trim()],
      );

      return { ...this.mapStatus(await this.requireCommitment(client, input.membershipId, false)), replayed: false };
    });
  }

  private async transitionNonFinancial(
    input: CommitmentTransitionEvidence,
    allowedStates: CommitmentState[],
    nextState: CommitmentState,
    timestampColumn: 'at_risk_at',
  ) {
    return this.transaction(async (client) => {
      const row = await this.requireCommitment(client, input.membershipId, true);
      if (row.state === nextState && row.last_transition_reference === input.reference) return this.mapStatus(row);
      if (!allowedStates.includes(row.state)) throw new ConflictError(`Commitment cannot transition from ${row.state} to ${nextState}`);
      await client.query(
        `UPDATE commitment_deposits
            SET state = $2::commitment_state, ${timestampColumn} = CURRENT_TIMESTAMP,
                last_transition_source = $3, last_transition_reference = $4,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [row.id, nextState, input.source.trim(), input.reference.trim()],
      );
      return this.mapStatus(await this.requireCommitment(client, input.membershipId, false));
    });
  }

  private async loadMembership(membershipId: string): Promise<MembershipRow> {
    const result = await this.db.query<MembershipRow>(
      `SELECT cm.id, cm.chama_id, cm.user_id, cm.membership_status::text AS membership_status,
              accepted.chama_rule_id, accepted.rule_version, accepted.commitment_amount
         FROM chama_members cm
         LEFT JOIN LATERAL (
           SELECT mca.chama_rule_id, cr.version::int AS rule_version, cr.commitment_amount::text AS commitment_amount
             FROM membership_constitution_acceptances mca
             JOIN chama_rules cr ON cr.id = mca.chama_rule_id
            WHERE mca.membership_id = cm.id
            ORDER BY mca.accepted_at DESC, mca.id DESC
            LIMIT 1
         ) accepted ON TRUE
        WHERE cm.id = $1`,
      [membershipId],
    );
    const membership = result.rows[0];
    if (!membership) throw new NotFoundError('Membership not found');
    return membership;
  }

  private async findLatestCommitment(membershipId: string): Promise<CommitmentRow | null> {
    const result = await this.db.query<CommitmentRow>(commitmentContextSql(false), [membershipId]);
    return result.rows[0] ?? null;
  }

  private async requireCommitment(client: PoolClient, membershipId: string, lock: boolean): Promise<CommitmentRow> {
    const result = await client.query<CommitmentRow>(commitmentContextSql(lock), [membershipId]);
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Commitment deposit not found');
    return row;
  }

  private assertOwner(actualUserId: string, expectedUserId: string) {
    if (actualUserId !== expectedUserId) throw new ForbiddenError('Commitment details are private to the membership owner', 'COMMITMENT_OWNER_REQUIRED');
  }

  private assertProviderEvidence(provider: string, providerReference: string, amount: bigint, currency = 'KES') {
    if (!provider.trim() || !providerReference.trim()) throw new UnprocessableEntityError('Provider confirmation requires provider and reference');
    if (amount <= 0n) throw new UnprocessableEntityError('Provider amount must be positive');
    if (currency !== 'KES') throw new UnprocessableEntityError('Phase 1 commitment currency must be KES');
  }

  private assertTransitionEvidence(source: string, reference: string) {
    if (!source.trim() || !reference.trim()) throw new UnprocessableEntityError('Commitment transition requires server evidence');
  }

  private mapStatus(row: CommitmentRow) {
    return {
      commitmentId: row.id,
      membershipId: row.membership_id,
      applicationId: row.application_id,
      chamaId: row.chama_id,
      required: true,
      amount: row.amount,
      currency: 'KES' as const,
      state: row.state,
      membershipStatus: row.membership_status,
      applicationStatus: row.application_status,
      canStartSaving: row.state === 'held' && row.membership_status === 'active',
      constitution: { id: row.chama_rule_id, version: Number(row.rule_version) },
      provider: row.provider,
      providerReference: row.provider_reference,
      timestamps: {
        heldAt: row.held_at,
        atRiskAt: row.at_risk_at,
        defaultTriggeredAt: row.default_triggered_at,
        eligibleForRefundAt: row.eligible_for_refund_at,
        refundRequestedAt: row.refund_requested_at,
        refundedAt: row.refunded_at,
        forfeitedAt: row.forfeited_at,
      },
      ledger: {
        holdTransactionId: row.hold_ledger_transaction_id,
        terminalTransactionId: row.terminal_ledger_transaction_id,
      },
    };
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function commitmentContextSql(lock: boolean) {
  return `SELECT cd.id, cd.chama_id, cd.user_id, cd.membership_id, cd.application_id,
                 cd.chama_rule_id, cr.version::int AS rule_version, cd.amount::text,
                 cd.state::text AS state, cd.provider, cd.provider_reference,
                 cd.terminal_provider, cd.terminal_provider_reference,
                 cd.last_transition_source, cd.last_transition_reference,
                 cd.forfeited_amount::text, cd.refunded_amount::text,
                 cd.hold_ledger_transaction_id, cd.terminal_ledger_transaction_id,
                 cd.held_at::text, cd.at_risk_at::text, cd.default_triggered_at::text,
                 cd.eligible_for_refund_at::text, cd.refund_requested_at::text,
                 cd.refunded_at::text, cd.forfeited_at::text,
                 cm.membership_status::text AS membership_status,
                 ca.status::text AS application_status,
                 EXISTS (
                   SELECT 1 FROM membership_constitution_acceptances mca
                    WHERE mca.membership_id = cd.membership_id
                      AND mca.chama_id = cd.chama_id
                      AND mca.chama_rule_id = cd.chama_rule_id
                 ) AS constitution_accepted
            FROM commitment_deposits cd
            JOIN chama_members cm ON cm.id = cd.membership_id AND cm.chama_id = cd.chama_id AND cm.user_id = cd.user_id
            JOIN chama_applications ca ON ca.id = cd.application_id AND ca.chama_id = cd.chama_id AND ca.user_id = cd.user_id
            JOIN chama_rules cr ON cr.id = cd.chama_rule_id AND cr.chama_id = cd.chama_id
           WHERE cd.membership_id = $1
           ORDER BY cd.cycle_no DESC
           LIMIT 1${lock ? ' FOR UPDATE OF cd, cm, ca' : ''}`;
}

async function advisoryLock(client: PoolClient, key: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

function commitmentLedgerReference(kind: 'hold' | 'refund' | 'forfeit', provider: string, providerReference: string) {
  return `commitment:${kind}:${provider.trim().toLowerCase()}:${providerReference.trim()}`;
}

function commitmentMetadata(row: CommitmentRow, provider: string, providerReference: string) {
  return {
    commitmentId: row.id,
    membershipId: row.membership_id,
    applicationId: row.application_id,
    chamaRuleId: row.chama_rule_id,
    ruleVersion: Number(row.rule_version),
    provider: provider.trim(),
    providerReference: providerReference.trim(),
    custody: true,
    affectsPooledAmount: false,
  };
}

async function insertCommitmentJournal(
  client: PoolClient,
  input: {
    operationType: 'commitment_hold' | 'commitment_refund' | 'commitment_forfeiture';
    reference: string;
    chamaId: string;
    memberId: string;
    amount: bigint;
    debitAccount: 'external_clearing' | 'commitment_escrow';
    creditAccount: 'external_clearing' | 'commitment_escrow' | 'commitment_forfeiture';
    metadata: Record<string, unknown>;
  },
) {
  const tx = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions (operation_type, reference, metadata)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id`,
    [input.operationType, input.reference, JSON.stringify(input.metadata)],
  );
  const ledgerId = tx.rows[0].id;
  await client.query(
    `INSERT INTO ledger_entries
       (ledger_transaction_id, chama_id, member_id, account, side, amount, currency)
     VALUES
       ($1, $2, $3, $4::ledger_account, 'debit', $6, 'KES'),
       ($1, $2, $3, $5::ledger_account, 'credit', $6, 'KES')`,
    [ledgerId, input.chamaId, input.memberId, input.debitAccount, input.creditAccount, input.amount.toString()],
  );
  return ledgerId;
}

export const commitmentService = new CommitmentService();
