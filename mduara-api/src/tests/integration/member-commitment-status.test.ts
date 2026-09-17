import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { ChamaBusinessBase } from '../../shared/business_base';
import { refreshMemberCommitmentStatuses } from '../../jobs/member-commitment-status';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-23 commitment status derivation and privacy-safe member list', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be23_${randomUUID().replace(/-/g, '')}`;
  const adminDb = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 6, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await db.end();
    await adminDb.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminDb.end();
  });

  await migrate({
    databaseUrl: databaseUrl!, dir: 'migrations', direction: 'up', schema,
    createSchema: true, migrationsSchema: schema, migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql', singleTransaction: true, log: () => {},
  });

  async function createUser(name: string, suffix: string) {
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email,pin_hash,full_name,phone,status,is_email_verified)
       VALUES ($1,'hash',$2,$3,'active',TRUE) RETURNING id`,
      [`${randomUUID()}@example.test`, name, `+254744${suffix.padStart(6, '0')}`],
    )).rows[0].id;
  }
  async function createMember(chamaId: string, userId: string, status: 'active' | 'defaulted' = 'active') {
    return (await db.query<{ id: string }>(
      `INSERT INTO chama_members (chama_id,user_id,role,membership_status)
       VALUES ($1,$2,'member',$3::membership_status) RETURNING id`,
      [chamaId, userId, status],
    )).rows[0].id;
  }
  async function assessedContribution(chamaId: string, memberId: string, label: string, missCount: number, dueDate: string) {
    await db.query(
      `INSERT INTO contributions
         (chama_id,member_id,expected_amount,due_date,status,period_label,penalty_checked_at,missed_at,consecutive_miss_count)
       VALUES ($1,$2,1000,$3,$4,$5,CURRENT_TIMESTAMP,$6,$7)`,
      [chamaId, memberId, dueDate, missCount ? 'late' : 'paid', label, missCount ? new Date(`${dueDate}T00:00:00Z`) : null, missCount],
    );
  }

  const creator = await createUser('Status Creator', '1');
  const onTrackUser = await createUser('On Track Member', '2');
  const missedOneUser = await createUser('Missed Once Member', '3');
  const missedTwoUser = await createUser('Missed Twice Member', '4');
  const defaultUser = await createUser('Defaulted Member', '5');
  const chamaId = (await db.query<{ id: string }>(
    `INSERT INTO chamas (name,type,status,visibility,contribution_amount,contribution_frequency,created_by)
     VALUES ('Commitment Status Chama','goal_based','active','application',1000,'monthly',$1) RETURNING id`,
    [creator],
  )).rows[0].id;

  const onTrack = await createMember(chamaId, onTrackUser);
  const missedOne = await createMember(chamaId, missedOneUser);
  const missedTwo = await createMember(chamaId, missedTwoUser);
  const defaulted = await createMember(chamaId, defaultUser, 'defaulted');

  await assessedContribution(chamaId, onTrack, '2026-06', 1, '2026-06-30');
  await assessedContribution(chamaId, onTrack, '2026-07', 0, '2026-07-31');
  await assessedContribution(chamaId, missedOne, '2026-07', 1, '2026-07-31');
  await assessedContribution(chamaId, missedTwo, '2026-06', 1, '2026-06-30');
  await assessedContribution(chamaId, missedTwo, '2026-07', 2, '2026-07-31');

  await t.test('materialized status follows latest assessed BE-08 miss/default state', async () => {
    const refreshed = await refreshMemberCommitmentStatuses(db);
    assert.equal(refreshed.updated, 3); // MISSED_1, MISSED_2, DEFAULT_TRIGGERED; ON_TRACK stays default.
    const rows = await db.query<{ id: string; commitment_status: string }>(
      `SELECT id, commitment_status::text FROM chama_members WHERE id = ANY($1::uuid[])`,
      [[onTrack, missedOne, missedTwo, defaulted]],
    );
    const statuses = Object.fromEntries(rows.rows.map((row) => [row.id, row.commitment_status]));
    assert.equal(statuses[onTrack], 'ON_TRACK');
    assert.equal(statuses[missedOne], 'MISSED_1');
    assert.equal(statuses[missedTwo], 'MISSED_2');
    assert.equal(statuses[defaulted], 'DEFAULT_TRIGGERED');
  });

  await t.test('latest successful assessment resets an earlier miss back to ON_TRACK', async () => {
    await assessedContribution(chamaId, missedOne, '2026-08', 0, '2026-08-31');
    const refreshed = await refreshMemberCommitmentStatuses(db);
    assert.equal(refreshed.updated, 1);
    const status = (await db.query<{ commitment_status: string }>(
      `SELECT commitment_status::text FROM chama_members WHERE id = $1`, [missedOne],
    )).rows[0].commitment_status;
    assert.equal(status, 'ON_TRACK');
  });

  await t.test('member list exposes status/verification but no contact or financial details', async () => {
    const service = new ChamaBusinessBase(db);
    const result = await service.listMembers({ chamaId, limit: 50, offset: 0 });
    assert.equal(result.total, 4);
    const member = result.members.find((item: Record<string, unknown>) => item.id === missedTwo) as Record<string, unknown>;
    assert.equal(member.commitment_status, 'MISSED_2');
    assert.equal(member.verification_badge, 'VERIFIED');
    assert.equal(member.full_name, 'Missed Twice Member');
    for (const forbidden of ['email','phone','expected_amount','amount','balance','pooled_amount','provider_reference','receipt_number']) {
      assert.equal(Object.prototype.hasOwnProperty.call(member, forbidden), false, `${forbidden} must not be exposed`);
    }
  });
});
