import type { RequestHandler } from 'express';
import { pool } from '../db/client';
import { assertSubscriptionFeature, assertSubscriptionWriteAccess, type SubscriptionFeature } from '../services/subscription.service';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors';

export function requireSubscriptionWriteAccess(chamaIdParam = 'chamaId'): RequestHandler {
  return async (req, _res, next) => {
    try {
      const chamaId = req.params?.[chamaIdParam];
      if (!chamaId) throw new Error(`Missing Chama route parameter: ${chamaIdParam}`);
      await assertSubscriptionWriteAccess(pool, chamaId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireSubscriptionFeature(feature: SubscriptionFeature, chamaIdParam = 'chamaId'): RequestHandler {
  return async (req, _res, next) => {
    try {
      const chamaId = req.params?.[chamaIdParam];
      if (!chamaId) throw new Error(`Missing Chama route parameter: ${chamaIdParam}`);
      await assertSubscriptionFeature(pool, chamaId, feature);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * BE-18 conditional gate. It only runs for format=pdf and is intentionally
 * placed after Chama RBAC middleware so subscription state cannot be used as
 * an authorization side channel.
 */
export function requireDetailedPdfExportIfRequested(chamaIdParam = 'id'): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (req.query.format !== 'pdf') { next(); return; }
      const chamaId = req.params?.[chamaIdParam];
      if (!chamaId) throw new NotFoundError('Chama route parameter is missing', 'CHAMA_NOT_FOUND');
      await assertSubscriptionFeature(pool, chamaId, 'detailed_pdf_export');
      next();
    } catch (error) { next(error); }
  };
}

/**
 * Member-statement PDF gate includes the same owner/leadership authorization
 * that the report service repeats. This prevents leaking a Chama's subscription
 * tier to callers who only know another member's membership UUID.
 */
export function requireMemberDetailedPdfExportIfRequested(membershipIdParam = 'id'): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (req.query.format !== 'pdf') { next(); return; }
      if (!req.user?.id) throw new UnauthorizedError();
      const membershipId = req.params?.[membershipIdParam];
      if (!membershipId) throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');

      const membership = (await pool.query<{ chama_id: string; user_id: string }>(
        `SELECT chama_id, user_id FROM chama_members WHERE id = $1`, [membershipId],
      )).rows[0];
      if (!membership) throw new NotFoundError('Membership not found', 'MEMBERSHIP_NOT_FOUND');

      if (membership.user_id !== req.user.id) {
        const leadership = await pool.query(
          `SELECT 1 FROM chama_members
            WHERE chama_id = $1 AND user_id = $2 AND membership_status = 'active'
              AND role IN ('chairperson','treasurer','secretary')`,
          [membership.chama_id, req.user.id],
        );
        if (!leadership.rowCount) {
          throw new ForbiddenError('Member statement access denied', 'REPORT_MEMBER_STATEMENT_FORBIDDEN');
        }
      }

      await assertSubscriptionFeature(pool, membership.chama_id, 'detailed_pdf_export');
      next();
    } catch (error) { next(error); }
  };
}
