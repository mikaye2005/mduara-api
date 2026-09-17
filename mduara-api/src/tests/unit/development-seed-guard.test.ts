import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDevelopmentSeedAllowed,
  DEVELOPMENT_REMOTE_SEED_FLAG,
  DEVELOPMENT_SEED_FLAG,
} from '../../db/development-seed';

const localDatabase = 'postgres://postgres:postgres@localhost:5432/mduaradb_dev';

test('BE-36 development seed is impossible in production even with the enable flag', () => {
  assert.throws(
    () => assertDevelopmentSeedAllowed({
      NODE_ENV: 'production',
      DATABASE_URL: localDatabase,
      [DEVELOPMENT_SEED_FLAG]: 'true',
    }),
    /disabled.*production/i,
  );
});

test('BE-36 development seed requires explicit opt-in and protects remote databases', () => {
  assert.throws(
    () => assertDevelopmentSeedAllowed({ NODE_ENV: 'development', DATABASE_URL: localDatabase }),
    new RegExp(DEVELOPMENT_SEED_FLAG),
  );

  assert.throws(
    () => assertDevelopmentSeedAllowed({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://dev:dev@db.example.test:5432/mduara_dev',
      [DEVELOPMENT_SEED_FLAG]: 'true',
    }),
    new RegExp(DEVELOPMENT_REMOTE_SEED_FLAG),
  );

  assert.doesNotThrow(() => assertDevelopmentSeedAllowed({
    NODE_ENV: 'development',
    DATABASE_URL: localDatabase,
    [DEVELOPMENT_SEED_FLAG]: 'true',
  }));
});
