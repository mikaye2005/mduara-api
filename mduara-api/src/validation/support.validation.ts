import { z } from 'zod';

export const supportCategorySchema = z.enum(['payment_issue', 'account_issue', 'refund_issue', 'chama_issue']);
export const supportStatusSchema = z.enum(['open', 'in_progress', 'escalated', 'resolved', 'closed']);

export const createSupportTicketSchema = z.object({
  category: supportCategorySchema,
  subject: z.string().trim().min(3).max(160),
  message: z.string().trim().min(5).max(5000),
  chamaId: z.string().uuid().optional(),
  paymentReference: z.string().trim().min(3).max(200).optional(),
  commitmentDepositId: z.string().uuid().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.category === 'payment_issue' && !value.paymentReference) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['paymentReference'], message: 'paymentReference is required for payment_issue' });
  }
  if (value.category === 'refund_issue' && !value.commitmentDepositId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['commitmentDepositId'], message: 'commitmentDepositId is required for refund_issue' });
  }
  if (value.category === 'chama_issue' && !value.chamaId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chamaId'], message: 'chamaId is required for chama_issue' });
  }
});

export const updateSupportTicketSchema = z.object({
  status: supportStatusSchema.optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  resolutionNotes: z.string().trim().min(3).max(5000).nullable().optional(),
}).strict().refine((value) => Object.values(value).some((item) => item !== undefined), {
  message: 'At least one support-ticket field must be provided',
});

export const supportTicketListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
  status: supportStatusSchema.optional(),
  category: supportCategorySchema.optional(),
});

export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>;
export type UpdateSupportTicketInput = z.infer<typeof updateSupportTicketSchema>;
