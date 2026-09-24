import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { hashLookupValue } from '../utils/crypto.util';
import { UnauthorizedError } from '../utils/errors';
import type {
  AccessTokenPayload,
  ChamaMembershipRole,
  RefreshTokenPayload,
  SessionMembershipClaim,
  TokenPair,
} from '../types';

interface RefreshTokenRow {
  id: string;
  user_id: string;
  status: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  token_hash: string;
}

interface AccessIdentityRow {
  phone: string;
  status: string;
  is_platform_admin: boolean;
  session_version: number;
}

interface MembershipClaimRow {
  id: string;
  chama_id: string;
  role: string;
}

type QueryExecutor = Pool | PoolClient;

type RotationOutcome =
  | { kind: 'ok'; pair: TokenPair }
  | { kind: 'unrecognized' }
  | { kind: 'reused' }
  | { kind: 'mismatch' }
  | { kind: 'expired' }
  | { kind: 'inactive' };

const DATABASE_TO_SESSION_ROLE: Readonly<Record<string, ChamaMembershipRole>> = {
  chairperson: 'chair',
  treasurer: 'treasurer',
  secretary: 'secretary',
  member: 'member',
};

/** Issues, verifies, rotates, and revokes JWT-backed sessions. */
export class TokenService {
  constructor(private readonly databasePool: Pool = pool) {}

  verifyAccessToken(token: string): AccessTokenPayload {
    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
      if (
        decoded.type !== 'access'
        || !decoded.sub
        || !decoded.phone
        || !Number.isInteger(decoded.sessionVersion)
        || !Array.isArray(decoded.memberships)
      ) {
        throw new Error('Not an access token');
      }
      return decoded;
    } catch {
      throw new UnauthorizedError('Invalid or expired access token');
    }
  }

  /** Issues a new access/refresh pair from the current PostgreSQL identity and memberships. */
  async issueTokenPair(userId: string, executor: QueryExecutor = this.databasePool): Promise<TokenPair> {
    return this.createTokenPair(executor, userId);
  }

  /**
   * Rotates a refresh token under a row lock. Reuse of an already-rotated token
   * revokes every active session because the token may have leaked.
   */
  async rotateRefreshToken(refreshToken: string): Promise<TokenPair> {
    const payload = this.verifyRefreshTokenSignature(refreshToken);
    const suppliedHash = hashLookupValue(refreshToken);

    const outcome = await withDatabaseTransaction(
      async (client): Promise<RotationOutcome> => {
        const result = await client.query<RefreshTokenRow>(
          `SELECT rt.id, rt.user_id, u.status, rt.expires_at, rt.revoked_at, rt.token_hash
           FROM refresh_tokens rt
           JOIN users u ON u.id = rt.user_id
           WHERE rt.id = $1
           FOR UPDATE OF rt`,
          [payload.jti],
        );
        const row = result.rows[0];

        if (!row || row.user_id !== payload.sub) return { kind: 'unrecognized' };

        if (row.token_hash !== suppliedHash) {
          await client.query(
            `INSERT INTO audit_logs (category, action, actor_id, entity_type, entity_id)
             VALUES ('security', 'auth.refresh_token_mismatch', $1, 'user', $1)`,
            [row.user_id],
          );
          await this.invalidateAllSessions(row.user_id, client);
          return { kind: 'mismatch' };
        }

        if (row.revoked_at) {
          await client.query(
            `INSERT INTO audit_logs (category, action, actor_id, entity_type, entity_id)
             VALUES ('security', 'auth.refresh_token_reuse', $1, 'user', $1)`,
            [row.user_id],
          );
          await this.invalidateAllSessions(row.user_id, client);
          return { kind: 'reused' };
        }

        if (new Date(row.expires_at).getTime() < Date.now()) {
          await client.query('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
          return { kind: 'expired' };
        }

        if (row.status !== 'active') {
          await this.revokeAllRefreshTokens(row.user_id, client);
          return { kind: 'inactive' };
        }

        await client.query('UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
        return { kind: 'ok', pair: await this.createTokenPair(client, row.user_id) };
      },
      { isolationLevel: 'READ COMMITTED', maxRetries: 1 },
      this.databasePool,
    );

    switch (outcome.kind) {
      case 'ok':
        return outcome.pair;
      case 'reused':
        throw new UnauthorizedError('Refresh token reuse detected. All sessions have been revoked.');
      case 'mismatch':
        throw new UnauthorizedError('Refresh token does not match stored record');
      case 'expired':
        throw new UnauthorizedError('Refresh token has expired');
      case 'inactive':
        throw new UnauthorizedError('Account is not active');
      case 'unrecognized':
        throw new UnauthorizedError('Refresh token not recognized');
    }
  }

  /** Idempotently revokes one refresh token after validating its signature. */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    const payload = this.verifyRefreshTokenSignature(refreshToken, true);
    const tokenHash = hashLookupValue(refreshToken);
    await this.databasePool.query(
      `UPDATE refresh_tokens
       SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
       WHERE id = $1 AND user_id = $2 AND token_hash = $3`,
      [payload.jti, payload.sub, tokenHash],
    );
  }

  /** Revokes refresh tokens but leaves already-issued short-lived access tokens untouched. */
  async revokeAllRefreshTokens(userId: string, executor: QueryExecutor = this.databasePool): Promise<void> {
    await executor.query(
      `UPDATE refresh_tokens
       SET revoked_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  /** Revokes refresh tokens and increments session_version so existing access tokens fail immediately. */
  async invalidateAllSessions(userId: string, executor?: QueryExecutor): Promise<void> {
    const work = async (db: QueryExecutor) => {
      await db.query(
        `UPDATE users
         SET session_version = session_version + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [userId],
      );
      await this.revokeAllRefreshTokens(userId, db);
    };

    if (executor) {
      await work(executor);
      return;
    }

    await withDatabaseTransaction(
      async (client) => work(client),
      { isolationLevel: 'READ COMMITTED', maxRetries: 1 },
      this.databasePool,
    );
  }

  private async createTokenPair(executor: QueryExecutor, userId: string): Promise<TokenPair> {
    const accessPayload = await this.loadAccessPayload(executor, userId);
    const jti = crypto.randomUUID();
    const accessToken = jwt.sign(accessPayload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
    } as jwt.SignOptions);
    const refreshToken = jwt.sign(
      { sub: userId, jti, type: 'refresh' } satisfies RefreshTokenPayload,
      env.JWT_REFRESH_SECRET,
      { expiresIn: env.JWT_REFRESH_EXPIRES_IN } as jwt.SignOptions,
    );

    const expiresAt = new Date(Date.now() + parseExpiryToMs(env.JWT_REFRESH_EXPIRES_IN));
    await executor.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [jti, userId, hashLookupValue(refreshToken), expiresAt],
    );

    return { accessToken, refreshToken, expiresIn: env.JWT_ACCESS_EXPIRES_IN };
  }

  private async loadAccessPayload(executor: QueryExecutor, userId: string): Promise<AccessTokenPayload> {
    const identityResult = await executor.query<AccessIdentityRow>(
      `SELECT phone, status, is_platform_admin, session_version
       FROM users
       WHERE id = $1`,
      [userId],
    );
    const identity = identityResult.rows[0];
    if (!identity || identity.status !== 'active') throw new UnauthorizedError('Account is not active');

    const membershipsResult = await executor.query<MembershipClaimRow>(
      `SELECT id, chama_id, role::text AS role
       FROM chama_members
       WHERE user_id = $1
         AND membership_status = 'active'
       ORDER BY joined_at DESC, id ASC`,
      [userId],
    );

    const memberships: SessionMembershipClaim[] = membershipsResult.rows.flatMap((row) => {
      const role = DATABASE_TO_SESSION_ROLE[row.role];
      return role ? [{ membershipId: row.id, chamaId: row.chama_id, role }] : [];
    });

    return {
      sub: userId,
      phone: identity.phone,
      type: 'access',
      isPlatformAdmin: identity.is_platform_admin,
      sessionVersion: identity.session_version,
      memberships,
    };
  }

  private verifyRefreshTokenSignature(token: string, ignoreExpiration = false): RefreshTokenPayload {
    try {
      const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { ignoreExpiration }) as RefreshTokenPayload;
      if (decoded.type !== 'refresh' || !decoded.sub || !decoded.jti) throw new Error('Not a refresh token');
      return decoded;
    } catch {
      throw new UnauthorizedError('Invalid refresh token');
    }
  }
}

function parseExpiryToMs(expiresIn: string): number {
  const match = /^(\d+)([smhd])$/.exec(expiresIn);
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = Number(match[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
  return value * unitMs;
}

export const tokenService = new TokenService();
