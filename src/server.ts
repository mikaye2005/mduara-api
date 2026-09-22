import { app } from './app';
import { env } from './config/env';
import { closeDatabase } from './db/client';
import { closeRedis } from './config/redis';
import { logger } from './utils/logger';
import { bootstrapSuperAdmin } from './db/bootstrap-admin';

async function startServer(): Promise<void> {
  if (env.SUPER_ADMIN_BOOTSTRAP) {
    try {
      const bootstrapped = await bootstrapSuperAdmin();
      logger.info(bootstrapped ? 'Bootstrap admin account synced from environment configuration' : 'No admin bootstrap configured; skipping admin bootstrap');
    } catch (error) {
      logger.warn('Admin bootstrap failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const server = app.listen(env.PORT, () => {
    logger.info(`mduara-api listening on port ${env.PORT}`, { env: env.NODE_ENV });
  });

  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully`);
    server.close(async () => {
      await Promise.allSettled([closeDatabase(), closeRedis()]);
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void startServer();
