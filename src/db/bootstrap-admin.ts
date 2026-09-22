import { randomUUID } from 'node:crypto';
import { pool } from './client';
import { hashSecret } from '../utils/crypto.util';
import { env } from '../config/env';

export async function bootstrapSuperAdmin(): Promise<boolean> {
  if (!env.SUPER_ADMIN_BOOTSTRAP) return false;

  const email = (env.SUPER_ADMIN_EMAIL ?? env.AUTH_DEV_EMAIL ?? '').trim();
  const phone = (env.SUPER_ADMIN_PHONE ?? env.AUTH_DEV_PHONE ?? '').trim();
  const pin = (env.SUPER_ADMIN_PIN ?? env.AUTH_DEV_PIN ?? '').trim();
  const fullName = env.SUPER_ADMIN_FULL_NAME?.trim() || 'Platform Super Admin';

  if (!email || !phone || !pin) {
    return false;
  }

  const pinHash = await hashSecret(pin);
  const existing = await pool.query<{ id: string; is_platform_admin: boolean; status: string }>(
    `SELECT id, is_platform_admin, status
     FROM users
     WHERE lower(email) = lower($1) OR phone = $2
     LIMIT 1`,
    [email, phone],
  );

  if (existing.rows[0]) {
    const user = existing.rows[0];
    await pool.query(
      `UPDATE users
       SET email = $2,
           full_name = $3,
           phone = $4,
           pin_hash = $5,
           status = 'active',
           is_email_verified = TRUE,
           is_platform_admin = TRUE,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [user.id, email, fullName, phone, pinHash],
    );
    return true;
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified, is_platform_admin, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', TRUE, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     RETURNING id`,
    [randomUUID(), email, pinHash, fullName, phone],
  );

  return inserted.rowCount > 0;
}
