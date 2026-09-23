import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { ChamaService } from '../../services/chama.service';
import { PollService } from '../../services/poll.service';
import { hashSecret } from '../../utils/crypto.util';
import { ConflictError } from '../../utils/errors';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-17 voting and decision-making lifecycle', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be17_${randomUUID().replace(/-/g, '')}`;
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
  async function createUser(name: string) {
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email, pin_hash, full_name, phone, status)
       VALUES ($1,$2,$3,$4,'active') RETURNING id`,
      [`${randomUUID()}@example.test`, pinHash, name, `+2547${Math.floor(10000000 + Math.random() * 89999999)}`],
    )).rows[0];
  }

  const chair = await createUser('Voting Chair');
  const memberA = await createUser('Voting Member A');
  const memberB = await createUser('Voting Member B');
  const chamaService = new ChamaService(db);
  const pollService = new PollService(db);
  const chama = await chamaService.createChama({
    name: 'BE-17 Governance Chama', type: 'table_banking', contribution_amount: 5000,
    contribution_frequency: 'monthly', visibility: 'application', created_by: chair.id,
  });
  await db.query(
    `INSERT INTO chama_members (chama_id,user_id,role,membership_status,approved_by,approved_at,joined_at)
     VALUES ($1,$2,'member','active',$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
            ($1,$3,'member','active',$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [chama.id, memberA.id, memberB.id, chair.id],
  );
  await db.query(
    `UPDATE chama_rules SET quorum_threshold_pct = 50, majority_threshold_pct = 60 WHERE chama_id = $1 AND status = 'active'`,
    [chama.id],
  );

  const baseNow = new Date('2026-09-18T09:00:00Z');

  await t.test('poll stays open before deadline/full-turnout and closes automatically on full turnout', async () => {
    const poll = await pollService.createPoll(chair.id, chama.id, {
      decisionType: 'general',
      title: 'Choose a meeting day',
      closesAt: '2026-09-18T12:00:00Z',
      options: [
        { code: 'saturday', label: 'Saturday' },
        { code: 'sunday', label: 'Sunday' },
      ],
      decisionPayload: {},
    }, baseNow);
    assert.equal(poll.status, 'open');
    assert.equal(poll.participation.eligible, 3);

    await pollService.vote(chair.id, poll.id, { optionCode: 'saturday' }, new Date('2026-09-18T09:10:00Z'));
    const afterTwo = await pollService.vote(memberA.id, poll.id, { optionCode: 'saturday' }, new Date('2026-09-18T09:20:00Z'));
    assert.equal(afterTwo.poll.status, 'open');
    assert.equal(afterTwo.poll.closeReason, null);

    await assert.rejects(
      pollService.vote(chair.id, poll.id, { optionCode: 'sunday' }, new Date('2026-09-18T09:25:00Z')),
      (error: unknown) => error instanceof ConflictError && error.code === 'POLL_VOTE_ALREADY_CAST',
    );

    const finalVote = await pollService.vote(memberB.id, poll.id, { optionCode: 'sunday' }, new Date('2026-09-18T09:30:00Z'));
    assert.equal(finalVote.poll.status, 'closed');
    assert.equal(finalVote.poll.closeReason, 'full_turnout');
    assert.equal(finalVote.poll.participation.votesCast, 3);

    const voteRow = (await db.query<{ id: string }>(`SELECT id FROM poll_votes WHERE poll_id = $1 LIMIT 1`, [poll.id])).rows[0];
    await assert.rejects(db.query(`UPDATE poll_votes SET cast_at = CURRENT_TIMESTAMP WHERE id = $1`, [voteRow.id]));
    await assert.rejects(db.query(`DELETE FROM poll_votes WHERE id = $1`, [voteRow.id]));
  });

  await t.test('deadline can close a poll, but never before the deadline when turnout is incomplete', async () => {
    const poll = await pollService.createPoll(chair.id, chama.id, {
      decisionType: 'general', title: 'Incomplete turnout test', closesAt: '2026-09-18T11:00:00Z',
      options: [{ code: 'yes', label: 'Yes' }, { code: 'no', label: 'No' }], decisionPayload: {},
    }, baseNow);
    await pollService.vote(chair.id, poll.id, { optionCode: 'yes' }, new Date('2026-09-18T09:15:00Z'));
    const before = await pollService.getResults(memberA.id, poll.id, new Date('2026-09-18T10:59:59Z'));
    assert.equal(before.status, 'open');
    const after = await pollService.getResults(memberA.id, poll.id, new Date('2026-09-18T11:00:01Z'));
    assert.equal(after.status, 'closed');
    assert.equal(after.closeReason, 'deadline');
  });

  await t.test('passed member-removal poll applies exactly once and leaves an audit trail', async () => {
    const targetMembership = (await db.query<{ id: string }>(
      `SELECT id FROM chama_members WHERE chama_id = $1 AND user_id = $2`, [chama.id, memberB.id],
    )).rows[0];
    const poll = await pollService.createPoll(chair.id, chama.id, {
      decisionType: 'member_removal', title: 'Remove member B', closesAt: '2026-09-18T12:00:00Z',
      options: [{ code: 'remove', label: 'Remove member' }, { code: 'retain', label: 'Retain member' }],
      actionOptionCode: 'remove',
      decisionPayload: { member_id: targetMembership.id, reason: 'Governance test removal' },
    }, baseNow);
    await pollService.vote(chair.id, poll.id, { optionCode: 'remove' }, new Date('2026-09-18T09:31:00Z'));
    await pollService.vote(memberA.id, poll.id, { optionCode: 'remove' }, new Date('2026-09-18T09:32:00Z'));
    await pollService.vote(memberB.id, poll.id, { optionCode: 'remove' }, new Date('2026-09-18T09:33:00Z'));

    const action = await pollService.actOutcome(chair.id, poll.id, new Date('2026-09-18T09:34:00Z'));
    assert.equal(action.action, 'member_removed');
    const status = (await db.query<{ membership_status: string }>(
      `SELECT membership_status::text AS membership_status FROM chama_members WHERE id = $1`, [targetMembership.id],
    )).rows[0];
    assert.equal(status.membership_status, 'exited');
    const audit = Number((await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'poll_member_removal_applied' AND entity_id = $1`, [targetMembership.id],
    )).rows[0]?.count ?? 0);
    assert.equal(audit, 1);
    await assert.rejects(
      pollService.actOutcome(chair.id, poll.id, new Date('2026-09-18T09:35:00Z')),
      (error: unknown) => error instanceof ConflictError && error.code === 'POLL_ALREADY_ACTED',
    );
  });

  await t.test('approved rule-amendment poll activates the exact frozen payload once', async () => {
    const activeBefore = (await db.query<{ id: string; version: number }>(
      `SELECT id, version FROM chama_rules WHERE chama_id = $1 AND status = 'active'`, [chama.id],
    )).rows[0];
    const summary = 'Raise governance majority threshold';
    const changes = { majority_threshold_pct: 70 };
    const poll = await pollService.createPoll(chair.id, chama.id, {
      decisionType: 'rule_amendment',
      title: 'Amend governance threshold',
      closesAt: '2026-09-18T12:00:00Z',
      options: [{ code: 'approve', label: 'Approve' }, { code: 'reject', label: 'Reject' }],
      actionOptionCode: 'approve',
      decisionPayload: { amendment_summary: summary, changes },
    }, baseNow);

    await pollService.vote(chair.id, poll.id, { optionCode: 'approve' }, new Date('2026-09-18T09:05:00Z'));
    const closed = await pollService.vote(memberA.id, poll.id, { optionCode: 'approve' }, new Date('2026-09-18T09:06:00Z'));
    assert.equal(closed.poll.status, 'closed');
    assert.equal(closed.poll.majorityMet, true);
    assert.equal(closed.poll.actionable, true);

    const amended = await chamaService.amendConstitution(chama.id, chair.id, {
      poll_id: poll.id,
      amendment_summary: summary,
      majority_threshold_pct: 70,
    });
    assert.equal(amended.version, activeBefore.version + 1);
    assert.equal(Number(amended.majorityThresholdPct), 70);

    const result = await pollService.getResults(chair.id, poll.id, new Date('2026-09-18T09:08:00Z'));
    assert.ok(result.actedAt);
    assert.equal(result.actionable, false);

    await assert.rejects(
      chamaService.amendConstitution(chama.id, chair.id, {
        poll_id: poll.id,
        amendment_summary: summary,
        majority_threshold_pct: 70,
      }),
      (error: unknown) => error instanceof ConflictError,
    );
  });
});
