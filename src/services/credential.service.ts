import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { hashSecret, verifySecret } from '../utils/crypto.util';
import { BadRequestError, TooManyRequestsError, UnauthorizedError } from '../utils/errors';
import { otpService, type OtpService } from './otp.service';
import { tokenService, type TokenService } from './token.service';

interface CredentialRow {
  id: string;
  phone: string;
  pin_hash: string;
  status: string;
  failed_login_attempts: number;
  login_locked_until: Date | string | null;
}

export interface AuthenticatedCredentialUser {
  id: string;
  phone: string;
}

export interface CredentialRequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** PostgreSQL-backed phone + PIN authentication and credential recovery. */
export class CredentialService {
  private readonly dummyPinHash: Promise<string>;

  constructor(
    private readonly databasePool: Pool = pool,
    private readonly otp: Pick<OtpService, 'verifyOtp'> = otpService,
    private readonly tokens: Pick<TokenService, 'invalidateAllSessions'> = tokenService,
  ) {
    // Keeps unknown-phone login work closer to the cost of a real bcrypt check.
    this.dummyPinHash = hashSecret('000000');
  }

  async authenticatePassword(identifier: string, password: string, context: CredentialRequestContext = {}): Promise<AuthenticatedCredentialUser> {
    return withDatabaseTransaction(
      async (client) => {
        const normalizedIdentifier = identifier.trim();
        const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedIdentifier);
        const result = await client.query<CredentialRow>(
          isEmail
            ? `SELECT id, phone, pin_hash, status, failed_login_attempts, login_locked_until
               FROM users
               WHERE lower(email) = lower($1)
               FOR UPDATE`
            : `SELECT id, phone, pin_hash, status, failed_login_attempts, login_locked_until
               FROM users
               WHERE phone = $1
               FOR UPDATE`,
          [normalizedIdentifier],
        );
        const user = result.rows[0];

        if (!user) {
          await verifySecret(password, await this.dummyPinHash);
          throw new UnauthorizedError('Invalid sign-in credentials');
        }

        const now = Date.now();
        if (user.login_locked_until && new Date(user.login_locked_until).getTime() > now) {
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((new Date(user.login_locked_until).getTime() - now) / 1000),
          );
          throw new TooManyRequestsError('Sign-in is temporarily locked. Try again later.', { retryAfterSeconds });
        }

        const passwordMatches = await verifySecret(password, user.pin_hash);
        if (!passwordMatches || user.status !== 'active') {
          if (user.status === 'active') {
            const nextAttemptCount = user.failed_login_attempts + 1;
            const shouldLock = nextAttemptCount >= env.PIN_MAX_FAILED_ATTEMPTS;
            await client.query(
              `UPDATE users
               SET failed_login_attempts = $2,
                   login_locked_until = CASE
                     WHEN $3::boolean THEN CURRENT_TIMESTAMP + ($4::int * INTERVAL '1 minute')
                     ELSE NULL
                   END,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $1`,
              [user.id, nextAttemptCount, shouldLock, env.PIN_LOCKOUT_MINUTES],
            );

            if (shouldLock) {
              await client.query(
                `INSERT INTO audit_logs
                   (category, action, actor_id, entity_type, entity_id, ip_address, user_agent, payload)
                 VALUES ('security', 'auth.pin_lockout', $1, 'user', $1, $2::inet, $3, $4::jsonb)`,
                [
                  user.id,
                  context.ipAddress?.startsWith('::ffff:') ? context.ipAddress.slice(7) : (context.ipAddress ?? null),
                  context.userAgent?.slice(0, 1024) ?? null,
                  JSON.stringify({ failedAttempts: nextAttemptCount, lockoutMinutes: env.PIN_LOCKOUT_MINUTES }),
                ],
              );
            }
          }
          throw new UnauthorizedError('Invalid sign-in credentials');
        }

        await client.query(
          `UPDATE users
           SET failed_login_attempts = 0,
               login_locked_until = NULL,
               last_login_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [user.id],
        );

        return { id: user.id, phone: user.phone };
      },
      { isolationLevel: 'READ COMMITTED', maxRetries: 1 },
      this.databasePool,
    );
  }

  async authenticatePin(phone: string, pin: string, context: CredentialRequestContext = {}): Promise<AuthenticatedCredentialUser> {
    return this.authenticatePassword(phone, pin, context);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    if (currentPassword === newPassword) throw new BadRequestError('New password must be different from the current password');
    const newPasswordHash = await hashSecret(newPassword);

    await withDatabaseTransaction(
      async (client) => {
        const result = await client.query<CredentialRow>(
          `SELECT id, phone, pin_hash, status, failed_login_attempts, login_locked_until
           FROM users
           WHERE id = $1
           FOR UPDATE`,
          [userId],
        );
        const user = result.rows[0];
        if (!user || user.status !== 'active' || !(await verifySecret(currentPassword, user.pin_hash))) {
          throw new UnauthorizedError('Current password is incorrect');
        }

        await client.query(
          `UPDATE users
           SET pin_hash = $2,
               pin_changed_at = CURRENT_TIMESTAMP,
               failed_login_attempts = 0,
               login_locked_until = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [userId, newPasswordHash],
        );
        await this.tokens.invalidateAllSessions(userId, client);
        await this.auditCredentialEvent(client, userId, 'auth.password_changed');
      },
      { isolationLevel: 'READ COMMITTED', maxRetries: 1 },
      this.databasePool,
    );
  }

  async changePin(userId: string, currentPin: string, newPin: string): Promise<void> {
    return this.changePassword(userId, currentPin, newPin);
  }

  async resetPassword(phone: string, code: string, newPassword: string): Promise<void> {
    const newPasswordHash = await hashSecret(newPassword);

    try {
      await withDatabaseTransaction(
        async (client) => {
          const userId = await this.otp.verifyOtp(phone, code, 'pin_reset', client);
          const result = await client.query<{ id: string; status: string }>(
            `SELECT id, status
             FROM users
             WHERE id = $1 AND phone = $2
             FOR UPDATE`,
            [userId, phone],
          );
          const user = result.rows[0];
          if (!user || user.status !== 'active') throw new UnauthorizedError('Unable to reset password');

          await client.query(
            `UPDATE users
             SET pin_hash = $2,
                 pin_changed_at = CURRENT_TIMESTAMP,
                 failed_login_attempts = 0,
                 login_locked_until = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [userId, newPasswordHash],
          );
          await this.tokens.invalidateAllSessions(userId, client);
          await this.auditCredentialEvent(client, userId, 'auth.password_reset');
        },
        { isolationLevel: 'READ COMMITTED', maxRetries: 1 },
        this.databasePool,
      );
    } catch (error) {
      // Recovery failures intentionally collapse to one response so callers
      // cannot infer whether the submitted phone number owns an account.
      if (error instanceof UnauthorizedError) throw new UnauthorizedError('Unable to reset password');
      throw error;
    }
  }

  async resetPin(phone: string, code: string, newPin: string): Promise<void> {
    return this.resetPassword(phone, code, newPin);
  }

  private async auditCredentialEvent(client: PoolClient, userId: string, action: string): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (category, action, actor_id, entity_type, entity_id)
       VALUES ('security', $2, $1, 'user', $1)`,
      [userId, action],
    );
  }
}

export const credentialService = new CredentialService();
