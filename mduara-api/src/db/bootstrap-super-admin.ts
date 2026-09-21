import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { registerSchema } from '../validation/auth.validation';

export interface SuperAdminBootstrapConfig {
  fullName: string;
  email: string;
  phone: string;
  pin: string;
  bcryptSaltRounds: number;
}

export interface SuperAdminBootstrapResult {
  action: 'created' | 'activated' | 'unchanged';
  userId: string;
  email: string;
  phone: string;
}

interface ExistingUser {
  id: string;
  email: string;
  phone: string;
}

export function readSuperAdminBootstrapConfig(environment: NodeJS.ProcessEnv = process.env): SuperAdminBootstrapConfig {
  const values = {
    fullName: environment.SUPER_ADMIN_FULL_NAME?.trim(),
    email: environment.SUPER_ADMIN_EMAIL?.trim(),
    phone: environment.SUPER_ADMIN_PHONE?.trim(),
    pin: environment.SUPER_ADMIN_PIN?.trim(),
  };
  const missing = [
    ['SUPER_ADMIN_FULL_NAME', values.fullName],
    ['SUPER_ADMIN_EMAIL', values.email],
    ['SUPER_ADMIN_PHONE', values.phone],
    ['SUPER_ADMIN_PIN', values.pin],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw new Error(`Super admin bootstrap requires: ${missing.join(', ')}`);
  }

  const parsed = registerSchema.safeParse(values);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid super admin bootstrap configuration:\n${issues.join('\n')}`);
  }

  const { fullName, email, phone, pin } = parsed.data;
  if (!fullName || !email || !phone || !pin) {
    throw new Error('Invalid super admin bootstrap configuration');
  }

  return {
    fullName,
    email,
    phone,
    pin,
    bcryptSaltRounds: readBcryptSaltRounds(environment.BCRYPT_SALT_ROUNDS),
  };
}

export async function bootstrapSuperAdmin(
  database: Pool,
  configuration: SuperAdminBootstrapConfig = readSuperAdminBootstrapConfig(),
): Promise<SuperAdminBootstrapResult> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('mduara:super-admin-bootstrap', 0))`);

    const matches = await client.query<ExistingUser>(
      `SELECT id, email, phone
         FROM users
        WHERE lower(email) = lower($1) OR phone = $2
        FOR UPDATE`,
      [configuration.email, configuration.phone],
    );

    if (matches.rows.length > 1) {
      throw new Error('Super admin email and phone belong to different existing users');
    }

    const existing = matches.rows[0];
    if (existing) {
      if (existing.email.toLowerCase() !== configuration.email || existing.phone !== configuration.phone) {
        throw new Error('Super admin email or phone conflicts with an existing user');
      }

      const activated = await client.query<{ id: string }>(
        `UPDATE users
            SET status = 'active',
                status_reason = NULL,
                is_email_verified = TRUE,
                is_platform_admin = TRUE,
                failed_login_attempts = 0,
                login_locked_until = NULL,
                session_version = session_version + 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
            AND (
              status <> 'active'
              OR status_reason IS NOT NULL
              OR NOT is_email_verified
              OR NOT is_platform_admin
              OR failed_login_attempts <> 0
              OR login_locked_until IS NOT NULL
            )
          RETURNING id`,
        [existing.id],
      );
      await ensureBaselineMemberTrustFormula(client, existing.id);

      await client.query('COMMIT');
      return {
        action: activated.rowCount ? 'activated' : 'unchanged',
        userId: existing.id,
        email: configuration.email,
        phone: configuration.phone,
      };
    }

    const pinHash = await bcrypt.hash(configuration.pin, configuration.bcryptSaltRounds);
    const created = await client.query<{ id: string }>(
      `INSERT INTO users
         (email, pin_hash, full_name, phone, status, is_email_verified, is_platform_admin)
       VALUES ($1, $2, $3, $4, 'active', TRUE, TRUE)
       RETURNING id`,
      [configuration.email, pinHash, configuration.fullName, configuration.phone],
    );
    await ensureBaselineMemberTrustFormula(client, created.rows[0].id);

    await client.query('COMMIT');
    return {
      action: 'created',
      userId: created.rows[0].id,
      email: configuration.email,
      phone: configuration.phone,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function readBcryptSaltRounds(value: string | undefined): number {
  if (!value?.trim()) return 12;

  const rounds = Number(value);
  if (!Number.isInteger(rounds) || rounds < 10 || rounds > 15) {
    throw new Error('BCRYPT_SALT_ROUNDS must be an integer from 10 to 15 for super admin bootstrap');
  }
  return rounds;
}

async function ensureBaselineMemberTrustFormula(client: import('pg').PoolClient, approvedBy: string): Promise<void> {
  await client.query(
    `INSERT INTO trust_score_formula_versions
       (subject_type, version, status, public_description, inputs, weights, levels,
        definition_hash, created_by, approved_by, approved_at, activated_at)
     SELECT 'member', 'member-v1', 'active',
            'A simple score based on due contribution completion and whether obligations were met on time.',
            '["on_time_contributions", "missed_contributions"]'::jsonb,
            '{"on_time_contributions":0.6,"missed_contributions":0.4}'::jsonb,
            '["needs_attention", "building", "highly_committed"]'::jsonb,
            'cf07a082ddb545d6a12451ebfdf6e4f839c8290faea785d22e992cf6ecf96775',
            $1, $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      WHERE NOT EXISTS (
        SELECT 1 FROM trust_score_formula_versions
        WHERE subject_type = 'member' AND status = 'active'
      )
      ON CONFLICT (version) DO NOTHING`,
    [approvedBy],
  );
}