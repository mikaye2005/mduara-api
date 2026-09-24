import type { NextFunction, Request, Response } from 'express';
import { goalCatalogService } from '../services/goal-catalog.service';
import { goalMarketplaceService } from '../services/goal-marketplace.service';
import { goalMatchingService } from '../services/goal-matching.service';
import { goalIdentifierSchema, goalListQuerySchema, goalMatchRequestSchema } from '../validation/goal.validation';

export async function listGoalCategories(_req: Request, res: Response, next: NextFunction) {
  try {
    const categories = await goalCatalogService.listCategories();
    res.json({ data: categories });
  } catch (error) {
    next(error);
  }
}

export async function listSavingGoals(req: Request, res: Response, next: NextFunction) {
  try {
    const query = goalListQuerySchema.parse({ category_code: req.query.category_code });
    const goals = await goalCatalogService.listGoals(query.category_code);
    res.json({ data: goals });
  } catch (error) {
    next(error);
  }
}

export async function getSavingGoal(req: Request, res: Response, next: NextFunction) {
  try {
    const identifier = goalIdentifierSchema.parse(req.params.identifier);
    const goal = await goalCatalogService.getGoal(identifier);
    res.json({ data: goal });
  } catch (error) {
    next(error);
  }
}

export async function listGoalMarketplaceMetrics(req: Request, res: Response, next: NextFunction) {
  try {
    const query = goalListQuerySchema.parse({ category_code: req.query.category_code });
    const metrics = await goalMarketplaceService.listMetrics(query.category_code);
    res.json({ data: metrics });
  } catch (error) {
    next(error);
  }
}

export async function getGoalMarketplaceMetric(req: Request, res: Response, next: NextFunction) {
  try {
    const identifier = goalIdentifierSchema.parse(req.params.identifier);
    const metric = await goalMarketplaceService.getMetric(identifier);
    res.json({ data: metric });
  } catch (error) {
    next(error);
  }
}


export async function matchGoalChamas(req: Request, res: Response, next: NextFunction) {
  try {
    const input = goalMatchRequestSchema.parse(req.body);
    const result = await goalMatchingService.findMatches({
      ...input,
      userId: req.user?.id,
    });
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}

export default {
  listGoalCategories,
  listSavingGoals,
  listGoalMarketplaceMetrics,
  getGoalMarketplaceMetric,
  matchGoalChamas,
  getSavingGoal,
};
