import { Router } from 'express';
import * as mgrController from '../controllers/mgr.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireChamaRoles } from '../middlewares/authorization.middleware';
import { validateBody } from '../middlewares/validation.middleware';
import { asyncHandler } from '../utils/async-handler';
import { createMgrCycleSchema, mgrSwapDecisionSchema, mgrSwapRequestSchema } from '../validation/mgr.validation';

const router = Router();

// Provider callbacks must be declared before the dynamic /cycles/:cycleId routes.
router.post('/cycles/mpesa/b2c/result', asyncHandler(mgrController.mpesaResult));
router.post('/cycles/mpesa/b2c/timeout', asyncHandler(mgrController.mpesaTimeout));

router.post(
  '/chamas/:chamaId/cycles',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'SECRETARY', 'TREASURER']),
  validateBody(createMgrCycleSchema),
  asyncHandler(mgrController.createCycle),
);
router.get('/chamas/:chamaId/cycles/current', authenticate, asyncHandler(mgrController.getCurrentCycle));
router.get('/cycles/:cycleId', authenticate, asyncHandler(mgrController.getCycle));
router.post(
  '/cycles/:cycleId/swap-request',
  authenticate,
  validateBody(mgrSwapRequestSchema),
  asyncHandler(mgrController.requestSwap),
);
router.patch(
  '/cycles/:cycleId/swap-requests/:swapId',
  authenticate,
  validateBody(mgrSwapDecisionSchema),
  asyncHandler(mgrController.decideSwap),
);
router.post('/cycles/:cycleId/disburse', authenticate, asyncHandler(mgrController.disburse));

export default router;
