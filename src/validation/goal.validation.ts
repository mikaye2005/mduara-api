import { z } from 'zod';

const catalogCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]*$/, 'Invalid goal/category code');

export const goalListQuerySchema = z.object({
  category_code: catalogCode.optional(),
});

export const goalIdentifierSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_-]+$/, 'Invalid goal identifier');


const uuid = z.string().uuid();

export const goalMatchRequestSchema = z
  .object({
    savingGoalId: uuid.optional(),
    goalCode: catalogCode.optional(),
    targetAmount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contributionCapacity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    contributionFrequency: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(40)
      .regex(/^[a-z][a-z0-9_-]*$/, 'Invalid contribution frequency'),
    durationMonths: z.number().int().min(1).max(120),
    location: z.string().trim().min(2).max(120).optional(),
    preferredVisibility: z.enum(['public', 'application']).optional(),
    invitationId: uuid.optional(),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .superRefine((value, ctx) => {
    if (!value.savingGoalId && !value.goalCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'savingGoalId or goalCode is required',
        path: ['goalCode'],
      });
    }
  });
