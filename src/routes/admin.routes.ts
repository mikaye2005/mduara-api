import { Router } from 'express';
import adminController from '../controllers/admin.controller';
import { requireRoles } from '../middlewares/authorization.middleware';
import { auditAdminAccess } from '../middlewares/admin.middleware';

const router = Router();

// app.ts already guards /api/v1/admin globally. Keep defense in depth here so
// this router remains safe if it is ever mounted elsewhere.
router.use(requireRoles(['SUPER_ADMIN']));
router.use(auditAdminAccess);

router.get('/overview', adminController.overview);
router.get('/dashboard', adminController.dashboard);
router.get('/command-center', adminController.commandCenter);
router.get('/revenue', adminController.revenue);
router.get('/search', adminController.search);
router.get('/users', adminController.listUsers);
router.post('/users', adminController.createUser);
router.get('/users/:userId', adminController.getUser);
router.patch('/users/:userId', adminController.updateUserProfile);
router.delete('/users/:userId/sessions', adminController.revokeUserSessions);
router.delete('/users/:userId/sessions/:sessionId', adminController.revokeUserSessions);
router.patch('/users/:userId/status', adminController.moderateUser);
router.get('/chamas', adminController.listChamas);
// Purpose-built detail payload for the Chama Management workspace. This must
// precede /:chamaId so it is never interpreted as an identifier.
router.get('/chamas/:chamaId/management', adminController.managementWorkspace);
router.get('/chamas/:chamaId', adminController.getChama);
router.patch('/chamas/:chamaId/status', adminController.moderateChama);
router.post('/chamas/:chamaId/members', adminController.addMembership);
router.patch('/chamas/:chamaId/members/:userId/role', adminController.changeRole);
router.post('/chamas/:chamaId/leadership-messages', adminController.contactChamaLeadership);
router.get('/payments', adminController.listPayments);
router.get('/payments/:paymentId', adminController.getPayment);
router.get('/refunds', adminController.listRefunds);
router.get('/defaults', adminController.listDefaults);
router.get('/applications', adminController.listApplications);
router.get('/loans', adminController.listLoans);
router.get('/tickets', adminController.listTickets);
router.get('/complaints', adminController.listTickets);
router.get('/tickets/:ticketId', adminController.getTicket);
router.patch('/tickets/:ticketId', adminController.updateTicket);
router.post('/tickets/:ticketId/comments', adminController.addTicketComment);
router.get('/notifications', adminController.listNotifications);
router.post('/broadcasts', adminController.broadcast);
router.get('/administrators', adminController.listAdministrators);
router.get('/suspicious-activity', adminController.suspiciousActivity);
router.get('/system-health', adminController.systemHealth);
router.get('/reconciliation', adminController.listReconciliation);
router.get('/audit-logs', adminController.auditLogs);

export default router;
