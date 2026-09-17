import { app } from './app';
import { env } from './config/env';
import { closeDatabase } from './db/client';
import { closeRedis } from './config/redis';
import { logger } from './utils/logger';

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
