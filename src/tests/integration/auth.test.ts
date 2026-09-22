import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { CredentialService } from '../../services/credential.service';
import { OtpService } from '../../services/otp.service';
import { SessionService } from '../../services/session.service';
import { TokenService } from '../../services/token.service';
import { hashSecret } from '../../utils/crypto.util';
import { TooManyRequestsError, UnauthorizedError } from '../../utils/errors';

const databaseUrl = process.env.TEST_DATABASE_URL;

class CapturingSmsProvider {
  readonly codes = new Map<string, string>();

  async sendOtp(phone: string, code: string): Promise<void> {
    this.codes.set(phone, code);
  }
}

test('BE-03/BE-24 phone + PIN authentication contract', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `auth_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  await migrate({
    databaseUrl: databaseUrl!,
    dir: 'migrations',
    direction: 'up',
    schema,
    createSchema: true,
    migrationsSchema: schema,
    migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql',
    singleTransaction: true,
    log: () => {},
  });

  const sms = new CapturingSmsProvider();
  const otp = new OtpService(pool, sms);
  const tokens = new TokenService(pool);
  const credentials = new CredentialService(pool, otp, tokens);
  const sessions = new SessionService(pool);

  async function createActiveUser(password = 'StrongPass!123') {
    const phone = `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;
    const email = `${randomUUID()}@example.test`;
    const pinHash = await hashSecret(password);
    const user = (await pool.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1, $2, 'Auth Test User', $3, 'active')
       RETURNING id`,
      [email, pinHash, phone],
    )).rows[0];
    return { id: user.id, phone, email, password };
  }

  await t.test('successful email or phone password login returns the user and issues a verifiable token pair', async () => {
    const user = await createActiveUser();
    assert.deepEqual(await credentials.authenticatePassword(user.phone, user.password), { id: user.id, phone: user.phone });
    assert.deepEqual(await credentials.authenticatePassword(user.email, user.password), { id: user.id, phone: user.phone });

    const pair = await tokens.issueTokenPair(user.id);
    const access = tokens.verifyAccessToken(pair.accessToken);
    assert.equal(access.sub, user.id);
    assert.equal(access.phone, user.phone);
    assert.equal(access.sessionVersion, 1);
  });

  await t.test('wrong passwords are generic and repeated failures lock the account', async () => {
    const user = await createActiveUser();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await assert.rejects(
        credentials.authenticatePassword(user.phone, 'wrongPassword!'),
        (error: unknown) => error instanceof UnauthorizedError && error.message === 'Invalid sign-in credentials',
      );
    }

    const row = (await pool.query<{ failed_login_attempts: number; login_locked_until: string | null }>(
      'SELECT failed_login_attempts, login_locked_until FROM users WHERE id = $1',
      [user.id],
    )).rows[0];
    assert.equal(row.failed_login_attempts, 5);
    assert.ok(row.login_locked_until);

    await assert.rejects(
      credentials.authenticatePassword(user.phone, user.password),
      (error: unknown) => error instanceof TooManyRequestsError,
    );
  });

  await t.test('PIN recovery consumes OTP, clears lockout, revokes sessions and accepts the new PIN', async () => {
    const user = await createActiveUser('StrongPass!123');
    const oldPair = await tokens.issueTokenPair(user.id);

    await pool.query(
      `UPDATE users
       SET failed_login_attempts = 5,
           login_locked_until = CURRENT_TIMESTAMP + INTERVAL '15 minutes'
       WHERE id = $1`,
      [user.id],
    );

    await otp.requestOtp(user.id, user.phone, 'pin_reset');
    const code = sms.codes.get(user.phone);
    assert.ok(code);

    await credentials.resetPin(user.phone, code!, '8642');

    const row = (await pool.query<{ failed_login_attempts: number; login_locked_until: string | null; session_version: number }>(
      'SELECT failed_login_attempts, login_locked_until, session_version FROM users WHERE id = $1',
      [user.id],
    )).rows[0];
    assert.equal(row.failed_login_attempts, 0);
    assert.equal(row.login_locked_until, null);
    assert.equal(row.session_version, 2);

    await assert.rejects(tokens.rotateRefreshToken(oldPair.refreshToken), UnauthorizedError);
    assert.deepEqual(await credentials.authenticatePassword(user.phone, '8642'), { id: user.id, phone: user.phone });
    await assert.rejects(credentials.authenticatePassword(user.phone, 'StrongPass!123'), UnauthorizedError);
  });

  await t.test('recovery failures do not distinguish known and unknown phone numbers', async () => {
    const user = await createActiveUser();
    const unknownPhone = `+2547${Math.floor(10000000 + Math.random() * 89999999)}`;

    for (const phone of [user.phone, unknownPhone]) {
      await assert.rejects(
        credentials.resetPin(phone, '000000', '1357'),
        (error: unknown) => error instanceof UnauthorizedError && error.message === 'Unable to reset PIN',
      );
    }
  });

  await t.test('session context returns Chama-scoped memberships without a global official role', async () => {
    const user = await createActiveUser();
    const chamaA = (await pool.query<{ id: string }>(
      `INSERT INTO chamas (name, type, contribution_amount, contribution_frequency, status)
       VALUES ('Alpha', 'table_banking', 1000, 'monthly', 'active') RETURNING id`,
    )).rows[0].id;
    const chamaB = (await pool.query<{ id: string }>(
      `INSERT INTO chamas (name, type, contribution_amount, contribution_frequency, status)
       VALUES ('Beta', 'table_banking', 1000, 'monthly', 'active') RETURNING id`,
    )).rows[0].id;

    await pool.query(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
       VALUES ($1, $3, 'secretary', 'active'), ($2, $3, 'treasurer', 'active')`,
      [chamaA, chamaB, user.id],
    );

    const context = await sessions.getContext(user.id);
    assert.equal(context.memberships.length, 2);
    assert.equal(context.memberships.find((m) => m.chamaId === chamaA)?.officialRole, 'secretary');
    assert.equal(context.memberships.find((m) => m.chamaId === chamaB)?.officialRole, 'treasurer');
    assert.ok(context.defaultContext);
    assert.equal(context.defaultContext?.workspace, 'member');
  });

  await t.test('BE-25 keeps one membership row, one office, and platform admin outside Chama roles', async () => {
    const user = await createActiveUser();
    const chama = (await pool.query<{ id: string }>(
      `INSERT INTO chamas (name, type, contribution_amount, contribution_frequency, status)
       VALUES ('Role Semantics', 'table_banking', 1000, 'monthly', 'active') RETURNING id`,
    )).rows[0].id;

    await pool.query(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
       VALUES ($1, $2, 'secretary', 'active')`,
      [chama, user.id],
    );

    await assert.rejects(
      pool.query(
        `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
         VALUES ($1, $2, 'treasurer', 'active')`,
        [chama, user.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );

    await assert.rejects(
      pool.query(
        `UPDATE chama_members SET role = 'super_admin' WHERE chama_id = $1 AND user_id = $2`,
        [chama, user.id],
      ),
      (error: unknown) => (error as { code?: string }).code === '22P02',
    );

    const state = (await pool.query<{ role: string; is_platform_admin: boolean }>(
      `SELECT cm.role::text AS role, u.is_platform_admin
       FROM chama_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chama_id = $1 AND cm.user_id = $2`,
      [chama, user.id],
    )).rows[0];

    assert.equal(state.role, 'secretary');
    assert.equal(state.is_platform_admin, false);
  });


  await t.test('BE-26 session context returns 3+ Chamas, preserves inactive memberships and selects only an active default', async () => {
    const user = await createActiveUser();
    await pool.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [user.id]);

    const chamas = [] as Array<{ id: string; name: string }>;
    for (const name of ['Future Home', 'Washing Machine Mbogi', "Summertides '27", 'Past Cycle']) {
      const row = (await pool.query<{ id: string }>(
        `INSERT INTO chamas (name, type, contribution_amount, contribution_frequency, status)
         VALUES ($1, 'goal_based', 1000, 'monthly', 'active') RETURNING id`,
        [name],
      )).rows[0];
      chamas.push({ id: row.id, name });
    }

    await pool.query(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status, joined_at)
       VALUES
         ($1, $5, 'member', 'active',    '2026-01-01T08:00:00Z'),
         ($2, $5, 'member', 'active',    '2026-09-01T08:00:00Z'),
         ($3, $5, 'secretary', 'suspended', '2026-08-01T08:00:00Z'),
         ($4, $5, 'chairperson', 'exited',   '2025-12-01T08:00:00Z')`,
      [chamas[0].id, chamas[1].id, chamas[2].id, chamas[3].id, user.id],
    );

    const context = await sessions.getContext(user.id);
    assert.equal(context.isPlatformAdmin, true);
    assert.equal(context.memberships.length, 4);

    const byId = new Map(context.memberships.map((membership) => [membership.chamaId, membership]));
    assert.equal(byId.get(chamas[2].id)?.membershipStatus, 'suspended');
    assert.equal(byId.get(chamas[2].id)?.role, 'secretary');
    assert.equal(byId.get(chamas[2].id)?.officialRole, null);
    assert.equal(byId.get(chamas[3].id)?.membershipStatus, 'exited');
    assert.equal(byId.get(chamas[3].id)?.officialRole, null);

    // The newest active membership is selected deterministically; inactive rows are never selected.
    assert.equal(context.defaultContext?.chamaId, chamas[1].id);
    assert.equal(context.defaultContext?.workspace, 'member');

    const pair = await tokens.issueTokenPair(user.id);
    const rotated = await tokens.rotateRefreshToken(pair.refreshToken);
    const refreshedUserId = tokens.verifyAccessToken(rotated.accessToken).sub;
    const restored = await sessions.getContext(refreshedUserId);
    assert.equal(restored.defaultContext?.chamaId, context.defaultContext?.chamaId);
    assert.deepEqual(
      restored.memberships.map((m) => [m.chamaId, m.membershipStatus, m.role]),
      context.memberships.map((m) => [m.chamaId, m.membershipStatus, m.role]),
    );
  });

});
