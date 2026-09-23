import { Router } from 'express';
import * as paymentController from '../controllers/payment.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

router.post('/stk-push', authenticate, paymentController.initiateStkPush);
router.get('/status/:checkoutId', authenticate, paymentController.getPaymentStatus);
router.post('/mpesa/callback', paymentController.mpesaCallback);
// Compatibility alias for the original BE-05 tracker wording.
router.post('/callback', paymentController.mpesaCallback);

export default router;
