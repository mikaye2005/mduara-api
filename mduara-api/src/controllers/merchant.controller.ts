import type { NextFunction, Request, Response } from 'express';
import { goalIdentifierSchema } from '../validation/goal.validation';
import { merchantListQuerySchema } from '../validation/merchant.validation';
import { merchantRewardService } from '../services/merchant-reward.service';

export async function listGoalMerchants(req: Request, res: Response, next: NextFunction) {
  try {
    const identifier = goalIdentifierSchema.parse(req.params.identifier);
    const query = merchantListQuerySchema.parse({ membership_id: req.query.membership_id });
    const data = await merchantRewardService.listGoalMerchants(identifier, {
      membershipId: query.membership_id,
      userId: req.user?.id,
    });
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export default { listGoalMerchants };
