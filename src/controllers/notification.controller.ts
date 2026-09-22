import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { notificationService } from '../services/notification.service';
import {
  dispatchNotificationSchema,
  notificationFeedQuerySchema,
  notificationIdSchema,
  notificationPreferencesSchema,
  notificationReadStateSchema,
} from '../validation/notification.validation';
import { ForbiddenError, ServiceUnavailableError, UnauthorizedError } from '../utils/errors';

function currentUserId(req: Request): string {
  if (!req.user?.id) throw new UnauthorizedError();
  return req.user.id;
}

function requestedSelf(req: Request): string {
  const current = currentUserId(req);
  const requested = req.params.id === 'me' || !req.params.id ? current : req.params.id;
  if (requested !== current) {
    throw new ForbiddenError('Users may access only their own notifications', 'NOTIFICATION_USER_SCOPE_FORBIDDEN');
  }
  return current;
}

function verifyInternalSecret(req: Request) {
  const configured = env.NOTIFICATION_DISPATCH_SECRET;
  if (!configured) {
    throw new ServiceUnavailableError('Internal notification dispatch is not configured', 'NOTIFICATION_DISPATCH_NOT_CONFIGURED');
  }
  const supplied = req.header('x-mduara-internal-secret') ?? '';
  const left = Buffer.from(configured);
  const right = Buffer.from(supplied);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new UnauthorizedError('Invalid internal notification credential', 'NOTIFICATION_INTERNAL_UNAUTHORIZED');
  }
}

export async function dispatchInternal(req: Request, res: Response, next: NextFunction) {
  try {
    verifyInternalSecret(req);
    const input = dispatchNotificationSchema.parse(req.body);
    const result = await notificationService.dispatch(input);
    res.status(202).json({ data: result });
  } catch (error) { next(error); }
}

export async function listMyNotifications(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = requestedSelf(req);
    const query = notificationFeedQuerySchema.parse(req.query);
    const result = await notificationService.getFeed(userId, {
      page: query.page,
      perPage: query.per_page,
      unreadOnly: query.unread_only,
    });
    res.json({ data: result.notifications, meta: result.meta });
  } catch (error) { next(error); }
}

export async function updateMyNotificationReadState(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = requestedSelf(req);
    const body = notificationReadStateSchema.parse(req.body);
    const notificationId = notificationIdSchema.parse(req.params.notificationId);
    const notification = await notificationService.setReadState(userId, notificationId, body.read);
    res.json({ data: notification });
  } catch (error) { next(error); }
}

export async function getMyNotificationPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await notificationService.getPreferences(requestedSelf(req));
    res.json({ data });
  } catch (error) { next(error); }
}

export async function updateMyNotificationPreferences(req: Request, res: Response, next: NextFunction) {
  try {
    const body = notificationPreferencesSchema.parse(req.body);
    const data = await notificationService.updatePreferences(requestedSelf(req), body);
    res.json({ data });
  } catch (error) { next(error); }
}

export default {
  dispatchInternal,
  listMyNotifications,
  updateMyNotificationReadState,
  getMyNotificationPreferences,
  updateMyNotificationPreferences,
};
