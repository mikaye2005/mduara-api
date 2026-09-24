import { z } from 'zod';

export const createChamaMessageSchema = z.object({
  body: z.string().trim().min(1).max(5000),
  parentMessageId: z.string().uuid().optional(),
  kind: z.enum(['message', 'announcement']).default('message'),
}).strict();

export const listChamaMessagesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
});