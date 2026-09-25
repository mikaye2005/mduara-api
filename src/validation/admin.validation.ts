import { z } from 'zod';

const page = z.coerce.number().int().min(1).default(1);
const perPage = z.coerce.number().int().min(1).max(100).default(25);
const optionalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

export const adminRangeSchema = z.object({
  range: z.enum(['1m', '3m', '6m', '1y', 'all']).default('6m'),
});

export const adminUserListSchema = z.object({
  page,
  per_page: perPage,
  status: z.enum(['pending', 'active', 'suspended', 'deleted']).optional(),
  q: z.string().trim().max(120).optional(),
});

export const adminUserStatusSchema = z.object({
  action: z.enum(['suspend', 'reactivate', 'delete']),
  reason: z.string().trim().min(5).max(500),
}).strict();

export const adminProvisionUserSchema = z.object({
  fullName: z.string().trim().min(2).max(150),
  phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/),
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  temporaryPassword: z.string().trim().min(8).max(72),
}).strict();

export const adminChamaListSchema = z.object({
  page,
  per_page: perPage,
  status: z.enum(['draft', 'recruiting', 'active', 'inactive', 'completed', 'dissolved', 'archived']).optional(),
  q: z.string().trim().max(120).optional(),
});

export const adminPaymentListSchema = z.object({
  page,
  per_page: perPage,
  status: z.enum(['pending', 'confirmed', 'failed', 'reversed']).optional(),
  from: optionalDate,
  to: optionalDate,
  q: z.string().trim().max(120).optional(),
}).refine((v) => !v.from || !v.to || v.to >= v.from, { message: 'to must be on or after from', path: ['to'] });

export const adminCommitmentListSchema = z.object({
  page,
  per_page: perPage,
  state: z.enum(['applied', 'held', 'at_risk', 'default_triggered', 'forfeited', 'partial_forfeit', 'eligible_for_refund', 'refund_requested', 'refunded']).optional(),
  q: z.string().trim().max(120).optional(),
});

export const adminApplicationListSchema = z.object({
  page,
  per_page: perPage,
  status: z.enum(['pending', 'commitment_pending', 'approved', 'rejected', 'withdrawn']).optional(),
  q: z.string().trim().max(120).optional(),
});

export const adminTicketListSchema = z.object({
  page,
  per_page: perPage,
  status: z.enum(['open', 'in_progress', 'escalated', 'resolved', 'closed']).optional(),
  category: z.enum(['payment_issue', 'account_issue', 'refund_issue', 'chama_issue']).optional(),
  q: z.string().trim().max(120).optional(),
});

export const adminAuditListSchema = z.object({
  page,
  per_page: perPage,
  category: z.enum(['security', 'financial', 'moderation', 'system']).optional(),
  action: z.string().trim().max(120).optional(),
  actor_id: z.string().uuid().optional(),
});

export const adminIdParamSchema = z.string().uuid();

export const adminSearchSchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const adminLoanListSchema = z.object({
  page,
  per_page: perPage,
  status: z.enum(['pending', 'awaiting_guarantors', 'pending_admin_approval', 'partially_approved', 'approved', 'disbursement_pending', 'disbursement_failed', 'disbursed', 'active', 'partially_repaid', 'repaid', 'rejected', 'defaulted', 'cancelled']).optional(),
  q: z.string().trim().max(120).optional(),
});

export const adminMembershipSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['member', 'treasurer', 'secretary', 'chairperson']).default('member'),
  membershipStatus: z.enum(['active', 'pending']).default('pending'),
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const adminRoleChangeSchema = z.object({
  role: z.enum(['member', 'treasurer', 'secretary', 'chairperson']),
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const adminTicketUpdateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'escalated', 'resolved', 'closed']).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  resolutionNotes: z.string().trim().min(3).max(5000).nullable().optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'At least one ticket field must be provided',
});

export const adminTicketCommentSchema = z.object({
  body: z.string().trim().min(2).max(5000),
  internal: z.boolean().default(true),
}).strict();

export const adminNotificationListSchema = z.object({
  page,
  per_page: perPage,
  status: z.enum(['pending', 'sent', 'failed', 'cancelled']).optional(),
  channel: z.enum(['in_app', 'sms', 'email', 'push']).optional(),
});

export const adminBroadcastSchema = z.object({
  audience: z.enum(['all_active_users', 'platform_admins', 'chama']),
  chamaId: z.string().uuid().optional(),
  channels: z.array(z.enum(['in_app', 'sms', 'email', 'push'])).min(1).max(4).default(['in_app']),
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(5).max(5000),
  reason: z.string().trim().min(5).max(1000),
}).strict().superRefine((value, ctx) => {
  if (value.audience === 'chama' && !value.chamaId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chamaId'], message: 'chamaId is required for a Chama broadcast' });
  }
  if (value.audience !== 'chama' && value.chamaId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chamaId'], message: 'chamaId is only valid for a Chama broadcast' });
  }
});

export type AdminRange = z.infer<typeof adminRangeSchema>['range'];
