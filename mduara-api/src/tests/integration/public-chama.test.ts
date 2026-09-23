import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { PublicChamaService, deriveRecruitmentStatus } from '../../services/public-chama.service';
import { hashSecret } from '../../utils/crypto.util';
import { ForbiddenError } from '../../utils/errors';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-12 recruitment status derives open, almost-full and closed deterministically', () => {
  const today = new Date('2026-09-17T12:00:00.000Z');
  assert.equal(deriveRecruitmentStatus({ status: 'active', targetMembers: 10, occupiedCount: 5, recruitmentDeadline: '2026-09-30' }, today), 'OPEN');
  assert.equal(deriveRecruitmentStatus({ status: 'recruiting', targetMembers: 10, occupiedCount: 9, recruitmentDeadline: '2026-09-30' }, today), 'ALMOST_FULL');
  assert.equal(deriveRecruitmentStatus({ status: 'active', targetMembers: 10, occupiedCount: 10, recruitmentDeadline: '2026-09-30' }, today), 'CLOSED');
  assert.equal(deriveRecruitmentStatus({ status: 'active', targetMembers: 10, occupiedCount: 5, recruitmentDeadline: '2026-09-16' }, today), 'CLOSED');
});

test('BE-28 public discovery/detail/application contract', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `public_chama_${randomUUID().replace(/-/g, '')}`;
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

  const pinHash = await hashSecret('2468');
  async function createUser(name: string, phone: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [`${randomUUID()}@example.test`, pinHash, name, phone],
    )).rows[0];
  }

  const applicant = await createUser('Applicant', '+254700001001');
  const official = await createUser('Public Chair', '+254700001002');

  async function createChama(name: string, visibility: 'public' | 'application' | 'private') {
    const chama = (await pool.query<{ id: string }>(
      `INSERT INTO chamas
         (name, type, status, visibility, goal_code, location, target_members,
          contribution_amount, contribution_frequency, saving_start_date, saving_end_date)
       VALUES ($1, 'goal_based', 'recruiting', $2::chama_visibility, 'washing_machine', 'Nairobi', 20,
               5000, 'monthly', DATE '2026-10-01', DATE '2027-03-30')
       RETURNING id`,
      [name, visibility],
    )).rows[0];

    const rule = (await pool.query<{ id: string }>(
      `INSERT INTO chama_rules
         (chama_id, version, status, purpose_goal, contribution_amount, contribution_frequency,
          commitment_amount, exit_withdrawal_policy, payout_policy, conduct_dispute_policy, dissolution_policy)
       VALUES ($1, 1, 'active', 'Save toward a washing machine', 5000, 'monthly', 500,
               '{"noticeDays":30}', '{"window":"March-April"}', '{"disputes":"vote"}', '{"voteRequired":true}')
       RETURNING id`,
      [chama.id],
    )).rows[0];
    return { chamaId: chama.id, ruleId: rule.id };
  }

  const publicChama = await createChama('Public Washing Machine Mbogi', 'public');
  const applicationChama = await createChama('Application Washing Machine Mbogi', 'application');
  const privateChama = await createChama('Private Washing Machine Mbogi', 'private');

  await pool.query(
    `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
     VALUES ($1, $2, 'chairperson', 'active')`,
    [publicChama.chamaId, official.id],
  );

  const service = new PublicChamaService(pool);

  await t.test('public list excludes private Chamas and supports goal/duration/capacity filters', async () => {
    const result = await service.list({
      page: 1,
      perPage: 20,
      goalCode: 'washing_machine',
      minDurationMonths: 6,
      maxDurationMonths: 6,
      hasCapacity: true,
    });

    assert.equal(result.meta.total, 2);
    assert.equal(result.chamas.some((chama) => chama.id === privateChama.chamaId), false);
    assert.equal(result.chamas.every((chama) => chama.durationMonths === 6), true);
    assert.equal(result.chamas.every((chama) => chama.availableSpots !== null && chama.availableSpots! > 0), true);
    assert.equal(result.chamas.every((chama) => ['OPEN', 'ALMOST_FULL'].includes(chama.recruitmentStatus)), true);
  });

  await t.test('public detail exposes officials and active Constitution without private contact/financial data', async () => {
    const detail = await service.getPublicDetail(publicChama.chamaId);
    assert.equal(detail.name, 'Public Washing Machine Mbogi');
    assert.equal(detail.officials[0]?.name, 'Public Chair');
    assert.equal(detail.officials[0]?.role, 'chairperson');
    assert.equal('phone' in (detail.officials[0] ?? {}), false);
    assert.equal('pooledAmount' in detail, false);
    assert.equal(detail.constitution?.id, publicChama.ruleId);
    assert.equal(detail.constitution?.commitmentAmount, '500');
    assert.equal(detail.constitution?.acceptanceRequired, true);
    assert.equal(['OPEN', 'ALMOST_FULL'].includes(detail.recruitmentStatus), true);

    await assert.rejects(service.getPublicDetail(privateChama.chamaId));
  });

  await t.test('APPLICATION visibility creates a pending application without manufacturing membership', async () => {
    const result = await service.apply({
      userId: applicant.id,
      chamaId: applicationChama.chamaId,
      constitutionRuleId: applicationChama.ruleId,
      message: 'I would like to join',
    });
    assert.equal(result.outcome, 'application_pending');
    assert.equal(result.membership, null);
    assert.equal(result.application.status, 'pending');

    const membershipCount = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM chama_members WHERE chama_id = $1 AND user_id = $2`,
      [applicationChama.chamaId, applicant.id],
    )).rows[0].count);
    assert.equal(membershipCount, 0);
  });

  await t.test('PUBLIC visibility records Constitution acceptance and returns commitment gate instead of false active success', async () => {
    const result = await service.apply({
      userId: applicant.id,
      chamaId: publicChama.chamaId,
      constitutionRuleId: publicChama.ruleId,
    });
    assert.equal(result.outcome, 'commitment_required');
    assert.equal(result.membership.membership_status, 'pending');
    assert.equal(result.commitment.amount, '500');

    const acceptanceCount = Number((await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM membership_constitution_acceptances
       WHERE membership_id = $1 AND chama_rule_id = $2`,
      [result.membership.id, publicChama.ruleId],
    )).rows[0].count);
    assert.equal(acceptanceCount, 1);
  });

  await t.test('PRIVATE visibility rejects direct application and accepts an applicant-specific valid invite', async () => {
    await assert.rejects(
      service.apply({
        userId: applicant.id,
        chamaId: privateChama.chamaId,
        constitutionRuleId: privateChama.ruleId,
      }),
      ForbiddenError,
    );

    const invite = (await pool.query<{ id: string }>(
      `INSERT INTO chama_invitations (chama_id, applicant_id, requested_role, status, expires_at)
       VALUES ($1, $2, 'member', 'sent', CURRENT_TIMESTAMP + INTERVAL '1 day') RETURNING id`,
      [privateChama.chamaId, applicant.id],
    )).rows[0];

    const result = await service.apply({
      userId: applicant.id,
      chamaId: privateChama.chamaId,
      constitutionRuleId: privateChama.ruleId,
      invitationId: invite.id,
    });
    assert.equal(result.outcome, 'commitment_required');
    assert.equal(result.membership.membership_status, 'pending');

    const inviteState = (await pool.query<{ status: string; use_count: number }>(
      `SELECT status::text AS status, use_count FROM chama_invitations WHERE id = $1`,
      [invite.id],
    )).rows[0];
    assert.equal(inviteState.status, 'accepted');
    assert.equal(inviteState.use_count, 1);
  });
});
