import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import migrate from 'node-pg-migrate';
import { GoalCatalogService } from '../../services/goal-catalog.service';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('BE-29 canonical Phase 1 goal catalog is normalized, deterministic and enforced by PostgreSQL', { skip: !databaseUrl, timeout: 120_000 }, async (t) => {
  const schema = `goal_catalog_${randomUUID().replace(/-/g, '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, max: 5, options: `-c search_path=${schema},public` });

  t.after(async () => {
    await pool.end();
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

  const service = new GoalCatalogService(pool);

  const categories = await service.listCategories();
  assert.deepEqual(
    categories.map((category) => [category.code, category.name, category.goalCount]),
    [
      ['home_appliances', 'Home Appliances', 4],
      ['travel', 'Travel', 4],
      ['education', 'Education', 3],
      ['personal', 'Personal', 3],
    ],
  );

  const allGoals = await service.listGoals();
  assert.equal(allGoals.length, 14);
  assert.equal(new Set(allGoals.map((goal) => goal.code)).size, 14);

  const homeGoals = await service.listGoals('home_appliances');
  assert.deepEqual(homeGoals.map((goal) => goal.name), ['Washing Machine', 'Fridge', 'TV', 'Cooker']);

  const washingMachine = await service.getGoal('washing_machine');
  assert.equal(washingMachine.id, '20000000-0000-4000-8000-000000000001');
  assert.equal(washingMachine.category.code, 'home_appliances');

  const sameGoal = await service.getGoal(washingMachine.id);
  assert.equal(sameGoal.code, 'washing_machine');

  await pool.query(
    `INSERT INTO chamas (name, type, goal_code, contribution_amount, contribution_frequency, status)
     VALUES ('Catalog-linked Mbogi', 'goal_based', 'washing_machine', 1000, 'monthly', 'recruiting')`,
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO chamas (name, type, goal_code, contribution_amount, contribution_frequency, status)
       VALUES ('Unknown Goal Mbogi', 'goal_based', 'not_a_real_goal', 1000, 'monthly', 'recruiting')`,
    ),
    (error: unknown) => (error as { code?: string }).code === '23503',
  );
});
