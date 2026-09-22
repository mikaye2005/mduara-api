import { z } from 'zod';

export const membershipIdSchema = z.string().uuid();
