import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { NotificationService, type NotificationAdapters } from '../../services/notification.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-16 notification delivery, preferences and in-app feed', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `be16_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await db.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  await migrate({
    databaseUrl: databaseUrl!,
    dir: 'migrations',
    direction: 'up',
    schema,
    createSchema: true,
    migrationsSchema: schema,
    migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql',
    singleTransaction: true,
    log: () => {},
  });

  const user = (await db.query<{ id: string }>(
    `INSERT INTO users (email, pin_hash, full_name, phone, status)
     VALUES ($1, 'test-pin-hash', 'Notification User', '+254700000001', 'active') RETURNING id`,
    [`${randomUUID()}@example.test`],
  )).rows[0];

  const calls = { sms: 0, email: 0, push: 0 };
  const adapters: NotificationAdapters = {
    sms: {
      async sendMessage() { calls.sms += 1; },
    },
    email: {
      async send() {
        calls.email += 1;
        throw new Error('Synthetic SMTP outage');
      },
    },
    push: {
      async send() { calls.push += 1; return 'push-provider-1'; },
    },
  };
  const service = new NotificationService(db, adapters);

  await t.test('a failed channel is logged but does not fail the overall event dispatch', async () => {
    const result = await service.dispatch({
      userIds: [user.id],
      template: 'application_approved',
      channels: ['in_app', 'sms', 'email', 'push'],
      data: { chamaName: 'Test Chama' },
      dedupeKey: 'application-approved:test-1',
    });

    const statuses = Object.fromEntries(result.recipients[0].deliveries.map((row) => [row.channel, row.status]));
    assert.deepEqual(statuses, { in_app: 'sent', sms: 'sent', email: 'failed', push: 'sent' });
    assert.deepEqual(calls, { sms: 1, email: 1, push: 1 });

    const failed = (await db.query<{ failure_reason: string | null }>(
      `SELECT failure_reason FROM notifications WHERE user_id = $1 AND channel = 'email'`,
      [user.id],
    )).rows[0];
    assert.match(failed.failure_reason ?? '', /Synthetic SMTP outage/);
  });

  await t.test('dedupe key prevents a retried internal event from being sent twice', async () => {
    await service.dispatch({
      userIds: [user.id],
      template: 'application_approved',
      channels: ['in_app', 'sms', 'email', 'push'],
      data: { chamaName: 'Test Chama' },
      dedupeKey: 'application-approved:test-1',
    });
    assert.deepEqual(calls, { sms: 1, email: 1, push: 1 });
    const count = Number((await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = $1 AND dedupe_key = $2`,
      [user.id, 'application-approved:test-1'],
    )).rows[0].count);
    assert.equal(count, 4);
  });

  await t.test('in-app feed exposes unread state and supports read/unread toggling', async () => {
    let feed = await service.getFeed(user.id, { page: 1, perPage: 25 });
    assert.equal(feed.notifications.length, 1);
    assert.equal(feed.meta.unread, 1);
    assert.equal(feed.notifications[0].eventType, 'application_approved');

    const id = feed.notifications[0].id;
    const read = await service.setReadState(user.id, id, true);
    assert.ok(read.readAt);
    feed = await service.getFeed(user.id, { page: 1, perPage: 25, unreadOnly: true });
    assert.equal(feed.notifications.length, 0);
    assert.equal(feed.meta.unread, 0);

    const unread = await service.setReadState(user.id, id, false);
    assert.equal(unread.readAt, null);
  });

  await t.test('channel preferences cancel delivery without calling the provider', async () => {
    const preferences = await service.updatePreferences(user.id, { smsEnabled: false });
    assert.equal(preferences.smsEnabled, false);

    const result = await service.dispatch({
      userIds: [user.id],
      template: 'commitment_refund_ready',
      channels: ['in_app', 'sms'],
      data: { chamaName: 'Test Chama' },
      dedupeKey: 'refund-ready:test-1',
    });
    const sms = result.recipients[0].deliveries.find((row) => row.channel === 'sms');
    assert.equal(sms?.status, 'cancelled');
    assert.match(sms?.failure_reason ?? '', /preference/i);
    assert.equal(calls.sms, 1);
  });
});
