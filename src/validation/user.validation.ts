import { z } from 'zod';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const updateMyProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  nationalId: z.string().trim().min(3).max(64).nullable().optional(),
  dateOfBirth: isoDateSchema.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.dateOfBirth && value.dateOfBirth > new Date().toISOString().slice(0, 10)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dateOfBirth'],
      message: 'dateOfBirth cannot be in the future',
    });
  }
}).refine(
  (value) => Object.values(value).some((item) => item !== undefined),
  { message: 'At least one profile field must be provided' },
);

export type UpdateMyProfileInput = z.infer<typeof updateMyProfileSchema>;
