import { Router } from 'express';
import authRoutes from './auth.routes';
import chamaRoutes from './chama.routes';
import loanRoutes from './loan.routes';
import userRoutes from './user.routes';
import goalRoutes from './goal.routes';
import trustRoutes from './trust.routes';
import membershipRoutes from './membership.routes';
import paymentRoutes from './payment.routes';
import mgrRoutes from './mgr.routes';
import subscriptionRoutes from './subscription.routes';
import analyticsRoutes from './analytics.routes';
import adminRoutes from './admin.routes';
import uploadRoutes from './upload.routes';
import { authenticate } from '../middlewares/auth.middleware';
import chamaController from '../controllers/chama.controller';
import notificationController from '../controllers/notification.controller';
import pollController from '../controllers/poll.controller';
import reportController from '../controllers/report.controller';
import supportController from '../controllers/support.controller';
import meetingController from '../controllers/meeting.controller';
import { requireMemberDetailedPdfExportIfRequested } from '../middlewares/subscription.middleware';
import { dynamicRouteGenerator } from '../shared/business-routing';

const router = Router();

router.use('/auth', authRoutes);
router.use('/chamas', chamaRoutes);
router.use('/loans', loanRoutes);
router.get('/users/:id/tickets', authenticate, supportController.listUserTickets);
router.use('/users', userRoutes);
router.use('/goals', goalRoutes);
router.use('/trust', trustRoutes);
router.use('/memberships', membershipRoutes);
router.use('/payments', paymentRoutes);
// BE-09 owns exact tracker paths under /chamas/:id/cycles and /cycles/:id/*.
router.use(mgrRoutes);
router.use('/broadcasts', authenticate, dynamicRouteGenerator.generateRoutes('chama_broadcasts'));
router.use('/subscriptions', subscriptionRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/admin', adminRoutes);
router.use('/uploads', uploadRoutes);
// Dedicated BE-19 support domain. /support/tickets is canonical; /support-tickets is a compatibility alias.
router.post('/support/tickets', authenticate, supportController.createTicket);
router.get('/support/tickets/:ticketId', authenticate, supportController.getTicket);
router.patch('/support/tickets/:ticketId', authenticate, supportController.updateTicket);
router.post('/support-tickets', authenticate, supportController.createTicket);
router.get('/support-tickets/:ticketId', authenticate, supportController.getTicket);
router.patch('/support-tickets/:ticketId', authenticate, supportController.updateTicket);

// Internal service-to-service event dispatch; authenticated with x-mduara-internal-secret.
router.post('/notifications/dispatch', notificationController.dispatchInternal);
router.get('/members/:id/statement', authenticate, requireMemberDetailedPdfExportIfRequested('id'), reportController.getMemberStatement);
router.get('/reports/:jobId', authenticate, reportController.getReportStatus);
router.get('/reports/:jobId/download', authenticate, reportController.downloadReport);
router.post('/meetings/:meetingId/rsvp', authenticate, meetingController.rsvp);
router.post('/meetings/:meetingId/attendance', authenticate, meetingController.recordAttendance);
router.post('/polls/:pollId/vote', authenticate, pollController.vote);
router.post('/polls/:pollId/act', authenticate, pollController.actOutcome);
router.get('/polls/:pollId/results', authenticate, pollController.results);
router.patch('/applications/:applicationId/approve', authenticate, chamaController.approveChamaApplicationById);
router.patch('/applications/:applicationId/reject', authenticate, chamaController.rejectChamaApplicationById);
router.use('/contribution-rules', authenticate, dynamicRouteGenerator.generateRoutes('contribution_rules'));

export default router;
