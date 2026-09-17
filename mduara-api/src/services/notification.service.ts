import type { Pool, QueryResultRow } from 'pg';
import { pool } from '../db/client';
import { env } from '../config/env';
import { emailService } from './email.service';
import { smsService } from './sms.service';
import { releaseSmsQuotaSlot, reserveSmsQuotaSlot } from './subscription.service';
import { logger } from '../utils/logger';
import { NotFoundError } from '../utils/errors';

export type NotificationChannel = 'in_app' | 'sms' | 'email' | 'push';
export type NotificationTemplateKey =
  | 'contribution_due'
  | 'contribution_received'
  | 'chama_almost_full'
  | 'application_approved'
  | 'missed_contribution'
  | 'commitment_refund_ready'
  | 'goal_completed'
  | 'constitution_amended'
  | 'meeting_reminder';

export interface DispatchNotificationInput {
  userIds: string[];
  template: NotificationTemplateKey;
  chamaId?: string | null;
  channels?: NotificationChannel[];
  data?: Record<string, unknown>;
  dedupeKey?: string | null;
}

interface RecipientRow extends QueryResultRow {
  id: string;
  phone: string;
  email: string;
  full_name: string;
  in_app_enabled: boolean;
  sms_enabled: boolean;
  email_enabled: boolean;
  push_enabled: boolean;
}

interface NotificationRow extends QueryResultRow {
  id: string;
  user_id: string;
  chama_id: string | null;
  event_type: string;
  dedupe_key: string | null;
  channel: NotificationChannel;
  title: string;
  body: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  provider_message_id: string | null;
  payload: Record<string, unknown>;
  available_at: string;
  sent_at: string | null;
  read_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

interface RenderedTemplate {
  title: string;
  body: string;
}

const DEFAULT_CHANNELS: NotificationChannel[] = ['in_app', 'sms', 'email', 'push'];

function text(data: Record<string, unknown>, key: string, fallback: string): string {
  const value = data[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return fallback;
}

function renderTemplate(template: NotificationTemplateKey, data: Record<string, unknown>): RenderedTemplate {
  const chama = text(data, 'chamaName', 'your Chama');
  const currency = text(data, 'currency', 'KES');
  const amount = text(data, 'amount', 'the scheduled amount');
  const dueDate = text(data, 'dueDate', 'the due date');

  switch (template) {
    case 'contribution_due':
      return {
        title: `${chama}: contribution due`,
        body: `Your contribution of ${currency} ${amount} is due by ${dueDate}. Please pay before the deadline.`,
      };
    case 'contribution_received':
      return {
        title: `${chama}: contribution received`,
        body: `M-Duara confirmed your contribution of ${currency} ${amount}.`,
      };
    case 'chama_almost_full':
      return {
        title: `${chama} is almost full`,
        body: `${chama} has ${text(data, 'remainingSpots', 'only a few')} place(s) remaining before recruitment closes.`,
      };
    case 'application_approved':
      return {
        title: `Application approved`,
        body: `Your application to join ${chama} has been approved.${text(data, 'nextStep', '') ? ` ${text(data, 'nextStep', '')}` : ''}`,
      };
    case 'missed_contribution':
      return {
        title: `${chama}: contribution missed`,
        body: `A contribution due on ${dueDate} is still unpaid. Your current escalation status is ${text(data, 'missStatus', 'missed')}.`,
      };
    case 'commitment_refund_ready':
      return {
        title: `Commitment refund ready`,
        body: `Your commitment deposit for ${chama} is eligible for refund. Open M-Duara to review and request the refund.`,
      };
    case 'goal_completed':
      return {
        title: `${chama}: goal completed`,
        body: `${chama} has reached its configured goal. Open M-Duara for the completion and payout details.`,
      };
    case 'constitution_amended':
      return {
        title: `${chama}: Constitution updated`,
        body: `Constitution version ${text(data, 'version', 'new')} is now active. Please review and accept the new version in M-Duara.`,
      };
    case 'meeting_reminder': {
      const meetingTitle = text(data, 'meetingTitle', 'Upcoming meeting');
      const startsAtLabel = text(data, 'startsAtLabel', text(data, 'startsAt', 'soon'));
      const location = text(data, 'location', '');
      const meetingUrl = text(data, 'meetingUrl', '');
      return {
        title: `${chama}: meeting reminder`,
        body: `${meetingTitle} starts ${startsAtLabel}${location ? ` at ${location}` : ''}.${meetingUrl ? ` Join: ${meetingUrl}` : ''}`,
      };
    }
  }
}

class PushAdapter {
  async send(input: {
    userId: string;
    deliveryId: string;
    eventType: string;
    title: string;
    body: string;
    chamaId: string | null;
    payload: Record<string, unknown>;
  }): Promise<string | null> {
    if (env.PUSH_PROVIDER === 'console') {
      logger.info('Push (console provider)', {
        userId: input.userId,
        deliveryId: input.deliveryId,
        eventType: input.eventType,
        title: input.title,
      });
      return null;
    }

    const response = await fetch(env.PUSH_WEBHOOK_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.PUSH_WEBHOOK_SECRET ? { Authorization: `Bearer ${env.PUSH_WEBHOOK_SECRET}` } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Push provider rejected delivery with status ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    const result = await response.json().catch(() => null) as { messageId?: string; id?: string } | null;
    return result?.messageId ?? result?.id ?? null;
  }
}

const pushAdapter = new PushAdapter();

export interface NotificationAdapters {
  sms: { sendMessage(phone: string, message: string): Promise<void> };
  email: { send(to: string, subject: string, text: string, deliveryId: string): Promise<void> };
  push: { send(input: { userId: string; deliveryId: string; eventType: string; title: string; body: string; chamaId: string | null; payload: Record<string, unknown> }): Promise<string | null> };
}

const defaultAdapters: NotificationAdapters = { sms: smsService, email: emailService, push: pushAdapter };

export class NotificationService {
  constructor(private readonly db: Pool = pool, private readonly adapters: NotificationAdapters = defaultAdapters) {}

  listTemplates() {
    return [
      'contribution_due',
      'contribution_received',
      'chama_almost_full',
      'application_approved',
      'missed_contribution',
      'commitment_refund_ready',
      'goal_completed',
      'constitution_amended',
      'meeting_reminder',
    ] as NotificationTemplateKey[];
  }

  async dispatch(input: DispatchNotificationInput) {
    const data = input.data ?? {};
    const rendered = renderTemplate(input.template, data);
    const channels = [...new Set(input.channels?.length ? input.channels : DEFAULT_CHANNELS)];
    const recipients = await this.loadRecipients(input.userIds);

    const results = [] as Array<{ userId: string; deliveries: NotificationRow[] }>;
    for (const recipient of recipients) {
      const rows: Array<{ row: NotificationRow; created: boolean }> = [];
      for (const channel of channels) {
        const enabled = this.channelEnabled(recipient, channel);
        const missingAddress = channel === 'sms'
          ? !recipient.phone
          : channel === 'email'
            ? !recipient.email
            : false;
        const initialStatus: NotificationRow['status'] = !enabled || missingAddress ? 'cancelled' : channel === 'in_app' ? 'sent' : 'pending';
        const reason = !enabled ? 'Disabled by user notification preference' : missingAddress ? `No ${channel} destination is configured` : null;
        const inserted = await this.insertDelivery({
          recipient,
          chamaId: input.chamaId ?? null,
          eventType: input.template,
          dedupeKey: input.dedupeKey ?? null,
          channel,
          rendered,
          data,
          status: initialStatus,
          reason,
        });
        rows.push(inserted);
      }

      for (let i = 0; i < rows.length; i += 1) {
        if (!rows[i].created || rows[i].row.status !== 'pending') continue;
        rows[i].row = await this.deliver(rows[i].row, recipient);
      }
      results.push({ userId: recipient.id, deliveries: rows.map((item) => item.row) });
    }

    return { template: input.template, recipients: results };
  }

  async dispatchBestEffort(input: DispatchNotificationInput): Promise<void> {
    try {
      await this.dispatch(input);
    } catch (error) {
      logger.warn('Best-effort notification dispatch failed', {
        template: input.template,
        chamaId: input.chamaId ?? null,
        userCount: input.userIds.length,
        errorCode: String((error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'NotificationError')),
      });
    }
  }

  async getFeed(userId: string, options: { page: number; perPage: number; unreadOnly?: boolean }) {
    const where = [`user_id = $1`, `channel = 'in_app'`, `status = 'sent'`];
    const values: unknown[] = [userId];
    if (options.unreadOnly) where.push('read_at IS NULL');
    const total = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE ${where.join(' AND ')}`,
      values,
    )).rows[0]?.count ?? 0);
    const unread = Number((await this.db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND channel = 'in_app' AND status = 'sent' AND read_at IS NULL`,
      [userId],
    )).rows[0]?.count ?? 0);
    const rows = await this.db.query<NotificationRow>(
      `SELECT id, user_id, chama_id, event_type, dedupe_key, channel::text AS channel,
              title, body, status::text AS status, provider_message_id, payload,
              available_at::text, sent_at::text, read_at::text, failed_at::text,
              failure_reason, created_at::text
         FROM notifications
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [...values, options.perPage, (options.page - 1) * options.perPage],
    );
    return {
      notifications: rows.rows.map(mapNotification),
      meta: { total, unread, page: options.page, perPage: options.perPage, totalPages: total ? Math.ceil(total / options.perPage) : 0 },
    };
  }

  async setReadState(userId: string, notificationId: string, read: boolean) {
    const row = (await this.db.query<NotificationRow>(
      `UPDATE notifications
          SET read_at = CASE WHEN $3 THEN COALESCE(read_at, CURRENT_TIMESTAMP) ELSE NULL END
        WHERE id = $1 AND user_id = $2 AND channel = 'in_app' AND status = 'sent'
        RETURNING id, user_id, chama_id, event_type, dedupe_key, channel::text AS channel,
                  title, body, status::text AS status, provider_message_id, payload,
                  available_at::text, sent_at::text, read_at::text, failed_at::text,
                  failure_reason, created_at::text`,
      [notificationId, userId, read],
    )).rows[0];
    if (!row) throw new NotFoundError('Notification not found', 'NOTIFICATION_NOT_FOUND');
    return mapNotification(row);
  }

  async getPreferences(userId: string) {
    await this.ensureUser(userId);
    await this.db.query(
      `INSERT INTO notification_preferences (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const row = (await this.db.query<{
      in_app_enabled: boolean; sms_enabled: boolean; email_enabled: boolean; push_enabled: boolean; updated_at: string;
    }>(
      `SELECT in_app_enabled, sms_enabled, email_enabled, push_enabled, updated_at::text
         FROM notification_preferences WHERE user_id = $1`,
      [userId],
    )).rows[0];
    return mapPreferences(row);
  }

  async updatePreferences(userId: string, updates: Partial<Record<'inAppEnabled' | 'smsEnabled' | 'emailEnabled' | 'pushEnabled', boolean>>) {
    await this.ensureUser(userId);
    const current = await this.getPreferences(userId);
    const row = (await this.db.query<{
      in_app_enabled: boolean; sms_enabled: boolean; email_enabled: boolean; push_enabled: boolean; updated_at: string;
    }>(
      `INSERT INTO notification_preferences
         (user_id, in_app_enabled, sms_enabled, email_enabled, push_enabled)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE
         SET in_app_enabled = EXCLUDED.in_app_enabled,
             sms_enabled = EXCLUDED.sms_enabled,
             email_enabled = EXCLUDED.email_enabled,
             push_enabled = EXCLUDED.push_enabled,
             updated_at = CURRENT_TIMESTAMP
       RETURNING in_app_enabled, sms_enabled, email_enabled, push_enabled, updated_at::text`,
      [
        userId,
        updates.inAppEnabled ?? current.inAppEnabled,
        updates.smsEnabled ?? current.smsEnabled,
        updates.emailEnabled ?? current.emailEnabled,
        updates.pushEnabled ?? current.pushEnabled,
      ],
    )).rows[0];
    return mapPreferences(row);
  }

  private async ensureUser(userId: string) {
    const result = await this.db.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    if (!result.rowCount) throw new NotFoundError('User not found', 'USER_NOT_FOUND');
  }

  private async loadRecipients(userIds: string[]) {
    const unique = [...new Set(userIds)];
    const result = await this.db.query<RecipientRow>(
      `SELECT u.id, u.phone, u.email, u.full_name,
              COALESCE(np.in_app_enabled, TRUE) AS in_app_enabled,
              COALESCE(np.sms_enabled, TRUE) AS sms_enabled,
              COALESCE(np.email_enabled, TRUE) AS email_enabled,
              COALESCE(np.push_enabled, TRUE) AS push_enabled
         FROM users u
         LEFT JOIN notification_preferences np ON np.user_id = u.id
        WHERE u.id = ANY($1::uuid[]) AND u.status <> 'deleted'`,
      [unique],
    );
    const found = new Set(result.rows.map((row) => row.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) throw new NotFoundError(`Notification recipient not found: ${missing[0]}`, 'NOTIFICATION_RECIPIENT_NOT_FOUND');
    return result.rows;
  }

  private channelEnabled(recipient: RecipientRow, channel: NotificationChannel) {
    if (channel === 'in_app') return recipient.in_app_enabled;
    if (channel === 'sms') return recipient.sms_enabled;
    if (channel === 'email') return recipient.email_enabled;
    return recipient.push_enabled;
  }

  private async insertDelivery(input: {
    recipient: RecipientRow;
    chamaId: string | null;
    eventType: NotificationTemplateKey;
    dedupeKey: string | null;
    channel: NotificationChannel;
    rendered: RenderedTemplate;
    data: Record<string, unknown>;
    status: NotificationRow['status'];
    reason: string | null;
  }): Promise<{ row: NotificationRow; created: boolean }> {
    const result = await this.db.query<NotificationRow>(
      `INSERT INTO notifications
         (user_id, chama_id, event_type, dedupe_key, channel, title, body, status,
          payload, sent_at, failed_at, failure_reason)
       VALUES ($1,$2,$3,$4,$5::notification_channel,$6,$7,$8::notification_status,$9::jsonb,
               CASE WHEN $8 = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END,
               CASE WHEN $8 = 'failed' THEN CURRENT_TIMESTAMP ELSE NULL END,
               $10)
       ON CONFLICT DO NOTHING
       RETURNING id, user_id, chama_id, event_type, dedupe_key, channel::text AS channel,
                 title, body, status::text AS status, provider_message_id, payload,
                 available_at::text, sent_at::text, read_at::text, failed_at::text,
                 failure_reason, created_at::text`,
      [
        input.recipient.id,
        input.chamaId,
        input.eventType,
        input.dedupeKey,
        input.channel,
        input.rendered.title,
        input.rendered.body,
        input.status,
        JSON.stringify(input.data),
        input.reason,
      ],
    );
    if (result.rows[0]) return { row: result.rows[0], created: true };
    if (!input.dedupeKey) throw new Error('Notification insert conflicted without a dedupe key');
    const existing = (await this.db.query<NotificationRow>(
      `SELECT id, user_id, chama_id, event_type, dedupe_key, channel::text AS channel,
              title, body, status::text AS status, provider_message_id, payload,
              available_at::text, sent_at::text, read_at::text, failed_at::text,
              failure_reason, created_at::text
         FROM notifications
        WHERE user_id = $1 AND event_type = $2 AND channel = $3::notification_channel AND dedupe_key = $4`,
      [input.recipient.id, input.eventType, input.channel, input.dedupeKey],
    )).rows[0];
    if (!existing) throw new Error('Unable to resolve deduplicated notification');
    return { row: existing, created: false };
  }

  private async deliver(row: NotificationRow, recipient: RecipientRow): Promise<NotificationRow> {
    let smsReservation: { reserved: boolean; periodMonth: string } | null = null;
    let providerAccepted = false;
    try {
      let providerMessageId: string | null = null;
      if (row.channel === 'sms') {
        if (row.chama_id) {
          const reservation = await reserveSmsQuotaSlot(this.db, row.chama_id, new Date());
          if (!reservation.allowed) {
            return this.finish(row.id, 'cancelled', null, 'Subscription SMS quota exhausted');
          }
          smsReservation = { reserved: reservation.reserved, periodMonth: reservation.periodMonth };
        }
        await this.adapters.sms.sendMessage(recipient.phone, row.body);
        providerAccepted = true;
      } else if (row.channel === 'email') {
        await this.adapters.email.send(recipient.email, row.title, row.body, row.id);
        providerAccepted = true;
      } else if (row.channel === 'push') {
        providerMessageId = await this.adapters.push.send({
          userId: recipient.id,
          deliveryId: row.id,
          eventType: row.event_type,
          title: row.title,
          body: row.body,
          chamaId: row.chama_id,
          payload: row.payload,
        });
        providerAccepted = true;
      }
      return this.finish(row.id, 'sent', providerMessageId, null);
    } catch (error) {
      if (row.channel === 'sms' && row.chama_id && smsReservation?.reserved && !providerAccepted) {
        await releaseSmsQuotaSlot(this.db, row.chama_id, smsReservation.periodMonth).catch(() => undefined);
      }
      const reason = sanitizeFailure(error);
      logger.warn('Notification channel delivery failed', { notificationId: row.id, channel: row.channel, errorCode: reason.slice(0, 120) });
      return this.finish(row.id, 'failed', null, reason);
    }
  }

  private async finish(id: string, status: 'sent' | 'failed' | 'cancelled', providerMessageId: string | null, reason: string | null) {
    const row = (await this.db.query<NotificationRow>(
      `UPDATE notifications
          SET status = $2::notification_status,
              provider_message_id = COALESCE($3, provider_message_id),
              sent_at = CASE WHEN $2 = 'sent' THEN CURRENT_TIMESTAMP ELSE sent_at END,
              failed_at = CASE WHEN $2 = 'failed' THEN CURRENT_TIMESTAMP ELSE failed_at END,
              failure_reason = $4
        WHERE id = $1
        RETURNING id, user_id, chama_id, event_type, dedupe_key, channel::text AS channel,
                  title, body, status::text AS status, provider_message_id, payload,
                  available_at::text, sent_at::text, read_at::text, failed_at::text,
                  failure_reason, created_at::text`,
      [id, status, providerMessageId, reason],
    )).rows[0];
    if (!row) throw new NotFoundError('Notification not found', 'NOTIFICATION_NOT_FOUND');
    return row;
  }
}

function mapNotification(row: NotificationRow) {
  return {
    id: row.id,
    userId: row.user_id,
    chamaId: row.chama_id,
    eventType: row.event_type,
    channel: row.channel,
    title: row.title,
    body: row.body,
    status: row.status,
    providerMessageId: row.provider_message_id,
    payload: row.payload,
    sentAt: row.sent_at,
    readAt: row.read_at,
    failedAt: row.failed_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

function mapPreferences(row: {
  in_app_enabled: boolean; sms_enabled: boolean; email_enabled: boolean; push_enabled: boolean; updated_at: string;
}) {
  return {
    inAppEnabled: row.in_app_enabled,
    smsEnabled: row.sms_enabled,
    emailEnabled: row.email_enabled,
    pushEnabled: row.push_enabled,
    updatedAt: row.updated_at,
  };
}

function sanitizeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Notification provider failure';
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 1000);
}

export const notificationService = new NotificationService();
