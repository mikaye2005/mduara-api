import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';

/** Hashes a secret (password, PIN, OTP code) with bcrypt before it is ever persisted. */
export async function hashSecret(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, env.BCRYPT_SALT_ROUNDS);
}

export async function verifySecret(plainText: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainText, hash);
}

export function generateNumericOtp(length: number): string {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i += 1) {
    otp += digits[crypto.randomInt(0, digits.length)];
  }
  return otp;
}

/** Opaque, high-entropy token used as the refresh token's raw (client-facing) value. */
export function generateOpaqueToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

/** Deterministic hash for lookups (refresh token, OTP) using SHA-256 with a server-side pepper. */
export function hashLookupValue(value: string): string {
  return crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update(value).digest('hex');
}
