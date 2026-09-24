import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import {
  createPostgresChamaMembershipRepository,
  protectAdministrativeRoutes,
  requireChamaRoles,
} from '../../middlewares/authorization.middleware';
import { identityRolesFromPlatformFlag } from '../../middlewares/auth.middleware';
import type { ApiRequest, ApiResponse } from '../../types/auth';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-35 authorization stays Chama-scoped, active-membership-backed and platform-admin independent', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `authz_be35_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await db.end();
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

  const scopedUser = '30000000-0000-4000-8000-000000000071';
  const chairUser = '30000000-0000-4000-8000-000000000072';
  const adminUser = '30000000-0000-4000-8000-000000000073';
  const suspendedUser = '30000000-0000-4000-8000-000000000074';
  const exitedUser = '30000000-0000-4000-8000-000000000075';
  await db.query(
    `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified, is_platform_admin)
     VALUES
       ($1, 'scope71@example.test', 'pin', 'Scope User', '+254700000071', 'active', TRUE, FALSE),
       ($2, 'chair72@example.test', 'pin', 'Chair User', '+254700000072', 'active', TRUE, FALSE),
       ($3, 'admin73@example.test', 'pin', 'Admin User', '+254700000073', 'active', TRUE, TRUE),
       ($4, 'suspended74@example.test', 'pin', 'Suspended User', '+254700000074', 'active', TRUE, FALSE),
       ($5, 'exited75@example.test', 'pin', 'Exited User', '+254700000075', 'active', TRUE, FALSE)`,
    [scopedUser, chairUser, adminUser, suspendedUser, exitedUser],
  );

  const chamaA = '40000000-0000-4000-8000-000000000071';
  const chamaB = '40000000-0000-4000-8000-000000000072';
  const chamaC = '40000000-0000-4000-8000-000000000073';
  const chamaD = '40000000-0000-4000-8000-000000000074';
  await db.query(
    `INSERT INTO chamas (id, name, type, status, visibility, contribution_amount, contribution_frequency, currency)
     VALUES
       ($1, 'Scope A', 'goal_based', 'active', 'public', 1000, 'monthly', 'KES'),
       ($2, 'Scope B', 'goal_based', 'active', 'public', 1000, 'monthly', 'KES'),
       ($3, 'Scope C', 'goal_based', 'active', 'public', 1000, 'monthly', 'KES'),
       ($4, 'Scope D', 'goal_based', 'active', 'public', 1000, 'monthly', 'KES')`,
    [chamaA, chamaB, chamaC, chamaD],
  );

  await db.query(
    `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
     VALUES
       ($1, $5, 'secretary', 'active'),
       ($2, $5, 'treasurer', 'active'),
       ($1, $6, 'chairperson', 'active'),
       ($2, $7, 'member', 'active'),
       ($3, $8, 'secretary', 'suspended'),
       ($4, $9, 'secretary', 'exited')`,
    [chamaA, chamaB, chamaC, chamaD, scopedUser, chairUser, adminUser, suspendedUser, exitedUser],
  );

  const repository = createPostgresChamaMembershipRepository(db);

  // Secretary capability exists in Chama A only; Chama B resolves the same identity as Treasurer.
  const secretaryGuard = requireChamaRoles(['SECRETARY'], { repository, allowSuperAdmin: false });
  const a = responseRecorder();
  let aNext = 0;
  await secretaryGuard(request(scopedUser, chamaA), a.response, () => { aNext += 1; });
  assert.equal(aNext, 1);

  const b = responseRecorder();
  let bNext = 0;
  await secretaryGuard(request(scopedUser, chamaB), b.response, () => { bNext += 1; });
  assert.equal(bNext, 0);
  assert.equal(b.statusCode, 403);

  // A client-selected active-Chama hint cannot elevate the route-scoped Chama B request.
  const spoof = responseRecorder();
  let spoofNext = 0;
  const spoofRequest = request(scopedUser, chamaB);
  spoofRequest.headers['x-active-chama-id'] = chamaA;
  await secretaryGuard(spoofRequest, spoof.response, () => { spoofNext += 1; });
  assert.equal(spoofNext, 0);
  assert.equal(spoof.statusCode, 403);

  // Treasurer and Chairperson retain ordinary Member capability in their own Chamas.
  const memberGuard = requireChamaRoles(['MEMBER'], { repository, allowSuperAdmin: false });
  for (const [userId, chamaId] of [[scopedUser, chamaB], [chairUser, chamaA]] as const) {
    const recorder = responseRecorder();
    let nextCalls = 0;
    await memberGuard(request(userId, chamaId), recorder.response, () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
  }

  // One membership row cannot be duplicated to give the same user a second office in the same Chama.
  await assert.rejects(
    db.query(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
       VALUES ($1, $2, 'treasurer', 'active')`,
      [chamaA, scopedUser],
    ),
    /duplicate key|unique/i,
  );
  assert.equal(
    Number((await db.query(`SELECT COUNT(*) FROM chama_members WHERE chama_id = $1 AND user_id = $2`, [chamaA, scopedUser])).rows[0].count),
    1,
  );

  // Suspended/exited memberships are invisible to the active-membership repository and lose office power.
  for (const [userId, chamaId] of [[suspendedUser, chamaC], [exitedUser, chamaD]] as const) {
    assert.equal(await repository.findActiveMembership(userId, chamaId), null);
    const recorder = responseRecorder();
    let nextCalls = 0;
    await secretaryGuard(request(userId, chamaId), recorder.response, () => { nextCalls += 1; });
    assert.equal(nextCalls, 0);
    assert.equal(recorder.statusCode, 403);
  }

  // PostgreSQL role reassignment takes effect immediately; stale client context cannot preserve Secretary access.
  await db.query(`UPDATE chama_members SET role = 'member' WHERE chama_id = $1 AND user_id = $2`, [chamaA, scopedUser]);
  const stale = responseRecorder();
  let staleNext = 0;
  await secretaryGuard(request(scopedUser, chamaA), stale.response, () => { staleNext += 1; });
  assert.equal(staleNext, 0);
  assert.equal(stale.statusCode, 403);

  // Platform administration comes only from users.is_platform_admin, independently of Chama office.
  const flags = await db.query<{ id: string; is_platform_admin: boolean }>(
    `SELECT id, is_platform_admin FROM users WHERE id IN ($1, $2) ORDER BY id`,
    [scopedUser, adminUser],
  );
  const flagById = new Map(flags.rows.map((row) => [row.id, row.is_platform_admin]));
  assert.deepEqual(identityRolesFromPlatformFlag(flagById.get(scopedUser) ?? false), ['MEMBER']);
  assert.deepEqual(identityRolesFromPlatformFlag(flagById.get(adminUser) ?? false), ['SUPER_ADMIN']);

  const adminGuard = protectAdministrativeRoutes('/api/v1/admin');
  const officeAdminAttempt = responseRecorder();
  let officeAdminNext = 0;
  const officeAdminRequest = request(scopedUser, chamaA);
  officeAdminRequest.originalUrl = '/api/v1/admin/users';
  await adminGuard(officeAdminRequest, officeAdminAttempt.response, () => { officeAdminNext += 1; });
  assert.equal(officeAdminNext, 0);
  assert.equal(officeAdminAttempt.statusCode, 403);

  const platformAdminAttempt = responseRecorder();
  let platformAdminNext = 0;
  const platformAdminRequest = request(adminUser, chamaB, identityRolesFromPlatformFlag(true));
  platformAdminRequest.originalUrl = '/api/v1/admin/users';
  await adminGuard(platformAdminRequest, platformAdminAttempt.response, () => { platformAdminNext += 1; });
  assert.equal(platformAdminNext, 1);
});

function request(userId: string, chamaId: string, roles: readonly ('MEMBER' | 'SUPER_ADMIN')[] = ['MEMBER']): ApiRequest {
  return { headers: {}, params: { chamaId }, auth: { userId, roles } };
}

function responseRecorder() {
  let statusCode = 200;
  let body: unknown;
  const response: ApiResponse = {
    status(code) {
      statusCode = code;
      return {
        json(value: unknown) {
          body = value;
          return value;
        },
      };
    },
  };
  return {
    response,
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}
