import { Router } from 'express';
import analyticsController from '../controllers/analytics.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireChamaMembership } from '../middlewares/authorization.middleware';

const router = Router();
const byRouteId = { chamaIdParam: 'id' } as const;

router.get('/chama/:id', authenticate, requireChamaMembership(byRouteId), analyticsController.getChamaAnalytics);

export default router;
