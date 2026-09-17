import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { workerTransaction } from './database';
import type { ScanOptions } from './financial-scan';
import { logger } from '../utils/logger';
import { releaseSmsQuotaSlot, reserveSmsQuotaSlot } from '../services/subscription.service';

export type ReminderChannel = 'sms' | 'email';
export interface ReminderSender {
  send(channel: ReminderChannel, recipient: string, subject: string, message: string, deliveryId: string): Promise<void>;
}
interface Delivery { id: string; kind: 'contribution' | 'loan'; entity_id: string; due_date: string; channel: ReminderChannel; attempts: number; lease_token: string; }
interface Recipient { chama_id: string; phone: string | null; email: string; chama_name: string; currency: string; outstanding: string; }

export async function enqueueReminders(pool: Pool, options: ScanOptions, channels: ReminderChannel[], now = new Date()): Promise<number> {
  let enqueued = 0;
  for (const kind of ['contribution', 'loan'] as const) {
    let cursorDate = '0001-01-01';
    let cursorId = '00000000-0000-0000-0000-000000000000';
    // All interpolated SQL comes from this fixed internal list, never user input.
    const table = kind === 'contribution' ? 'contributions' : 'loans';
    const statuses = kind === 'contribution' ? "'pending', 'partially_paid', 'late'" : "'active', 'partially_repaid'";
    while (!options.isStopping?.()) {
      const rows = await pool.query<{ id: string; due_date: string; deadline: Date }>(
        `SELECT e.id, e.due_date::text, (e.due_date + 1)::timestamp AT TIME ZONE $2 AS deadline
         FROM ${table} e JOIN chamas g ON g.id = e.chama_id AND g.status = 'active'
         JOIN chama_members m ON m.id = e.member_id AND m.chama_id = e.chama_id AND m.membership_status = 'active'
         WHERE e.status IN (${statuses})
           AND e.due_date >= ($1::timestamptz AT TIME ZONE $2)::date
           AND e.due_date <= (($1::timestamptz + interval '48 hours') AT TIME ZONE $2)::date
           AND (e.due_date + 1)::timestamp AT TIME ZONE $2 > $1
           AND ((e.due_date + 1)::timestamp AT TIME ZONE $2) - interval '48 hours' <= $1
           AND (e.due_date, e.id) > ($3::date, $4::uuid)
         ORDER BY e.due_date, e.id LIMIT $5`, [now, options.timezone, cursorDate, cursorId, options.batchSize],
      );
      if (!rows.rows.length) break;
      for (const row of rows.rows) {
        if (options.isStopping?.()) break;
        const result = await pool.query(
          `INSERT INTO reminder_deliveries (kind, entity_id, due_date, channel, available_at, expires_at)
           SELECT $1, $2, $3, channel, $4, $5 FROM unnest($6::text[]) AS channel
           ON CONFLICT (kind, entity_id, due_date, channel) DO NOTHING`,
          [kind, row.id, row.due_date, now, row.deadline, channels],
        );
        enqueued += result.rowCount;
      }
      const last = rows.rows[rows.rows.length - 1];
      cursorDate = last.due_date;
      cursorId = last.id;
    }
  }
  return enqueued;
}

export class ReminderDispatcher {
  constructor(
    private readonly pool: Pool,
    private readonly sender: ReminderSender,
    private readonly maxAttempts = 8,
    private readonly channels: ReminderChannel[] = ['sms', 'email'],
  ) {}

  async dispatchBatch(limit: number, now = new Date(), isStopping: () => boolean = () => false) {
    const startedAt = Date.now();
    const clock = () => new Date(now.getTime() + Date.now() - startedAt);
    const totals = { sent: 0, cancelled: 0, retried: 0, failed: 0 };
    // Claim one at a time so leases never expire while waiting in a local batch.
    for (let i = 0; i < limit && !isStopping(); i += 1) {
      const claimTime = clock();
      const delivery = await workerTransaction(this.pool, async (client) => {
        const token = randomUUID();
        const result = await client.query<Delivery>(
          `WITH candidate AS (
             SELECT id FROM reminder_deliveries
             WHERE channel = ANY($3::text[]) AND ((status = 'pending' AND available_at <= $1)
                OR (status = 'processing' AND locked_until <= $1))
             ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1
           ) UPDATE reminder_deliveries d SET status = 'processing', attempts = attempts + 1,
               lease_token = $2, locked_until = $1::timestamptz + interval '60 seconds'
             FROM candidate c WHERE d.id = c.id
             RETURNING d.id, d.kind, d.entity_id, d.due_date::text, d.channel, d.attempts, d.lease_token`, [claimTime, token, this.channels],
        );
        return result.rows[0];
      });
      if (!delivery) break;
      let smsReservation: { reserved: boolean; periodMonth: string } | null = null;
      let providerAccepted = false;
      let recipientChamaId: string | null = null;
      try {
        if (delivery.attempts > this.maxAttempts) {
          await this.finish(delivery, 'failed', 'Delivery attempt limit reached');
          totals.failed += 1;
          continue;
        }
        const recipient = await this.findRecipient(delivery, clock());
        const address = delivery.channel === 'sms' ? recipient?.phone : recipient?.email;
        recipientChamaId = recipient?.chama_id ?? null;
        if (!recipient || BigInt(recipient.outstanding) <= 0n || !address) {
          await this.finish(delivery, 'cancelled');
          totals.cancelled += 1;
          continue;
        }
        if (delivery.channel === 'sms') {
          const reservation = await reserveSmsQuotaSlot(this.pool, recipient.chama_id, clock());
          if (!reservation.allowed) {
            await this.finish(delivery, 'cancelled', 'Subscription SMS quota exhausted');
            totals.cancelled += 1;
            continue;
          }
          smsReservation = { reserved: reservation.reserved, periodMonth: reservation.periodMonth };
        }
        const purpose = delivery.kind === 'contribution' ? 'contribution' : 'loan repayment';
        const subject = `${recipient.chama_name}: ${purpose} reminder`;
        const message = `M-Duara reminder: Your ${purpose} of ${recipient.currency} ${recipient.outstanding} for ${recipient.chama_name} is due by the end of ${delivery.due_date}. Please pay before the deadline.`;
        // No transaction or database connection is held during provider I/O.
        await this.sender.send(delivery.channel, address, subject, message, delivery.id);
        providerAccepted = true;
        await this.pool.query(
          `UPDATE reminder_deliveries SET status = 'sent', sent_at = $3, locked_until = NULL, lease_token = NULL, last_error = NULL
           WHERE id = $1 AND lease_token = $2`, [delivery.id, delivery.lease_token, clock()],
        );
        totals.sent += 1;
      } catch (error) {
        if (delivery.channel === 'sms' && smsReservation?.reserved && !providerAccepted) {
          if (recipientChamaId) await releaseSmsQuotaSlot(this.pool, recipientChamaId, smsReservation.periodMonth).catch(() => undefined);
        }
        const failed = delivery.attempts >= this.maxAttempts;
        const errorCode = String((error as { code?: string })?.code ?? (error instanceof Error ? error.name : 'DeliveryError')).slice(0, 100);
        logger.warn('Reminder delivery attempt failed', { deliveryId: delivery.id, channel: delivery.channel, attempts: delivery.attempts, errorCode, failed });
        const delaySeconds = Math.min(3600, 30 * 2 ** (delivery.attempts - 1));
        await this.pool.query(
          `UPDATE reminder_deliveries SET status = $3, available_at = $4::timestamptz + $5 * interval '1 second',
             locked_until = NULL, lease_token = NULL, last_error = $6 WHERE id = $1 AND lease_token = $2`,
          [delivery.id, delivery.lease_token, failed ? 'failed' : 'pending', clock(), delaySeconds,
            errorCode],
        );
        if (failed) totals.failed += 1;
        else totals.retried += 1;
      }
    }
    return totals;
  }

  private async finish(delivery: Delivery, status: 'cancelled' | 'failed', reason: string | null = null) {
    await this.pool.query(
      `UPDATE reminder_deliveries SET status = $3, last_error = $4, locked_until = NULL, lease_token = NULL
       WHERE id = $1 AND lease_token = $2`, [delivery.id, delivery.lease_token, status, reason],
    );
  }

  private async findRecipient(delivery: Delivery, now: Date): Promise<Recipient | undefined> {
    const contribution = delivery.kind === 'contribution';
    const table = contribution ? 'contributions' : 'loans';
    const payments = contribution ? 'contribution_payments' : 'loan_repayments';
    const foreignKey = contribution ? 'contribution_id' : 'loan_id';
    const amount = contribution ? 'expected_amount' : 'total_due';
    const statuses = contribution ? "'pending', 'partially_paid', 'late'" : "'active', 'partially_repaid'";
    const result = await this.pool.query<Recipient>(
      `SELECT g.id AS chama_id, u.phone, u.email, g.name AS chama_name, g.currency,
         (e.${amount} - COALESCE((SELECT SUM(amount) FROM ${payments} WHERE ${foreignKey} = e.id AND status = 'confirmed'), 0))::text AS outstanding
       FROM ${table} e JOIN chamas g ON g.id = e.chama_id AND g.status = 'active'
       JOIN chama_members m ON m.id = e.member_id AND m.chama_id = e.chama_id AND m.membership_status = 'active'
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       JOIN reminder_deliveries d ON d.id = $3 AND d.expires_at > $4
       WHERE e.id = $1 AND e.due_date = $2 AND e.status IN (${statuses})`,
      [delivery.entity_id, delivery.due_date, delivery.id, now],
    );
    return result.rows[0];
  }
}
