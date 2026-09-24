import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { smsService, type SmsService } from './sms.service';
import { generateNumericOtp, hashSecret, verifySecret } from '../utils/crypto.util';
import { ServiceUnavailableError, TooManyRequestsError, UnauthorizedError } from '../utils/errors';

export type OtpPurpose = 'registration' | 'password_reset' | 'pin_reset';

type QueryExecutor = PoolClient;

interface OtpCodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  expires_at: Date | string;
  attempt_count: number;
}

interface RateLimitRow {
  request_count: number;
  oldest_created_at: Date | string | null;
  newest_created_at: Date | string | null;
}

type VerifyOutcome =
  | { kind: 'ok'; userId: string }
  | { kind: 'missing' }
  | { kind: 'expired' }
  | { kind: 'attempts_exceeded' }
  | { kind: 'invalid' };

const RATE_LIMIT_WINDOW_MS = env.OTP_RATE_LIMIT_WINDOW_MINUTES * 60_000;
const RESEND_COOLDOWN_MS = env.OTP_RESEND_COOLDOWN_SECONDS * 1000;

/**
 * Generates, dispatches, and verifies one-time passcodes. PostgreSQL is the
 * single source of truth for throttling, OTP state, and concurrent consumption.
 */
export class OtpService {
  constructor(
    private readonly databasePool: Pool = pool,
    private readonly sms: Pick<SmsService, 'sendOtp'> = smsService,
  ) {}

  /**
   * Records every request, even for an unknown/ineligible phone, so rate-limit
   * behaviour cannot be used as an account-enumeration oracle.
   */
  async requestOtp(userId: string | null, phone: string, purpose: OtpPurpose): Promise<void> {
    const code = generateNumericOtp(env.OTP_LENGTH);
    // Hash even when no eligible user exists to keep the CPU work broadly similar.
    const codeHash = await hashSecret(code);
    const expiresAt = new Date(Date.now() + env.OTP_EXPIRES_MINUTES * 60_000);

    const otpId = await withDatabaseTransaction(
      async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp-request:${phone}:${purpose}`]);

        const limit = await client.query<RateLimitRow>(
          `SELECT COUNT(*)::int AS request_count,
                  MIN(created_at) AS oldest_created_at,
                  MAX(created_at) AS newest_created_at
           FROM otp_request_events
           WHERE phone = $1
             AND purpose = $2
             AND created_at >= CURRENT_TIMESTAMP - ($3::int * INTERVAL '1 minute')`,
          [phone, purpose, env.OTP_RATE_LIMIT_WINDOW_MINUTES],
        );
        const row = limit.rows[0];
        const now = Date.now();

        if (row?.newest_created_at) {
          const newest = new Date(row.newest_created_at).getTime();
          if (newest + RESEND_COOLDOWN_MS > now) {
            throw new TooManyRequestsError('Please wait before requesting another verification code.', {
              retryAfterSeconds: Math.max(1, Math.ceil((newest + RESEND_COOLDOWN_MS - now) / 1000)),
            });
          }
        }

        if ((row?.request_count ?? 0) >= env.OTP_RATE_LIMIT_MAX) {
          const oldest = row?.oldest_created_at ? new Date(row.oldest_created_at).getTime() : now;
          throw new TooManyRequestsError('Too many OTP requests. Please try again later.', {
            retryAfterSeconds: Math.max(1, Math.ceil((oldest + RATE_LIMIT_WINDOW_MS - now) / 1000)),
          });
        }

        await client.query(
          `INSERT INTO otp_request_events (phone, purpose)
           VALUES ($1, $2)`,
          [phone, purpose],
        );

        if (!userId) return null;

        await client.query(
          `UPDATE otp_codes
           SET consumed_at = CURRENT_TIMESTAMP
           WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL`,
          [phone, purpose],
        );

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO otp_codes (user_id, phone, code_hash, purpose, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [userId, phone, codeHash, purpose, expiresAt],
        );
        return inserted.rows[0].id;
      },
      { isolationLevel: 'READ COMMITTED', maxRetries: 1 },
      this.databasePool,
    );

    if (!otpId) return;

    try {
      await this.sms.sendOtp(phone, code, env.OTP_EXPIRES_MINUTES);
    } catch {
      await this.databasePool.query(
        'UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1 AND consumed_at IS NULL',
        [otpId],
      );
      throw new ServiceUnavailableError('Unable to deliver the verification code right now. Please try again.');
    }
  }

  /** Atomically consumes the most recent unconsumed OTP and returns its user id. */
  async verifyOtp(phone: string, code: string, purpose: OtpPurpose, executor?: QueryExecutor): Promise<string> {
    const verify = async (client: QueryExecutor): Promise<VerifyOutcome> => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`otp-verify:${phone}:${purpose}`]);

      const result = await client.query<OtpCodeRow>(
        `SELECT id, user_id, code_hash, expires_at, attempt_count
         FROM otp_codes
         WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [phone, purpose],
      );
      const otp = result.rows[0];

      if (!otp) return { kind: 'missing' };

      if (otp.attempt_count >= env.OTP_MAX_VERIFY_ATTEMPTS) {
        await client.query('UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [otp.id]);
        return { kind: 'attempts_exceeded' };
      }

      if (new Date(otp.expires_at).getTime() < Date.now()) {
        await client.query('UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [otp.id]);
        return { kind: 'expired' };
      }

      const isMatch = await verifySecret(code, otp.code_hash);
      if (!isMatch) {
        await client.query(
          `UPDATE otp_codes
           SET attempt_count = attempt_count + 1,
               consumed_at = CASE
                 WHEN attempt_count + 1 >= $2 THEN CURRENT_TIMESTAMP
                 ELSE consumed_at
               END
           WHERE id = $1`,
          [otp.id, env.OTP_MAX_VERIFY_ATTEMPTS],
        );
        return { kind: 'invalid' };
      }

      await client.query('UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [otp.id]);
      return { kind: 'ok', userId: otp.user_id };
    };

    const outcome = executor
      ? await verify(executor)
      : await withDatabaseTransaction(
        verify,
        { isolationLevel: 'READ COMMITTED', maxRetries: 1 },
        this.databasePool,
      );

    switch (outcome.kind) {
      case 'ok':
        return outcome.userId;
      case 'missing':
        throw new UnauthorizedError('No valid verification code is pending');
      case 'expired':
        throw new UnauthorizedError('Verification code has expired');
      case 'attempts_exceeded':
        throw new UnauthorizedError('Verification code attempts exceeded. Request a new code.');
      case 'invalid':
        throw new UnauthorizedError('Invalid verification code');
    }
    throw new UnauthorizedError('Unable to verify code');
  }
}

export const otpService = new OtpService();
