import type { NextFunction, Request, Response } from 'express';
import { chamaContributionService } from '../services/chama-contribution.service';
import { chamaContributionLedgerQuerySchema } from '../validation/chama-contribution.validation';

export async function listChamaContributions(req: Request, res: Response, next: NextFunction) {
  try {
    const query = chamaContributionLedgerQuerySchema.parse(req.query);
    const result = await chamaContributionService.list({
      chamaId: req.params.id,
      period: query.period,
      page: query.page,
      perPage: query.per_page,
    });
    res.json({ data: result.contributions, meta: result.meta });
  } catch (error) { next(error); }
}

export default { listChamaContributions };