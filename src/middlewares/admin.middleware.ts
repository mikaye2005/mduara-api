import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { writeAuditEvent } from '../services/audit.service';
import { pool } from '../db/client';
import { UnauthorizedError } from '../utils/errors';

/** Every platform-admin endpoint access is itself an auditable security event. */
export function createAdminAccessAudit(db: Pool = pool): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user?.id || !req.user.isPlatformAdmin) throw new UnauthorizedError('Platform administrator authentication is required');
      const path = String(req.originalUrl ?? req.url ?? '').split('?', 1)[0];
      await writeAuditEvent(db, {
        category: 'security',
        action: 'platform_admin_access',
        actorId: req.user.id,
        actorRole: 'platform_admin',
        ipAddress: req.ip,
        userAgent: req.get('user-agent') ?? null,
        payload: {
          method: String(req.method ?? 'GET').toUpperCase(),
          path,
          queryKeys: Object.keys(req.query ?? {}).sort(),
        },
      });
      next();
    } catch (error) { next(error); }
  };
}

export const auditAdminAccess = createAdminAccessAudit();
