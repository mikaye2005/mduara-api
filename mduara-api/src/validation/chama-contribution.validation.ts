import { z } from 'zod';

export const chamaContributionLedgerQuerySchema = z.object({
  period: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
});