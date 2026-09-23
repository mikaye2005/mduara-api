import type { Pool, PoolClient } from 'pg';
import { pool } from './client';

const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01']);

interface DatabaseError extends Error {
  code?: string;
}

export interface TransactionOptions {
  /** Serializable prevents predicate races; row locks serialize treasury updates. */
  isolationLevel?: 'SERIALIZABLE' | 'REPEATABLE READ' | 'READ COMMITTED';
  maxRetries?: number;
}

/**
 * Runs every statement through one checked-out connection. A failure at any
 * point rolls back the whole unit of work before the connection is returned.
 */
export async function withDatabaseTransaction<T>(
  work: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
  databasePool: Pool = pool,
): Promise<T> {
  const isolationLevel = options.isolationLevel ?? 'SERIALIZABLE';
  const maxRetries = options.maxRetries ?? 2;

  for (let attempt = 0; ; attempt += 1) {
    const client = await databasePool.connect();

    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original error is more useful; the pool will discard a bad client.
      }

      const code = (error as DatabaseError).code;
      if (attempt < maxRetries && code && RETRYABLE_TRANSACTION_CODES.has(code)) {
        continue;
      }

      throw error;
    } finally {
      client.release();
    }
  }
}
