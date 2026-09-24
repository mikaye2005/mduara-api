import { randomInt } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { ledgerService } from './ledger.service';
import { mpesaService, type B2CPayoutRequest, type B2CPayoutResult } from './mpesa.service';
import { assertSubscriptionWriteAccess } from './subscription.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from '../utils/errors';
import type { CreateMgrCycleInput, MgrSwapDecisionInput, MgrSwapRequestInput } from '../validation/mgr.validation';

interface PayoutGateway {
  dispatchB2CPayout(request: B2CPayoutRequest): Promise<B2CPayoutResult>;
}

export interface MgrB2CResultPayload {
  Result?: {
    ResultType?: number;
    ResultCode?: number;
    ResultDesc?: string;
    OriginatorConversationID?: string;
    ConversationID?: string;
    TransactionID?: string;
    ResultParameters?: { ResultParameter?: Array<{ Key?: string; Value?: string | number }> };
  };
}

interface CallbackConfig {
  resultUrl?: string;
  timeoutUrl?: string;
}

interface ChamaRow extends QueryResultRow {
  id: string;
  type: string;
  status: string;
  pooled_amount: string;
  currency: string;
}

interface MemberRow extends QueryResultRow {
  id: string;
  user_id: string;
  full_name: string;
  phone: string | null;
  role: 'member' | 'treasurer' | 'secretary' | 'chairperson';
}

interface CycleRow extends QueryResultRow {
  id: string;
  chama_id: string;
  cycle_no: number;
  generation_mode: 'manual' | 'randomized' | 'bidding';
  payout_amount: string;
  start_date: string;
  interval_days: number;
  current_position: number;
  status: 'active' | 'completed' | 'cancelled';
  policy_snapshot: Record<string, unknown>;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PayoutRow extends QueryResultRow {
  id: string;
  cycle_id: string;
  chama_id: string;
  member_id: string;
  rotation_position: number;
  payout_amount: string;
  scheduled_date: string;
  paid_at: string | null;
  status: 'scheduled' | 'disbursement_pending' | 'paid' | 'skipped' | 'disputed';
  receipt_number: string | null;
  payout_ledger_transaction_id: string | null;
  full_name?: string;
}

interface AttemptContext extends QueryResultRow {
  attempt_id: string;
  payout_id: string;
  cycle_id: string;
  chama_id: string;
  member_id: string;
  amount: string;
  attempt_status: string;
  payout_status: string;
  rotation_position: number;
  current_position: number;
  cycle_status: string;
}

const LEADERSHIP = new Set(['chairperson', 'secretary', 'treasurer']);
const PAYOUT_ROLES = new Set(['chairperson', 'treasurer']);

export class MerryGoRoundService {
  constructor(
    private readonly db: Pool = pool,
    private readonly payoutGateway: PayoutGateway = mpesaService,
    private readonly callbacks: CallbackConfig = {
      resultUrl: env.MPESA_MGR_B2C_RESULT_URL,
      timeoutUrl: env.MPESA_MGR_B2C_TIMEOUT_URL,
    },
  ) {}

  async createCycle(userId: string, chamaId: string, input: CreateMgrCycleInput) {
    if (input.mode === 'bidding') {
      throw new UnprocessableEntityError(
        'Bidding queue generation is not enabled until the bidding/price allocation policy is approved',
        undefined,
        'MGR_BIDDING_POLICY_NOT_CONFIGURED',
      );
    }

    return withDatabaseTransaction(async (client) => {
      const chama = await requireMerryGoRoundChama(client, chamaId, true);
      await assertSubscriptionWriteAccess(client, chamaId);
      if (chama.status !== 'active') {
        throw new ConflictError('Merry-go-round cycles can only start in an active Chama', 'MGR_CHAMA_NOT_ACTIVE');
      }
      const role = await requireActiveRole(client, chamaId, userId);
      if (!LEADERSHIP.has(role)) {
        throw new ForbiddenError('Only Chama leadership may create a merry-go-round cycle', 'MGR_CYCLE_CREATE_FORBIDDEN');
      }

      const activeCycle = await client.query('SELECT id FROM merry_go_round_cycles WHERE chama_id = $1 AND status = $2 FOR UPDATE', [chamaId, 'active']);
      if (activeCycle.rowCount) throw new ConflictError('This Chama already has an active merry-go-round cycle', 'MGR_ACTIVE_CYCLE_EXISTS');

      const membersResult = await client.query<MemberRow>(
        `SELECT cm.id, cm.user_id, cm.role::text AS role, u.full_name, u.phone
           FROM chama_members cm
           JOIN users u ON u.id = cm.user_id
          WHERE cm.chama_id = $1 AND cm.membership_status = 'active'
          ORDER BY cm.joined_at, cm.id
          FOR SHARE OF cm`,
        [chamaId],
      );
      if (membersResult.rows.length < 2) {
        throw new UnprocessableEntityError('At least two active members are required to generate a merry-go-round queue', undefined, 'MGR_MEMBERS_INSUFFICIENT');
      }

      let order = membersResult.rows.map((row) => row.id);
      if (input.mode === 'manual') {
        const requested = input.memberOrder ?? [];
        assertExactMemberOrder(order, requested);
        order = [...requested];
      } else {
        order = shuffle(order);
      }

      const constitution = (await client.query<{ id: string; version: number; payout_policy: Record<string, unknown> }>(
        `SELECT id, version, payout_policy
           FROM chama_rules
          WHERE chama_id = $1 AND status = 'active'
          LIMIT 1`,
        [chamaId],
      )).rows[0];
      if (!constitution) {
        throw new UnprocessableEntityError('An active Constitution is required before creating a payout cycle', undefined, 'MGR_CONSTITUTION_REQUIRED');
      }

      const nextNo = Number((await client.query<{ next_no: string }>(
        `SELECT (COALESCE(MAX(cycle_no), 0) + 1)::text AS next_no
           FROM merry_go_round_cycles WHERE chama_id = $1`,
        [chamaId],
      )).rows[0].next_no);

      const cycle = (await client.query<CycleRow>(
        `INSERT INTO merry_go_round_cycles
           (chama_id, cycle_no, generation_mode, payout_amount, start_date, interval_days,
            policy_snapshot, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         RETURNING *`,
        [
          chamaId,
          nextNo,
          input.mode,
          input.payoutAmount.toString(),
          input.firstPayoutDate,
          input.intervalDays,
          JSON.stringify({
            chamaRuleId: constitution.id,
            chamaRuleVersion: constitution.version,
            payoutPolicy: constitution.payout_policy ?? {},
          }),
          userId,
        ],
      )).rows[0];

      for (let index = 0; index < order.length; index += 1) {
        await client.query(
          `INSERT INTO merry_go_round_payouts
             (cycle_id, chama_id, member_id, rotation_position, payout_amount, scheduled_date)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            cycle.id,
            chamaId,
            order[index],
            index + 1,
            input.payoutAmount.toString(),
            addDays(input.firstPayoutDate, index * input.intervalDays),
          ],
        );
      }

      await writeAudit(client, 'mgr_cycle_created', userId, role, chamaId, 'merry_go_round_cycle', cycle.id, {
        cycleNo: nextNo,
        mode: input.mode,
        memberCount: order.length,
        payoutAmount: input.payoutAmount.toString(),
        constitutionId: constitution.id,
        constitutionVersion: constitution.version,
      });
      return getCycleWithin(client, cycle.id);
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async getCurrentCycle(userId: string, chamaId: string) {
    return withDatabaseTransaction(async (client) => {
      await requireActiveMembership(client, chamaId, userId);
      await requireMerryGoRoundChama(client, chamaId, false);
      const row = (await client.query<{ id: string }>(
        `SELECT id FROM merry_go_round_cycles
          WHERE chama_id = $1 AND status = 'active'
          ORDER BY cycle_no DESC LIMIT 1`,
        [chamaId],
      )).rows[0];
      if (!row) throw new NotFoundError('No active merry-go-round cycle was found', 'MGR_ACTIVE_CYCLE_NOT_FOUND');
      return getCycleWithin(client, row.id);
    }, {}, this.db);
  }

  async getCycle(userId: string, cycleId: string) {
    return withDatabaseTransaction(async (client) => {
      const cycle = await requireCycle(client, cycleId, false);
      await requireActiveMembership(client, cycle.chama_id, userId);
      return getCycleWithin(client, cycleId);
    }, {}, this.db);
  }

  async requestSwap(userId: string, cycleId: string, input: MgrSwapRequestInput) {
    return withDatabaseTransaction(async (client) => {
      const cycle = await requireCycle(client, cycleId, true);
      await assertSubscriptionWriteAccess(client, cycle.chama_id);
      if (cycle.status !== 'active') throw new ConflictError('Only an active cycle can accept swap requests', 'MGR_CYCLE_NOT_ACTIVE');
      const requester = await requireActiveMembership(client, cycle.chama_id, userId);
      if (requester.id === input.targetMemberId) {
        throw new UnprocessableEntityError('A member cannot swap a turn with themself', undefined, 'MGR_SWAP_SELF');
      }
      const target = (await client.query<{ id: string }>(
        `SELECT id FROM chama_members
          WHERE id = $1 AND chama_id = $2 AND membership_status = 'active'
          FOR SHARE`,
        [input.targetMemberId, cycle.chama_id],
      )).rows[0];
      if (!target) throw new NotFoundError('Target active member was not found in this Chama', 'MGR_SWAP_TARGET_NOT_FOUND');

      const payouts = await client.query<PayoutRow>(
        `SELECT * FROM merry_go_round_payouts
          WHERE cycle_id = $1 AND member_id = ANY($2::uuid[])
          FOR UPDATE`,
        [cycle.id, [requester.id, target.id]],
      );
      const requesterPayout = payouts.rows.find((row) => row.member_id === requester.id);
      const targetPayout = payouts.rows.find((row) => row.member_id === target.id);
      if (!requesterPayout || !targetPayout) throw new NotFoundError('Both members must have turns in this cycle', 'MGR_SWAP_TURN_NOT_FOUND');
      for (const payout of [requesterPayout, targetPayout]) {
        if (payout.status !== 'scheduled' || payout.rotation_position < cycle.current_position) {
          throw new ConflictError('Only unresolved current/upcoming turns can be swapped', 'MGR_SWAP_TURN_NOT_AVAILABLE');
        }
      }
      const conflict = await client.query(
        `SELECT id FROM merry_go_round_swap_requests
          WHERE cycle_id = $1 AND status = 'pending'
            AND (requester_payout_id = ANY($2::uuid[]) OR target_payout_id = ANY($2::uuid[]))
          LIMIT 1`,
        [cycle.id, [requesterPayout.id, targetPayout.id]],
      );
      if (conflict.rowCount) throw new ConflictError('One of these turns already has a pending swap request', 'MGR_SWAP_PENDING_EXISTS');

      const swap = (await client.query(
        `INSERT INTO merry_go_round_swap_requests
           (cycle_id, chama_id, requester_payout_id, target_payout_id, requester_member_id, target_member_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [cycle.id, cycle.chama_id, requesterPayout.id, targetPayout.id, requester.id, target.id],
      )).rows[0];
      await writeAudit(client, 'mgr_swap_requested', userId, requester.role, cycle.chama_id, 'merry_go_round_swap', swap.id, {
        cycleId: cycle.id,
        requesterMemberId: requester.id,
        targetMemberId: target.id,
        requesterPosition: requesterPayout.rotation_position,
        targetPosition: targetPayout.rotation_position,
      });
      return serializeSwap(swap);
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async decideSwap(userId: string, cycleId: string, swapId: string, input: MgrSwapDecisionInput) {
    return withDatabaseTransaction(async (client) => {
      const cycle = await requireCycle(client, cycleId, true);
      await assertSubscriptionWriteAccess(client, cycle.chama_id);
      const member = await requireActiveMembership(client, cycle.chama_id, userId);
      const swap = (await client.query<any>(
        `SELECT * FROM merry_go_round_swap_requests
          WHERE id = $1 AND cycle_id = $2
          FOR UPDATE`,
        [swapId, cycleId],
      )).rows[0];
      if (!swap) throw new NotFoundError('Swap request was not found', 'MGR_SWAP_NOT_FOUND');
      if (swap.status !== 'pending') return serializeSwap(swap);

      if (input.decision === 'cancel') {
        if (member.id !== swap.requester_member_id) {
          throw new ForbiddenError('Only the requesting member can cancel this swap', 'MGR_SWAP_CANCEL_FORBIDDEN');
        }
        const updated = (await client.query(
          `UPDATE merry_go_round_swap_requests
              SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 RETURNING *`,
          [swap.id],
        )).rows[0];
        await writeAudit(client, 'mgr_swap_cancelled', userId, member.role, cycle.chama_id, 'merry_go_round_swap', swap.id, {});
        return serializeSwap(updated);
      }

      if (member.id !== swap.target_member_id) {
        throw new ForbiddenError('Only the target member can accept or reject this swap', 'MGR_SWAP_DECISION_FORBIDDEN');
      }

      if (input.decision === 'reject') {
        const updated = (await client.query(
          `UPDATE merry_go_round_swap_requests
              SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 RETURNING *`,
          [swap.id],
        )).rows[0];
        await writeAudit(client, 'mgr_swap_rejected', userId, member.role, cycle.chama_id, 'merry_go_round_swap', swap.id, {});
        return serializeSwap(updated);
      }

      if (cycle.status !== 'active') throw new ConflictError('The cycle is no longer active', 'MGR_CYCLE_NOT_ACTIVE');
      const payoutRows = await client.query<PayoutRow>(
        `SELECT * FROM merry_go_round_payouts
          WHERE id = ANY($1::uuid[]) AND cycle_id = $2
          FOR UPDATE`,
        [[swap.requester_payout_id, swap.target_payout_id], cycle.id],
      );
      const first = payoutRows.rows.find((row) => row.id === swap.requester_payout_id);
      const second = payoutRows.rows.find((row) => row.id === swap.target_payout_id);
      if (!first || !second) throw new NotFoundError('Swap turns no longer exist', 'MGR_SWAP_TURN_NOT_FOUND');
      for (const payout of [first, second]) {
        if (payout.status !== 'scheduled' || payout.rotation_position < cycle.current_position) {
          throw new ConflictError('One of the turns can no longer be swapped', 'MGR_SWAP_TURN_NOT_AVAILABLE');
        }
      }

      await swapPayoutPositions(client, cycle.id, first, second);
      const updated = (await client.query(
        `UPDATE merry_go_round_swap_requests
            SET status = 'accepted', target_accepted_at = CURRENT_TIMESTAMP,
                resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 RETURNING *`,
        [swap.id],
      )).rows[0];
      await writeAudit(client, 'mgr_swap_accepted', userId, member.role, cycle.chama_id, 'merry_go_round_swap', swap.id, {
        requesterMemberId: swap.requester_member_id,
        targetMemberId: swap.target_member_id,
        requesterOldPosition: first.rotation_position,
        targetOldPosition: second.rotation_position,
      });
      return serializeSwap(updated);
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async disburse(userId: string, cycleId: string) {
    if (!this.callbacks.resultUrl || !this.callbacks.timeoutUrl) {
      throw new ServiceUnavailableError('M-Pesa merry-go-round callback URLs are not configured', 'MGR_B2C_CALLBACKS_NOT_CONFIGURED');
    }

    const instruction = await withDatabaseTransaction(async (client) => {
      const cycle = await requireCycle(client, cycleId, true);
      await assertSubscriptionWriteAccess(client, cycle.chama_id);
      if (cycle.status !== 'active') throw new ConflictError('The cycle is not active', 'MGR_CYCLE_NOT_ACTIVE');
      const role = await requireActiveRole(client, cycle.chama_id, userId);
      if (!PAYOUT_ROLES.has(role)) {
        throw new ForbiddenError('Only the Chairperson or Treasurer may disburse a merry-go-round payout', 'MGR_DISBURSE_FORBIDDEN');
      }

      const payout = (await client.query<PayoutRow & { phone: string | null; full_name: string }>(
        `SELECT p.*, u.phone, u.full_name
           FROM merry_go_round_payouts p
           JOIN chama_members cm ON cm.id = p.member_id AND cm.membership_status = 'active'
           JOIN users u ON u.id = cm.user_id
          WHERE p.cycle_id = $1 AND p.rotation_position = $2
          FOR UPDATE OF p, cm`,
        [cycle.id, cycle.current_position],
      )).rows[0];
      if (!payout) throw new NotFoundError('The current payout turn was not found or its member is inactive', 'MGR_CURRENT_TURN_NOT_FOUND');
      if (payout.status !== 'scheduled') {
        throw new ConflictError(`Current payout is ${payout.status} and cannot be dispatched`, 'MGR_PAYOUT_STATE_INVALID');
      }
      if (!payout.phone) throw new UnprocessableEntityError('Current recipient has no payout phone number', undefined, 'MGR_PAYOUT_PHONE_MISSING');

      const unresolved = await client.query(
        `SELECT id FROM merry_go_round_disbursement_attempts
          WHERE payout_id = $1 AND status IN ('pending','dispatched','timed_out')
          LIMIT 1 FOR UPDATE`,
        [payout.id],
      );
      if (unresolved.rowCount) {
        throw new ConflictError('This payout already has an unresolved provider attempt', 'MGR_PAYOUT_ATTEMPT_UNRESOLVED');
      }

      const treasury = (await client.query<{ pooled_amount: string }>(
        `SELECT pooled_amount::text FROM chamas WHERE id = $1 FOR UPDATE`,
        [cycle.chama_id],
      )).rows[0];
      if (!treasury || BigInt(treasury.pooled_amount) < BigInt(payout.payout_amount)) {
        throw new UnprocessableEntityError(
          'Chama treasury is insufficient for the current merry-go-round payout',
          { required: payout.payout_amount, available: treasury?.pooled_amount ?? '0' },
          'MGR_TREASURY_INSUFFICIENT',
        );
      }

      const attemptNo = Number((await client.query<{ next_no: string }>(
        `SELECT (COALESCE(MAX(attempt_no),0)+1)::text AS next_no
           FROM merry_go_round_disbursement_attempts WHERE payout_id = $1`,
        [payout.id],
      )).rows[0].next_no);
      const attempt = (await client.query<{ id: string }>(
        `INSERT INTO merry_go_round_disbursement_attempts
           (payout_id, attempt_no, amount, phone_number)
         VALUES ($1,$2,$3,$4)
         RETURNING id`,
        [payout.id, attemptNo, payout.payout_amount, payout.phone],
      )).rows[0];
      await client.query(
        `UPDATE merry_go_round_payouts
            SET status = 'disbursement_pending', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [payout.id],
      );
      await writeAudit(client, 'mgr_disbursement_requested', userId, role, cycle.chama_id, 'merry_go_round_payout', payout.id, {
        cycleId: cycle.id,
        position: payout.rotation_position,
        amount: payout.payout_amount,
        attemptId: attempt.id,
        attemptNo,
      });
      return {
        attemptId: attempt.id,
        payoutId: payout.id,
        cycleId: cycle.id,
        amount: BigInt(payout.payout_amount),
        phoneNumber: payout.phone,
        reference: `mgr:${cycle.id}:${payout.id}:${attemptNo}`,
        remarks: `M-Duara MGR cycle ${cycle.cycle_no} turn ${payout.rotation_position}`,
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);

    try {
      const provider = await this.payoutGateway.dispatchB2CPayout({
        amount: instruction.amount,
        phoneNumber: instruction.phoneNumber,
        reference: instruction.reference,
        remarks: instruction.remarks,
        resultUrl: this.callbacks.resultUrl,
        timeoutUrl: this.callbacks.timeoutUrl,
      });
      await withDatabaseTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE merry_go_round_disbursement_attempts
              SET status = 'dispatched', provider_reference = $2, dispatched_at = CURRENT_TIMESTAMP,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status = 'pending' AND provider_reference IS NULL
            RETURNING id`,
          [instruction.attemptId, provider.providerReference],
        );
        if (!updated.rowCount) throw new ConflictError('Disbursement attempt changed before provider dispatch could be recorded', 'MGR_PAYOUT_DISPATCH_RACE');
      }, {}, this.db);
      return {
        cycleId: instruction.cycleId,
        payoutId: instruction.payoutId,
        status: 'disbursement_pending' as const,
        providerReference: provider.providerReference,
      };
    } catch (error) {
      await withDatabaseTransaction(async (client) => {
        const attempt = (await client.query<{ payout_id: string; provider_reference: string | null }>(
          `SELECT payout_id, provider_reference FROM merry_go_round_disbursement_attempts WHERE id = $1 FOR UPDATE`,
          [instruction.attemptId],
        )).rows[0];
        if (attempt && !attempt.provider_reference) {
          await client.query(
            `UPDATE merry_go_round_disbursement_attempts
                SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1`,
            [instruction.attemptId, error instanceof Error ? error.message : String(error)],
          );
          await client.query(
            `UPDATE merry_go_round_payouts
                SET status = 'scheduled', updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND status = 'disbursement_pending'`,
            [attempt.payout_id],
          );
        }
      }, {}, this.db);
      throw error;
    }
  }

  async processB2CResult(payload: MgrB2CResultPayload) {
    const result = payload.Result;
    const conversationId = result?.ConversationID?.trim();
    if (!conversationId || result?.ResultCode === undefined) {
      throw new UnprocessableEntityError('Invalid M-Pesa B2C result payload', undefined, 'MGR_B2C_RESULT_INVALID');
    }

    return withDatabaseTransaction(async (client) => {
      const context = await findAttemptContext(client, conversationId);
      if (!context) throw new NotFoundError('Merry-go-round disbursement attempt was not found', 'MGR_DISBURSEMENT_NOT_FOUND');

      if (result.ResultCode !== 0) {
        if (context.attempt_status === 'failed' && context.payout_status === 'scheduled') {
          return { cycleId: context.cycle_id, payoutId: context.payout_id, status: 'scheduled' as const, replayed: true };
        }
        await client.query(
          `UPDATE merry_go_round_disbursement_attempts
              SET status = 'failed', failure_reason = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [context.attempt_id, result.ResultDesc ?? `M-Pesa result code ${result.ResultCode}`],
        );
        await client.query(
          `UPDATE merry_go_round_payouts
              SET status = 'scheduled', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND status IN ('disbursement_pending','disputed')`,
          [context.payout_id],
        );
        await writeAudit(client, 'mgr_disbursement_failed', null, 'system', context.chama_id, 'merry_go_round_payout', context.payout_id, {
          provider: 'mpesa', conversationId, resultCode: result.ResultCode, resultDescription: result.ResultDesc ?? null,
        });
        return { cycleId: context.cycle_id, payoutId: context.payout_id, status: 'scheduled' as const, replayed: false };
      }

      if (context.attempt_status === 'confirmed' && context.payout_status === 'paid') {
        return { cycleId: context.cycle_id, payoutId: context.payout_id, status: 'paid' as const, replayed: true };
      }

      const parameters = Object.fromEntries(
        (result.ResultParameters?.ResultParameter ?? [])
          .filter((item) => item.Key)
          .map((item) => [String(item.Key), item.Value]),
      );
      const transactionId = result.TransactionID?.trim()
        || String(parameters.TransactionReceipt ?? parameters.TransactionID ?? '').trim();
      if (!transactionId) {
        throw new UnprocessableEntityError('Successful M-Pesa B2C result is missing a transaction receipt', undefined, 'MGR_B2C_RECEIPT_MISSING');
      }
      const providerAmount = parseProviderAmount(parameters.TransactionAmount);
      if (providerAmount !== null && providerAmount !== BigInt(context.amount)) {
        throw new UnprocessableEntityError(
          'M-Pesa B2C result amount does not match the scheduled payout',
          { expected: context.amount, actual: providerAmount.toString() },
          'MGR_B2C_AMOUNT_MISMATCH',
        );
      }

      const ledger = await ledgerService.recordMemberPayoutWithinTransaction(client, {
        chamaId: context.chama_id,
        memberId: context.member_id,
        amount: BigInt(context.amount),
        reference: `mgr-payout:${transactionId}`,
        metadata: {
          provider: 'mpesa',
          conversationId,
          transactionId,
          cycleId: context.cycle_id,
          payoutId: context.payout_id,
          rotationPosition: context.rotation_position,
        },
      });

      await client.query(
        `UPDATE merry_go_round_disbursement_attempts
            SET status = 'confirmed', transaction_receipt = $2, confirmed_at = CURRENT_TIMESTAMP,
                failure_reason = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [context.attempt_id, transactionId],
      );
      await client.query(
        `UPDATE merry_go_round_payouts
            SET status = 'paid', receipt_number = $2, payout_ledger_transaction_id = $3,
                paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [context.payout_id, transactionId, ledger.ledgerTransactionId],
      );

      const maxPosition = Number((await client.query<{ max_position: string }>(
        `SELECT MAX(rotation_position)::text AS max_position
           FROM merry_go_round_payouts WHERE cycle_id = $1`,
        [context.cycle_id],
      )).rows[0].max_position);
      if (context.rotation_position !== context.current_position) {
        throw new ConflictError('Confirmed payout does not match the cycle current position', 'MGR_CYCLE_POSITION_CONFLICT');
      }
      if (context.current_position >= maxPosition) {
        await client.query(
          `UPDATE merry_go_round_cycles
              SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [context.cycle_id],
        );
      } else {
        await client.query(
          `UPDATE merry_go_round_cycles
              SET current_position = current_position + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [context.cycle_id],
        );
      }

      await writeAudit(client, 'mgr_disbursement_confirmed', null, 'system', context.chama_id, 'merry_go_round_payout', context.payout_id, {
        provider: 'mpesa',
        conversationId,
        transactionId,
        ledgerTransactionId: ledger.ledgerTransactionId,
        cycleCompleted: context.current_position >= maxPosition,
      });
      return {
        cycleId: context.cycle_id,
        payoutId: context.payout_id,
        status: 'paid' as const,
        transactionId,
        ledgerTransactionId: ledger.ledgerTransactionId,
        cycleStatus: context.current_position >= maxPosition ? 'completed' : 'active',
        nextPosition: context.current_position >= maxPosition ? null : context.current_position + 1,
        replayed: ledger.replayed,
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async processB2CTimeout(payload: MgrB2CResultPayload) {
    const conversationId = payload.Result?.ConversationID?.trim();
    if (!conversationId) {
      throw new UnprocessableEntityError('Invalid M-Pesa B2C timeout payload', undefined, 'MGR_B2C_TIMEOUT_INVALID');
    }
    return withDatabaseTransaction(async (client) => {
      const context = await findAttemptContext(client, conversationId);
      if (!context) throw new NotFoundError('Merry-go-round disbursement attempt was not found', 'MGR_DISBURSEMENT_NOT_FOUND');
      if (context.attempt_status === 'confirmed' || context.payout_status === 'paid') {
        return { cycleId: context.cycle_id, payoutId: context.payout_id, status: 'paid' as const, replayed: true };
      }
      await client.query(
        `UPDATE merry_go_round_disbursement_attempts
            SET status = 'timed_out', failure_reason = 'M-Pesa B2C timeout', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status IN ('pending','dispatched')`,
        [context.attempt_id],
      );
      await client.query(
        `UPDATE merry_go_round_payouts
            SET status = 'disputed', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'disbursement_pending'`,
        [context.payout_id],
      );
      await writeAudit(client, 'mgr_disbursement_timeout', null, 'system', context.chama_id, 'merry_go_round_payout', context.payout_id, {
        provider: 'mpesa', conversationId,
      });
      return { cycleId: context.cycle_id, payoutId: context.payout_id, status: 'disputed' as const, replayed: false };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }
}

async function requireMerryGoRoundChama(client: PoolClient, chamaId: string, lock: boolean): Promise<ChamaRow> {
  const result = await client.query<ChamaRow>(
    `SELECT id, type::text AS type, status::text AS status, pooled_amount::text, currency
       FROM chamas WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [chamaId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Chama was not found', 'CHAMA_NOT_FOUND');
  if (row.type !== 'merry_go_round') {
    throw new UnprocessableEntityError('This operation is only available to merry-go-round Chamas', undefined, 'MGR_CHAMA_TYPE_REQUIRED');
  }
  return row;
}

async function requireCycle(client: PoolClient, cycleId: string, lock: boolean): Promise<CycleRow> {
  const result = await client.query<CycleRow>(
    `SELECT * FROM merry_go_round_cycles WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [cycleId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Merry-go-round cycle was not found', 'MGR_CYCLE_NOT_FOUND');
  return row;
}

async function requireActiveMembership(client: PoolClient, chamaId: string, userId: string): Promise<MemberRow> {
  const row = (await client.query<MemberRow>(
    `SELECT cm.id, cm.user_id, cm.role::text AS role, u.full_name, u.phone
       FROM chama_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.chama_id = $1 AND cm.user_id = $2 AND cm.membership_status = 'active'
      LIMIT 1`,
    [chamaId, userId],
  )).rows[0];
  if (!row) throw new ForbiddenError('An active Chama membership is required', 'CHAMA_MEMBERSHIP_INACTIVE');
  return row;
}

async function requireActiveRole(client: PoolClient, chamaId: string, userId: string): Promise<MemberRow['role']> {
  return (await requireActiveMembership(client, chamaId, userId)).role;
}

async function getCycleWithin(client: PoolClient, cycleId: string) {
  const cycle = await requireCycle(client, cycleId, false);
  const payouts = await client.query<PayoutRow>(
    `SELECT p.*, u.full_name
       FROM merry_go_round_payouts p
       JOIN chama_members cm ON cm.id = p.member_id
       JOIN users u ON u.id = cm.user_id
      WHERE p.cycle_id = $1
      ORDER BY p.rotation_position`,
    [cycleId],
  );
  const swaps = await client.query(
    `SELECT id, requester_member_id, target_member_id, status::text AS status,
            requester_accepted_at, target_accepted_at, resolved_at, created_at
       FROM merry_go_round_swap_requests
      WHERE cycle_id = $1
      ORDER BY created_at DESC`,
    [cycleId],
  );
  return {
    id: cycle.id,
    chamaId: cycle.chama_id,
    cycleNo: cycle.cycle_no,
    mode: cycle.generation_mode,
    payoutAmount: cycle.payout_amount,
    startDate: cycle.start_date,
    intervalDays: cycle.interval_days,
    currentPosition: cycle.current_position,
    status: cycle.status,
    policySnapshot: cycle.policy_snapshot,
    completedAt: cycle.completed_at,
    queue: payouts.rows.map((payout) => ({
      id: payout.id,
      memberId: payout.member_id,
      memberName: payout.full_name ?? null,
      position: payout.rotation_position,
      payoutAmount: payout.payout_amount,
      scheduledDate: payout.scheduled_date,
      status: payout.status,
      receiptNumber: payout.receipt_number,
      paidAt: payout.paid_at,
      isCurrent: cycle.status === 'active' && payout.rotation_position === cycle.current_position,
    })),
    swaps: swaps.rows.map(serializeSwap),
  };
}

async function findAttemptContext(client: PoolClient, conversationId: string): Promise<AttemptContext | undefined> {
  return (await client.query<AttemptContext>(
    `SELECT a.id AS attempt_id, p.id AS payout_id, p.cycle_id, p.chama_id, p.member_id,
            a.amount::text, a.status::text AS attempt_status, p.status::text AS payout_status,
            p.rotation_position, c.current_position, c.status::text AS cycle_status
       FROM merry_go_round_disbursement_attempts a
       JOIN merry_go_round_payouts p ON p.id = a.payout_id
       JOIN merry_go_round_cycles c ON c.id = p.cycle_id
      WHERE a.provider = 'mpesa' AND a.provider_reference = $1
      FOR UPDATE OF a, p, c`,
    [conversationId],
  )).rows[0];
}

async function swapPayoutPositions(client: PoolClient, cycleId: string, first: PayoutRow, second: PayoutRow): Promise<void> {
  const temporary = Number((await client.query<{ value: string }>(
    `SELECT (COALESCE(MAX(rotation_position),0)+1)::text AS value
       FROM merry_go_round_payouts WHERE cycle_id = $1`,
    [cycleId],
  )).rows[0].value);
  await client.query(
    `UPDATE merry_go_round_payouts SET rotation_position = $2, scheduled_date = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [first.id, temporary, second.scheduled_date],
  );
  await client.query(
    `UPDATE merry_go_round_payouts SET rotation_position = $2, scheduled_date = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [second.id, first.rotation_position, first.scheduled_date],
  );
  await client.query(
    `UPDATE merry_go_round_payouts SET rotation_position = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [first.id, second.rotation_position],
  );
}

function assertExactMemberOrder(active: string[], requested: string[]): void {
  if (active.length !== requested.length) {
    throw new UnprocessableEntityError(
      'Manual memberOrder must contain every active Chama membership exactly once',
      { activeCount: active.length, suppliedCount: requested.length },
      'MGR_MANUAL_ORDER_INCOMPLETE',
    );
  }
  const expected = new Set(active);
  if (requested.some((id) => !expected.has(id))) {
    throw new UnprocessableEntityError(
      'Manual memberOrder contains a membership that is not active in this Chama',
      undefined,
      'MGR_MANUAL_ORDER_INVALID',
    );
  }
}

function shuffle<T>(input: T[]): T[] {
  const result = [...input];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function addDays(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function parseProviderAmount(value: unknown): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d+(?:\.0+)?$/.test(normalized)) {
    throw new UnprocessableEntityError('Invalid provider payout amount', { value }, 'MGR_B2C_AMOUNT_INVALID');
  }
  return BigInt(normalized.split('.')[0]);
}

function serializeSwap(row: any) {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    requesterMemberId: row.requester_member_id,
    targetMemberId: row.target_member_id,
    status: row.status,
    requesterAcceptedAt: row.requester_accepted_at,
    targetAcceptedAt: row.target_accepted_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

async function writeAudit(
  client: PoolClient,
  action: string,
  actorId: string | null,
  actorRole: string,
  chamaId: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const normalizedRole = ['member', 'treasurer', 'secretary', 'chairperson', 'platform_admin', 'system'].includes(actorRole)
    ? actorRole
    : 'system';
  await client.query(
    `INSERT INTO audit_logs (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
     VALUES ('financial',$1,$2,$3::audit_actor_role,$4,$5,$6,$7::jsonb)`,
    [action, actorId, normalizedRole, chamaId, entityType, entityId, JSON.stringify(payload)],
  );
}

export const merryGoRoundService = new MerryGoRoundService();
