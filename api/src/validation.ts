import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest('Request validation failed', z.treeifyError(result.error));
  }
  return result.data;
}

export const uuid = z.uuid();
export const password = z.string().min(12, 'Password must be at least 12 characters').max(1024);
export const idParams = z.object({ id: z.uuid() });

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function page<T>(rows: T[], limit: number, offset: number) {
  return { items: rows, limit, offset, nextOffset: rows.length === limit ? offset + limit : null };
}
