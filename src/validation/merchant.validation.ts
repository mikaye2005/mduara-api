import { z } from 'zod';

export const merchantListQuerySchema = z.object({
  membership_id: z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : value),
    z.string().uuid().optional(),
  ),
});
