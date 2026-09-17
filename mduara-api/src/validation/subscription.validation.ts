import { z } from 'zod';

export const subscriptionPaymentSchema = z.object({
  chamaId: z.string().uuid(),
  planCode: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  phoneNumber: z.string().trim().min(9).max(20),
}).strict();

export type SubscriptionPaymentInput = z.infer<typeof subscriptionPaymentSchema>;
