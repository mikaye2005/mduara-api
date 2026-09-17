import assert from 'node:assert/strict';
import test from 'node:test';
import cron from 'node-cron';
import { BackgroundScheduler, SCHEDULES } from '../../jobs/scheduler';

test('midnight schedule resolves to Nairobi midnight regardless of the host timezone', async () => {
  const task = cron.createTask(SCHEDULES.midnight, () => {}, { timezone: 'Africa/Nairobi' });
  await task.start();
  const next = task.getNextRun()!;
  assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next), '00:00');
  await task.destroy();
});
test('recovery and midnight runs cannot overlap; shutdown waits for active work', async () => {
  let release!: () => void;
  let count = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new BackgroundScheduler('Africa/Nairobi', {
    financial: async () => { count += 1; await pending; }, reminders: async () => {},
  });
  const first = scheduler.run('financial');
  const second = scheduler.run('financial');
  await Promise.resolve();
  assert.equal(count, 1);
  assert.equal(first, second);
  let stopped = false;
  const stop = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stop;
  await scheduler.run('financial');
  assert.equal(count, 1);
});
test('a failed run releases the overlap guard so the next run can retry', async () => {
  let count = 0;
  const scheduler = new BackgroundScheduler('UTC', {
    financial: async () => { count += 1; if (count === 1) throw new Error('temporary failure'); }, reminders: async () => {},
  });
  await scheduler.run('financial');
  await scheduler.run('financial');
  assert.equal(count, 2);
  await scheduler.stop();
});
