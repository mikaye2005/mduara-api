import { z } from 'zod';

export const trustUuidSchema = z.string().uuid();

export const trustHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
