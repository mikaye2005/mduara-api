import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/client';

export type AuditCategory = 'security' | 'financial' | 'moderation' | 'system';
export type AuditActorRole = 'member' | 'treasurer' | 'secretary' | 'chairperson' | 'platform_admin' | 'system';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface AuditEventInput {
  category: AuditCategory;
  action: string;
  actorId?: string | null;
  actorRole?: AuditActorRole | null;
  chamaId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  payload?: Record<string, unknown>;
}

export async function writeAuditEvent(db: Queryable, input: AuditEventInput): Promise<string> {
  const row = (await db.query<{ id: string }>(
    `INSERT INTO audit_logs
       (category, action, actor_id, actor_role, chama_id, entity_type, entity_id, ip_address, user_agent, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::inet,$9,$10::jsonb)
     RETURNING id`,
    [
      input.category,
      input.action,
      input.actorId ?? null,
      input.actorRole ?? null,
      input.chamaId ?? null,
      input.entityType ?? null,
      input.entityId ?? null,
      normalizeIp(input.ipAddress),
      input.userAgent?.slice(0, 1024) ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  )).rows[0];
  return row.id;
}

function normalizeIp(ip?: string | null): string | null {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export const auditService = { write: (input: AuditEventInput) => writeAuditEvent(pool, input) };
