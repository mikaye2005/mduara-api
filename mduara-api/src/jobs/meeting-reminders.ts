import { randomUUID } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { NotificationService } from '../services/notification.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';

interface ClaimedMeeting extends QueryResultRow {
  id: string;
  chama_id: string;
  title: string;
  starts_at: string;
  location: string | null;
  meeting_url: string | null;
  reminder_attempts: number;
  reminder_claim_token: string;
}

interface NotificationDispatcher {
  dispatch(input: {
    userIds: string[];
    template: 'meeting_reminder';
    chamaId: string;
    data: Record<string, unknown>;
    dedupeKey: string;
  }): Promise<unknown>;
}

export class MeetingReminderWorker {
  constructor(
    private readonly db: Pool,
    private readonly notifications: NotificationDispatcher = new NotificationService(db),
    private readonly maxAttempts = 5,
  ) {}

  async runBatch(limit: number, now = new Date(), shouldStop: () => boolean = () => false) {
    const totals = { claimed: 0, dispatched: 0, retried: 0, failed: 0 };

    const expired = await this.db.query(
      `UPDATE chama_meetings
          SET reminder_failed_at = $1,
              reminder_last_error = COALESCE(reminder_last_error, 'Meeting started before reminder delivery completed'),
              reminder_claim_token = NULL,
              reminder_claimed_until = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE starts_at <= $1
          AND reminder_dispatched_at IS NULL
          AND reminder_failed_at IS NULL`,
      [now],
    );
    totals.failed += expired.rowCount ?? 0;

    while (!shouldStop() && totals.claimed < limit) {
      const meeting = await this.claimOne(now);
      if (!meeting) break;
      totals.claimed += 1;
      try {
        const [chama, recipients] = await Promise.all([
          this.db.query<{ name: string }>('SELECT name FROM chamas WHERE id = $1', [meeting.chama_id]),
          this.db.query<{ user_id: string }>(
            `SELECT cm.user_id
               FROM chama_members cm
               JOIN users u ON u.id = cm.user_id
              WHERE cm.chama_id = $1
                AND cm.membership_status = 'active'
                AND u.status = 'active'
              ORDER BY cm.joined_at, cm.id`,
            [meeting.chama_id],
          ),
        ]);
        const startsAtLabel = new Intl.DateTimeFormat('en-KE', {
          timeZone: env.SCHEDULER_TIMEZONE,
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(meeting.starts_at));

        await this.notifications.dispatch({
          userIds: recipients.rows.map((row) => row.user_id),
          template: 'meeting_reminder',
          chamaId: meeting.chama_id,
          data: {
            chamaName: chama.rows[0]?.name ?? 'your Chama',
            meetingTitle: meeting.title,
            startsAt: new Date(meeting.starts_at).toISOString(),
            startsAtLabel,
            location: meeting.location ?? '',
            meetingUrl: meeting.meeting_url ?? '',
            meetingId: meeting.id,
          },
          dedupeKey: `meeting-reminder:${meeting.id}`,
        });

        await this.db.query(
          `UPDATE chama_meetings
              SET reminder_dispatched_at = $3,
                  reminder_claim_token = NULL,
                  reminder_claimed_until = NULL,
                  reminder_next_attempt_at = NULL,
                  reminder_last_error = NULL,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND reminder_claim_token = $2`,
          [meeting.id, meeting.reminder_claim_token, now],
        );
        totals.dispatched += 1;
      } catch (error) {
        const finalFailure = meeting.reminder_attempts >= this.maxAttempts;
        const reason = sanitizeError(error);
        const delaySeconds = Math.min(3600, 30 * 2 ** Math.max(meeting.reminder_attempts - 1, 0));
        await this.db.query(
          `UPDATE chama_meetings
              SET reminder_failed_at = CASE WHEN $3 THEN $4 ELSE NULL END,
                  reminder_next_attempt_at = CASE WHEN $3 THEN NULL ELSE $4::timestamptz + $5 * interval '1 second' END,
                  reminder_claim_token = NULL,
                  reminder_claimed_until = NULL,
                  reminder_last_error = $6,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND reminder_claim_token = $2`,
          [meeting.id, meeting.reminder_claim_token, finalFailure, now, delaySeconds, reason],
        );
        logger.warn('Meeting reminder dispatch failed', {
          meetingId: meeting.id,
          attempts: meeting.reminder_attempts,
          finalFailure,
          errorCode: reason.slice(0, 120),
        });
        if (finalFailure) totals.failed += 1;
        else totals.retried += 1;
      }
    }
    return totals;
  }

  private async claimOne(now: Date): Promise<ClaimedMeeting | undefined> {
    const token = randomUUID();
    const row = (await this.db.query<ClaimedMeeting>(
      `WITH candidate AS (
         SELECT id
           FROM chama_meetings
          WHERE reminder_dispatched_at IS NULL
            AND reminder_failed_at IS NULL
            AND reminder_at <= $1
            AND COALESCE(reminder_next_attempt_at, reminder_at) <= $1
            AND starts_at > $1
            AND (reminder_claimed_until IS NULL OR reminder_claimed_until < $1)
          ORDER BY COALESCE(reminder_next_attempt_at, reminder_at), id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE chama_meetings m
          SET reminder_claim_token = $2,
              reminder_claimed_until = $1::timestamptz + interval '5 minutes',
              reminder_attempts = reminder_attempts + 1,
              updated_at = CURRENT_TIMESTAMP
         FROM candidate c
        WHERE m.id = c.id
       RETURNING m.id, m.chama_id, m.title, m.starts_at::text, m.location, m.meeting_url,
                 m.reminder_attempts, m.reminder_claim_token::text`,
      [now, token],
    )).rows[0];
    return row;
  }
}

function sanitizeError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Meeting reminder dispatch failed';
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 1000);
}
