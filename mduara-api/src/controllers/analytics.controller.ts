import type { NextFunction, Request, Response } from 'express';
import { analyticsService } from '../services/analytics.service';
import { chamaAnalyticsQuerySchema } from '../validation/analytics.validation';

export async function getChamaAnalytics(req: Request, res: Response, next: NextFunction) {
  try {
    const query = chamaAnalyticsQuerySchema.parse(req.query);
    const data = await analyticsService.getChamaAnalytics(req.params.id, query.range);
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export default { getChamaAnalytics };
