import type { z } from 'zod';
import { AppError } from './errors';

export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
      .join('; ');
    throw new AppError(400, 'VALIDATION_ERROR', details);
  }
  return result.data;
}
