import { z } from 'zod';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const reportQuerySchema = z.object({
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  format: z.enum(['json', 'pdf', 'excel']).default('json'),
}).superRefine((value, ctx) => {
  if (value.from && value.to && value.to < value.from) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'to cannot precede from' });
  }
});

export const reportJobIdSchema = z.string().uuid();

export type ReportQuery = z.infer<typeof reportQuerySchema>;
