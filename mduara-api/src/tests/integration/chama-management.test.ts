import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { ChamaApplicationService } from '../../services/chama-application.service';
import { ChamaInvitationService } from '../../services/chama-invitation.service';
import { ChamaService } from '../../services/chama.service';
import { PublicChamaService } from '../../services/public-chama.service';
import { UserProfileService } from '../../services/user-profile.service';
import { hashSecret } from '../../utils/crypto.util';
import { ConflictError } from '../../utils/errors';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-06 user and Chama group management contract', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be06_${randomUUID().replace(/-/g, '')}`;
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
  async function createUser(name: string, explicitPhone?: string) {
    return (await pool.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id`,
      [`${randomUUID()}@example.test`, pinHash, name, explicitPhone ?? `+2547${Math.floor(10000000 + Math.random() * 89999999)}`],
    )).rows[0];
  }

  const founder = await createUser('Founder Chair');
  const applicant = await createUser('Applicant One');
  const rejectedApplicant = await createUser('Applicant Two');
  const replacementChair = await createUser('Replacement Chair');

  const chamaService = new ChamaService(pool);
  const applicationService = new ChamaApplicationService(pool);
  const publicChamaService = new PublicChamaService(pool);
  const invitationService = new ChamaInvitationService(pool);
  const profileService = new UserProfileService(pool);

  await t.test('profile metadata can be updated without exposing credential mutation', async () => {
    const profile = await profileService.updateOwnProfile(applicant.id, {
      fullName: 'Applicant Updated',
      nationalId: 'BE06-ID-001',
      dateOfBirth: '2000-01-02',
      avatarUrl: 'https://example.test/avatar.png',
    });

    assert.equal(profile.fullName, 'Applicant Updated');
    assert.equal(profile.nationalId, 'BE06-ID-001');
    assert.equal(profile.dateOfBirth, '2000-01-02');
    assert.equal(profile.avatarUrl, 'https://example.test/avatar.png');
  });

  const chama = await chamaService.createChama({
    name: 'BE-06 Managed Chama',
    type: 'table_banking',
    contribution_amount: 5000,
    contribution_frequency: 'monthly',
    visibility: 'application',
    target_members: 3,
    created_by: founder.id,
  });

  const rule = (await pool.query<{ id: string; version: number; commitment_amount: string }>(
    `SELECT id, version, commitment_amount::text AS commitment_amount
     FROM chama_rules
     WHERE chama_id = $1 AND status = 'active'`,
    [chama.id],
  )).rows[0];

  await t.test('Chama creation atomically seeds the founder and initial active Constitution', async () => {
    const membership = (await pool.query<{ role: string; membership_status: string }>(
      `SELECT role::text AS role, membership_status::text AS membership_status
       FROM chama_members WHERE chama_id = $1 AND user_id = $2`,
      [chama.id, founder.id],
    )).rows[0];
    assert.equal(membership.role, 'chairperson');
    assert.equal(membership.membership_status, 'active');
    assert.equal(rule.version, 1);
    assert.equal(rule.commitment_amount, '500');
  });

  await publicChamaService.apply({
    userId: applicant.id,
    chamaId: chama.id,
    constitutionRuleId: rule.id,
    message: 'Please approve me',
  });
  await publicChamaService.apply({
    userId: rejectedApplicant.id,
    chamaId: chama.id,
    constitutionRuleId: rule.id,
    message: 'Second application',
  });

  await t.test('leadership can list pending applications and approval preserves the commitment gate', async () => {
    const queue = await applicationService.list({ chamaId: chama.id, page: 1, perPage: 25, status: 'pending' });
    assert.equal(queue.meta.total, 2);
    const application = queue.applications.find((item) => item.userId === applicant.id);
    assert.ok(application);

    const reviewed = await applicationService.review({
      chamaId: chama.id,
      applicationId: application!.id,
      actorId: founder.id,
      decision: 'approve',
    });

    assert.equal(reviewed.outcome, 'commitment_required');
    assert.equal(reviewed.membership.membership_status, 'pending');
    assert.equal(reviewed.application.status, 'commitment_pending');
    assert.equal(reviewed.commitment.required, true);

    const acceptanceCount = Number((await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM membership_constitution_acceptances
       WHERE membership_id = $1 AND chama_rule_id = $2`,
      [reviewed.membership.id, rule.id],
    )).rows[0].count);
    assert.equal(acceptanceCount, 1);

    const depositCount = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM commitment_deposits WHERE membership_id = $1`,
      [reviewed.membership.id],
    )).rows[0].count);
    assert.equal(depositCount, 1);
  });

  await t.test('rejection records the reviewer and reason without creating membership', async () => {
    const queue = await applicationService.list({ chamaId: chama.id, page: 1, perPage: 25, status: 'pending' });
    const application = queue.applications.find((item) => item.userId === rejectedApplicant.id);
    assert.ok(application);

    const reviewed = await applicationService.review({
      chamaId: chama.id,
      applicationId: application!.id,
      actorId: founder.id,
      decision: 'reject',
      rejectionReason: 'Current group capacity plan does not fit this application.',
    });
    assert.equal(reviewed.outcome, 'rejected');
    assert.equal(reviewed.application.status, 'rejected');
    assert.equal(reviewed.application.reviewed_by, founder.id);

    const membershipCount = Number((await pool.query(
      `SELECT COUNT(*)::int AS count FROM chama_members WHERE chama_id = $1 AND user_id = $2`,
      [chama.id, rejectedApplicant.id],
    )).rows[0].count);
    assert.equal(membershipCount, 0);
  });

  await t.test('the last active chairperson cannot be removed and exits maintain exit_date', async () => {
    await assert.rejects(
      chamaService.updateMember({
        chamaId: chama.id,
        userId: founder.id,
        updates: { membership_status: 'exited' },
        actorId: founder.id,
      }),
      (error: unknown) => error instanceof ConflictError && error.code === 'LAST_ACTIVE_CHAIRPERSON',
    );

    await pool.query(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status, approved_by, approved_at)
       VALUES ($1, $2, 'chairperson', 'active', $3, CURRENT_TIMESTAMP)`,
      [chama.id, replacementChair.id, founder.id],
    );

    const exited = await chamaService.updateMember({
      chamaId: chama.id,
      userId: founder.id,
      updates: { membership_status: 'exited' },
      actorId: replacementChair.id,
    });
    assert.equal(exited.membership_status, 'exited');
    assert.ok(exited.exit_date);

    const reactivated = await chamaService.updateMember({
      chamaId: chama.id,
      userId: founder.id,
      updates: { membership_status: 'active' },
      actorId: replacementChair.id,
    });
    assert.equal(reactivated.membership_status, 'active');
    assert.equal(reactivated.exit_date, null);
  });

  await t.test('phone-only invitations survive deferred signup and are claimed by the authenticated phone owner', async () => {
    const privateChama = await chamaService.createChama({
      name: 'Deferred Signup Chama',
      type: 'table_banking',
      contribution_amount: 2000,
      contribution_frequency: 'monthly',
      visibility: 'private',
      target_members: 5,
      created_by: founder.id,
    });
    const privateRule = (await pool.query<{ id: string }>(
      `SELECT id FROM chama_rules WHERE chama_id = $1 AND status = 'active'`,
      [privateChama.id],
    )).rows[0];

    const deferredPhone = '+254700007771';
    const invite = await chamaService.inviteApplicant({
      chamaId: privateChama.id,
      phone: deferredPhone,
      requestedRole: 'member',
      message: 'Join after signup',
    });
    assert.equal(invite.invitation.applicant_id, null);

    const deferredUser = await createUser('Deferred Invite User', deferredPhone);
    const joined = await publicChamaService.apply({
      userId: deferredUser.id,
      chamaId: privateChama.id,
      constitutionRuleId: privateRule.id,
      invitationId: invite.invitation.id,
    });
    assert.equal(joined.outcome, 'commitment_required');
    assert.equal(joined.membership.membership_status, 'pending');

    const inviteState = (await pool.query<{ applicant_id: string; status: string }>(
      `SELECT applicant_id, status::text AS status FROM chama_invitations WHERE id = $1`,
      [invite.invitation.id],
    )).rows[0];
    assert.equal(inviteState.applicant_id, deferredUser.id);
    assert.equal(inviteState.status, 'accepted');

    const cancelInvite = await chamaService.inviteApplicant({
      chamaId: privateChama.id,
      phone: '+254700007772',
      requestedRole: 'member',
    });
    const cancelled = await invitationService.cancel(privateChama.id, cancelInvite.invitation.id, founder.id);
    assert.equal(cancelled.status, 'cancelled');

    const rejectPhone = '+254700007773';
    const rejectUser = await createUser('Invitation Rejector', rejectPhone);
    const rejectInvite = await chamaService.inviteApplicant({
      chamaId: privateChama.id,
      applicantId: rejectUser.id,
      phone: rejectPhone,
      requestedRole: 'member',
    });
    const rejected = await invitationService.reject(privateChama.id, rejectInvite.invitation.id, rejectUser.id);
    assert.equal(rejected.status, 'rejected');

    const resendInvite = await chamaService.inviteApplicant({
      chamaId: privateChama.id,
      phone: '+254700007774',
      requestedRole: 'member',
    });
    const resendTarget = await invitationService.getForResend(privateChama.id, resendInvite.invitation.id);
    assert.equal(resendTarget.phone, '+254700007774');
    const sent = await invitationService.markSent(privateChama.id, resendInvite.invitation.id);
    assert.equal(sent.status, 'sent');
  });

  await t.test('invitation creation respects target capacity and avoids duplicate active invitations', async () => {
    await chamaService.updateMember({
      chamaId: chama.id,
      userId: founder.id,
      updates: { membership_status: 'exited' },
      actorId: replacementChair.id,
    });

    const first = await chamaService.inviteApplicant({
      chamaId: chama.id,
      applicantId: rejectedApplicant.id,
      requestedRole: 'member',
      phone: '+254700009999',
    });
    assert.equal(first.invitation.recipient_phone, '+254700009999');

    await assert.rejects(
      chamaService.inviteApplicant({
        chamaId: chama.id,
        applicantId: rejectedApplicant.id,
        requestedRole: 'member',
      }),
      (error: unknown) => error instanceof ConflictError && error.code === 'CHAMA_INVITATION_EXISTS',
    );
  });
});


test('BE-14 recruitment, invitation and approval lifecycle', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `recruitment_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 10, options: `-c search_path=${schema},public` });

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

  const pinHash = await hashSecret('2468');
  let phoneCounter = 710000000;
  async function createUser(name: string) {
    phoneCounter += 1;
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [`${randomUUID()}@example.test`, pinHash, name, `+254${phoneCounter}`],
    )).rows[0];
  }

  async function createChamaFixture(input: {
    name: string;
    visibility: 'public' | 'application' | 'private';
    targetMembers?: number;
    recruitmentDeadline?: string | null;
  }) {
    const founder = await createUser(`${input.name} Founder`);
    const chama = (await db.query<{ id: string }>(
      `INSERT INTO chamas
         (name, type, status, visibility, goal_code, location, target_members,
          recruitment_deadline, contribution_amount, contribution_frequency,
          saving_start_date, saving_end_date, created_by)
       VALUES ($1, 'goal_based', 'recruiting', $2::chama_visibility, 'washing_machine', 'Nairobi', $3,
               $4::date, 5000, 'monthly', DATE '2026-10-01', DATE '2027-03-30', $5)
       RETURNING id`,
      [input.name, input.visibility, input.targetMembers ?? 10, input.recruitmentDeadline ?? null, founder.id],
    )).rows[0];

    const rule = (await db.query<{ id: string }>(
      `INSERT INTO chama_rules
         (chama_id, version, status, purpose_goal, contribution_amount, contribution_frequency,
          commitment_amount, exit_withdrawal_policy, payout_policy, conduct_dispute_policy, dissolution_policy)
       VALUES ($1, 1, 'active', 'Save toward a washing machine', 5000, 'monthly', 0,
               '{"noticeDays":30}', '{"window":"March-April"}', '{"disputes":"vote"}', '{"voteRequired":true}')
       RETURNING id`,
      [chama.id],
    )).rows[0];

    await db.query(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status, approved_at)
       VALUES ($1, $2, 'chairperson', 'active', CURRENT_TIMESTAMP)`,
      [chama.id, founder.id],
    );
    return { chamaId: chama.id, ruleId: rule.id, founderId: founder.id };
  }

  const publicService = new PublicChamaService(db);
  const chamaService = new ChamaService(db);
  const applicationService = new ChamaApplicationService(db);

  await t.test('deadline-passed recruitment rejects a new application/join', async () => {
    const fixture = await createChamaFixture({
      name: 'Expired Recruitment',
      visibility: 'public',
      recruitmentDeadline: '2026-09-16',
    });
    const applicant = await createUser('Late Applicant');

    await assert.rejects(publicService.apply({
      userId: applicant.id,
      chamaId: fixture.chamaId,
      constitutionRuleId: fixture.ruleId,
    }));
  });

  await t.test('the last slot closes recruitment atomically and does not reopen after an exit', async () => {
    const fixture = await createChamaFixture({
      name: 'Last Slot Chama',
      visibility: 'public',
      targetMembers: 2,
      recruitmentDeadline: '2026-12-31',
    });
    const first = await createUser('Concurrent Applicant A');
    const second = await createUser('Concurrent Applicant B');

    const settled = await Promise.allSettled([
      publicService.apply({ userId: first.id, chamaId: fixture.chamaId, constitutionRuleId: fixture.ruleId }),
      publicService.apply({ userId: second.id, chamaId: fixture.chamaId, constitutionRuleId: fixture.ruleId }),
    ]);
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);

    const state = (await db.query<{ count: number; recruitment_closed_at: string | null }>(
      `SELECT COUNT(cm.id)::int AS count, MAX(c.recruitment_closed_at)::text AS recruitment_closed_at
         FROM chamas c
         JOIN chama_members cm ON cm.chama_id = c.id
        WHERE c.id = $1 AND cm.membership_status IN ('active','pending')
        GROUP BY c.id`,
      [fixture.chamaId],
    )).rows[0];
    assert.equal(Number(state.count), 2);
    assert.ok(state.recruitment_closed_at);

    const joinedUserId = settled[0].status === 'fulfilled' ? first.id : second.id;
    await db.query(
      `UPDATE chama_members SET membership_status = 'exited', exit_date = CURRENT_TIMESTAMP
        WHERE chama_id = $1 AND user_id = $2`,
      [fixture.chamaId, joinedUserId],
    );
    const replacement = await createUser('Replacement Applicant');
    await assert.rejects(publicService.apply({
      userId: replacement.id,
      chamaId: fixture.chamaId,
      constitutionRuleId: fixture.ruleId,
    }));
  });

  await t.test('Private Chamas require a live token and multi-use tokens stop exactly at max uses', async () => {
    const fixture = await createChamaFixture({
      name: 'Private Token Chama',
      visibility: 'private',
      targetMembers: 8,
      recruitmentDeadline: '2026-12-31',
    });
    const noTokenUser = await createUser('No Token User');
    await assert.rejects(publicService.apply({
      userId: noTokenUser.id,
      chamaId: fixture.chamaId,
      constitutionRuleId: fixture.ruleId,
    }));

    const created = await chamaService.inviteApplicant({
      chamaId: fixture.chamaId,
      shareable: true,
      maxUses: 2,
      expiresAt: '2026-12-31T23:59:59+03:00',
      requestedRole: 'member',
    });
    assert.ok(created.inviteToken.length >= 20);

    const stored = (await db.query<{ invite_token_hash: string; max_uses: number; use_count: number }>(
      `SELECT invite_token_hash, max_uses, use_count FROM chama_invitations WHERE id = $1`,
      [created.invitation.id],
    )).rows[0];
    assert.notEqual(stored.invite_token_hash, created.inviteToken);
    assert.equal(Number(stored.max_uses), 2);
    assert.equal(Number(stored.use_count), 0);

    const invitedOne = await createUser('Invited One');
    const invitedTwo = await createUser('Invited Two');
    const invitedThree = await createUser('Invited Three');
    for (const user of [invitedOne, invitedTwo]) {
      const joined = await publicService.apply({
        userId: user.id,
        chamaId: fixture.chamaId,
        constitutionRuleId: fixture.ruleId,
        invitationToken: created.inviteToken,
      });
      assert.equal(joined.outcome, 'joined');
    }

    const exhausted = (await db.query<{ status: string; use_count: number }>(
      `SELECT status::text AS status, use_count FROM chama_invitations WHERE id = $1`,
      [created.invitation.id],
    )).rows[0];
    assert.equal(Number(exhausted.use_count), 2);
    assert.equal(exhausted.status, 'accepted');

    await assert.rejects(publicService.apply({
      userId: invitedThree.id,
      chamaId: fixture.chamaId,
      constitutionRuleId: fixture.ruleId,
      invitationToken: created.inviteToken,
    }));
  });

  await t.test('application approval is Chair/Secretary-only and can close the last slot', async () => {
    const fixture = await createChamaFixture({
      name: 'Application Chama',
      visibility: 'application',
      targetMembers: 2,
      recruitmentDeadline: '2026-12-31',
    });
    const applicant = await createUser('Pending Applicant');
    const ordinary = await createUser('Ordinary Member');
    await db.query(
      `INSERT INTO chama_members (chama_id, user_id, role, membership_status)
       VALUES ($1, $2, 'member', 'active')`,
      [fixture.chamaId, ordinary.id],
    );
    // Temporarily make target 3 so the ordinary member + founder leave one slot.
    await db.query(`UPDATE chamas SET target_members = 3 WHERE id = $1`, [fixture.chamaId]);

    const pending = await publicService.apply({
      userId: applicant.id,
      chamaId: fixture.chamaId,
      constitutionRuleId: fixture.ruleId,
      message: 'Please consider my application',
    });
    assert.equal(pending.outcome, 'application_pending');

    await assert.rejects(applicationService.reviewByApplicationId({
      applicationId: pending.application.id,
      actorId: ordinary.id,
      decision: 'approve',
    }));

    const approved = await applicationService.reviewByApplicationId({
      applicationId: pending.application.id,
      actorId: fixture.founderId,
      decision: 'approve',
    });
    assert.equal(approved.outcome, 'approved');

    const closure = (await db.query<{ recruitment_closed_at: string | null }>(
      `SELECT recruitment_closed_at::text FROM chamas WHERE id = $1`,
      [fixture.chamaId],
    )).rows[0];
    assert.ok(closure.recruitment_closed_at);
  });
});


test('BE-15 Constitution setup, history and digital acceptance contract', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be15_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  await migrate({
    databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema,
    createSchema: true, migrationsSchema: schema, migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql', singleTransaction: true, log: () => {},
  });

  const pinHash = await hashSecret('2468');
  const founder = (await db.query<{ id: string }>(
    `INSERT INTO users (email, pin_hash, full_name, phone, status)
     VALUES ($1, $2, 'Constitution Chair', '+254700009901', 'active') RETURNING id`,
    [`${randomUUID()}@example.test`, pinHash],
  )).rows[0];
  const service = new ChamaService(db);

  const chama = await service.createChama({
    name: 'BE-15 Goal Mbogi',
    description: 'Save for a verified Phase 1 goal',
    type: 'goal_based',
    contribution_amount: 4000,
    contribution_frequency: 'monthly',
    visibility: 'application',
    constitution_template: 'goal_based',
    constitution: {
      template_code: 'goal_based',
      default_grace_period_days: 2,
      default_after_consecutive_misses: 3,
      quorum_threshold_pct: 60,
      majority_threshold_pct: 50,
    },
    created_by: founder.id,
  });

  const founderMembership = (await db.query<{ id: string }>(
    `SELECT id FROM chama_members WHERE chama_id = $1 AND user_id = $2`,
    [chama.id, founder.id],
  )).rows[0];

  await t.test('creation applies a typed template and setup can be edited only before acceptance', async () => {
    const initial = (await db.query<any>(
      `SELECT template_code, contribution_amount::text, default_grace_period_days,
              default_after_consecutive_misses, quorum_threshold_pct::text,
              dissolution_policy, payout_policy
         FROM chama_rules WHERE chama_id = $1 AND status = 'active'`,
      [chama.id],
    )).rows[0];
    assert.equal(initial.template_code, 'goal_based');
    assert.equal(initial.contribution_amount, '4000');
    assert.equal(initial.default_grace_period_days, 2);
    assert.equal(initial.default_after_consecutive_misses, 3);
    assert.equal(initial.quorum_threshold_pct, '60.00');
    assert.equal(initial.dissolution_policy.requires_member_vote, true);
    assert.equal(initial.payout_policy.trigger, 'goal_completion');

    const configured = await service.configureConstitution(chama.id, founder.id, {
      purpose_goal: 'Save for a washing machine',
      contribution_amount: 4500,
      contribution_frequency: 'monthly',
      contribution_due_day: 5,
      late_fine_type: 'flat',
      late_fine_amount: 100,
    });
    assert.equal(configured.purposeGoal, 'Save for a washing machine');
    assert.equal(configured.contribution.amount, '4500');
    assert.equal(configured.contribution.dueDay, 5);

    const chamaContribution = (await db.query<{ amount: string }>(
      `SELECT contribution_amount::text AS amount FROM chamas WHERE id = $1`, [chama.id],
    )).rows[0];
    assert.equal(chamaContribution.amount, '4500');
  });

  await t.test('acceptance captures evidence, is idempotent and permanently locks setup mutation', async () => {
    const accepted = await service.acceptCurrentConstitution(founderMembership.id, founder.id, {
      ipAddress: '127.0.0.1', userAgent: 'be15-test-agent',
    });
    assert.equal(accepted.replayed, false);
    assert.equal(accepted.ipAddress, '127.0.0.1');
    assert.equal(accepted.userAgent, 'be15-test-agent');

    const replay = await service.acceptCurrentConstitution(founderMembership.id, founder.id, {
      ipAddress: '10.0.0.1', userAgent: 'should-not-replace-original-evidence',
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.ipAddress, '127.0.0.1');
    assert.equal(replay.userAgent, 'be15-test-agent');

    await assert.rejects(
      service.configureConstitution(chama.id, founder.id, { purpose_goal: 'Retroactive mutation' }),
      (error: unknown) => error instanceof ConflictError && error.code === 'CONSTITUTION_SETUP_LOCKED',
    );
  });

  await t.test('a later active version requires a fresh acceptance and history preserves both versions', async () => {
    const v1 = (await db.query<{ id: string }>(
      `SELECT id FROM chama_rules WHERE chama_id = $1 AND status = 'active'`, [chama.id],
    )).rows[0];
    await db.query(`UPDATE chama_rules SET status = 'superseded' WHERE id = $1`, [v1.id]);
    const v2 = (await db.query<{ id: string }>(
      `INSERT INTO chama_rules (
         chama_id, version, status, template_code, purpose_goal,
         contribution_amount, contribution_frequency, contribution_due_day,
         late_fine_type, late_fine_amount, late_fine_percentage, commitment_amount,
         default_grace_period_days, default_after_consecutive_misses,
         quorum_threshold_pct, majority_threshold_pct, exit_withdrawal_policy,
         payout_policy, conduct_dispute_policy, dissolution_policy, metadata,
         effective_from, supersedes_id, amendment_summary, created_by
       )
       SELECT chama_id, 2, 'active', template_code, purpose_goal,
              contribution_amount, contribution_frequency, contribution_due_day,
              late_fine_type, late_fine_amount, late_fine_percentage, commitment_amount,
              default_grace_period_days, default_after_consecutive_misses,
              quorum_threshold_pct, majority_threshold_pct, exit_withdrawal_policy,
              payout_policy, conduct_dispute_policy, dissolution_policy, metadata,
              CURRENT_TIMESTAMP, id, 'BE-17 simulated approved amendment', $2
         FROM chama_rules WHERE id = $1
       RETURNING id`,
      [v1.id, founder.id],
    )).rows[0];

    const before = await service.getConstitution(chama.id, founder.id);
    assert.equal(before.current?.id, v2.id);
    assert.equal(before.currentAcceptance.accepted, false);
    assert.equal(before.history.length, 2);

    const accepted = await service.acceptCurrentConstitution(founderMembership.id, founder.id, {
      ipAddress: '127.0.0.2', userAgent: 'be15-v2-agent',
    });
    assert.equal(accepted.constitution.version, 2);
    assert.equal(accepted.replayed, false);

    const acceptanceCount = Number((await db.query(
      `SELECT COUNT(*)::int AS count FROM membership_constitution_acceptances WHERE membership_id = $1`,
      [founderMembership.id],
    )).rows[0].count);
    assert.equal(acceptanceCount, 2);
  });

  await t.test('approved BE-17 amendment poll activates exactly the frozen Constitution changes', async () => {
    const current = (await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM chama_rules WHERE chama_id = $1 AND status = 'active'`, [chama.id],
    )).rows[0];
    const changes = { payout_policy: { trigger: 'goal_completion', settlement: 'provider_instruction', reviewed: true } };
    const summary = 'Change the payout clause';
    const poll = (await db.query<{ id: string }>(
      `INSERT INTO polls (
         chama_id, chama_rule_id, decision_type, decision_payload, action_option_code, title,
         quorum_threshold_pct, majority_threshold_pct, status, opens_at, closes_at,
         closed_at, close_reason, created_by
       ) VALUES ($1, $2, 'rule_amendment', $3::jsonb, 'approve', 'Amend Constitution',
                 50, 50, 'closed', TIMESTAMPTZ '2026-08-01 08:00:00+03',
                 TIMESTAMPTZ '2026-08-02 08:00:00+03', TIMESTAMPTZ '2026-08-01 09:00:00+03',
                 'full_turnout', $4)
       RETURNING id`,
      [chama.id, current.id, JSON.stringify({ amendment_summary: summary, changes }), founder.id],
    )).rows[0];
    const option = (await db.query<{ id: string }>(
      `INSERT INTO poll_options (poll_id, code, label, sort_order)
       VALUES ($1, 'approve', 'Approve', 1) RETURNING id`,
      [poll.id],
    )).rows[0];
    await db.query(
      `INSERT INTO poll_options (poll_id, code, label, sort_order) VALUES ($1, 'reject', 'Reject', 2)`,
      [poll.id],
    );
    await db.query(
      `INSERT INTO poll_eligible_voters (poll_id, chama_id, member_id) VALUES ($1, $2, $3)`,
      [poll.id, chama.id, founderMembership.id],
    );
    await db.query(
      `INSERT INTO poll_votes (poll_id, member_id, option_id) VALUES ($1, $2, $3)`,
      [poll.id, founderMembership.id, option.id],
    );

    const amended = await service.amendConstitution(chama.id, founder.id, {
      poll_id: poll.id,
      amendment_summary: summary,
      ...changes,
    });
    assert.equal(amended.version, current.version + 1);
    assert.equal(amended.status, 'active');
    assert.deepEqual(amended.payoutPolicy, changes.payout_policy);

    const old = (await db.query<{ status: string }>(`SELECT status::text AS status FROM chama_rules WHERE id = $1`, [current.id])).rows[0];
    assert.equal(old.status, 'superseded');
    const acted = (await db.query<{ acted_at: string | null }>(`SELECT acted_at::text FROM polls WHERE id = $1`, [poll.id])).rows[0];
    assert.ok(acted.acted_at);

    await assert.rejects(
      service.amendConstitution(chama.id, founder.id, {
        poll_id: poll.id,
        amendment_summary: summary,
        ...changes,
      }),
      (error: unknown) => error instanceof ConflictError,
    );
  });

});
