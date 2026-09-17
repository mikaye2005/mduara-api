import type { NextFunction, Request, Response } from 'express';
import { trustScoreService } from '../services/trust-score.service';
import { trustHistoryQuerySchema, trustUuidSchema } from '../validation/trust.validation';

export async function getPublicChamaTrust(req: Request, res: Response, next: NextFunction) {
  try {
    const chamaId = trustUuidSchema.parse(req.params.chamaId);
    const trust = await trustScoreService.getPublicChamaTrust(chamaId);
    res.json({ data: trust });
  } catch (error) {
    next(error);
  }
}

export async function getOwnMembershipTrust(req: Request, res: Response, next: NextFunction) {
  try {
    const membershipId = trustUuidSchema.parse(req.params.membershipId);
    const trust = await trustScoreService.getOwnMembershipTrust(membershipId, req.user!.id);
    res.json({ data: trust });
  } catch (error) {
    next(error);
  }
}

export async function getOwnMembershipTrustHistory(req: Request, res: Response, next: NextFunction) {
  try {
    const membershipId = trustUuidSchema.parse(req.params.membershipId);
    const query = trustHistoryQuerySchema.parse({ limit: req.query.limit });
    const history = await trustScoreService.getOwnMembershipHistory(membershipId, req.user!.id, query.limit);
    res.json({ data: history });
  } catch (error) {
    next(error);
  }
}

export default { getPublicChamaTrust, getOwnMembershipTrust, getOwnMembershipTrustHistory };
