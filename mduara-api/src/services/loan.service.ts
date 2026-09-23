import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { ledgerService } from './ledger.service';
import { mpesaService, type B2CPayoutRequest, type B2CPayoutResult } from './mpesa.service';
import { assertActiveLoanCapacity } from './subscription.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from '../utils/errors';
import type {
  ApplyLoanInput,
  RepayLoanInput,
  UpsertLoanRuleInput,
} from '../validation/loan.validation';

interface PayoutGateway {
  dispatchB2CPayout(request: B2CPayoutRequest): Promise<B2CPayoutResult>;
}

interface LoanRow extends QueryResultRow {
  id: string;
  chama_id: string;
  member_id: string;
  principal_amount: string;
  total_due: string;
  status: string;
  phone: string | null;
}

interface LoanRuleRow extends QueryResultRow {
  interest_rate: string;
  max_borrowing_multiplier: string;
  min_guarantors: number;
  max_term_days: number | null;
  interest_cycle_days: number | null;
}

interface GuaranteeRow extends QueryResultRow {
  id: string;
  member_id: string;
  guaranteed_amount: string;
  approved_at: string | null;
}

interface B2CResultParameter {
  Key?: string;
  Value?: string | number;
}

export interface B2CResultPayload {
  Result?: {
    ResultType?: number;
    ResultCode?: number;
    ResultDesc?: string;
    OriginatorConversationID?: string;
    ConversationID?: string;
    TransactionID?: string;
    ResultParameters?: { ResultParameter?: B2CResultParameter[] };
  };
}

export interface RejectLoanInput {
  reason?: string;
}

/**
 * BE-07 loan lifecycle service.
 *
 * Financial-policy note: PD-22 (interest/amortisation method) is still OPEN.
 * Production loan application/disbursement therefore fails closed until that
 * policy is approved. Development/test can exercise the workflow safely.
 */
export class LoanService {
  constructor(
    private readonly db: Pool = pool,
    private readonly payoutGateway: PayoutGateway = mpesaService,
  ) {}

  async apply(userId: string, input: ApplyLoanInput) {
    assertLoanPricingPolicyAvailable();
    return withDatabaseTransaction(async (client) => {
      const membership = await getActiveMembership(client, input.chamaId, userId);
      await assertActiveLoanCapacity(client, input.chamaId);
      const rule = await getActiveLoanRule(client, input.chamaId);

      if (input.guarantors.length < rule.min_guarantors) {
        throw new UnprocessableEntityError(
          `This Chama requires at least ${rule.min_guarantors} guarantors per loan`,
          undefined,
          'LOAN_MIN_GUARANTORS_NOT_MET',
        );
      }
      if (
        rule.max_term_days
        && input.dueDate
        && new Date(input.dueDate) > new Date(Date.now() + rule.max_term_days * 86_400_000)
      ) {
        throw new UnprocessableEntityError(
          `The due date exceeds this Chama's maximum loan term of ${rule.max_term_days} days`,
          undefined,
          'LOAN_TERM_EXCEEDED',
        );
      }

      const savings = await memberSavings(client, membership.id);
      const capacity = applyMultiplier(savings, Number(rule.max_borrowing_multiplier));
      const amount = BigInt(input.amount);
      if (amount > capacity) {
        throw new UnprocessableEntityError(
          'Requested amount exceeds borrowing capacity',
          { capacity: capacity.toString(), savings: savings.toString() },
          'LOAN_CAPACITY_EXCEEDED',
        );
      }

      if (input.guarantors.some((guarantor) => guarantor.memberId === membership.id)) {
        throw new UnprocessableEntityError('An applicant cannot guarantee their own loan', undefined, 'LOAN_SELF_GUARANTEE');
      }
      await assertActiveGuarantors(client, input.chamaId, input.guarantors.map((guarantor) => guarantor.memberId));

      // This preserves the existing development model only. Production is blocked above
      // while PD-22 remains unresolved, so this cannot become a production pricing promise.
      const interestRate = Number(rule.interest_rate);
      const totalDue = calculateLegacyDevelopmentTotalDue(amount, interestRate);
      const result = await client.query<LoanRow>(
        `INSERT INTO loans
           (chama_id, member_id, principal_amount, interest_rate, total_due, purpose,
            due_date, interest_cycle_days, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'awaiting_guarantors')
         RETURNING id, chama_id, member_id, principal_amount::text, total_due::text,
                   status::text AS status, NULL::text AS phone`,
        [
          input.chamaId,
          membership.id,
          amount.toString(),
          interestRate,
          totalDue.toString(),
          input.purpose ?? null,
          input.dueDate ?? null,
          rule.interest_cycle_days,
        ],
      );

      for (const guarantor of input.guarantors) {
        await client.query(
          `INSERT INTO loan_guarantors (loan_id, member_id, guaranteed_amount)
           VALUES ($1,$2,$3)`,
          [result.rows[0].id, guarantor.memberId, guarantor.guaranteedAmount],
        );
      }

      await writeAudit(client, {
        action: 'loan_applied',
        actorId: userId,
        actorRole: 'member',
        chamaId: input.chamaId,
        loanId: result.rows[0].id,
        payload: {
          amount: amount.toString(),
          guarantorCount: input.guarantors.length,
          borrowingCapacity: capacity.toString(),
        },
      });
      return serializeLoan(result.rows[0]);
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async getRule(userId: string, chamaId: string) {
    return withDatabaseTransaction(async (client) => {
      await getActiveMembership(client, chamaId, userId);
      return serializeLoanRule(await getActiveLoanRule(client, chamaId));
    }, {}, this.db);
  }

  async upsertRule(userId: string, chamaId: string, input: UpsertLoanRuleInput) {
    return withDatabaseTransaction(async (client) => {
      const role = await getActiveRole(client, chamaId, userId);
      if (!['chairperson', 'treasurer'].includes(role)) {
        throw new ForbiddenError('Only the Chairperson or Treasurer may configure loan rules', 'LOAN_RULE_ROLE_FORBIDDEN');
      }
      const result = await client.query<LoanRuleRow>(
        `INSERT INTO loan_rules
           (chama_id, interest_rate, max_borrowing_multiplier, min_guarantors,
            max_term_days, created_by, interest_cycle_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (chama_id) DO UPDATE SET
           interest_rate = EXCLUDED.interest_rate,
           max_borrowing_multiplier = EXCLUDED.max_borrowing_multiplier,
           min_guarantors = EXCLUDED.min_guarantors,
           max_term_days = EXCLUDED.max_term_days,
           interest_cycle_days = CASE
             WHEN $8::boolean THEN EXCLUDED.interest_cycle_days
             ELSE loan_rules.interest_cycle_days
           END,
           updated_at = CURRENT_TIMESTAMP
         RETURNING interest_rate::text, max_borrowing_multiplier::text,
                   min_guarantors, max_term_days, interest_cycle_days`,
        [
          chamaId,
          input.interestRate,
          input.maxBorrowingMultiplier,
          input.minGuarantors,
          input.maxTermDays ?? null,
          userId,
          input.interestCycleDays ?? null,
          input.interestCycleDays !== undefined,
        ],
      );
      await writeAudit(client, {
        action: 'loan_rule_updated', actorId: userId, actorRole: role as 'chairperson' | 'treasurer',
        chamaId, loanId: null, payload: serializeLoanRule(result.rows[0]),
      });
      return serializeLoanRule(result.rows[0]);
    }, {}, this.db);
  }

  async acceptGuarantee(userId: string, loanId: string) {
    return withDatabaseTransaction(async (client) => {
      const loan = await getLoanForUpdate(client, loanId);
      const guarantee = await getNominatedGuaranteeForUpdate(client, loanId, userId);
      if (!guarantee) {
        throw new ForbiddenError('You are not an active nominated guarantor for this loan', 'LOAN_GUARANTOR_FORBIDDEN');
      }

      if (guarantee.approved_at) {
        const progress = await guarantorProgress(client, loan);
        return {
          loanId,
          guaranteedAmount: guarantee.guaranteed_amount,
          approved: true,
          loanStatus: loan.status,
          coverageAmount: progress.coverageAmount.toString(),
          approvedCount: progress.approvedCount,
          replayed: true,
        };
      }
      if (loan.status !== 'awaiting_guarantors') {
        throw new ConflictError('This loan is no longer accepting guarantor pledges', 'LOAN_NOT_AWAITING_GUARANTORS');
      }

      const savings = await memberSavings(client, guarantee.member_id);
      const alreadyLocked = await lockedGuarantees(client, guarantee.member_id, loan.id);
      const available = savings > alreadyLocked ? savings - alreadyLocked : 0n;
      const pledge = BigInt(guarantee.guaranteed_amount);
      if (pledge > available) {
        throw new UnprocessableEntityError(
          'Guarantor pledge exceeds available unencumbered savings',
          { availableSavings: available.toString(), requestedPledge: pledge.toString() },
          'LOAN_GUARANTOR_COLLATERAL_INSUFFICIENT',
        );
      }

      await client.query(
        `UPDATE loan_guarantors
            SET approved_at = CURRENT_TIMESTAMP, approved_by = $2
          WHERE id = $1`,
        [guarantee.id, userId],
      );

      const progress = await guarantorProgress(client, loan);
      const rule = await getActiveLoanRule(client, loan.chama_id);
      let loanStatus = loan.status;
      if (progress.coverageAmount >= BigInt(loan.principal_amount) && progress.approvedCount >= rule.min_guarantors) {
        await client.query(
          `UPDATE loans SET status = 'pending_admin_approval', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [loan.id],
        );
        loanStatus = 'pending_admin_approval';
      }

      await writeAudit(client, {
        action: 'loan_guarantor_accepted', actorId: userId, actorRole: 'member',
        chamaId: loan.chama_id, loanId: loan.id,
        payload: {
          membershipId: guarantee.member_id,
          pledgedAmount: guarantee.guaranteed_amount,
          availableBeforePledge: available.toString(),
          coverageAmount: progress.coverageAmount.toString(),
          approvedCount: progress.approvedCount,
          loanStatus,
        },
      });

      return {
        loanId,
        guaranteedAmount: guarantee.guaranteed_amount,
        approved: true,
        loanStatus,
        coverageAmount: progress.coverageAmount.toString(),
        approvedCount: progress.approvedCount,
        replayed: false,
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async approve(userId: string, loanId: string) {
    const decision = await withDatabaseTransaction(async (client) => {
      const loan = await getLoanForUpdate(client, loanId);
      const role = await getActiveRole(client, loan.chama_id, userId);
      const progress = await guarantorProgress(client, loan);
      const rule = await getActiveLoanRule(client, loan.chama_id);
      if (progress.coverageAmount < BigInt(loan.principal_amount) || progress.approvedCount < rule.min_guarantors) {
        throw new UnprocessableEntityError(
          'Loan cannot enter administrative approval before guarantor collateral reaches 100%',
          {
            requiredAmount: loan.principal_amount,
            approvedCoverage: progress.coverageAmount.toString(),
            requiredGuarantors: rule.min_guarantors,
            approvedGuarantors: progress.approvedCount,
          },
          'LOAN_COLLATERAL_INCOMPLETE',
        );
      }

      if (loan.status === 'pending_admin_approval') {
        if (role !== 'treasurer') {
          throw new ForbiddenError('Treasurer approval is required before Chairperson approval', 'LOAN_TREASURER_APPROVAL_REQUIRED');
        }
        await client.query(
          `UPDATE loans SET status = 'partially_approved', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [loan.id],
        );
        await writeAudit(client, {
          action: 'loan_treasurer_approved', actorId: userId, actorRole: 'treasurer',
          chamaId: loan.chama_id, loanId: loan.id,
          payload: { approvedCoverage: progress.coverageAmount.toString(), approvedGuarantors: progress.approvedCount },
        });
        return { loanId: loan.id, status: 'partially_approved' as const, dispatch: null };
      }

      if (loan.status === 'partially_approved') {
        if (role !== 'chairperson') {
          throw new ForbiddenError('Only the Chairperson may give the final loan approval', 'LOAN_CHAIR_APPROVAL_REQUIRED');
        }
        assertLoanDisbursementPolicyAvailable();
        const treasurerApproval = await client.query(
          `SELECT 1 FROM audit_logs
            WHERE entity_type = 'loan' AND entity_id = $1
              AND action = 'loan_treasurer_approved'
            LIMIT 1`,
          [loan.id],
        );
        if (!treasurerApproval.rowCount) {
          throw new ConflictError('Treasurer approval record is missing', 'LOAN_TREASURER_APPROVAL_MISSING');
        }
        if (!loan.phone) {
          throw new UnprocessableEntityError('The borrower has no phone number for payout', undefined, 'LOAN_PAYOUT_PHONE_MISSING');
        }
        await assertTreasuryAvailableForLoan(client, loan.chama_id, loan.id, BigInt(loan.principal_amount));

        await client.query(
          `UPDATE loans
              SET status = 'disbursement_pending', approved_by = $2,
                  approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [loan.id, userId],
        );
        await client.query(
          `INSERT INTO loan_disbursements (loan_id, amount, phone_number, status)
           VALUES ($1,$2,$3,'pending')
           ON CONFLICT (loan_id) DO UPDATE SET
             amount = EXCLUDED.amount,
             phone_number = EXCLUDED.phone_number,
             status = 'pending',
             provider_reference = NULL,
             failure_reason = NULL,
             dispatched_at = NULL,
             updated_at = CURRENT_TIMESTAMP`,
          [loan.id, loan.principal_amount, loan.phone],
        );
        await writeAudit(client, {
          action: 'loan_chair_approved', actorId: userId, actorRole: 'chairperson',
          chamaId: loan.chama_id, loanId: loan.id,
          payload: { approvedCoverage: progress.coverageAmount.toString(), approvedGuarantors: progress.approvedCount },
        });
        return {
          loanId: loan.id,
          status: 'disbursement_pending' as const,
          dispatch: {
            amount: BigInt(loan.principal_amount),
            phoneNumber: loan.phone,
            reference: loan.id,
            remarks: `Loan ${loan.id}`,
          },
        };
      }

      throw new ConflictError('Loan is not at the expected approval step', 'LOAN_APPROVAL_STATE_INVALID');
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);

    if (!decision.dispatch) return decision;

    try {
      const payout = await this.payoutGateway.dispatchB2CPayout(decision.dispatch);
      await withDatabaseTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE loan_disbursements
              SET provider_reference = $2, dispatched_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
            WHERE loan_id = $1 AND status = 'pending'
            RETURNING id`,
          [decision.loanId, payout.providerReference],
        );
        if (!updated.rowCount) throw new ConflictError('Loan disbursement is no longer pending', 'LOAN_DISBURSEMENT_STATE_INVALID');
        await writeAudit(client, {
          action: 'loan_disbursement_dispatched', actorId: userId, actorRole: 'chairperson',
          chamaId: (await getLoanForUpdate(client, decision.loanId)).chama_id,
          loanId: decision.loanId,
          payload: { provider: 'mpesa', conversationId: payout.providerReference },
        });
      }, {}, this.db);
      return { loanId: decision.loanId, status: 'disbursement_pending' as const, payoutReference: payout.providerReference };
    } catch (error) {
      await withDatabaseTransaction(async (client) => {
        const loan = await getLoanForUpdate(client, decision.loanId);
        await client.query(
          `UPDATE loan_disbursements
              SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP
            WHERE loan_id = $1`,
          [decision.loanId, error instanceof Error ? error.message : 'Payout dispatch failed'],
        );
        await client.query(
          `UPDATE loans SET status = 'disbursement_failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [decision.loanId],
        );
        await writeAudit(client, {
          action: 'loan_disbursement_dispatch_failed', actorId: userId, actorRole: 'chairperson',
          chamaId: loan.chama_id, loanId: loan.id,
          payload: { reason: error instanceof Error ? error.message : 'Payout dispatch failed' },
        });
      }, {}, this.db);
      throw error;
    }
  }

  async reject(userId: string, loanId: string, input: RejectLoanInput) {
    return withDatabaseTransaction(async (client) => {
      const loan = await getLoanForUpdate(client, loanId);
      const role = await getActiveRole(client, loan.chama_id, userId);
      if (!['chairperson', 'treasurer'].includes(role)) {
        throw new ForbiddenError('Only the Treasurer or Chairperson may reject a loan', 'LOAN_REJECT_ROLE_FORBIDDEN');
      }
      if (!['awaiting_guarantors', 'pending_admin_approval', 'partially_approved', 'disbursement_failed'].includes(loan.status)) {
        throw new ConflictError('This loan can no longer be rejected', 'LOAN_REJECT_STATE_INVALID');
      }
      if (loan.status === 'disbursement_failed') {
        const dispatched = (await client.query<{ provider_reference: string | null; dispatched_at: string | null }>(
          `SELECT provider_reference, dispatched_at::text FROM loan_disbursements WHERE loan_id = $1 FOR UPDATE`,
          [loan.id],
        )).rows[0];
        if (dispatched?.provider_reference || dispatched?.dispatched_at) {
          throw new ConflictError(
            'A dispatched payout must be reconciled with the provider before the loan can be rejected',
            'LOAN_DISBURSEMENT_RECONCILIATION_REQUIRED',
          );
        }
      }

      await client.query(`UPDATE loans SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [loan.id]);
      await writeAudit(client, {
        action: 'loan_rejected', actorId: userId, actorRole: role as 'chairperson' | 'treasurer',
        chamaId: loan.chama_id, loanId: loan.id,
        payload: { reason: input.reason ?? null },
      });
      return { loanId: loan.id, status: 'rejected' as const, collateralReleased: true };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  /**
   * Records borrower-supplied repayment evidence as pending only.
   * A client can never self-confirm movement of money. The outstanding balance
   * changes only after a trusted provider/reconciliation boundary confirms it.
   */
  async recordRepaymentIntent(userId: string, loanId: string, input: RepayLoanInput) {
    assertLoanPricingPolicyAvailable();
    return withDatabaseTransaction(async (client) => {
      const loan = await getLoanForUpdate(client, loanId);
      const membership = await getActiveMembership(client, loan.chama_id, userId);
      if (membership.id !== loan.member_id) throw new ForbiddenError('Only the borrower may submit repayment evidence', 'LOAN_REPAY_BORROWER_ONLY');
      if (!['active', 'partially_repaid'].includes(loan.status)) {
        throw new ConflictError('This loan is not currently accepting repayments', 'LOAN_NOT_REPAYABLE');
      }
      const confirmed = await confirmedRepayments(client, loan.id);
      const outstanding = BigInt(loan.total_due) - confirmed;
      const amount = BigInt(input.amount);
      if (amount > outstanding) {
        throw new UnprocessableEntityError(
          'Repayment exceeds the outstanding balance',
          { outstanding: outstanding.toString() },
          'LOAN_REPAYMENT_EXCEEDS_OUTSTANDING',
        );
      }
      const payment = await client.query<{ id: string }>(
        `INSERT INTO loan_repayments
           (loan_id, amount, payment_method, provider_reference, receipt_number, status, verified_by)
         VALUES ($1,$2,$3,$4,$5,'pending',NULL)
         RETURNING id`,
        [loan.id, amount.toString(), input.paymentMethod, input.providerReference ?? null, input.receiptNumber ?? null],
      );
      await writeAudit(client, {
        action: 'loan_repayment_evidence_submitted', actorId: userId, actorRole: 'member',
        chamaId: loan.chama_id, loanId: loan.id,
        payload: { repaymentId: payment.rows[0].id, amount: amount.toString(), paymentMethod: input.paymentMethod },
      });
      return {
        repaymentId: payment.rows[0].id,
        loanId: loan.id,
        status: 'pending' as const,
        outstandingBalance: outstanding.toString(),
        message: 'Repayment evidence recorded pending provider/reconciliation confirmation.',
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  /** Processes the trusted Daraja B2C result callback. Dispatch acceptance alone never calls this. */
  async processB2CResult(payload: B2CResultPayload) {
    const result = payload.Result;
    const conversationId = result?.ConversationID?.trim();
    if (!conversationId || result?.ResultCode === undefined) {
      throw new UnprocessableEntityError('Invalid M-Pesa B2C result payload', undefined, 'MPESA_B2C_RESULT_INVALID');
    }

    return withDatabaseTransaction(async (client) => {
      const context = (await client.query<{
        disbursement_id: string;
        loan_id: string;
        chama_id: string;
        member_id: string;
        amount: string;
        disbursement_status: string;
        loan_status: string;
      }>(
        `SELECT ld.id AS disbursement_id, ld.loan_id, l.chama_id, l.member_id,
                ld.amount::text, ld.status::text AS disbursement_status,
                l.status::text AS loan_status
           FROM loan_disbursements ld
           JOIN loans l ON l.id = ld.loan_id
          WHERE ld.provider_reference = $1
          FOR UPDATE OF ld, l`,
        [conversationId],
      )).rows[0];
      if (!context) throw new NotFoundError('Loan disbursement was not found for this provider result', 'LOAN_DISBURSEMENT_NOT_FOUND');

      if (result.ResultCode !== 0) {
        if (context.disbursement_status === 'failed' && context.loan_status === 'disbursement_failed') {
          return { loanId: context.loan_id, status: 'disbursement_failed' as const, replayed: true };
        }
        await client.query(
          `UPDATE loan_disbursements
              SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [context.disbursement_id, result.ResultDesc ?? `M-Pesa result code ${result.ResultCode}`],
        );
        await client.query(
          `UPDATE loans SET status = 'disbursement_failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [context.loan_id],
        );
        await writeAudit(client, {
          action: 'loan_disbursement_failed', actorId: null, actorRole: 'system',
          chamaId: context.chama_id, loanId: context.loan_id,
          payload: { provider: 'mpesa', conversationId, resultCode: result.ResultCode, resultDescription: result.ResultDesc ?? null },
        });
        return { loanId: context.loan_id, status: 'disbursement_failed' as const, replayed: false };
      }

      if (context.disbursement_status === 'confirmed' && ['disbursed', 'active', 'partially_repaid', 'repaid'].includes(context.loan_status)) {
        return { loanId: context.loan_id, status: context.loan_status, replayed: true };
      }

      const parameters = Object.fromEntries(
        (result.ResultParameters?.ResultParameter ?? [])
          .filter((item) => item.Key)
          .map((item) => [String(item.Key), item.Value]),
      );
      const transactionId = result.TransactionID?.trim()
        || String(parameters.TransactionReceipt ?? parameters.TransactionID ?? '').trim();
      if (!transactionId) {
        throw new UnprocessableEntityError('Successful M-Pesa B2C result is missing a transaction id', undefined, 'MPESA_B2C_TRANSACTION_ID_MISSING');
      }
      const providerAmount = parseProviderAmount(parameters.TransactionAmount);
      if (providerAmount !== null && providerAmount !== BigInt(context.amount)) {
        throw new UnprocessableEntityError(
          'M-Pesa B2C result amount does not match the loan disbursement',
          { expected: context.amount, actual: providerAmount.toString() },
          'MPESA_B2C_AMOUNT_MISMATCH',
        );
      }

      const ledger = await ledgerService.recordLoanDisbursementWithinTransaction(client, {
        chamaId: context.chama_id,
        memberId: context.member_id,
        amount: BigInt(context.amount),
        reference: `loan-disbursement:${transactionId}`,
        metadata: { provider: 'mpesa', conversationId, transactionId, loanId: context.loan_id },
      });
      await client.query(
        `UPDATE loan_disbursements
            SET status = 'confirmed', failure_reason = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [context.disbursement_id],
      );
      // PD-22 blocks manufacturing a repayment schedule/active pricing contract.
      // Provider-confirmed payout is therefore represented truthfully as DISBURSED.
      await client.query(
        `UPDATE loans SET status = 'disbursed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [context.loan_id],
      );
      await writeAudit(client, {
        action: 'loan_disbursement_confirmed', actorId: null, actorRole: 'system',
        chamaId: context.chama_id, loanId: context.loan_id,
        payload: { provider: 'mpesa', conversationId, transactionId, ledgerTransactionId: ledger.ledgerTransactionId },
      });
      return {
        loanId: context.loan_id,
        status: 'disbursed' as const,
        transactionId,
        ledgerTransactionId: ledger.ledgerTransactionId,
        replayed: ledger.replayed,
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async processB2CTimeout(payload: B2CResultPayload) {
    const conversationId = payload.Result?.ConversationID?.trim();
    if (!conversationId) {
      throw new UnprocessableEntityError('Invalid M-Pesa B2C timeout payload', undefined, 'MPESA_B2C_TIMEOUT_INVALID');
    }
    return withDatabaseTransaction(async (client) => {
      const row = (await client.query<{ id: string; loan_id: string; chama_id: string }>(
        `SELECT ld.id, ld.loan_id, l.chama_id
           FROM loan_disbursements ld JOIN loans l ON l.id = ld.loan_id
          WHERE ld.provider_reference = $1
          FOR UPDATE OF ld, l`,
        [conversationId],
      )).rows[0];
      if (!row) throw new NotFoundError('Loan disbursement was not found for this provider timeout', 'LOAN_DISBURSEMENT_NOT_FOUND');
      await client.query(
        `UPDATE loan_disbursements
            SET status = 'failed', failure_reason = 'M-Pesa B2C timeout', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'pending'`,
        [row.id],
      );
      await client.query(
        `UPDATE loans SET status = 'disbursement_failed', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'disbursement_pending'`,
        [row.loan_id],
      );
      await writeAudit(client, {
        action: 'loan_disbursement_timeout', actorId: null, actorRole: 'system',
        chamaId: row.chama_id, loanId: row.loan_id,
        payload: { provider: 'mpesa', conversationId },
      });
      return { loanId: row.loan_id, status: 'disbursement_failed' as const };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }
}


async function assertTreasuryAvailableForLoan(
  client: PoolClient,
  chamaId: string,
  loanId: string,
  amount: bigint,
): Promise<void> {
  const treasury = (await client.query<{ pooled_amount: string }>(
    `SELECT pooled_amount::text FROM chamas WHERE id = $1 FOR UPDATE`,
    [chamaId],
  )).rows[0];
  if (!treasury) throw new NotFoundError('Chama not found', 'CHAMA_NOT_FOUND');
  const reserved = BigInt((await client.query<{ amount: string }>(
    `SELECT COALESCE(SUM(ld.amount), 0)::text AS amount
       FROM loan_disbursements ld
       JOIN loans l ON l.id = ld.loan_id
      WHERE l.chama_id = $1
        AND ld.loan_id <> $2
        AND ld.status = 'pending'
        AND l.status = 'disbursement_pending'`,
    [chamaId, loanId],
  )).rows[0].amount);
  const available = BigInt(treasury.pooled_amount) > reserved ? BigInt(treasury.pooled_amount) - reserved : 0n;
  if (amount > available) {
    throw new UnprocessableEntityError(
      'Chama treasury has insufficient unreserved funds for this loan payout',
      { availableTreasury: available.toString(), requiredAmount: amount.toString() },
      'LOAN_TREASURY_INSUFFICIENT',
    );
  }
}

async function getActiveMembership(client: PoolClient, chamaId: string, userId: string): Promise<{ id: string; role: string }> {
  const result = await client.query<{ id: string; role: string }>(
    `SELECT id, role::text AS role
       FROM chama_members
      WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
    [chamaId, userId],
  );
  if (!result.rows[0]) throw new ForbiddenError('You are not an active member of this Chama', 'CHAMA_MEMBERSHIP_INACTIVE');
  return result.rows[0];
}

async function getActiveRole(client: PoolClient, chamaId: string, userId: string): Promise<string> {
  return (await getActiveMembership(client, chamaId, userId)).role;
}

async function assertActiveGuarantors(client: PoolClient, chamaId: string, memberIds: string[]): Promise<void> {
  if (new Set(memberIds).size !== memberIds.length) {
    throw new UnprocessableEntityError('Each guarantor may only be nominated once', undefined, 'LOAN_DUPLICATE_GUARANTOR');
  }
  const result = await client.query<{ id: string }>(
    `SELECT id FROM chama_members
      WHERE chama_id = $1 AND membership_status = 'active' AND id = ANY($2::uuid[])`,
    [chamaId, memberIds],
  );
  if (result.rowCount !== memberIds.length) {
    throw new UnprocessableEntityError('Every guarantor must be an active Chama member', undefined, 'LOAN_GUARANTOR_INACTIVE');
  }
}

async function memberSavings(client: PoolClient, memberId: string): Promise<bigint> {
  const result = await client.query<{ amount: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS amount
       FROM contribution_payments
      WHERE member_id = $1 AND status = 'confirmed'`,
    [memberId],
  );
  return BigInt(result.rows[0].amount);
}

async function lockedGuarantees(client: PoolClient, memberId: string, excludingLoanId?: string): Promise<bigint> {
  const result = await client.query<{ amount: string }>(
    `SELECT COALESCE(SUM(lg.guaranteed_amount), 0)::text AS amount
       FROM loan_guarantors lg
       JOIN loans l ON l.id = lg.loan_id
      WHERE lg.member_id = $1
        AND lg.approved_at IS NOT NULL
        AND l.status NOT IN ('rejected', 'cancelled', 'repaid')
        AND ($2::uuid IS NULL OR l.id <> $2::uuid)`,
    [memberId, excludingLoanId ?? null],
  );
  return BigInt(result.rows[0].amount);
}

async function getActiveLoanRule(client: PoolClient, chamaId: string): Promise<LoanRuleRow> {
  const result = await client.query<LoanRuleRow>(
    `SELECT interest_rate::text, max_borrowing_multiplier::text,
            min_guarantors, max_term_days, interest_cycle_days
       FROM loan_rules WHERE chama_id = $1`,
    [chamaId],
  );
  if (!result.rows[0]) {
    throw new UnprocessableEntityError('This Chama has not configured its loan rules yet', undefined, 'LOAN_RULE_NOT_CONFIGURED');
  }
  return result.rows[0];
}

async function getLoanForUpdate(client: PoolClient, loanId: string): Promise<LoanRow> {
  const result = await client.query<LoanRow>(
    `SELECT l.id, l.chama_id, l.member_id, l.principal_amount::text,
            l.total_due::text, l.status::text AS status, u.phone
       FROM loans l
       JOIN chama_members cm ON cm.id = l.member_id
       JOIN users u ON u.id = cm.user_id
      WHERE l.id = $1
      FOR UPDATE OF l`,
    [loanId],
  );
  if (!result.rows[0]) throw new NotFoundError('Loan not found', 'LOAN_NOT_FOUND');
  return result.rows[0];
}

async function getNominatedGuaranteeForUpdate(client: PoolClient, loanId: string, userId: string): Promise<GuaranteeRow | null> {
  const result = await client.query<GuaranteeRow>(
    `SELECT lg.id, lg.member_id, lg.guaranteed_amount::text, lg.approved_at::text
       FROM loan_guarantors lg
       JOIN chama_members cm ON cm.id = lg.member_id
      WHERE lg.loan_id = $1 AND cm.user_id = $2 AND cm.membership_status = 'active'
      FOR UPDATE OF lg`,
    [loanId, userId],
  );
  return result.rows[0] ?? null;
}

async function guarantorProgress(client: PoolClient, loan: LoanRow): Promise<{ coverageAmount: bigint; approvedCount: number }> {
  const result = await client.query<{ amount: string; count: number }>(
    `SELECT COALESCE(SUM(guaranteed_amount) FILTER (WHERE approved_at IS NOT NULL), 0)::text AS amount,
            COUNT(*) FILTER (WHERE approved_at IS NOT NULL)::int AS count
       FROM loan_guarantors WHERE loan_id = $1`,
    [loan.id],
  );
  return { coverageAmount: BigInt(result.rows[0].amount), approvedCount: Number(result.rows[0].count) };
}

async function confirmedRepayments(client: PoolClient, loanId: string): Promise<bigint> {
  const result = await client.query<{ amount: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS amount
       FROM loan_repayments WHERE loan_id = $1 AND status = 'confirmed'`,
    [loanId],
  );
  return BigInt(result.rows[0].amount);
}

async function writeAudit(
  client: PoolClient,
  input: {
    action: string;
    actorId: string | null;
    actorRole: 'member' | 'treasurer' | 'chairperson' | 'system';
    chamaId: string;
    loanId: string | null;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs
       (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
     VALUES ('financial',$1,$2,$3::audit_actor_role,$4,'loan',$5,$6::jsonb)`,
    [input.action, input.actorId, input.actorRole, input.chamaId, input.loanId, JSON.stringify(input.payload)],
  );
}

function applyMultiplier(base: bigint, multiplier: number): bigint {
  return (base * BigInt(Math.round(multiplier * 100))) / 100n;
}

function calculateLegacyDevelopmentTotalDue(principal: bigint, interestRate: number): bigint {
  return (principal * BigInt(Math.round((100 + interestRate) * 100)) + 9_999n) / 10_000n;
}

function serializeLoan(loan: LoanRow) {
  return {
    id: loan.id,
    chamaId: loan.chama_id,
    principalAmount: loan.principal_amount,
    totalDue: loan.total_due,
    status: loan.status,
  };
}

function serializeLoanRule(rule: LoanRuleRow) {
  return {
    interestRate: Number(rule.interest_rate),
    maxBorrowingMultiplier: Number(rule.max_borrowing_multiplier),
    minGuarantors: rule.min_guarantors,
    maxTermDays: rule.max_term_days,
    interestCycleDays: rule.interest_cycle_days,
  };
}

function parseProviderAmount(value: unknown): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+(?:\.0+)?$/.test(value.trim())) return BigInt(value.trim().split('.')[0]);
  return null;
}

function assertLoanPricingPolicyAvailable(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new ServiceUnavailableError(
      'Production loan pricing is blocked until PD-22 approves the interest calculation method',
      'LOAN_PRICING_POLICY_UNAPPROVED',
    );
  }
}

function assertLoanDisbursementPolicyAvailable(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new ServiceUnavailableError(
      'Production loan disbursement is blocked until PD-22 approves loan pricing and repayment terms',
      'LOAN_DISBURSEMENT_POLICY_UNAPPROVED',
    );
  }
}

export const loanService = new LoanService();
