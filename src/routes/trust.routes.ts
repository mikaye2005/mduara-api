import { Router } from 'express';
import trustController from '../controllers/trust.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

// Public Chama trust exposes only aggregate/sanitized factors.
router.get('/chamas/:chamaId', trustController.getPublicChamaTrust);

// Member trust and history are private to the authenticated membership owner.
router.get('/memberships/:membershipId/history', authenticate, trustController.getOwnMembershipTrustHistory);
router.get('/memberships/:membershipId', authenticate, trustController.getOwnMembershipTrust);

export default router;
