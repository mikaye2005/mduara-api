import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller';
import { authenticate } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validation.middleware';
import { asyncHandler } from '../utils/async-handler';
import { subscriptionPaymentSchema } from '../validation/subscription.validation';

const router = Router();

// Provider callback is intentionally public but cryptographically/source verified in the controller.
router.post('/mpesa/callback', asyncHandler(subscriptionController.mpesaCallback));
router.get('/plans', asyncHandler(subscriptionController.listPlans));
router.post('/pay', authenticate, validateBody(subscriptionPaymentSchema), asyncHandler(subscriptionController.pay));
router.get('/payments/:checkoutId', authenticate, asyncHandler(subscriptionController.paymentStatus));
router.get('/chamas/:chamaId', authenticate, asyncHandler(subscriptionController.getChamaSubscription));

export default router;
