import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { withDatabaseTransaction } from '../db/transaction';
import { env } from '../config/env';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../utils/errors';
import type { CreateMeetingInput, MeetingRsvpInput, RecordAttendanceInput } from '../validation/meeting.validation';

type LeadershipRole = 'chairperson' | 'secretary';

interface MeetingRow extends QueryResultRow {
  id: string;
  chama_id: string;
  title: string;
  starts_at: string;
  location: string | null;
  meeting_url: string | null;
  agenda: string | null;
  resolutions: string | null;
  reminder_at: string;
  reminder_dispatched_at: string | null;
  reminder_failed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export class MeetingService {
  constructor(private readonly db: Pool = pool) {}

  async createMeeting(actorId: string, chamaId: string, input: CreateMeetingInput, now = new Date()) {
    return withDatabaseTransaction(async (client) => {
      const leader = await requireMeetingLeader(client, actorId, chamaId);
      const startsAt = new Date(input.startsAt);
      if (!Number.isFinite(startsAt.getTime()) || startsAt <= now) {
        throw new BadRequestError('Meeting startsAt must be in the future', undefined, 'MEETING_START_INVALID');
      }
      const reminderAt = input.reminderAt
        ? new Date(input.reminderAt)
        : new Date(startsAt.getTime() - 24 * 60 * 60 * 1000);
      if (!Number.isFinite(reminderAt.getTime()) || reminderAt >= startsAt) {
        throw new BadRequestError('Meeting reminder must be before the meeting starts', undefined, 'MEETING_REMINDER_INVALID');
      }

      const meeting = (await client.query<MeetingRow>(
        `INSERT INTO chama_meetings
           (chama_id, title, starts_at, location, meeting_url, agenda, reminder_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, chama_id, title, starts_at::text, location, meeting_url, agenda, resolutions,
                   reminder_at::text, reminder_dispatched_at::text, reminder_failed_at::text,
                   created_by, created_at::text, updated_at::text`,
        [chamaId, input.title, startsAt, input.location ?? null, input.meetingUrl ?? null, input.agenda ?? null, reminderAt, actorId],
      )).rows[0];

      await client.query(
        `INSERT INTO audit_logs (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
         VALUES ('system','meeting_created',$1,$2::audit_actor_role,$3,'meeting',$4,$5::jsonb)`,
        [actorId, leader.role, chamaId, meeting.id, JSON.stringify({ startsAt: meeting.starts_at, reminderAt: meeting.reminder_at })],
      );
      return serializeMeeting(meeting);
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async listMeetings(actorId: string, chamaId: string, input: { page: number; perPage: number; from?: string; to?: string }) {
    const membership = await requireActiveMembership(this.db, actorId, chamaId);
    const countValues: unknown[] = [chamaId];
    const countWhere = ['m.chama_id = $1'];
    let countTimezoneIndex: number | null = null;
    if (input.from || input.to) {
      countValues.push(env.SCHEDULER_TIMEZONE);
      countTimezoneIndex = countValues.length;
    }
    if (input.from) {
      countValues.push(input.from);
      countWhere.push(`m.starts_at >= ($${countValues.length}::date::timestamp AT TIME ZONE $${countTimezoneIndex})`);
    }
    if (input.to) {
      countValues.push(input.to);
      countWhere.push(`m.starts_at < (($${countValues.length}::date + INTERVAL '1 day') AT TIME ZONE $${countTimezoneIndex})`);
    }

    const [totalResult, activeMembersResult] = await Promise.all([
      this.db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM chama_meetings m WHERE ${countWhere.join(' AND ')}`,
        countValues,
      ),
      this.db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM chama_members WHERE chama_id = $1 AND membership_status = 'active'`,
        [chamaId],
      ),
    ]);
    const total = Number(totalResult.rows[0]?.count ?? 0);
    const activeMembers = Number(activeMembersResult.rows[0]?.count ?? 0);

    // The data query includes the caller membership for self RSVP/attendance state.
    const queryValues: unknown[] = [chamaId, membership.id];
    const queryWhere = ['m.chama_id = $1'];
    let queryTimezoneIndex: number | null = null;
    if (input.from || input.to) {
      queryValues.push(env.SCHEDULER_TIMEZONE);
      queryTimezoneIndex = queryValues.length;
    }
    if (input.from) {
      queryValues.push(input.from);
      queryWhere.push(`m.starts_at >= ($${queryValues.length}::date::timestamp AT TIME ZONE $${queryTimezoneIndex})`);
    }
    if (input.to) {
      queryValues.push(input.to);
      queryWhere.push(`m.starts_at < (($${queryValues.length}::date + INTERVAL '1 day') AT TIME ZONE $${queryTimezoneIndex})`);
    }
    queryValues.push(input.perPage, (input.page - 1) * input.perPage);
    const limitIndex = queryValues.length - 1;
    const offsetIndex = queryValues.length;

    const rows = await this.db.query<MeetingRow & {
      my_rsvp: string | null; my_present: boolean | null;
      going_count: number; maybe_count: number; declined_count: number; recorded_present_count: number;
    }>(
      `SELECT m.id, m.chama_id, m.title, m.starts_at::text, m.location, m.meeting_url, m.agenda, m.resolutions,
              m.reminder_at::text, m.reminder_dispatched_at::text, m.reminder_failed_at::text,
              m.created_by, m.created_at::text, m.updated_at::text,
              mine.status::text AS my_rsvp, myatt.present AS my_present,
              COUNT(DISTINCT allr.id) FILTER (WHERE allr.status = 'going')::int AS going_count,
              COUNT(DISTINCT allr.id) FILTER (WHERE allr.status = 'maybe')::int AS maybe_count,
              COUNT(DISTINCT allr.id) FILTER (WHERE allr.status = 'declined')::int AS declined_count,
              COUNT(DISTINCT alla.id) FILTER (WHERE alla.present = TRUE)::int AS recorded_present_count
         FROM chama_meetings m
         LEFT JOIN meeting_rsvps mine ON mine.meeting_id = m.id AND mine.member_id = $2
         LEFT JOIN meeting_attendance myatt ON myatt.meeting_id = m.id AND myatt.member_id = $2
         LEFT JOIN meeting_rsvps allr ON allr.meeting_id = m.id
         LEFT JOIN meeting_attendance alla ON alla.meeting_id = m.id
        WHERE ${queryWhere.join(' AND ')}
        GROUP BY m.id, mine.status, myatt.present
        ORDER BY m.starts_at DESC, m.id DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      queryValues,
    );

    return {
      meetings: rows.rows.map((row) => ({
        ...serializeMeeting(row),
        myRsvp: row.my_rsvp,
        myAttendance: row.my_present,
        aggregates: (() => {
          const going = Number(row.going_count ?? 0);
          const maybe = Number(row.maybe_count ?? 0);
          const declined = Number(row.declined_count ?? 0);
          return {
            going, maybe, declined,
            awaitingRsvp: Math.max(activeMembers - going - maybe - declined, 0),
            recordedPresent: Number(row.recorded_present_count ?? 0),
          };
        })(),
      })),
      meta: { total, page: input.page, perPage: input.perPage, totalPages: total ? Math.ceil(total / input.perPage) : 0 },
    };
  }

  async rsvp(actorId: string, meetingId: string, input: MeetingRsvpInput, now = new Date()) {
    return withDatabaseTransaction(async (client) => {
      const meeting = await requireMeeting(client, meetingId, true);
      if (new Date(meeting.starts_at) <= now) {
        throw new ConflictError('RSVP is closed because the meeting has started', 'MEETING_RSVP_CLOSED');
      }
      const membership = await requireActiveMembership(client, actorId, meeting.chama_id);
      const row = (await client.query<{ id: string; status: string; responded_at: string; updated_at: string }>(
        `INSERT INTO meeting_rsvps (meeting_id, chama_id, member_id, status)
         VALUES ($1,$2,$3,$4::meeting_rsvp_status)
         ON CONFLICT (meeting_id, member_id) DO UPDATE
           SET status = EXCLUDED.status, responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         RETURNING id, status::text, responded_at::text, updated_at::text`,
        [meeting.id, meeting.chama_id, membership.id, input.status],
      )).rows[0];
      return { meetingId: meeting.id, memberId: membership.id, status: row.status, respondedAt: toIso(row.responded_at), updatedAt: toIso(row.updated_at) };
    }, {}, this.db);
  }

  async recordAttendance(actorId: string, meetingId: string, input: RecordAttendanceInput, now = new Date()) {
    return withDatabaseTransaction(async (client) => {
      const meeting = await requireMeeting(client, meetingId, true);
      const leader = await requireMeetingLeader(client, actorId, meeting.chama_id);
      if (new Date(meeting.starts_at) > now) {
        throw new ConflictError('Attendance cannot be recorded before the meeting starts', 'MEETING_ATTENDANCE_TOO_EARLY');
      }
      const target = (await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM chama_members WHERE id = $1 AND chama_id = $2`,
        [input.memberId, meeting.chama_id],
      )).rows[0];
      if (!target) throw new NotFoundError('Member does not belong to this Chama', 'MEETING_MEMBER_NOT_FOUND');

      const previous = (await client.query<{ present: boolean }>(
        `SELECT present FROM meeting_attendance WHERE meeting_id = $1 AND member_id = $2`,
        [meeting.id, target.id],
      )).rows[0];
      const row = (await client.query<{
        id: string; present: boolean; notes: string | null; recorded_by: string | null; recorded_at: string; updated_at: string;
      }>(
        `INSERT INTO meeting_attendance
           (meeting_id, chama_id, member_id, present, notes, recorded_by, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
         ON CONFLICT (meeting_id, member_id) DO UPDATE
           SET present = EXCLUDED.present, notes = EXCLUDED.notes, recorded_by = EXCLUDED.recorded_by,
               recorded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         RETURNING id, present, notes, recorded_by, recorded_at::text, updated_at::text`,
        [meeting.id, meeting.chama_id, target.id, input.present, input.notes ?? null, actorId],
      )).rows[0];

      await client.query(
        `INSERT INTO audit_logs (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, payload)
         VALUES ('moderation','meeting_attendance_recorded',$1,$2::audit_actor_role,$3,'meeting_attendance',$4,$5::jsonb)`,
        [actorId, leader.role, meeting.chama_id, row.id, JSON.stringify({
          meetingId: meeting.id, memberId: target.id, targetUserId: target.user_id,
          previousPresent: previous?.present ?? null, present: row.present,
        })],
      );
      return {
        id: row.id, meetingId: meeting.id, memberId: target.id, present: row.present,
        notes: row.notes, recordedBy: row.recorded_by, recordedAt: toIso(row.recorded_at), updatedAt: toIso(row.updated_at),
      };
    }, { isolationLevel: 'SERIALIZABLE', maxRetries: 2 }, this.db);
  }

  async attendanceHistory(actorId: string, chamaId: string, input: { from: string; to: string; memberId?: string; page: number; perPage: number }) {
    await requireMeetingLeader(this.db, actorId, chamaId);
    if (input.memberId) {
      const exists = await this.db.query(`SELECT 1 FROM chama_members WHERE id = $1 AND chama_id = $2`, [input.memberId, chamaId]);
      if (!exists.rowCount) throw new NotFoundError('Member does not belong to this Chama', 'MEETING_MEMBER_NOT_FOUND');
    }
    const values: unknown[] = [chamaId, input.from, input.to, env.SCHEDULER_TIMEZONE];
    const where = [
      'm.chama_id = $1',
      `m.starts_at >= ($2::date::timestamp AT TIME ZONE $4)`,
      `m.starts_at < (($3::date + INTERVAL '1 day') AT TIME ZONE $4)`,
    ];
    if (input.memberId) { values.push(input.memberId); where.push(`a.member_id = $${values.length}::uuid`); }
    const count = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM meeting_attendance a JOIN chama_meetings m ON m.id = a.meeting_id
        WHERE ${where.join(' AND ')}`,
      values,
    )).rows[0]?.count ?? 0);
    values.push(input.perPage, (input.page - 1) * input.perPage);
    const rows = await this.db.query<{
      meeting_id: string; title: string; starts_at: string; member_id: string; user_id: string; full_name: string;
      present: boolean; notes: string | null; recorded_by: string | null; recorded_at: string;
    }>(
      `SELECT m.id AS meeting_id, m.title, m.starts_at::text,
              a.member_id, cm.user_id, u.full_name, a.present, a.notes,
              a.recorded_by, a.recorded_at::text
         FROM meeting_attendance a
         JOIN chama_meetings m ON m.id = a.meeting_id
         JOIN chama_members cm ON cm.id = a.member_id
         JOIN users u ON u.id = cm.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.starts_at DESC, u.full_name, a.member_id
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return {
      attendance: rows.rows.map((row) => ({
        meetingId: row.meeting_id, title: row.title, startsAt: toIso(row.starts_at),
        memberId: row.member_id, userId: row.user_id, fullName: row.full_name,
        present: row.present, notes: row.notes, recordedBy: row.recorded_by, recordedAt: toIso(row.recorded_at),
      })),
      meta: { total: count, page: input.page, perPage: input.perPage, totalPages: count ? Math.ceil(count / input.perPage) : 0 },
    };
  }
}

async function requireMeeting(db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, meetingId: string, forUpdate = false) {
  const row = (await db.query<MeetingRow>(
    `SELECT id, chama_id, title, starts_at::text, location, meeting_url, agenda, resolutions,
            reminder_at::text, reminder_dispatched_at::text, reminder_failed_at::text,
            created_by, created_at::text, updated_at::text
       FROM chama_meetings WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [meetingId],
  )).rows[0];
  if (!row) throw new NotFoundError('Meeting not found', 'MEETING_NOT_FOUND');
  return row;
}

async function requireActiveMembership(db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, actorId: string, chamaId: string) {
  const row = (await db.query<{ id: string; role: string }>(
    `SELECT id, role::text AS role FROM chama_members
      WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'`,
    [chamaId, actorId],
  )).rows[0];
  if (!row) throw new ForbiddenError('Active Chama membership is required', 'MEETING_MEMBERSHIP_REQUIRED');
  return row;
}

async function requireMeetingLeader(db: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, actorId: string, chamaId: string) {
  const membership = await requireActiveMembership(db, actorId, chamaId);
  if (!['chairperson', 'secretary'].includes(membership.role)) {
    throw new ForbiddenError('Only the Chairperson or Secretary may manage meetings', 'MEETING_LEADERSHIP_REQUIRED');
  }
  return { ...membership, role: membership.role as LeadershipRole };
}

function serializeMeeting(row: MeetingRow) {
  return {
    id: row.id, chamaId: row.chama_id, title: row.title, startsAt: toIso(row.starts_at),
    location: row.location, meetingUrl: row.meeting_url, agenda: row.agenda, resolutions: row.resolutions,
    reminderAt: toIso(row.reminder_at), reminderDispatchedAt: toIso(row.reminder_dispatched_at),
    reminderFailedAt: toIso(row.reminder_failed_at), createdBy: row.created_by,
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: string | null) {
  return value ? new Date(value).toISOString() : null;
}

export const meetingService = new MeetingService();
