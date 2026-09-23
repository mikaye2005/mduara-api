import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../utils/logger';

export const SCHEDULES = {
  midnight: '0 0 * * *',
  recovery: '5 * * * *',
  reminders: '* * * * *',
  reports: '* * * * *',
  meetings: '* * * * *',
} as const;

type WorkName = 'financial' | 'reminders' | 'reports' | 'meetings';

export class BackgroundScheduler {
  private tasks: ScheduledTask[] = [];
  private running = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(private readonly timezone: string, private readonly work: {
    financial: () => Promise<unknown>;
    reminders: () => Promise<unknown>;
    reports?: () => Promise<unknown>;
    meetings?: () => Promise<unknown>;
  }) {}

  isStopping = () => this.stopping;

  async start(): Promise<void> {
    const schedules: Array<readonly [string, WorkName]> = [
      [SCHEDULES.midnight, 'financial'],
      [SCHEDULES.recovery, 'financial'],
      [SCHEDULES.reminders, 'reminders'],
    ];
    if (this.work.reports) schedules.push([SCHEDULES.reports, 'reports']);
    if (this.work.meetings) schedules.push([SCHEDULES.meetings, 'meetings']);

    this.tasks = schedules.map(([expression, name]) => cron.schedule(expression, () => this.run(name), {
      name: `mduara-${name}`,
      timezone: this.timezone,
      noOverlap: true,
    }));

    // Recover missed work immediately after a restart, without relying on cron replay.
    const startup: Promise<void>[] = [this.run('financial'), this.run('reminders')];
    if (this.work.reports) startup.push(this.run('reports'));
    if (this.work.meetings) startup.push(this.run('meetings'));
    await Promise.all(startup);
  }

  run(name: WorkName): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const work = this.work[name];
    if (!work) return Promise.resolve();
    const existing = this.running.get(name);
    if (existing) return existing;
    const started = Date.now();
    const promise = Promise.resolve().then(() => work()).then((result) => {
      logger.info('Background job completed', { job: name, durationMs: Date.now() - started, result });
    }).catch((error) => {
      logger.error('Background job failed; scheduled recovery will retry', {
        job: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => { this.running.delete(name); });
    this.running.set(name, promise);
    return promise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.tasks.map((task) => task.destroy()));
    await Promise.all(this.running.values());
  }
}
