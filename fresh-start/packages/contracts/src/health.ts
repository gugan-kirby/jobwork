import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('api'),
  version: z.string(),
  time: z.iso.datetime(),
  db: z.enum(['ok', 'fail']),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
