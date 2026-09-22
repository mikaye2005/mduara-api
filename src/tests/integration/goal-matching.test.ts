import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { GoalMatchingService } from '../../services/goal-matching.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-31 goal-to-Chama matching is eligible, explainable and deterministic', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `goal_matching_${randomUUID().replace(/-/g, '')}`;
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

  const userId = '30000000-0000-4000-8000-000000000031';
  const otherUserId = '30000000-0000-4000-8000-000000000032';
  await pool.query(
    `INSERT INTO users (id, email, pin_hash, full_name, phone, status, is_email_verified)
     VALUES
       ($1, 'matcher@example.test', 'test-pin-hash', 'Matcher User', '+254700000031', 'active', TRUE),
       ($2, 'other@example.test', 'test-pin-hash', 'Other User', '+254700000032', 'active', TRUE)`,
    [userId, otherUserId],
  );

  const chamas = await pool.query<{ id: string; name: string }>(
    `INSERT INTO chamas
       (name, type, status, visibility, goal_code, location, target_members,
        saving_start_date, saving_end_date, contribution_amount, contribution_frequency, target_amount, currency)
     VALUES
       ('Nairobi Washer Public', 'goal_based', 'recruiting', 'public', 'washing_machine', 'Nairobi', 5,
        '2026-10-01', '2027-09-30', 4000, 'monthly', 1200000, 'KES'),
       ('Washer Application', 'goal_based', 'active', 'application', 'washing_machine', 'Kiambu', 8,
        '2026-10-01', '2027-06-30', 3000, 'monthly', 1600000, 'KES'),
       ('Too Expensive Washer', 'goal_based', 'recruiting', 'public', 'washing_machine', 'Nairobi', 5,
        '2026-10-01', '2027-09-30', 6000, 'monthly', 1000000, 'KES'),
       ('Full Washer', 'goal_based', 'recruiting', 'public', 'washing_machine', 'Nairobi', 2,
        '2026-10-01', '2027-09-30', 2500, 'monthly', 900000, 'KES'),
       ('Completed Washer', 'goal_based', 'completed', 'public', 'washing_machine', 'Nairobi', 5,
        '2026-10-01', '2027-09-30', 2000, 'monthly', 800000, 'KES'),
       ('Wrong Goal Fridge', 'goal_based', 'recruiting', 'public', 'fridge', 'Nairobi', 5,
        '2026-10-01', '2027-09-30', 2000, 'monthly', 800000, 'KES'),
       ('Too Long Washer', 'goal_based', 'recruiting', 'public', 'washing_machine', 'Nairobi', 5,
        '2026-10-01', '2028-09-30', 2000, 'monthly', 1800000, 'KES'),
       ('Weekly Washer', 'goal_based', 'recruiting', 'public', 'washing_machine', 'Nairobi', 5,
        '2026-10-01', '2027-09-30', 1000, 'weekly', 1000000, 'KES'),
       ('Private Washer', 'goal_based', 'recruiting', 'private', 'washing_machine', 'Nairobi', 5,
        '2026-10-01', '2027-09-30', 3500, 'monthly', 1000000, 'KES')
     RETURNING id, name`,
  );
  const chamaId = new Map(chamas.rows.map((row) => [row.name, row.id]));

  await pool.query(
    `INSERT INTO chama_members (chama_id, user_id, membership_status)
     VALUES ($1, $2, 'active'), ($1, $3, 'pending')`,
    [chamaId.get('Full Washer'), userId, otherUserId],
  );

  const invitationId = '50000000-0000-4000-8000-000000000031';
  await pool.query(
    `INSERT INTO chama_invitations
       (id, chama_id, applicant_id, status, max_uses, use_count, expires_at)
     VALUES ($1, $2, $3, 'sent', 1, 0, CURRENT_TIMESTAMP + INTERVAL '1 day')`,
    [invitationId, chamaId.get('Private Washer'), userId],
  );

  const service = new GoalMatchingService(pool);
  const baseInput = {
    goalCode: 'washing_machine',
    targetAmount: 120000,
    contributionCapacity: 5000,
    contributionFrequency: 'monthly',
    durationMonths: 12,
    location: 'Nairobi',
    preferredVisibility: 'public' as const,
  };

  const publicResult = await service.findMatches(baseInput);
  assert.deepEqual(publicResult.matches.map((match) => match.chama.name), [
    'Nairobi Washer Public',
    'Washer Application',
  ]);
  assert.equal(publicResult.matches[0].rank, 1);
  assert.equal(publicResult.matches[0].joinable, true);
  assert.ok(publicResult.matches[0].matchReasons.some((reason) => reason.includes('Exact canonical')));

  const excluded = new Set(publicResult.matches.map((match) => match.chama.name));
  assert.equal(excluded.has('Too Expensive Washer'), false);
  assert.equal(excluded.has('Full Washer'), false);
  assert.equal(excluded.has('Completed Washer'), false);
  assert.equal(excluded.has('Wrong Goal Fridge'), false);
  assert.equal(excluded.has('Too Long Washer'), false);
  assert.equal(excluded.has('Weekly Washer'), false);
  assert.equal(excluded.has('Private Washer'), false);

  const repeatResult = await service.findMatches(baseInput);
  assert.deepEqual(
    repeatResult.matches.map((match) => [match.chama.id, match.score]),
    publicResult.matches.map((match) => [match.chama.id, match.score]),
  );

  const invitedResult = await service.findMatches({
    ...baseInput,
    invitationId,
    userId,
  });
  const privateMatch = invitedResult.matches.find((match) => match.chama.name === 'Private Washer');
  assert.equal(privateMatch?.entryMode, 'private_invite');
  assert.ok(privateMatch?.matchReasons.some((reason) => reason.includes('Valid applicant-specific invitation')));

  const wrongInviteUser = await service.findMatches({
    ...baseInput,
    invitationId,
    userId: otherUserId,
  });
  assert.equal(wrongInviteUser.matches.some((match) => match.chama.name === 'Private Washer'), false);

  const washingGoalId = '20000000-0000-4000-8000-000000000001';
  const byId = await service.findMatches({ ...baseInput, goalCode: undefined, savingGoalId: washingGoalId });
  assert.equal(byId.goal.code, 'washing_machine');

  await assert.rejects(
    service.findMatches({ ...baseInput, savingGoalId: washingGoalId, goalCode: 'fridge' }),
    /Saving goal not found or goal identifiers conflict/,
  );
});
