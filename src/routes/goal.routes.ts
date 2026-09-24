import { Router } from 'express';
import goalController from '../controllers/goal.controller';
import merchantController from '../controllers/merchant.controller';
import { optionalAuthenticate } from '../middlewares/auth.middleware';

const router = Router();

// Public Phase 1 Mbogi goal catalog.
router.get('/categories', goalController.listGoalCategories);
router.get('/', goalController.listSavingGoals);
router.get('/metrics', goalController.listGoalMarketplaceMetrics);
router.post('/matches', optionalAuthenticate, goalController.matchGoalChamas);
router.get('/:identifier/merchants', optionalAuthenticate, merchantController.listGoalMerchants);
router.get('/:identifier/metrics', goalController.getGoalMarketplaceMetric);
router.get('/:identifier', goalController.getSavingGoal);

export default router;
