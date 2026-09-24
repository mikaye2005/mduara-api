import { z } from 'zod';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const publicChamaListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(50).default(20),
  goal_code: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['recruiting', 'active', 'completed']).optional(),
  visibility: z.enum(['public', 'application']).optional(),
  type: z.enum(['goal_based', 'table_banking', 'merry_go_round', 'welfare', 'investment']).optional(),
  location: z.string().trim().min(1).max(120).optional(),
  min_contribution: z.coerce.number().int().min(0).optional(),
  max_contribution: z.coerce.number().int().min(0).optional(),
  min_duration_months: z.coerce.number().int().min(1).max(120).optional(),
  max_duration_months: z.coerce.number().int().min(1).max(120).optional(),
  has_capacity: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  min_available_spots: z.coerce.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
  if (value.min_contribution !== undefined && value.max_contribution !== undefined && value.min_contribution > value.max_contribution) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['min_contribution'], message: 'min_contribution cannot exceed max_contribution' });
  }
  if (value.min_duration_months !== undefined && value.max_duration_months !== undefined && value.min_duration_months > value.max_duration_months) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['min_duration_months'], message: 'min_duration_months cannot exceed max_duration_months' });
  }
});

export const publicChamaApplySchema = z.object({
  message: z.string().trim().max(1000).optional(),
  constitution_rule_id: z.string().uuid(),
  accept_constitution: z.boolean(),
  invitation_id: z.string().uuid().optional(),
});

export const chamaCycleFieldsSchema = z.object({
  visibility: z.enum(['public', 'application', 'private']).optional(),
  goal_code: z.string().trim().min(1).max(100).optional().nullable(),
  location: z.string().trim().min(1).max(120).optional().nullable(),
  target_members: z.coerce.number().int().min(2).optional().nullable(),
  recruitment_deadline: dateSchema.optional().nullable(),
  saving_start_date: dateSchema.optional().nullable(),
  saving_end_date: dateSchema.optional().nullable(),
  purchase_window_start: dateSchema.optional().nullable(),
  purchase_window_end: dateSchema.optional().nullable(),
});
