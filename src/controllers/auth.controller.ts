import type { Request, Response } from 'express';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { credentialService } from '../services/credential.service';
import { otpService } from '../services/otp.service';
import { sessionService } from '../services/session.service';
import { tokenService } from '../services/token.service';
import { hashSecret } from '../utils/crypto.util';
import { ConflictError, UnauthorizedError } from '../utils/errors';
import { sendSuccess } from '../utils/response.util';
import type { SessionContext, TokenPair } from '../types';
import type {
  ChangePinInput,
  LoginInput,
  RefreshTokenInput,
  RegisterInput,
  ResetPinInput,
  SendOtpInput,
  VerifyOtpInput,
} from '../validation/auth.validation';

interface UserRow {
  id: string;
  phone: string;
  email: string;
  full_name: string;
  status: string;
}

function sessionResponse(tokens: TokenPair, session: SessionContext) {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_in: tokens.expiresIn,
    user: session.user,
    isPlatformAdmin: session.isPlatformAdmin,
    memberships: session.memberships,
    defaultContext: session.defaultContext,
  };
}

/** POST /api/v1/auth/register — creates a pending account using a phone number or email plus a password. */
export async function register(req: Request<unknown, unknown, RegisterInput>, res: Response): Promise<void> {
  const { fullName, phone, email, password } = req.body;
  const normalizedEmail = email?.trim().toLowerCase() ?? null;
  const normalizedPhone = phone?.trim() ?? null;

  const existing = await pool.query<{ id: string; status: string }>(
    `SELECT id, status
     FROM users
     WHERE ($1::text IS NOT NULL AND lower(email) = lower($1)) OR ($2::text IS NOT NULL AND phone = $2)
     LIMIT 1`,
    [normalizedEmail, normalizedPhone],
  );
  if (existing.rows[0]) {
    const message = existing.rows[0].status === 'pending'
      ? 'An account is already awaiting verification. Request a new registration OTP instead.'
      : 'An account with this phone number or email already exists';
    throw new ConflictError(message);
  }

  const passwordHash = await hashSecret(password);
  let user: UserRow;
  try {
    const inserted = await pool.query<UserRow>(
      `INSERT INTO users (full_name, phone, email, pin_hash, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, phone, email, full_name, status`,
      [fullName, normalizedPhone ?? '', normalizedEmail ?? '', passwordHash],
    );
    user = inserted.rows[0];
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ConflictError('An account with this phone number or email already exists');
    }
    throw error;
  }

  await otpService.requestOtp(user.id, user.phone, 'registration');

  sendSuccess(
    res,
    { message: 'Registration started. Enter the OTP sent to your phone to activate your account.', phone: user.phone },
    201,
  );
}

/** POST /api/v1/auth/login — accepts a phone number or email with a password. */
export async function login(req: Request<unknown, unknown, LoginInput>, res: Response): Promise<void> {
  const payload = req.body as Record<string, unknown>;
  const identifier = String(payload.identifier ?? payload.phone ?? payload.email ?? '').trim();
  const password = String(payload.password ?? '');

  const user = await credentialService.authenticatePassword(identifier, password, {
    ipAddress: req.ip,
    userAgent: req.get('user-agent') ?? null,
  });
  const tokens = await tokenService.issueTokenPair(user.id);
  const session = await sessionService.getContext(user.id);
  sendSuccess(res, sessionResponse(tokens, session));
}

/**
 * POST /api/v1/auth/send-otp
 * Sends registration-resend or PIN-reset OTPs. The response deliberately does
 * not reveal whether a phone number belongs to an eligible account.
 */
export async function sendOtp(req: Request<unknown, unknown, SendOtpInput>, res: Response): Promise<void> {
  const { phone, purpose } = req.body;
  const result = await pool.query<UserRow>(
    `SELECT id, phone, email, full_name, status
     FROM users
     WHERE phone = $1
     LIMIT 1`,
    [phone],
  );
  const user = result.rows[0];

  const eligible = user && (
    (purpose === 'registration' && user.status === 'pending')
    || (purpose === 'pin_reset' && user.status === 'active')
  );

  // requestOtp records rate-limit events even when eligible is false, preventing
  // the rate-limit response from becoming an account-enumeration oracle.
  await otpService.requestOtp(eligible ? user.id : null, phone, purpose);

  sendSuccess(res, { message: 'If the phone number is eligible, a verification code has been sent.' });
}

/** POST /api/v1/auth/verify-otp — activates a pending registration and creates its first session. */
export async function verifyOtp(req: Request<unknown, unknown, VerifyOtpInput>, res: Response): Promise<void> {
  const { phone, code } = req.body;

  const result = await withDatabaseTransaction(
    async (client) => {
      const userId = await otpService.verifyOtp(phone, code, 'registration', client);
      const userResult = await client.query<UserRow>(
        `SELECT id, phone, email, full_name, status
         FROM users
         WHERE id = $1 AND phone = $2
         FOR UPDATE`,
        [userId, phone],
      );
      const user = userResult.rows[0];
      if (!user) throw new UnauthorizedError('Account no longer exists');
      if (user.status !== 'pending' && user.status !== 'active') {
        throw new UnauthorizedError('Account cannot be activated');
      }

      if (user.status === 'pending') {
        await client.query(
          `UPDATE users
           SET status = 'active',
               last_login_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [user.id],
        );
      }

      const tokens = await tokenService.issueTokenPair(user.id, client);
      return { userId: user.id, tokens };
    },
    { isolationLevel: 'READ COMMITTED', maxRetries: 1 },
  );

  const session = await sessionService.getContext(result.userId);
  sendSuccess(res, sessionResponse(result.tokens, session));
}

/** POST /api/v1/auth/refresh — rotates a refresh token and restores equivalent session context. */
export async function refresh(req: Request<unknown, unknown, RefreshTokenInput>, res: Response): Promise<void> {
  const tokens = await tokenService.rotateRefreshToken(req.body.refreshToken);
  const payload = tokenService.verifyAccessToken(tokens.accessToken);
  const session = await sessionService.getContext(payload.sub);
  sendSuccess(res, sessionResponse(tokens, session));
}

/** POST /api/v1/auth/logout — idempotently revokes the supplied refresh token. */
export async function logout(req: Request<unknown, unknown, RefreshTokenInput>, res: Response): Promise<void> {
  await tokenService.revokeRefreshToken(req.body.refreshToken);
  sendSuccess(res, { message: 'Signed out' });
}

/** POST /api/v1/auth/logout-all — invalidates refresh and access sessions on every device. */
export async function logoutAll(req: Request, res: Response): Promise<void> {
  await tokenService.invalidateAllSessions(req.user!.id);
  sendSuccess(res, { message: 'Signed out on all devices' });
}

/** GET /api/v1/auth/me — authoritative profile plus all Chama workspace contexts. */
export async function me(req: Request, res: Response): Promise<void> {
  const session = await sessionService.getContext(req.user!.id);
  sendSuccess(res, session);
}

/** PATCH /api/v1/auth/pin — verifies the current password, replaces it, and invalidates all sessions. */
export async function changePin(req: Request<unknown, unknown, ChangePinInput>, res: Response): Promise<void> {
  const currentPassword = 'currentPassword' in req.body ? req.body.currentPassword : req.body.currentPin;
  const newPassword = 'newPassword' in req.body ? req.body.newPassword : req.body.newPin;
  await credentialService.changePin(req.user!.id, currentPassword, newPassword);
  sendSuccess(res, { message: 'Password updated. Sign in again on your devices.' });
}

/** POST /api/v1/auth/reset-pin — atomically consumes a recovery OTP and invalidates all sessions. */
export async function resetPin(req: Request<unknown, unknown, ResetPinInput>, res: Response): Promise<void> {
  const newPassword = 'newPassword' in req.body ? req.body.newPassword : req.body.newPin;
  await credentialService.resetPin(req.body.phone, req.body.code, newPassword);
  sendSuccess(res, { message: 'Password reset successfully. Sign in again on your devices.' });
}
