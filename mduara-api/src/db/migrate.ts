import 'dotenv/config';
import migrate from 'node-pg-migrate';
import { Pool } from 'pg';
import { bootstrapSuperAdmin, readSuperAdminBootstrapConfig } from './bootstrap-super-admin';

export async function migrateDatabase(shouldBootstrapSuperAdmin = true): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required to run migrations');

  const superAdminConfiguration = shouldBootstrapSuperAdmin
    ? readSuperAdminBootstrapConfig(process.env)
    : undefined;

  await migrate({
    databaseUrl,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    ignorePattern: '.*\\.sql',
    singleTransaction: true,
    log: (message) => console.log(message),
  });

  if (!superAdminConfiguration) return;

  const database = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await bootstrapSuperAdmin(database, superAdminConfiguration);
    console.log(JSON.stringify({ event: 'mduara.super_admin_bootstrap_complete', ...result }, null, 2));
  } finally {
    await database.end();
  }
}

if (require.main === module) {
  const shouldBootstrapSuperAdmin = !process.argv.includes('--skip-super-admin');
  void migrateDatabase(shouldBootstrapSuperAdmin).catch((error) => {
    console.error('[migration failed]', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}