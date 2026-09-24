import type { Pool } from 'pg';
import { pool } from '../db/client';
import { logger } from '../utils/logger';

export type BackgroundJobName = 'financial' | 'reminders' | 'reports' | 'meetings';

export async function runTrackedBackgroundJob<T>(
  name: BackgroundJobName,
  work: () => Promise<T>,
  db: Pool = pool,
): Promise<T> {
  const startedAt = new Date();
  const run = (await db.query<{ id: string }>(
    `INSERT INTO background_job_runs (job_name, status, started_at)
     VALUES ($1, 'running', $2) RETURNING id`,
    [name, startedAt],
  )).rows[0];

  try {
    const result = await work();
    const completedAt = new Date();
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    try {
      await db.query(
        `UPDATE background_job_runs
            SET status = 'succeeded', completed_at = $2, duration_ms = $3,
                result = $4::jsonb
          WHERE id = $1 AND status = 'running'`,
        [run.id, completedAt, durationMs, JSON.stringify(toJsonSafe(result))],
      );
    } catch (telemetryError) {
      // The domain job already succeeded. Never replay money/notification work merely
      // because telemetry finalization failed; surface the telemetry defect separately.
      logger.error('Background job telemetry finalization failed after successful work', {
        job: name,
        runId: run.id,
        error: telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
      });
    }
    return result;
  } catch (error) {
    const completedAt = new Date();
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime());
    const failure = sanitizeFailure(error);
    try {
      await db.query(
        `UPDATE background_job_runs
            SET status = 'failed', completed_at = $2, duration_ms = $3,
                failure_reason = $4
          WHERE id = $1 AND status = 'running'`,
        [run.id, completedAt, durationMs, failure],
      );
    } catch (telemetryError) {
      logger.error('Unable to persist failed background job telemetry', {
        job: name,
        runId: run.id,
        originalError: failure,
        telemetryError: telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
      });
    }
    throw error;
  }
}

function sanitizeFailure(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error ?? 'Background job failed');
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 2000);
}

function toJsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, (_key, current) => typeof current === 'bigint' ? current.toString() : current));
}
