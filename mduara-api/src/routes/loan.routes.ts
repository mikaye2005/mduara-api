import { Router } from 'express';
import * as loanController from '../controllers/loan.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { requireChamaMembership, requireChamaRoles } from '../middlewares/authorization.middleware';
import { validateBody } from '../middlewares/validation.middleware';
import { asyncHandler } from '../utils/async-handler';
import {
  applyLoanSchema,
  nominateGuarantorSchema,
  rejectLoanSchema,
  repayLoanSchema,
  upsertLoanRuleSchema,
} from '../validation/loan.validation';

const router = Router();

router.get(
  '/chamas/:chamaId/rules',
  authenticate,
  requireChamaMembership(),
  asyncHandler(loanController.getLoanRule),
);
router.put(
  '/chamas/:chamaId/rules',
  authenticate,
  requireChamaRoles(['CHAIRPERSON', 'TREASURER']),
  validateBody(upsertLoanRuleSchema),
  asyncHandler(loanController.upsertLoanRule),
);

// Provider callbacks are verified in the controller and intentionally do not use member JWT auth.
router.post('/mpesa/b2c/result', asyncHandler(loanController.mpesaDisbursementResult));
router.post('/mpesa/b2c/timeout', asyncHandler(loanController.mpesaDisbursementTimeout));

router.post('/apply', authenticate, validateBody(applyLoanSchema), asyncHandler(loanController.apply));
router.post('/:id/guarantors', authenticate, validateBody(nominateGuarantorSchema), asyncHandler(loanController.approveGuarantor));
router.patch('/:id/approve', authenticate, asyncHandler(loanController.approve));
router.patch('/:id/reject', authenticate, validateBody(rejectLoanSchema), asyncHandler(loanController.reject));
router.post('/:id/repay', authenticate, validateBody(repayLoanSchema), asyncHandler(loanController.repay));

export default router;
