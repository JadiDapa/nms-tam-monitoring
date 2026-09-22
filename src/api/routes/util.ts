import { z } from 'zod';

export const idParams = z.object({ id: z.uuid() });
export const idAndChildParams = z.object({ id: z.uuid(), childId: z.uuid() });

/**
 * Optional "?ids=a,b,c" filter used by list endpoints so a caller that owns a subset of objects (the web app, per client)
 * can ask for exactly those. Absent = no filter. Present but empty = matches nothing (never "everything").
 */
export const idList = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(z.uuid()).max(1000));

export const paging = {
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
};

export const timeRange = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  order: z.enum(['asc', 'desc']).optional(),
};
