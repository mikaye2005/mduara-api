import { Pool } from 'pg';
import { env } from './config/env';
import { runFinancialScan } from './jobs/financial-scan';
import { enqueueReminders, ReminderDispatcher, type ReminderChannel } from './jobs/reminders';
import { ReportJobWorker } from './jobs/report.worker';
import { MeetingReminderWorker } from './jobs/meeting-reminders';
import { BackgroundScheduler } from './jobs/scheduler';
import { emailService } from './services/email.service';
import { smsService } from './services/sms.service';
import { runTrackedBackgroundJob } from './services/background-job.service';
import { logger } from './utils/logger';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.WORKER_DB_POOL_MAX,
  application_name: 'mduara-background-worker',
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 10_000,
  lock_timeout: 500,
});
pool.on('error', (error) => logger.error('Worker database connection failed', { error: error.message }));

const channels = env.REMINDER_CHANNELS.split(',') as ReminderChannel[];
const dispatcher = new ReminderDispatcher(pool, {
  async send(channel, recipient, subject, message, deliveryId) {
    if (channel === 'sms') await smsService.sendMessage(recipient, message);
    else await emailService.send(recipient, subject, message, deliveryId);
  },
}, 8, channels);
const reportWorker = new ReportJobWorker(pool);
const meetingReminderWorker = new MeetingReminderWorker(pool);

const options = {
  timezone: env.SCHEDULER_TIMEZONE,
  batchSize: env.WORKER_BATCH_SIZE,
  isStopping: () => scheduler.isStopping(),
};

const scheduler = new BackgroundScheduler(env.SCHEDULER_TIMEZONE, {
  financial: () => runTrackedBackgroundJob('financial', () => runFinancialScan(pool, options), pool),
  reminders: () => runTrackedBackgroundJob('reminders', async () => ({
    enqueued: await enqueueReminders(pool, options, channels),
    ...await dispatcher.dispatchBatch(env.WORKER_BATCH_SIZE, new Date(), options.isStopping),
  }), pool),
  reports: () => runTrackedBackgroundJob('reports', () => reportWorker.runBatch(env.WORKER_BATCH_SIZE, new Date(), options.isStopping), pool),
  meetings: () => runTrackedBackgroundJob('meetings', () => meetingReminderWorker.runBatch(env.WORKER_BATCH_SIZE, new Date(), options.isStopping), pool),
});

let shutdownStarted = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info('Stopping background worker', { signal });
  await scheduler.stop();
  emailService.close();
  await pool.end();
}

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    if (channels.includes('sms') && env.SMS_PROVIDER === 'console') {
      throw new Error('Production SMS reminders require SMS_PROVIDER=africastalking');
    }
    if (channels.includes('email') && env.EMAIL_PROVIDER === 'console') {
      throw new Error('Production email reminders require EMAIL_PROVIDER=smtp');
    }
  }

  // Fail fast if the worker was deployed against a schema that is behind its code.
  await pool.query('SELECT penalty_checked_at FROM contributions LIMIT 0');
  await pool.query('SELECT next_interest_date FROM loans LIMIT 0');
  await pool.query('SELECT id FROM reminder_deliveries LIMIT 0');
  await pool.query('SELECT id FROM report_jobs LIMIT 0');
  await pool.query('SELECT reminder_at, reminder_dispatched_at FROM chama_meetings LIMIT 0');
  await pool.query('SELECT id FROM background_job_runs LIMIT 0');

  process.once('SIGTERM', () => void shutdown('SIGTERM').catch((error) => {
    logger.error('Worker shutdown failed', { error: error.message }); process.exitCode = 1;
  }));
  process.once('SIGINT', () => void shutdown('SIGINT').catch((error) => {
    logger.error('Worker shutdown failed', { error: error.message }); process.exitCode = 1;
  }));

  logger.info('Starting background worker', {
    timezone: env.SCHEDULER_TIMEZONE,
    channels,
    poolSize: env.WORKER_DB_POOL_MAX,
    reportQueue: true,
    meetingReminders: true,
  });
  await scheduler.start();
}

void main().catch(async (error) => {
  logger.error('Background worker startup failed', { error: error.message });
  await shutdown('startup failure');
  process.exitCode = 1;
});
