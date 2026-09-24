import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { MeetingService } from '../../services/meeting.service';
import { MeetingReminderWorker } from '../../jobs/meeting-reminders';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-20 meeting scheduling, RSVP, attendance and reminders', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be20_${randomUUID().replace(/-/g, '')}`;
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

  async function user(name: string, suffix: string) {
    return (await db.query<{ id: string }>(
      `INSERT INTO users (email,pin_hash,full_name,phone,status)
       VALUES ($1,'hash',$2,$3,'active') RETURNING id`,
      [`${randomUUID()}@example.test`, name, `+254722${suffix.padStart(6, '0')}`],
    )).rows[0].id;
  }
  async function chama(name: string, creator: string) {
    return (await db.query<{ id: string }>(
      `INSERT INTO chamas (name,type,status,visibility,contribution_amount,contribution_frequency,created_by)
       VALUES ($1,'goal_based','active','application',1000,'monthly',$2) RETURNING id`, [name, creator],
    )).rows[0].id;
  }
  async function member(chamaId: string, userId: string, role: 'chairperson' | 'secretary' | 'member') {
    return (await db.query<{ id: string }>(
      `INSERT INTO chama_members (chama_id,user_id,role,membership_status)
       VALUES ($1,$2,$3,'active') RETURNING id`, [chamaId, userId, role],
    )).rows[0].id;
  }

  const chair = await user('Meeting Chair', '1');
  const secretary = await user('Meeting Secretary', '2');
  const alice = await user('Meeting Alice', '3');
  const outsider = await user('Other Chama Member', '4');
  const chamaId = await chama('Meeting Chama', chair);
  const otherChama = await chama('Other Chama', outsider);
  await member(chamaId, chair, 'chairperson');
  await member(chamaId, secretary, 'secretary');
  const aliceMembership = await member(chamaId, alice, 'member');
  const outsiderMembership = await member(otherChama, outsider, 'member');

  const service = new MeetingService(db);
  const base = new Date('2026-09-20T06:00:00.000Z');
  const startsAt = new Date(base.getTime() + 4 * 60 * 60 * 1000);
  const reminderAt = new Date(base.getTime() + 60 * 60 * 1000);

  let meetingId = '';
  await t.test('Chair/Secretary create a true scheduled event and active members can list it', async () => {
    const meeting = await service.createMeeting(chair, chamaId, {
      title: 'Monthly Chama Review',
      startsAt: startsAt.toISOString(),
      location: 'DeKUT Resource Centre',
      meetingUrl: null,
      agenda: 'Contributions, goals and member questions',
      reminderAt: reminderAt.toISOString(),
    }, base);
    meetingId = meeting.id;
    assert.equal(meeting.startsAt, startsAt.toISOString());
    assert.equal(meeting.reminderAt, reminderAt.toISOString());

    await assert.rejects(
      () => service.createMeeting(alice, chamaId, {
        title: 'Unauthorized Meeting', startsAt: startsAt.toISOString(), location: 'Room 2',
      }, base),
      (error: { code?: string }) => error.code === 'MEETING_LEADERSHIP_REQUIRED',
    );

    const listed = await service.listMeetings(alice, chamaId, { page: 1, perPage: 25 });
    assert.equal(listed.meta.total, 1);
    assert.equal(listed.meetings[0].myRsvp, null);
    assert.equal(listed.meetings[0].aggregates.going, 0);
  });

  await t.test('RSVP is self-only, idempotently updatable, and closes when the meeting starts', async () => {
    const going = await service.rsvp(alice, meetingId, { status: 'going' }, base);
    assert.equal(going.memberId, aliceMembership);
    assert.equal(going.status, 'going');
    const maybe = await service.rsvp(alice, meetingId, { status: 'maybe' }, new Date(base.getTime() + 5_000));
    assert.equal(maybe.status, 'maybe');

    await assert.rejects(
      () => service.rsvp(outsider, meetingId, { status: 'going' }, base),
      (error: { code?: string }) => error.code === 'MEETING_MEMBERSHIP_REQUIRED',
    );
    await assert.rejects(
      () => service.rsvp(alice, meetingId, { status: 'going' }, startsAt),
      (error: { code?: string }) => error.code === 'MEETING_RSVP_CLOSED',
    );

    const listed = await service.listMeetings(alice, chamaId, { page: 1, perPage: 25 });
    assert.equal(listed.meetings[0].myRsvp, 'maybe');
    assert.equal(listed.meetings[0].aggregates.maybe, 1);
  });

  await t.test('database integrity rejects cross-Chama attendance and leadership records attendance only after start', async () => {
    await assert.rejects(
      () => db.query(
        `INSERT INTO meeting_attendance (meeting_id,chama_id,member_id,present,recorded_by)
         VALUES ($1,$2,$3,TRUE,$4)`,
        [meetingId, chamaId, outsiderMembership, secretary],
      ),
      (error: { code?: string }) => error.code === '23503',
    );

    await assert.rejects(
      () => service.recordAttendance(secretary, meetingId, { memberId: aliceMembership, present: true }, base),
      (error: { code?: string }) => error.code === 'MEETING_ATTENDANCE_TOO_EARLY',
    );
    await assert.rejects(
      () => service.recordAttendance(alice, meetingId, { memberId: aliceMembership, present: true }, new Date(startsAt.getTime() + 60_000)),
      (error: { code?: string }) => error.code === 'MEETING_LEADERSHIP_REQUIRED',
    );

    const recorded = await service.recordAttendance(
      secretary,
      meetingId,
      { memberId: aliceMembership, present: true, notes: 'Present for the full meeting' },
      new Date(startsAt.getTime() + 60_000),
    );
    assert.equal(recorded.present, true);
    assert.equal(recorded.recordedBy, secretary);

    const day = startsAt.toISOString().slice(0, 10);
    const history = await service.attendanceHistory(chair, chamaId, { from: day, to: day, page: 1, perPage: 50 });
    assert.equal(history.meta.total, 1);
    assert.equal(history.attendance[0].memberId, aliceMembership);
    assert.equal(history.attendance[0].present, true);
  });

  await t.test('reminder worker retries safely then deduplicates the successful meeting event', async () => {
    const reminderMeeting = await service.createMeeting(secretary, chamaId, {
      title: 'Reminder Reliability Test',
      startsAt: new Date(base.getTime() + 6 * 60 * 60 * 1000).toISOString(),
      location: 'Online room',
      meetingUrl: 'https://example.test/meeting',
      reminderAt: new Date(base.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    }, base);

    const calls: Array<{ dedupeKey: string; userIds: string[] }> = [];
    let failOnce = true;
    const notifications = {
      async dispatch(input: { dedupeKey: string; userIds: string[] }) {
        if (failOnce) { failOnce = false; throw new Error('temporary push gateway failure'); }
        calls.push(input);
        return { ok: true };
      },
    };
    const worker = new MeetingReminderWorker(db, notifications as never, 3);
    const firstAt = new Date(base.getTime() + 2 * 60 * 60 * 1000 + 1_000);
    const first = await worker.runBatch(10, firstAt);
    assert.equal(first.retried, 1);
    const second = await worker.runBatch(10, new Date(firstAt.getTime() + 31_000));
    assert.equal(second.dispatched, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dedupeKey, `meeting-reminder:${reminderMeeting.id}`);
    assert.ok(calls[0].userIds.includes(alice));

    const replay = await worker.runBatch(10, new Date(firstAt.getTime() + 62_000));
    assert.equal(replay.claimed, 0);
    assert.equal(calls.length, 1);
    const state = (await db.query<{ reminder_attempts: number; reminder_dispatched_at: string | null; reminder_failed_at: string | null }>(
      `SELECT reminder_attempts, reminder_dispatched_at::text, reminder_failed_at::text FROM chama_meetings WHERE id = $1`,
      [reminderMeeting.id],
    )).rows[0];
    assert.equal(state.reminder_attempts, 2);
    assert.ok(state.reminder_dispatched_at);
    assert.equal(state.reminder_failed_at, null);
  });
});
