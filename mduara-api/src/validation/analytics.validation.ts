import { z } from 'zod';

export const chamaAnalyticsQuerySchema = z.object({
  range: z.enum(['1m', '3m', '6m', '1y', 'all']).default('6m'),
}).strict();
