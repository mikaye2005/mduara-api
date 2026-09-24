import { Router } from 'express';
import { authenticate } from '../middlewares/auth.middleware';
import { getMyMemberSummary, updateMyProfile } from '../controllers/user.controller';
import notificationController from '../controllers/notification.controller';

const router = Router();

router.patch('/me', authenticate, updateMyProfile);
router.get('/me/summary', authenticate, getMyMemberSummary);

router.get('/me/notifications', authenticate, notificationController.listMyNotifications);
router.patch('/me/notifications/:notificationId', authenticate, notificationController.updateMyNotificationReadState);
router.get('/me/notification-preferences', authenticate, notificationController.getMyNotificationPreferences);
router.patch('/me/notification-preferences', authenticate, notificationController.updateMyNotificationPreferences);

// Tracker-compatible explicit user-id aliases; controller enforces self-only access.
router.get('/:id/notifications', authenticate, notificationController.listMyNotifications);
router.patch('/:id/notifications/:notificationId', authenticate, notificationController.updateMyNotificationReadState);
router.get('/:id/notification-preferences', authenticate, notificationController.getMyNotificationPreferences);
router.patch('/:id/notification-preferences', authenticate, notificationController.updateMyNotificationPreferences);

export default router;
