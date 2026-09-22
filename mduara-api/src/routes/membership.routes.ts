import { Router } from 'express';
import membershipController from '../controllers/membership.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

// All membership financial views are owner-scoped inside the service.
router.get('/:id/contributions', authenticate, membershipController.getOwnContributions);
router.get('/:id/commitment', authenticate, membershipController.getOwnCommitment);
router.post('/:id/accept-constitution', authenticate, membershipController.acceptConstitution);
// Client requests eligibility/intent only. Provider confirmation remains the
// sole authority that moves money and finalizes a refund.
router.post('/:id/commitment/refund-request', authenticate, membershipController.requestCommitmentRefund);
router.post('/:id/commitment/pay', authenticate, membershipController.initiateCommitmentPayment);
router.post('/commitment/mpesa/callback', membershipController.commitmentMpesaCallback);

export default router;
