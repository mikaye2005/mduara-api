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
router.get('/revenue', adminController.revenue);
router.get('/users', adminController.listUsers);
router.patch('/users/:userId/status', adminController.moderateUser);
router.get('/chamas', adminController.listChamas);
router.get('/payments', adminController.listPayments);
router.get('/refunds', adminController.listRefunds);
router.get('/defaults', adminController.listDefaults);
router.get('/applications', adminController.listApplications);
router.get('/tickets', adminController.listTickets);
router.get('/complaints', adminController.listTickets);
router.get('/suspicious-activity', adminController.suspiciousActivity);
router.get('/system-health', adminController.systemHealth);
router.get('/audit-logs', adminController.auditLogs);

export default router;
