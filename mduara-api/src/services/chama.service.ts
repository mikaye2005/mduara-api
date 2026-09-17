import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { ChamaBusinessBase, CONSTITUTION_TEMPLATES, mergeConstitutionTemplate, type ConstitutionSetupParams, type ConstitutionTemplateCode } from '../shared/business_base';
import { ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import { constitutionRuleFieldsSchema } from '../validation/chama.validation';
import { evaluatePollWithinTransaction } from './poll.service';
import { NotificationService } from './notification.service';

interface ConstitutionRuleRow extends QueryResultRow {
  id: string;
  chama_id: string;
  version: number;
  status: 'draft' | 'active' | 'superseded';
  template_code: ConstitutionTemplateCode;
  purpose_goal: string;
  contribution_amount: string;
  contribution_frequency: string;
  contribution_due_day: number | null;
  late_fine_type: 'flat' | 'percentage';
  late_fine_amount: string;
  late_fine_percentage: string;
  commitment_amount: string;
  default_grace_period_days: number;
  default_after_consecutive_misses: number;
  quorum_threshold_pct: string;
  majority_threshold_pct: string;
  exit_withdrawal_policy: Record<string, unknown>;
  payout_policy: Record<string, unknown>;
  conduct_dispute_policy: Record<string, unknown>;
  dissolution_policy: Record<string, unknown>;
  metadata: Record<string, unknown>;
  effective_from: string | null;
  supersedes_id: string | null;
  amendment_summary: string | null;
  amendment_poll_id: string | null;
  created_by: string | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
  acceptance_count?: number;
  amendment_poll_title?: string | null;
  amendment_poll_status?: string | null;
}

export interface ConstitutionAmendmentInput extends ConstitutionSetupParams {
  poll_id: string;
  amendment_summary: string;
}

export class ChamaService extends ChamaBusinessBase {
  private readonly notifications: NotificationService;

  constructor(db: Pool = pool) {
    super(db);
    this.notifications = new NotificationService(db);
  }

  listConstitutionTemplates() {
    return Object.values(CONSTITUTION_TEMPLATES).map((template) => ({
      code: template.code,
      label: template.label,
      description: template.description,
      defaults: {
        exitWithdrawalPolicy: template.exit_withdrawal_policy,
        payoutPolicy: template.payout_policy,
        conductDisputePolicy: template.conduct_dispute_policy,
        dissolutionPolicy: template.dissolution_policy,
      },
    }));
  }

  async getConstitution(chamaId: string, actorId: string) {
    const membership = await this.requireActiveMembership(this.db, chamaId, actorId);
    const rules = await this.db.query<ConstitutionRuleRow>(
      `SELECT r.*,
              u.full_name AS created_by_name,
              COUNT(a.id)::int AS acceptance_count,
              p.title AS amendment_poll_title,
              p.status::text AS amendment_poll_status
         FROM chama_rules r
         LEFT JOIN users u ON u.id = r.created_by
         LEFT JOIN membership_constitution_acceptances a ON a.chama_rule_id = r.id
         LEFT JOIN polls p ON p.id = r.amendment_poll_id
        WHERE r.chama_id = $1
        GROUP BY r.id, u.full_name, p.title, p.status
        ORDER BY r.version DESC`,
      [chamaId],
    );
    if (rules.rows.length === 0) throw new NotFoundError('Constitution not found', 'CONSTITUTION_NOT_FOUND');

    const current = rules.rows.find((rule) => rule.status === 'active') ?? null;
    const accepted = current
      ? (await this.db.query<{ accepted_at: string; ip_address: string | null; user_agent: string | null }>(
          `SELECT accepted_at, host(ip_address) AS ip_address, user_agent
             FROM membership_constitution_acceptances
            WHERE membership_id = $1 AND chama_rule_id = $2`,
          [membership.id, current.id],
        )).rows[0] ?? null
      : null;

    return {
      chamaId,
      current: current ? serializeRule(current) : null,
      currentAcceptance: accepted ? {
        accepted: true,
        acceptedAt: accepted.accepted_at,
        ipAddress: accepted.ip_address,
        userAgent: accepted.user_agent,
      } : { accepted: false, acceptedAt: null, ipAddress: null, userAgent: null },
      history: rules.rows.map(serializeRule),
    };
  }

  async configureConstitution(chamaId: string, actorId: string, input: ConstitutionSetupParams) {
    return this.transaction(async (client) => {
      await this.requireChairperson(client, chamaId, actorId);
      const rule = await this.requireActiveRule(client, chamaId, true);

      const ruleCount = Number((await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM chama_rules WHERE chama_id = $1`,
        [chamaId],
      )).rows[0]?.count ?? 0);
      const acceptanceCount = Number((await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM membership_constitution_acceptances
          WHERE chama_rule_id = $1`,
        [rule.id],
      )).rows[0]?.count ?? 0);
      const applicantAcceptanceCount = Number((await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
           FROM chama_applications
          WHERE chama_rule_id = $1 AND constitution_accepted_at IS NOT NULL`,
        [rule.id],
      )).rows[0]?.count ?? 0);

      if (rule.version !== 1 || ruleCount !== 1 || acceptanceCount > 0 || applicantAcceptanceCount > 0) {
        throw new ConflictError(
          'The active Constitution has already been accepted or versioned; use the amendment workflow',
          'CONSTITUTION_SETUP_LOCKED',
        );
      }

      const templateCode = input.template_code ?? rule.template_code;
      const template = mergeConstitutionTemplate(templateCode, input);
      const contributionAmount = input.contribution_amount ?? Number(rule.contribution_amount);
      const contributionFrequency = input.contribution_frequency ?? rule.contribution_frequency;

      const updated = (await client.query<ConstitutionRuleRow>(
        `UPDATE chama_rules
            SET template_code = $2,
                purpose_goal = $3,
                contribution_amount = $4,
                contribution_frequency = $5,
                contribution_due_day = $6,
                late_fine_type = $7,
                late_fine_amount = $8,
                late_fine_percentage = $9,
                default_grace_period_days = $10,
                default_after_consecutive_misses = $11,
                quorum_threshold_pct = $12,
                majority_threshold_pct = $13,
                exit_withdrawal_policy = $14::jsonb,
                payout_policy = $15::jsonb,
                conduct_dispute_policy = $16::jsonb,
                dissolution_policy = $17::jsonb,
                metadata = COALESCE(metadata, '{}'::jsonb) || $18::jsonb,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
          RETURNING *`,
        [
          rule.id,
          template.template_code,
          input.purpose_goal ?? rule.purpose_goal,
          contributionAmount,
          contributionFrequency,
          input.contribution_due_day === undefined ? rule.contribution_due_day : input.contribution_due_day,
          input.late_fine_type ?? rule.late_fine_type,
          input.late_fine_amount ?? Number(rule.late_fine_amount),
          input.late_fine_percentage ?? Number(rule.late_fine_percentage),
          input.default_grace_period_days ?? rule.default_grace_period_days,
          input.default_after_consecutive_misses ?? rule.default_after_consecutive_misses,
          input.quorum_threshold_pct ?? Number(rule.quorum_threshold_pct),
          input.majority_threshold_pct ?? Number(rule.majority_threshold_pct),
          JSON.stringify(input.template_code !== undefined || input.exit_withdrawal_policy !== undefined ? template.exit_withdrawal_policy : rule.exit_withdrawal_policy),
          JSON.stringify(input.template_code !== undefined || input.payout_policy !== undefined ? template.payout_policy : rule.payout_policy),
          JSON.stringify(input.template_code !== undefined || input.conduct_dispute_policy !== undefined ? template.conduct_dispute_policy : rule.conduct_dispute_policy),
          JSON.stringify(input.template_code !== undefined || input.dissolution_policy !== undefined ? template.dissolution_policy : rule.dissolution_policy),
          JSON.stringify({ templateCode: template.template_code, templateVersion: 1, setupConfigured: true }),
        ],
      )).rows[0];

      if (input.contribution_amount !== undefined || input.contribution_frequency !== undefined) {
        await client.query(
          `UPDATE chamas
              SET contribution_amount = $2, contribution_frequency = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [chamaId, contributionAmount, contributionFrequency],
        );
      }

      return serializeRule(updated);
    });
  }

  /**
   * Activate a Constitution amendment only from an authoritative BE-17 poll.
   * The poll freezes both the action option and exact proposed changes; the
   * request must match that frozen payload byte-for-byte after canonicalization.
   */
  async amendConstitution(chamaId: string, actorId: string, input: ConstitutionAmendmentInput) {
    const activated = await this.transaction(async (client) => {
      await this.requireChairperson(client, chamaId, actorId);
      const activeRule = await this.requireActiveRule(client, chamaId, true);
      const result = await evaluatePollWithinTransaction(client, input.poll_id, chamaId, new Date());

      if (result.decisionType !== 'rule_amendment') {
        throw new ConflictError('Poll is not a Constitution amendment decision', 'CONSTITUTION_AMENDMENT_POLL_TYPE_INVALID');
      }
      if (result.chamaRuleId !== activeRule.id) {
        throw new ConflictError('Poll does not target the current Constitution version', 'CONSTITUTION_AMENDMENT_STALE_POLL');
      }
      if (result.status !== 'closed') {
        throw new ConflictError('Amendment poll is not closed', 'CONSTITUTION_AMENDMENT_POLL_NOT_CLOSED');
      }
      if (!result.participation.quorumMet) {
        throw new ConflictError('Amendment poll did not meet Constitution quorum', 'CONSTITUTION_AMENDMENT_QUORUM_NOT_MET');
      }
      if (!result.majorityMet || !result.actionable) {
        throw new ConflictError('Amendment poll did not approve the proposed action', 'CONSTITUTION_AMENDMENT_NOT_APPROVED');
      }

      const payload = result.decisionPayload as { amendment_summary?: unknown; changes?: unknown };
      const summary = typeof payload.amendment_summary === 'string' ? payload.amendment_summary.trim() : '';
      const changes = constitutionRuleFieldsSchema.parse(payload.changes ?? {});
      if (!summary || Object.keys(changes).length === 0) {
        throw new ConflictError('Approved amendment payload is incomplete', 'CONSTITUTION_AMENDMENT_PAYLOAD_INVALID');
      }

      const requestedChanges = constitutionRuleFieldsSchema.parse(
        Object.fromEntries(Object.entries(input).filter(([key, value]) =>
          !['poll_id', 'amendment_summary'].includes(key) && value !== undefined,
        )),
      );
      if (summary !== input.amendment_summary.trim() || stableJson(changes) !== stableJson(requestedChanges)) {
        throw new ConflictError(
          'Requested Constitution changes do not match the changes approved by the poll',
          'CONSTITUTION_AMENDMENT_PAYLOAD_MISMATCH',
        );
      }

      const templateCode = changes.template_code ?? activeRule.template_code;
      const template = mergeConstitutionTemplate(templateCode, changes);
      const next = {
        template_code: templateCode,
        purpose_goal: changes.purpose_goal ?? activeRule.purpose_goal,
        contribution_amount: changes.contribution_amount ?? Number(activeRule.contribution_amount),
        contribution_frequency: changes.contribution_frequency ?? activeRule.contribution_frequency,
        contribution_due_day: changes.contribution_due_day === undefined ? activeRule.contribution_due_day : changes.contribution_due_day,
        late_fine_type: changes.late_fine_type ?? activeRule.late_fine_type,
        late_fine_amount: changes.late_fine_amount ?? Number(activeRule.late_fine_amount),
        late_fine_percentage: changes.late_fine_percentage ?? Number(activeRule.late_fine_percentage),
        default_grace_period_days: changes.default_grace_period_days ?? activeRule.default_grace_period_days,
        default_after_consecutive_misses: changes.default_after_consecutive_misses ?? activeRule.default_after_consecutive_misses,
        quorum_threshold_pct: changes.quorum_threshold_pct ?? Number(activeRule.quorum_threshold_pct),
        majority_threshold_pct: changes.majority_threshold_pct ?? Number(activeRule.majority_threshold_pct),
        exit_withdrawal_policy: changes.template_code !== undefined || changes.exit_withdrawal_policy !== undefined
          ? template.exit_withdrawal_policy : activeRule.exit_withdrawal_policy,
        payout_policy: changes.template_code !== undefined || changes.payout_policy !== undefined
          ? template.payout_policy : activeRule.payout_policy,
        conduct_dispute_policy: changes.template_code !== undefined || changes.conduct_dispute_policy !== undefined
          ? template.conduct_dispute_policy : activeRule.conduct_dispute_policy,
        dissolution_policy: changes.template_code !== undefined || changes.dissolution_policy !== undefined
          ? template.dissolution_policy : activeRule.dissolution_policy,
      };

      await client.query(
        `UPDATE chama_rules SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'active'`,
        [activeRule.id],
      );
      const created = (await client.query<ConstitutionRuleRow>(
        `INSERT INTO chama_rules (
           chama_id, version, status, template_code, purpose_goal,
           contribution_amount, contribution_frequency, contribution_due_day,
           late_fine_type, late_fine_amount, late_fine_percentage,
           commitment_amount, default_grace_period_days, default_after_consecutive_misses,
           quorum_threshold_pct, majority_threshold_pct,
           exit_withdrawal_policy, payout_policy, conduct_dispute_policy, dissolution_policy,
           metadata, effective_from, supersedes_id, amendment_summary, amendment_poll_id, created_by
         ) VALUES (
           $1,$2,'active',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
           $16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,
           CURRENT_TIMESTAMP,$21,$22,$23,$24
         ) RETURNING *`,
        [
          chamaId,
          activeRule.version + 1,
          next.template_code,
          next.purpose_goal,
          next.contribution_amount,
          next.contribution_frequency,
          next.contribution_due_day,
          next.late_fine_type,
          next.late_fine_amount,
          next.late_fine_percentage,
          activeRule.commitment_amount,
          next.default_grace_period_days,
          next.default_after_consecutive_misses,
          next.quorum_threshold_pct,
          next.majority_threshold_pct,
          JSON.stringify(next.exit_withdrawal_policy),
          JSON.stringify(next.payout_policy),
          JSON.stringify(next.conduct_dispute_policy),
          JSON.stringify(next.dissolution_policy),
          JSON.stringify({ ...(activeRule.metadata ?? {}), amendmentPollId: result.id }),
          activeRule.id,
          summary,
          result.id,
          actorId,
        ],
      )).rows[0];

      if (changes.contribution_amount !== undefined || changes.contribution_frequency !== undefined) {
        await client.query(
          `UPDATE chamas
              SET contribution_amount = $2, contribution_frequency = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
          [chamaId, next.contribution_amount, next.contribution_frequency],
        );
      }

      const acted = await client.query(
        `UPDATE polls SET acted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND acted_at IS NULL`,
        [result.id],
      );
      if (acted.rowCount !== 1) {
        throw new ConflictError('Amendment poll has already been acted on', 'POLL_ALREADY_ACTED');
      }

      const recipients = (await client.query<{ user_id: string }>(
        `SELECT user_id FROM chama_members WHERE chama_id = $1 AND membership_status = 'active'`,
        [chamaId],
      )).rows.map((row) => row.user_id);
      const chamaName = (await client.query<{ name: string }>(`SELECT name FROM chamas WHERE id = $1`, [chamaId])).rows[0]?.name ?? 'your Chama';

      return { rule: serializeRule(created), recipients, chamaName };
    });

    if (activated.recipients.length) {
      await this.notifications.dispatchBestEffort({
        userIds: activated.recipients,
        template: 'constitution_amended',
        chamaId,
        channels: ['in_app'],
        data: { chamaName: activated.chamaName, version: activated.rule.version },
        dedupeKey: `constitution-amended:${activated.rule.id}`,
      });
    }
    return activated.rule;
  }

  async acceptCurrentConstitution(
    membershipId: string,
    userId: string,
    evidence: { ipAddress?: string | null; userAgent?: string | null },
  ) {
    return this.transaction(async (client) => {
      const membership = (await client.query<{ id: string; chama_id: string; user_id: string; membership_status: string }>(
        `SELECT id, chama_id, user_id, membership_status::text AS membership_status
           FROM chama_members
          WHERE id = $1
          FOR UPDATE`,
        [membershipId],
      )).rows[0];
      if (!membership) throw new NotFoundError('Membership not found');
      if (membership.user_id !== userId) throw new ForbiddenError('Constitution acceptance is owner-scoped');
      if (membership.membership_status === 'exited') {
        throw new ConflictError('Exited memberships cannot accept a new Constitution version', 'MEMBERSHIP_EXITED');
      }

      const rule = await this.requireActiveRule(client, membership.chama_id, false);
      const existing = (await client.query<{ accepted_at: string; ip_address: string | null; user_agent: string | null }>(
        `SELECT accepted_at, host(ip_address) AS ip_address, user_agent
           FROM membership_constitution_acceptances
          WHERE membership_id = $1 AND chama_rule_id = $2`,
        [membership.id, rule.id],
      )).rows[0];
      if (existing) {
        return {
          membershipId: membership.id,
          chamaId: membership.chama_id,
          constitution: { id: rule.id, version: rule.version },
          acceptedAt: existing.accepted_at,
          ipAddress: existing.ip_address,
          userAgent: existing.user_agent,
          replayed: true,
        };
      }

      const accepted = (await client.query<{ accepted_at: string; ip_address: string | null; user_agent: string | null }>(
        `INSERT INTO membership_constitution_acceptances
           (chama_id, membership_id, chama_rule_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4::inet, $5)
         RETURNING accepted_at, host(ip_address) AS ip_address, user_agent`,
        [membership.chama_id, membership.id, rule.id, evidence.ipAddress ?? null, evidence.userAgent ?? null],
      )).rows[0];

      return {
        membershipId: membership.id,
        chamaId: membership.chama_id,
        constitution: { id: rule.id, version: rule.version },
        acceptedAt: accepted.accepted_at,
        ipAddress: accepted.ip_address,
        userAgent: accepted.user_agent,
        replayed: false,
      };
    });
  }

  private async requireActiveMembership(queryable: { query: PoolClient['query'] }, chamaId: string, actorId: string) {
    const membership = (await queryable.query(
      `SELECT id, role::text AS role, membership_status::text AS membership_status
         FROM chama_members
        WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
      [chamaId, actorId],
    )).rows[0];
    if (!membership) throw new ForbiddenError('Active Chama membership required');
    return membership as { id: string; role: string; membership_status: string };
  }

  private async requireChairperson(queryable: { query: PoolClient['query'] }, chamaId: string, actorId: string) {
    const membership = await this.requireActiveMembership(queryable, chamaId, actorId);
    if (membership.role !== 'chairperson') {
      throw new ForbiddenError('Only the active Chairperson may manage Constitution versions');
    }
    return membership;
  }

  private async requireActiveRule(queryable: { query: PoolClient['query'] }, chamaId: string, forUpdate: boolean) {
    const rule = (await queryable.query<ConstitutionRuleRow>(
      `SELECT * FROM chama_rules
        WHERE chama_id = $1 AND status = 'active'
        ${forUpdate ? 'FOR UPDATE' : ''}`,
      [chamaId],
    )).rows[0];
    if (!rule) throw new ConflictError('Active Constitution not found', 'CONSTITUTION_NOT_AVAILABLE');
    return rule;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function serializeRule(rule: ConstitutionRuleRow) {
  return {
    id: rule.id,
    chamaId: rule.chama_id,
    version: Number(rule.version),
    status: rule.status,
    templateCode: rule.template_code,
    purposeGoal: rule.purpose_goal,
    contribution: {
      amount: rule.contribution_amount,
      frequency: rule.contribution_frequency,
      dueDay: rule.contribution_due_day,
    },
    lateFine: {
      type: rule.late_fine_type,
      amount: rule.late_fine_amount,
      percentage: rule.late_fine_percentage,
    },
    commitmentAmount: rule.commitment_amount,
    defaultGracePeriodDays: rule.default_grace_period_days,
    defaultAfterConsecutiveMisses: rule.default_after_consecutive_misses,
    quorumThresholdPct: rule.quorum_threshold_pct,
    majorityThresholdPct: rule.majority_threshold_pct,
    exitWithdrawalPolicy: rule.exit_withdrawal_policy,
    payoutPolicy: rule.payout_policy,
    conductDisputePolicy: rule.conduct_dispute_policy,
    dissolutionPolicy: rule.dissolution_policy,
    metadata: rule.metadata,
    effectiveFrom: rule.effective_from,
    supersedesId: rule.supersedes_id,
    amendmentSummary: rule.amendment_summary,
    amendmentPoll: rule.amendment_poll_id ? {
      id: rule.amendment_poll_id,
      title: rule.amendment_poll_title ?? null,
      status: rule.amendment_poll_status ?? null,
    } : null,
    createdBy: rule.created_by ? { id: rule.created_by, name: rule.created_by_name ?? null } : null,
    createdAt: rule.created_at,
    updatedAt: rule.updated_at,
    acceptanceCount: Number(rule.acceptance_count ?? 0),
  };
}

export const chamaService = new ChamaService();
