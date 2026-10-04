import type { ZodType } from 'zod';
import { ValidationFailed } from './domain-error';

/** Edge validation (ES-10): parse or throw problem-details with safe field paths (doc 08 §3). */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationFailed(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
