import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { DEV_FIXTURE_IDS, seedDevelopmentDatabase } from '../../db/development-seed';
import { SessionService } from '../../services/session.service';
import { GoalMarketplaceService } from '../../services/goal-marketplace.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-36 seed is deterministic, multi-Chama aware and marketplace-ready', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `seed_be36_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const db = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    MDUARA_ENABLE_DEV_SEED: process.env.MDUARA_ENABLE_DEV_SEED,
    MDUARA_ALLOW_REMOTE_DEV_SEED: process.env.MDUARA_ALLOW_REMOTE_DEV_SEED,
  };

  t.after(async () => {
    restoreEnv('NODE_ENV', previous.NODE_ENV);
    restoreEnv('DATABASE_URL', previous.DATABASE_URL);
    restoreEnv('MDUARA_ENABLE_DEV_SEED', previous.MDUARA_ENABLE_DEV_SEED);
    restoreEnv('MDUARA_ALLOW_REMOTE_DEV_SEED', previous.MDUARA_ALLOW_REMOTE_DEV_SEED);
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

  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = databaseUrl!;
  process.env.MDUARA_ENABLE_DEV_SEED = 'true';
  process.env.MDUARA_ALLOW_REMOTE_DEV_SEED = 'true';

  const first = await seedDevelopmentDatabase(db);
  const second = await seedDevelopmentDatabase(db);
  assert.deepEqual(second, first);
  assert.equal(first.users, Object.keys(DEV_FIXTURE_IDS.users).length);
  assert.equal(first.chamas, Object.keys(DEV_FIXTURE_IDS.chamas).length);
  assert.equal(first.memberships, Object.keys(DEV_FIXTURE_IDS.memberships).length);
  assert.equal(first.aishaMemberships, 3);
  assert.equal(first.aishaOfficialMemberships, 1);
  assert.equal(first.washingMachinePartnerMerchants, 3);

  const aisha = await db.query<{ id: string; chama_id: string; role: string }>(
    `SELECT id, chama_id, role::text AS role
       FROM chama_members
      WHERE user_id = $1
      ORDER BY id`,
    [DEV_FIXTURE_IDS.users.aisha],
  );
  assert.deepEqual(
    aisha.rows.map((row) => [row.id, row.chama_id, row.role]),
    [
      [DEV_FIXTURE_IDS.memberships.aishaSummertides, DEV_FIXTURE_IDS.chamas.summertides, 'secretary'],
      [DEV_FIXTURE_IDS.memberships.aishaFutureHome, DEV_FIXTURE_IDS.chamas.futureHome, 'member'],
      [DEV_FIXTURE_IDS.memberships.aishaWashingMachine, DEV_FIXTURE_IDS.chamas.washingMachine, 'member'],
    ],
  );

  const context = await new SessionService(db).getContext(DEV_FIXTURE_IDS.users.aisha);
  assert.equal(context.memberships.length, 3);
  assert.equal(context.defaultContext?.membershipId, DEV_FIXTURE_IDS.memberships.aishaSummertides);
  assert.equal(context.memberships.find((item) => item.chamaId === DEV_FIXTURE_IDS.chamas.summertides)?.officialRole, 'secretary');
  assert.equal(context.memberships.find((item) => item.chamaId === DEV_FIXTURE_IDS.chamas.futureHome)?.officialRole, null);
  assert.equal(context.memberships.find((item) => item.chamaId === DEV_FIXTURE_IDS.chamas.washingMachine)?.officialRole, null);

  const visibility = await db.query<{ name: string; visibility: string }>(
    `SELECT name, visibility::text AS visibility
       FROM chamas
      WHERE id = ANY($1::uuid[])
      ORDER BY name`,
    [Object.values(DEV_FIXTURE_IDS.chamas)],
  );
  const byName = new Map(visibility.rows.map((row) => [row.name, row.visibility]));
  assert.equal(byName.get("Summertides '27"), 'private');
  assert.equal(byName.get('Future Home'), 'application');
  assert.equal(byName.get('Next Step Founders'), 'public');
  assert.equal(byName.get('Washing Machine Mbogi'), 'public');

  const ruleCount = Number((await db.query(
    `SELECT COUNT(*)::int AS count FROM chama_rules
      WHERE id = ANY($1::uuid[]) AND status = 'active' AND commitment_amount = 500`,
    [Object.values(DEV_FIXTURE_IDS.rules)],
  )).rows[0].count);
  assert.equal(ruleCount, 4);

  const catalogCounts = (await db.query<{ categories: number; goals: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM goal_categories WHERE is_active = TRUE) AS categories,
       (SELECT COUNT(*)::int FROM saving_goals WHERE is_active = TRUE) AS goals`,
  )).rows[0];
  assert.equal(Number(catalogCounts.categories), 4);
  assert.equal(Number(catalogCounts.goals), 14);

  const washingMetric = await new GoalMarketplaceService(db).getMetric('washing_machine');
  assert.equal(washingMetric.partnerMerchantCount, 3);
  assert.ok(washingMetric.membersSaving >= 2);
  assert.ok(BigInt(washingMetric.totalTargetValue) > 0n);

});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
