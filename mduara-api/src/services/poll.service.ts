import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import type { CreatePollInput, VotePollInput } from '../validation/poll.validation';

interface PollRow extends QueryResultRow {
  id: string;
  chama_id: string;
  chama_rule_id: string | null;
  decision_type: 'general' | 'rule_amendment' | 'member_removal' | 'dissolution' | 'payout_order_dispute';
  decision_payload: Record<string, unknown>;
  action_option_code: string | null;
  title: string;
  description: string | null;
  quorum_threshold_pct: string;
  majority_threshold_pct: string;
  status: 'draft' | 'open' | 'closed' | 'cancelled';
  opens_at: string | null;
  closes_at: string;
  created_by: string | null;
  closed_at: string | null;
  close_reason: 'deadline' | 'full_turnout' | null;
  acted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OptionTallyRow extends QueryResultRow {
  id: string;
  code: string;
  label: string;
  sort_order: number;
  votes: number;
}

export interface PollEvaluation {
  id: string;
  chamaId: string;
  chamaRuleId: string | null;
  decisionType: PollRow['decision_type'];
  decisionPayload: Record<string, unknown>;
  actionOptionCode: string | null;
  title: string;
  description: string | null;
  status: PollRow['status'];
  opensAt: string | null;
  closesAt: string;
  closedAt: string | null;
  closeReason: PollRow['close_reason'];
  thresholds: { quorumPct: number; majorityPct: number };
  participation: { eligible: number; votesCast: number; turnoutPct: number; quorumMet: boolean };
  tallies: Array<{ id: string; code: string; label: string; votes: number; percentage: number }>;
  winningOptionCodes: string[];
  actionVotes: number | null;
  actionVotePct: number | null;
  majorityMet: boolean;
  actionable: boolean;
  actedAt: string | null;
}

export class PollService {
  constructor(private readonly db: Pool = pool) {}

  async createPoll(actorId: string, chamaId: string, input: CreatePollInput, now = new Date()) {
    return withDatabaseTransaction(async (client) => {
      const chair = (await client.query<{ id: string }>(
        `SELECT id FROM chama_members
          WHERE chama_id = $1 AND user_id = $2 AND role = 'chairperson' AND membership_status = 'active'
          FOR SHARE`,
        [chamaId, actorId],
      )).rows[0];
      if (!chair) throw new ForbiddenError('Only the active Chairperson may create governance polls', 'POLL_CREATE_FORBIDDEN');

      const rule = (await client.query<{ id: string; quorum_threshold_pct: string; majority_threshold_pct: string }>(
        `SELECT id, quorum_threshold_pct::text, majority_threshold_pct::text
           FROM chama_rules
          WHERE chama_id = $1 AND status = 'active'
          FOR SHARE`,
        [chamaId],
      )).rows[0];
      if (!rule) throw new ConflictError('Active Constitution not found', 'POLL_CONSTITUTION_NOT_AVAILABLE');

      const opensAt = input.opensAt ? new Date(input.opensAt) : now;
      const closesAt = new Date(input.closesAt);
      if (!Number.isFinite(opensAt.getTime()) || !Number.isFinite(closesAt.getTime())) {
        throw new BadRequestError('Invalid poll date/time', undefined, 'POLL_TIME_INVALID');
      }
      if (closesAt <= opensAt || closesAt <= now) {
        throw new BadRequestError('Poll closesAt must be after opensAt and in the future', undefined, 'POLL_WINDOW_INVALID');
      }
      if (closesAt.getTime() - opensAt.getTime() > 90 * 86_400_000) {
        throw new BadRequestError('Poll duration cannot exceed 90 days', undefined, 'POLL_WINDOW_TOO_LONG');
      }

      const status: PollRow['status'] = opensAt <= now ? 'open' : 'draft';
      const poll = (await client.query<PollRow>(
        `INSERT INTO polls
           (chama_id, chama_rule_id, decision_type, decision_payload, action_option_code,
            title, description, quorum_threshold_pct, majority_threshold_pct,
            status, opens_at, closes_at, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::poll_status,$11,$12,$13)
         RETURNING id, chama_id, chama_rule_id, decision_type, decision_payload, action_option_code,
                   title, description, quorum_threshold_pct::text, majority_threshold_pct::text,
                   status::text AS status, opens_at::text, closes_at::text, created_by,
                   closed_at::text, close_reason, acted_at::text, created_at::text, updated_at::text`,
        [
          chamaId,
          rule.id,
          input.decisionType,
          JSON.stringify(input.decisionPayload ?? {}),
          input.actionOptionCode ?? null,
          input.title,
          input.description ?? null,
          rule.quorum_threshold_pct,
          rule.majority_threshold_pct,
          status,
          opensAt,
          closesAt,
          actorId,
        ],
      )).rows[0];

      for (let i = 0; i < input.options.length; i += 1) {
        const option = input.options[i];
        await client.query(
          `INSERT INTO poll_options (poll_id, code, label, sort_order) VALUES ($1,$2,$3,$4)`,
          [poll.id, option.code, option.label, i],
        );
      }

      const eligible = await client.query(
        `INSERT INTO poll_eligible_voters (poll_id, chama_id, member_id)
         SELECT $1, $2, cm.id
           FROM chama_members cm
          WHERE cm.chama_id = $2 AND cm.membership_status = 'active'`,
        [poll.id, chamaId],
      );
      if (!eligible.rowCount) throw new ConflictError('A poll requires at least one active eligible member', 'POLL_NO_ELIGIBLE_VOTERS');

      return evaluateLockedPoll(client, poll.id, chamaId, now);
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async vote(actorId: string, pollId: string, input: VotePollInput, now = new Date()) {
    return withDatabaseTransaction(async (client) => {
      const poll = await lockPoll(client, pollId);
      await refreshLockedPoll(client, poll, now);
      const current = await lockPoll(client, pollId);
      if (current.status === 'cancelled') throw new ConflictError('Poll is cancelled', 'POLL_CANCELLED');
      if (current.status === 'closed') throw new ConflictError('Poll is closed', 'POLL_CLOSED');
      if (current.opens_at && new Date(current.opens_at) > now) throw new ConflictError('Poll has not opened yet', 'POLL_NOT_OPEN');
      if (current.status !== 'open') throw new ConflictError('Poll is not open', 'POLL_NOT_OPEN');

      const membership = (await client.query<{ id: string }>(
        `SELECT cm.id
           FROM chama_members cm
           JOIN poll_eligible_voters ev ON ev.member_id = cm.id AND ev.poll_id = $1
          WHERE cm.chama_id = $2 AND cm.user_id = $3 AND cm.membership_status = 'active'`,
        [pollId, current.chama_id, actorId],
      )).rows[0];
      if (!membership) throw new ForbiddenError('You are not an eligible voter for this poll', 'POLL_VOTER_INELIGIBLE');

      const existing = await client.query(`SELECT 1 FROM poll_votes WHERE poll_id = $1 AND member_id = $2`, [pollId, membership.id]);
      if (existing.rowCount) throw new ConflictError('Vote has already been cast and is immutable', 'POLL_VOTE_ALREADY_CAST');

      const option = (await client.query<{ id: string; code: string; label: string }>(
        `SELECT id, code, label FROM poll_options
          WHERE poll_id = $1
            AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($3::text IS NOT NULL AND code = $3))`,
        [pollId, input.optionId ?? null, input.optionCode ?? null],
      )).rows[0];
      if (!option) throw new NotFoundError('Poll option not found', 'POLL_OPTION_NOT_FOUND');

      const vote = (await client.query<{ id: string; cast_at: string }>(
        `INSERT INTO poll_votes (poll_id, member_id, option_id)
         VALUES ($1,$2,$3) RETURNING id, cast_at::text`,
        [pollId, membership.id, option.id],
      )).rows[0];

      await refreshLockedPoll(client, current, now);
      const result = await evaluateLockedPoll(client, pollId, current.chama_id, now);
      return {
        vote: { id: vote.id, pollId, option: { id: option.id, code: option.code, label: option.label }, castAt: vote.cast_at },
        poll: result,
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async getResults(actorId: string, pollId: string, now = new Date()) {
    return withDatabaseTransaction(async (client) => {
      const poll = await lockPoll(client, pollId);
      const member = await client.query(
        `SELECT 1 FROM chama_members
          WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
        [poll.chama_id, actorId],
      );
      if (!member.rowCount) throw new ForbiddenError('Active Chama membership required to view poll results', 'POLL_RESULTS_FORBIDDEN');
      await refreshLockedPoll(client, poll, now);
      return evaluateLockedPoll(client, pollId, poll.chama_id, now);
    }, {}, this.db);
  }

  async actOutcome(actorId: string, pollId: string, now = new Date()) {
    return withDatabaseTransaction(async (client) => {
      const poll = await lockPoll(client, pollId);
      const chair = await client.query(
        `SELECT 1 FROM chama_members
          WHERE chama_id = $1 AND user_id = $2 AND role = 'chairperson' AND membership_status = 'active'`,
        [poll.chama_id, actorId],
      );
      if (!chair.rowCount) throw new ForbiddenError('Only the active Chairperson may apply a governance outcome', 'POLL_ACTION_FORBIDDEN');

      const result = await evaluatePollWithinTransaction(client, pollId, poll.chama_id, now);
      if (result.status !== 'closed') throw new ConflictError('Poll is not closed', 'POLL_NOT_CLOSED');
      if (result.actedAt) throw new ConflictError('Poll outcome has already been applied', 'POLL_ALREADY_ACTED');
      if (!result.majorityMet) throw new ConflictError('Poll did not approve its action option', 'POLL_ACTION_NOT_APPROVED');

      if (result.decisionType === 'rule_amendment') {
        throw new ConflictError('Rule-amendment outcomes are applied through the Constitution amendment endpoint', 'POLL_ACTION_USE_CONSTITUTION_ENDPOINT');
      }
      if (result.decisionType === 'dissolution') {
        throw new ConflictError('Chama dissolution teardown policy is not yet approved; no lifecycle transition was applied', 'POLL_DISSOLUTION_POLICY_NOT_CONFIGURED');
      }
      if (result.decisionType === 'payout_order_dispute') {
        throw new ConflictError('Payout-order dispute settlement must be applied by the governed payout domain', 'POLL_PAYOUT_ACTION_NOT_CONFIGURED');
      }
      if (result.decisionType === 'general') {
        throw new ConflictError('General polls do not have an automatic domain action', 'POLL_GENERAL_HAS_NO_ACTION');
      }

      const payload = result.decisionPayload as { member_id?: unknown; reason?: unknown };
      if (typeof payload.member_id !== 'string') {
        throw new ConflictError('Member-removal poll payload is invalid', 'POLL_MEMBER_REMOVAL_PAYLOAD_INVALID');
      }
      const membership = (await client.query<{ id: string; user_id: string; role: string; membership_status: string }>(
        `SELECT id, user_id, role::text AS role, membership_status::text AS membership_status
           FROM chama_members WHERE id = $1 AND chama_id = $2 FOR UPDATE`,
        [payload.member_id, poll.chama_id],
      )).rows[0];
      if (!membership) throw new NotFoundError('Target membership not found', 'POLL_MEMBER_REMOVAL_TARGET_NOT_FOUND');
      if (membership.membership_status === 'exited') {
        throw new ConflictError('Target membership has already exited', 'POLL_MEMBER_ALREADY_EXITED');
      }
      if (membership.role === 'chairperson' && membership.membership_status === 'active') {
        const otherChairs = Number((await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM chama_members
            WHERE chama_id = $1 AND role = 'chairperson' AND membership_status = 'active' AND id <> $2`,
          [poll.chama_id, membership.id],
        )).rows[0]?.count ?? 0);
        if (otherChairs < 1) throw new ConflictError('Cannot remove the final active Chairperson', 'CHAMA_LAST_CHAIRPERSON');
      }

      await client.query(
        `UPDATE chama_members
            SET membership_status = 'exited', exit_date = CURRENT_DATE, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [membership.id],
      );
      const acted = await client.query(
        `UPDATE polls SET acted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND acted_at IS NULL`,
        [pollId],
      );
      if (acted.rowCount !== 1) throw new ConflictError('Poll outcome has already been applied', 'POLL_ALREADY_ACTED');

      await client.query(
        `INSERT INTO audit_logs (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
         VALUES ('moderation','poll_member_removal_applied',$1,'chairperson',$2,'membership',$3,$4::jsonb)`,
        [actorId, poll.chama_id, membership.id, JSON.stringify({ pollId, targetUserId: membership.user_id, reason: payload.reason ?? null })],
      );

      return {
        pollId,
        decisionType: result.decisionType,
        action: 'member_removed' as const,
        membershipId: membership.id,
        userId: membership.user_id,
        membershipStatus: 'exited' as const,
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async listForChama(actorId: string, chamaId: string, input: { page: number; perPage: number; status?: string }) {
    const member = await this.db.query(
      `SELECT 1 FROM chama_members WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
      [chamaId, actorId],
    );
    if (!member.rowCount) throw new ForbiddenError('Active Chama membership required', 'POLL_LIST_FORBIDDEN');
    const where = ['p.chama_id = $1'];
    const values: unknown[] = [chamaId];
    if (input.status) { where.push(`p.status = $2::poll_status`); values.push(input.status); }
    const count = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM polls p WHERE ${where.join(' AND ')}`,
      values,
    )).rows[0]?.count ?? 0);
    const limitIndex = values.length + 1;
    const offsetIndex = values.length + 2;
    const rows = await this.db.query<PollRow & { votes_cast: number; eligible_count: number }>(
      `SELECT p.id, p.chama_id, p.chama_rule_id, p.decision_type, p.decision_payload,
              p.action_option_code, p.title, p.description, p.quorum_threshold_pct::text,
              p.majority_threshold_pct::text, p.status::text AS status, p.opens_at::text,
              p.closes_at::text, p.created_by, p.closed_at::text, p.close_reason,
              p.acted_at::text, p.created_at::text, p.updated_at::text,
              COUNT(DISTINCT v.member_id)::int AS votes_cast,
              COUNT(DISTINCT ev.member_id)::int AS eligible_count
         FROM polls p
         LEFT JOIN poll_eligible_voters ev ON ev.poll_id = p.id
         LEFT JOIN poll_votes v ON v.poll_id = p.id
        WHERE ${where.join(' AND ')}
        GROUP BY p.id
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...values, input.perPage, (input.page - 1) * input.perPage],
    );
    return {
      polls: rows.rows.map((row) => ({
        id: row.id,
        chamaId: row.chama_id,
        decisionType: row.decision_type,
        title: row.title,
        status: row.status,
        opensAt: row.opens_at,
        closesAt: row.closes_at,
        closedAt: row.closed_at,
        closeReason: row.close_reason,
        votesCast: Number(row.votes_cast),
        eligibleCount: Number(row.eligible_count),
      })),
      meta: { total: count, page: input.page, perPage: input.perPage, totalPages: count ? Math.ceil(count / input.perPage) : 0 },
    };
  }
}

async function lockPoll(client: PoolClient, pollId: string): Promise<PollRow> {
  const row = (await client.query<PollRow>(
    `SELECT id, chama_id, chama_rule_id, decision_type, decision_payload, action_option_code,
            title, description, quorum_threshold_pct::text, majority_threshold_pct::text,
            status::text AS status, opens_at::text, closes_at::text, created_by,
            closed_at::text, close_reason, acted_at::text, created_at::text, updated_at::text
       FROM polls WHERE id = $1 FOR UPDATE`,
    [pollId],
  )).rows[0];
  if (!row) throw new NotFoundError('Poll not found', 'POLL_NOT_FOUND');
  return row;
}

async function refreshLockedPoll(client: PoolClient, poll: PollRow, now: Date): Promise<void> {
  if (poll.status === 'closed' || poll.status === 'cancelled') return;
  const counts = (await client.query<{ eligible: number; votes: number }>(
    `SELECT COUNT(DISTINCT ev.member_id)::int AS eligible,
            COUNT(DISTINCT v.member_id)::int AS votes
       FROM poll_eligible_voters ev
       LEFT JOIN poll_votes v ON v.poll_id = ev.poll_id AND v.member_id = ev.member_id
      WHERE ev.poll_id = $1`,
    [poll.id],
  )).rows[0];
  const eligible = Number(counts?.eligible ?? 0);
  const votes = Number(counts?.votes ?? 0);

  if (eligible > 0 && votes >= eligible) {
    await client.query(
      `UPDATE polls SET status = 'closed', closed_at = COALESCE(closed_at, $2),
                        close_reason = COALESCE(close_reason, 'full_turnout'), updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status IN ('draft','open')`,
      [poll.id, now],
    );
    return;
  }
  if (new Date(poll.closes_at) <= now) {
    await client.query(
      `UPDATE polls SET status = 'closed', closed_at = COALESCE(closed_at, $2),
                        close_reason = COALESCE(close_reason, 'deadline'), updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 AND status IN ('draft','open')`,
      [poll.id, now],
    );
    return;
  }
  if (poll.status === 'draft' && (!poll.opens_at || new Date(poll.opens_at) <= now)) {
    await client.query(`UPDATE polls SET status = 'open', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'draft'`, [poll.id]);
  }
}

export async function evaluatePollWithinTransaction(
  client: PoolClient,
  pollId: string,
  chamaId: string,
  now = new Date(),
): Promise<PollEvaluation> {
  const poll = await lockPoll(client, pollId);
  if (poll.chama_id !== chamaId) throw new NotFoundError('Poll not found for Chama', 'POLL_NOT_FOUND');
  await refreshLockedPoll(client, poll, now);
  return evaluateLockedPoll(client, pollId, chamaId, now);
}

async function evaluateLockedPoll(client: PoolClient, pollId: string, chamaId: string, now: Date): Promise<PollEvaluation> {
  let poll = await lockPoll(client, pollId);
  if (poll.chama_id !== chamaId) throw new NotFoundError('Poll not found for Chama', 'POLL_NOT_FOUND');
  await refreshLockedPoll(client, poll, now);
  poll = await lockPoll(client, pollId);

  const eligible = Number((await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM poll_eligible_voters WHERE poll_id = $1`, [pollId],
  )).rows[0]?.count ?? 0);
  const tallies = (await client.query<OptionTallyRow>(
    `SELECT o.id, o.code, o.label, o.sort_order, COUNT(v.id)::int AS votes
       FROM poll_options o
       LEFT JOIN poll_votes v ON v.option_id = o.id AND v.poll_id = o.poll_id
      WHERE o.poll_id = $1
      GROUP BY o.id
      ORDER BY o.sort_order, o.id`,
    [pollId],
  )).rows;
  const votesCast = tallies.reduce((sum, row) => sum + Number(row.votes), 0);
  const turnoutPct = eligible === 0 ? 0 : (votesCast / eligible) * 100;
  const quorumThreshold = Number(poll.quorum_threshold_pct);
  const majorityThreshold = Number(poll.majority_threshold_pct);
  const quorumMet = turnoutPct >= quorumThreshold;
  const maxVotes = tallies.length ? Math.max(...tallies.map((row) => Number(row.votes))) : 0;
  const winningOptionCodes = maxVotes === 0 ? [] : tallies.filter((row) => Number(row.votes) === maxVotes).map((row) => row.code);
  const actionRow = poll.action_option_code
    ? tallies.find((row) => row.code === poll.action_option_code) ?? null
    : (winningOptionCodes.length === 1 ? tallies.find((row) => row.code === winningOptionCodes[0]) ?? null : null);
  const actionVotes = actionRow ? Number(actionRow.votes) : null;
  const actionVotePct = actionVotes === null || votesCast === 0 ? null : (actionVotes / votesCast) * 100;
  const majorityMet = Boolean(quorumMet && actionVotePct !== null && actionVotePct >= majorityThreshold);

  return {
    id: poll.id,
    chamaId: poll.chama_id,
    chamaRuleId: poll.chama_rule_id,
    decisionType: poll.decision_type,
    decisionPayload: poll.decision_payload ?? {},
    actionOptionCode: poll.action_option_code,
    title: poll.title,
    description: poll.description,
    status: poll.status,
    opensAt: poll.opens_at,
    closesAt: poll.closes_at,
    closedAt: poll.closed_at,
    closeReason: poll.close_reason,
    thresholds: { quorumPct: quorumThreshold, majorityPct: majorityThreshold },
    participation: { eligible, votesCast, turnoutPct, quorumMet },
    tallies: tallies.map((row) => ({
      id: row.id,
      code: row.code,
      label: row.label,
      votes: Number(row.votes),
      percentage: votesCast === 0 ? 0 : (Number(row.votes) / votesCast) * 100,
    })),
    winningOptionCodes,
    actionVotes,
    actionVotePct,
    majorityMet,
    actionable: poll.status === 'closed' && majorityMet && poll.acted_at === null && poll.decision_type !== 'general',
    actedAt: poll.acted_at,
  };
}

export const pollService = new PollService();
