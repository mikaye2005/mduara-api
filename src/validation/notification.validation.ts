import { z } from 'zod';

export const notificationTemplateSchema = z.enum([
  'contribution_due',
  'contribution_received',
  'chama_almost_full',
  'application_approved',
  'missed_contribution',
  'commitment_refund_ready',
  'goal_completed',
  'constitution_amended',
  'meeting_reminder',
]);

export const notificationChannelSchema = z.enum(['in_app', 'sms', 'email', 'push']);

export const dispatchNotificationSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(100),
  template: notificationTemplateSchema,
  chamaId: z.string().uuid().nullable().optional(),
  channels: z.array(notificationChannelSchema).min(1).max(4).optional(),
  data: z.record(z.unknown()).refine((value) => JSON.stringify(value).length <= 16_384, 'Notification data payload is too large').optional(),
  dedupeKey: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();

export const notificationFeedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  unread_only: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
});

export const notificationIdSchema = z.string().uuid();

export const notificationReadStateSchema = z.object({ read: z.boolean() }).strict();

export const notificationPreferencesSchema = z.object({
  inAppEnabled: z.boolean().optional(),
  smsEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
}).strict().refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  { message: 'At least one notification preference must be provided' },
);
