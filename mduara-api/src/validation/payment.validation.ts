import { z } from 'zod';

export const stkPushSchema = z.object({
  contributionId: z.string().uuid(),
  amount: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform((value) => String(value)),
  phoneNumber: z.string().trim().min(9).max(20),
});

export const checkoutIdSchema = z.string().trim().min(5).max(200);
