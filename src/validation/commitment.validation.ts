import { z } from 'zod';

export const membershipIdSchema = z.string().uuid();

export const commitmentPaymentSchema = z.object({ phoneNumber: z.string().trim().min(9).max(20) }).strict();
