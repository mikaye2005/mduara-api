import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { ForbiddenError, NotFoundError, ServiceUnavailableError } from '../utils/errors';

export interface TrustFactor {
  code: string;
  label: string;
  effect: 'positive' | 'negative' | 'neutral';
  summary: string;
}

interface FormulaRow extends QueryResultRow {
  id: string;
  subject_type: 'member' | 'chama';
  version: string;
  public_description: string;
}

interface SnapshotRow extends QueryResultRow {
  id: string;
  score: string;
  level: string;
  factors: TrustFactor[];
  calculated_at: string;
  formula_version_id: string;
  formula_version: string;
  public_description: string;
}

interface MembershipRow extends QueryResultRow {
  id: string;
  user_id: string;
  chama_id: string;
  chama_name: string;
}

interface ChamaRow extends QueryResultRow {
  id: string;
  name: string;
  visibility: string;
}

export interface RecordTrustSnapshotInput {
  subjectType: 'member' | 'chama';
  formulaVersionId: string;
  membershipId?: string;
  chamaId?: string;
  score: number;
  level: string;
  factors: TrustFactor[];
  calculationKey: string;
  sourceFingerprint: string;
  calculatedAt?: Date;
}

const UNAVAILABLE_FORMULA = 'TRUST_SCORE_FORMULA_NOT_ACTIVATED';
const UNAVAILABLE_SNAPSHOT = 'TRUST_SCORE_NOT_CALCULATED';

function unavailable(subject: object, reason: string) {
  return {
    subject,
    available: false as const,
    score: null,
    level: null,
    factors: [] as TrustFactor[],
    calculatedAt: null,
    version: null,
    methodology: null,
    unavailableReason: reason,
  };
}

function available(subject: object, row: SnapshotRow) {
  return {
    subject,
    available: true as const,
    score: Number(row.score),
    level: row.level,
    factors: row.factors ?? [],
    calculatedAt: row.calculated_at,
    version: row.formula_version,
    methodology: row.public_description,
    unavailableReason: null,
  };
}

/**
 * BE-32 trust-score persistence/read contract.
 *
 * This service deliberately does NOT calculate a score from financial data.
 * A future calculation job must use an approved/active formula version and then
 * call recordSnapshot() with already-sanitized factors. Raw contribution values,
 * balances and payment-method details are never persisted in factors.
 */
export class TrustScoreService {
  constructor(private readonly db: Pool = pool) {}

  async getPublicChamaTrust(chamaId: string) {
    const chama = await this.loadPublicChama(chamaId);
    const subject = { type: 'chama' as const, chamaId: chama.id, name: chama.name };
    const formula = await this.getActiveFormula('chama');
    if (!formula) return unavailable(subject, UNAVAILABLE_FORMULA);

    const snapshot = await this.getCurrentSnapshot({ subjectType: 'chama', chamaId, formulaId: formula.id });
    return snapshot ? available(subject, snapshot) : unavailable(subject, UNAVAILABLE_SNAPSHOT);
  }

  async getOwnMembershipTrust(membershipId: string, userId: string) {
    const membership = await this.loadOwnedMembership(membershipId, userId);
    const subject = {
      type: 'member' as const,
      membershipId: membership.id,
      chamaId: membership.chama_id,
      chamaName: membership.chama_name,
    };
    const formula = await this.getActiveFormula('member');
    if (!formula) return unavailable(subject, UNAVAILABLE_FORMULA);

    const snapshot = await this.getCurrentSnapshot({
      subjectType: 'member',
      membershipId,
      chamaId: membership.chama_id,
      formulaId: formula.id,
    });
    return snapshot ? available(subject, snapshot) : unavailable(subject, UNAVAILABLE_SNAPSHOT);
  }

  async getOwnMembershipHistory(membershipId: string, userId: string, limit = 20) {
    const membership = await this.loadOwnedMembership(membershipId, userId);
    const result = await this.db.query<SnapshotRow>(
      `SELECT ts.id, ts.score::text, ts.level, ts.factors, ts.calculated_at::text,
              ts.formula_version_id, tf.version AS formula_version,
              tf.public_description
       FROM trust_score_snapshots ts
       JOIN trust_score_formula_versions tf ON tf.id = ts.formula_version_id
       WHERE ts.subject_type = 'member' AND ts.membership_id = $1
       ORDER BY ts.calculated_at DESC, ts.id DESC
       LIMIT $2`,
      [membershipId, limit],
    );

    return {
      subject: {
        type: 'member' as const,
        membershipId: membership.id,
        chamaId: membership.chama_id,
        chamaName: membership.chama_name,
      },
      history: result.rows.map((row) => ({
        snapshotId: row.id,
        score: Number(row.score),
        level: row.level,
        factors: row.factors ?? [],
        calculatedAt: row.calculated_at,
        version: row.formula_version,
        methodology: row.public_description,
      })),
    };
  }

  async recordSnapshot(input: RecordTrustSnapshotInput) {
    this.assertSanitizedFactors(input.factors);

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const formula = await this.getActiveFormulaForUpdate(client, input.formulaVersionId, input.subjectType);
      if (!formula) throw new ServiceUnavailableError('Trust-score formula is not active');

      let chamaId = input.chamaId;
      let membershipId: string | null = null;
      if (input.subjectType === 'member') {
        if (!input.membershipId) throw new ServiceUnavailableError('Member trust snapshot requires membershipId');
        const membership = await client.query<{ id: string; chama_id: string }>(
          `SELECT id, chama_id FROM chama_members WHERE id = $1`,
          [input.membershipId],
        );
        const row = membership.rows[0];
        if (!row) throw new NotFoundError('Membership not found');
        membershipId = row.id;
        chamaId = row.chama_id;
      } else {
        if (!chamaId) throw new ServiceUnavailableError('Chama trust snapshot requires chamaId');
        const chama = await client.query(`SELECT id FROM chamas WHERE id = $1`, [chamaId]);
        if (!chama.rows[0]) throw new NotFoundError('Chama not found');
      }

      const result = await client.query<SnapshotRow>(
        `INSERT INTO trust_score_snapshots
           (subject_type, formula_version_id, chama_id, membership_id, score, level,
            factors, calculation_key, source_fingerprint, calculated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, COALESCE($10, CURRENT_TIMESTAMP))
         RETURNING id, score::text, level, factors, calculated_at::text,
                   formula_version_id, $11::text AS formula_version,
                   $12::text AS public_description`,
        [
          input.subjectType,
          formula.id,
          chamaId,
          membershipId,
          input.score,
          input.level,
          JSON.stringify(input.factors),
          input.calculationKey,
          input.sourceFingerprint,
          input.calculatedAt ?? null,
          formula.version,
          formula.public_description,
        ],
      );
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async getActiveFormula(subjectType: 'member' | 'chama'): Promise<FormulaRow | null> {
    const result = await this.db.query<FormulaRow>(
      `SELECT id, subject_type::text AS subject_type, version, public_description
       FROM trust_score_formula_versions
       WHERE subject_type = $1 AND status = 'active'
       LIMIT 1`,
      [subjectType],
    );
    return result.rows[0] ?? null;
  }

  private async getActiveFormulaForUpdate(
    client: PoolClient,
    formulaVersionId: string,
    subjectType: 'member' | 'chama',
  ): Promise<FormulaRow | null> {
    const result = await client.query<FormulaRow>(
      `SELECT id, subject_type::text AS subject_type, version, public_description
       FROM trust_score_formula_versions
       WHERE id = $1 AND subject_type = $2 AND status = 'active'
       FOR SHARE`,
      [formulaVersionId, subjectType],
    );
    return result.rows[0] ?? null;
  }

  private async getCurrentSnapshot(input: {
    subjectType: 'member' | 'chama';
    membershipId?: string;
    chamaId: string;
    formulaId: string;
  }): Promise<SnapshotRow | null> {
    const result = await this.db.query<SnapshotRow>(
      `SELECT ts.id, ts.score::text, ts.level, ts.factors, ts.calculated_at::text,
              ts.formula_version_id, tf.version AS formula_version,
              tf.public_description
       FROM trust_score_snapshots ts
       JOIN trust_score_formula_versions tf ON tf.id = ts.formula_version_id
       WHERE ts.subject_type = $1
         AND ts.chama_id = $2
         AND ts.formula_version_id = $3
         AND (($1 = 'member' AND ts.membership_id = $4) OR ($1 = 'chama' AND ts.membership_id IS NULL))
       ORDER BY ts.calculated_at DESC, ts.id DESC
       LIMIT 1`,
      [input.subjectType, input.chamaId, input.formulaId, input.membershipId ?? null],
    );
    return result.rows[0] ?? null;
  }

  private async loadPublicChama(chamaId: string): Promise<ChamaRow> {
    const result = await this.db.query<ChamaRow>(
      `SELECT id, name, visibility::text AS visibility
       FROM chamas
       WHERE id = $1 AND visibility IN ('public', 'application')`,
      [chamaId],
    );
    const chama = result.rows[0];
    if (!chama) throw new NotFoundError('Chama not found');
    return chama;
  }

  private async loadOwnedMembership(membershipId: string, userId: string): Promise<MembershipRow> {
    const result = await this.db.query<MembershipRow>(
      `SELECT cm.id, cm.user_id, cm.chama_id, c.name AS chama_name
       FROM chama_members cm
       JOIN chamas c ON c.id = cm.chama_id
       WHERE cm.id = $1`,
      [membershipId],
    );
    const membership = result.rows[0];
    if (!membership) throw new NotFoundError('Membership not found');
    if (membership.user_id !== userId) throw new ForbiddenError('Trust history is private to the membership owner');
    return membership;
  }

  private assertSanitizedFactors(factors: TrustFactor[]): void {
    for (const factor of factors) {
      if (!factor.code || !factor.label || !factor.summary) {
        throw new ServiceUnavailableError('Trust factors must be explainable and sanitized');
      }

      const allowedKeys = new Set(['code', 'label', 'effect', 'summary']);
      if (Object.keys(factor).some((key) => !allowedKeys.has(key))) {
        throw new ServiceUnavailableError('Raw private financial data is not allowed in trust factors');
      }

      const text = `${factor.label} ${factor.summary}`;
      const containsRawFinancialValue = /\b(?:KES|KSh)\s*[0-9][0-9,]*(?:\.[0-9]+)?\b/i.test(text);
      const containsSensitiveIdentifier = /(?:\+254\d{9}|\bM-?Pesa\b|account\s*(?:number|no\.?))/i.test(text);
      if (containsRawFinancialValue || containsSensitiveIdentifier) {
        throw new ServiceUnavailableError('Raw private financial data is not allowed in trust factors');
      }
    }
  }
}

export const trustScoreService = new TrustScoreService();
