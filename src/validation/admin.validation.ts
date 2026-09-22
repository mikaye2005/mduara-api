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

export type AdminRange = z.infer<typeof adminRangeSchema>['range'];
