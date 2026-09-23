import { z } from 'zod';

const dateOnly = /^\d{4}-\d{2}-\d{2}$/;

export const createMgrCycleSchema = z.object({
  mode: z.enum(['manual', 'randomized', 'bidding']),
  payoutAmount: z.coerce.bigint().positive(),
  firstPayoutDate: z.string().regex(dateOnly, 'firstPayoutDate must be YYYY-MM-DD'),
  intervalDays: z.coerce.number().int().min(1).max(3650),
  memberOrder: z.array(z.string().uuid()).min(2).optional(),
}).superRefine((value, ctx) => {
  if (value.mode === 'manual' && !value.memberOrder) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memberOrder'], message: 'memberOrder is required for manual queue generation' });
  }
  if (value.memberOrder && new Set(value.memberOrder).size !== value.memberOrder.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['memberOrder'], message: 'memberOrder cannot contain duplicate memberships' });
  }
});

export const mgrSwapRequestSchema = z.object({
  targetMemberId: z.string().uuid(),
});

export const mgrSwapDecisionSchema = z.object({
  decision: z.enum(['accept', 'reject', 'cancel']),
});

export type CreateMgrCycleInput = z.infer<typeof createMgrCycleSchema>;
export type MgrSwapRequestInput = z.infer<typeof mgrSwapRequestSchema>;
export type MgrSwapDecisionInput = z.infer<typeof mgrSwapDecisionSchema>;
