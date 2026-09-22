'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

if (!process.env.DATABASE_URL) {
  const user = process.env.DB_USER || 'postgres';
  const password = process.env.DB_PASSWORD || 'postgres';
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5432';
  const database = process.env.DB_NAME || 'mduara';

  process.env.DATABASE_URL = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

const migrateCli = require.resolve('node-pg-migrate/bin/node-pg-migrate');
const result = spawnSync(process.execPath, [migrateCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: path.resolve(__dirname, '..'),
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const args = process.argv.slice(2);
const hasMigrationCommand = args.some((arg) => ['up', 'up-all', 'up --', 'down', 'down-all'].includes(arg));
if (process.env.SUPER_ADMIN_BOOTSTRAP === 'true' && args.includes('up')) {
  const bootstrap = spawnSync(process.execPath, ['--import', 'tsx', '-e', "import { bootstrapSuperAdmin } from './src/db/bootstrap-admin.ts'; await bootstrapSuperAdmin();"], {
    stdio: 'inherit',
    env: process.env,
    cwd: path.resolve(__dirname, '..'),
  });
  if (bootstrap.error) throw bootstrap.error;
  if (bootstrap.status !== 0) process.exit(bootstrap.status ?? 1);
}

process.exit(0);