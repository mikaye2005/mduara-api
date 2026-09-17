import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { GoalCatalogService } from './goal-catalog.service';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors';

export type MerchantRewardState = 'locked' | 'eligible' | 'redeemed' | 'expired' | 'revoked';

interface MembershipContextRow extends QueryResultRow {
  id: string;
  user_id: string;
  membership_status: string;
  chama_id: string;
  goal_code: string | null;
}

interface MerchantRow extends QueryResultRow {
  partnership_id: string;
  merchant_id: string;
  merchant_code: string;
  merchant_name: string;
  merchant_description: string | null;
  logo_url: string | null;
  website_url: string | null;
  merchant_is_demo: boolean;
  offer_title: string;
  offer_summary: string;
  offer_terms: string | null;
  reward_rules: Record<string, unknown>;
  valid_from: string | null;
  valid_until: string | null;
  partnership_is_demo: boolean;
  reward_id: string | null;
  reward_state: MerchantRewardState | null;
  eligible_at: string | null;
  redeemed_at: string | null;
}

interface RewardRow extends QueryResultRow {
  id: string;
  state: MerchantRewardState;
  membership_id: string;
  partnership_id: string;
  eligibility_reference: string | null;
  redemption_reference: string | null;
  eligible_at: string | null;
  redeemed_at: string | null;
}

interface EligibilityInput {
  membershipId: string;
  partnershipId: string;
  source: string;
  reference: string;
  fingerprint: string;
}

interface RedemptionInput {
  rewardId: string;
  source: string;
  reference: string;
  fingerprint: string;
}

export class MerchantRewardService {
  constructor(private readonly db: Pool = pool) {}

  async listGoalMerchants(
    identifier: string,
    context: { membershipId?: string; userId?: string } = {},
  ) {
    const goal = await new GoalCatalogService(this.db).getGoal(identifier);
    let membership: MembershipContextRow | null = null;

    if (context.membershipId) {
      if (!context.userId) throw new UnauthorizedError('Authentication is required for membership reward state');
      membership = await this.loadMembership(context.membershipId);
      if (membership.user_id !== context.userId) {
        throw new ForbiddenError('Reward state is private to the membership owner');
      }
      if (membership.membership_status !== 'active') {
        throw new BadRequestError('Reward state requires an active membership');
      }
      if (membership.goal_code !== goal.code) {
        throw new BadRequestError('Membership does not belong to the requested saving goal');
      }
    }

    const result = await this.db.query<MerchantRow>(
      `SELECT gmp.id AS partnership_id,
              pm.id AS merchant_id,
              pm.code AS merchant_code,
              pm.name AS merchant_name,
              pm.description AS merchant_description,
              pm.logo_url,
              pm.website_url,
              pm.is_demo AS merchant_is_demo,
              gmp.offer_title,
              gmp.offer_summary,
              gmp.offer_terms,
              gmp.reward_rules,
              gmp.valid_from::text,
              gmp.valid_until::text,
              gmp.is_demo AS partnership_is_demo,
              mmr.id AS reward_id,
              mmr.state::text AS reward_state,
              mmr.eligible_at::text,
              mmr.redeemed_at::text
       FROM goal_merchant_partnerships gmp
       JOIN partner_merchants pm ON pm.id = gmp.merchant_id
       LEFT JOIN member_merchant_rewards mmr
         ON mmr.partnership_id = gmp.id
        AND mmr.membership_id = $2::uuid
       WHERE gmp.goal_id = $1::uuid
         AND pm.status = 'active'
         AND gmp.status = 'active'
         AND (gmp.valid_from IS NULL OR gmp.valid_from <= CURRENT_TIMESTAMP)
         AND (gmp.valid_until IS NULL OR gmp.valid_until > CURRENT_TIMESTAMP)
       ORDER BY pm.name ASC, gmp.id ASC`,
      [goal.id, membership?.id ?? null],
    );

    return {
      goal,
      membershipId: membership?.id ?? null,
      merchants: result.rows.map((row) => ({
        partnershipId: row.partnership_id,
        merchant: {
          id: row.merchant_id,
          code: row.merchant_code,
          name: row.merchant_name,
          description: row.merchant_description,
          logoUrl: row.logo_url,
          websiteUrl: row.website_url,
          isDemo: row.merchant_is_demo,
        },
        offer: {
          title: row.offer_title,
          summary: row.offer_summary,
          terms: row.offer_terms,
          rewardRules: row.reward_rules ?? {},
          validFrom: row.valid_from,
          validUntil: row.valid_until,
          isDemo: row.partnership_is_demo,
        },
        reward: {
          id: row.reward_id,
          state: row.reward_state ?? 'locked',
          eligibleAt: row.eligible_at,
          redeemedAt: row.redeemed_at,
          serverConfirmed: row.reward_state === 'eligible' || row.reward_state === 'redeemed',
        },
      })),
      meta: { count: result.rows.length, rewardStateAuthority: 'server' as const },
    };
  }

  /** Internal server/job boundary. No public route grants eligibility. */
  async grantEligibility(input: EligibilityInput) {
    this.assertEvidence(input.source, input.reference, input.fingerprint);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const eligibility = await this.loadEligibilityContext(client, input.membershipId, input.partnershipId);
      this.assertEligibilityContext(eligibility);

      const existing = await client.query<RewardRow>(
        `SELECT id, state::text AS state, membership_id, partnership_id,
                eligibility_reference, redemption_reference,
                eligible_at::text, redeemed_at::text
         FROM member_merchant_rewards
         WHERE membership_id = $1 AND partnership_id = $2
         FOR UPDATE`,
        [input.membershipId, input.partnershipId],
      );

      let result;
      const row = existing.rows[0];
      if (!row) {
        result = await client.query<RewardRow>(
          `INSERT INTO member_merchant_rewards
             (membership_id, partnership_id, state, eligibility_source,
              eligibility_reference, eligibility_fingerprint, eligible_at)
           VALUES ($1, $2, 'eligible', $3, $4, $5, CURRENT_TIMESTAMP)
           RETURNING id, state::text AS state, membership_id, partnership_id,
                     eligibility_reference, redemption_reference,
                     eligible_at::text, redeemed_at::text`,
          [input.membershipId, input.partnershipId, input.source, input.reference, input.fingerprint],
        );
      } else if (row.state === 'locked') {
        result = await client.query<RewardRow>(
          `UPDATE member_merchant_rewards
           SET state = 'eligible', eligibility_source = $3, eligibility_reference = $4,
               eligibility_fingerprint = $5, eligible_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND membership_id = $2
           RETURNING id, state::text AS state, membership_id, partnership_id,
                     eligibility_reference, redemption_reference,
                     eligible_at::text, redeemed_at::text`,
          [row.id, input.membershipId, input.source, input.reference, input.fingerprint],
        );
      } else if (row.state === 'eligible' && row.eligibility_reference === input.reference) {
        result = { rows: [row] } as { rows: RewardRow[] };
      } else {
        throw new ConflictError(`Reward is already ${row.state}`);
      }

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Internal trusted boundary for merchant/provider-confirmed redemption. */
  async recordRedemption(input: RedemptionInput) {
    this.assertEvidence(input.source, input.reference, input.fingerprint);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<RewardRow & { partnership_status: string; merchant_status: string; valid_from: Date | null; valid_until: Date | null }>(
        `SELECT mmr.id, mmr.state::text AS state, mmr.membership_id, mmr.partnership_id,
                mmr.eligibility_reference, mmr.redemption_reference,
                mmr.eligible_at::text, mmr.redeemed_at::text,
                gmp.status::text AS partnership_status, pm.status::text AS merchant_status,
                gmp.valid_from, gmp.valid_until
         FROM member_merchant_rewards mmr
         JOIN goal_merchant_partnerships gmp ON gmp.id = mmr.partnership_id
         JOIN partner_merchants pm ON pm.id = gmp.merchant_id
         WHERE mmr.id = $1
         FOR UPDATE OF mmr`,
        [input.rewardId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundError('Merchant reward not found');
      if (row.state === 'redeemed' && row.redemption_reference === input.reference) {
        await client.query('COMMIT');
        return row;
      }
      if (row.state !== 'eligible') throw new ConflictError(`Reward is ${row.state}, not eligible`);
      const now = new Date();
      if (row.merchant_status !== 'active' || row.partnership_status !== 'active'
        || (row.valid_from && row.valid_from > now) || (row.valid_until && row.valid_until <= now)) {
        throw new ConflictError('Merchant partnership is not currently redeemable');
      }

      const updated = await client.query<RewardRow>(
        `UPDATE member_merchant_rewards
         SET state = 'redeemed', redemption_source = $2, redemption_reference = $3,
             redemption_fingerprint = $4, redeemed_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING id, state::text AS state, membership_id, partnership_id,
                   eligibility_reference, redemption_reference,
                   eligible_at::text, redeemed_at::text`,
        [input.rewardId, input.source, input.reference, input.fingerprint],
      );
      await client.query('COMMIT');
      return updated.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadMembership(membershipId: string): Promise<MembershipContextRow> {
    const result = await this.db.query<MembershipContextRow>(
      `SELECT cm.id, cm.user_id, cm.membership_status::text AS membership_status,
              cm.chama_id, c.goal_code
       FROM chama_members cm
       JOIN chamas c ON c.id = cm.chama_id
       WHERE cm.id = $1`,
      [membershipId],
    );
    if (!result.rows[0]) throw new NotFoundError('Membership not found');
    return result.rows[0];
  }

  private async loadEligibilityContext(client: PoolClient, membershipId: string, partnershipId: string) {
    const result = await client.query<{
      membership_status: string;
      chama_goal_code: string | null;
      partnership_status: string;
      merchant_status: string;
      partnership_goal_code: string;
      valid_from: Date | null;
      valid_until: Date | null;
    }>(
      `SELECT cm.membership_status::text AS membership_status,
              c.goal_code AS chama_goal_code,
              gmp.status::text AS partnership_status,
              pm.status::text AS merchant_status,
              sg.code AS partnership_goal_code,
              gmp.valid_from,
              gmp.valid_until
       FROM chama_members cm
       JOIN chamas c ON c.id = cm.chama_id
       CROSS JOIN goal_merchant_partnerships gmp
       JOIN saving_goals sg ON sg.id = gmp.goal_id
       JOIN partner_merchants pm ON pm.id = gmp.merchant_id
       WHERE cm.id = $1 AND gmp.id = $2
       FOR UPDATE OF cm, gmp`,
      [membershipId, partnershipId],
    );
    if (!result.rows[0]) throw new NotFoundError('Membership or merchant partnership not found');
    return result.rows[0];
  }

  private assertEligibilityContext(row: {
    membership_status: string;
    chama_goal_code: string | null;
    partnership_status: string;
    merchant_status: string;
    partnership_goal_code: string;
    valid_from: Date | null;
    valid_until: Date | null;
  }) {
    if (row.membership_status !== 'active') throw new ConflictError('Membership is not active');
    if (!row.chama_goal_code || row.chama_goal_code !== row.partnership_goal_code) {
      throw new ConflictError('Membership goal does not match merchant partnership goal');
    }
    const now = new Date();
    if (row.merchant_status !== 'active' || row.partnership_status !== 'active'
      || (row.valid_from && row.valid_from > now) || (row.valid_until && row.valid_until <= now)) {
      throw new ConflictError('Merchant partnership is not currently eligible');
    }
  }

  private assertEvidence(source: string, reference: string, fingerprint: string) {
    if (!source.trim() || !reference.trim() || fingerprint.trim().length < 32) {
      throw new BadRequestError('Server reward evidence is incomplete');
    }
  }
}

export const merchantRewardService = new MerchantRewardService();
