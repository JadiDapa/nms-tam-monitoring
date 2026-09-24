import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';

const durationUnit = z.enum(['seconds', 'minutes', 'hours']);
const UNIT_TO_SEC: Record<z.infer<typeof durationUnit>, number> = { seconds: 1, minutes: 60, hours: 3600 };

const simulateBody = z
  .object({
    deviceIds: z.union([z.literal('all'), z.array(z.uuid()).min(1).max(1000)]),
    startAt: z.coerce.date(),
    durationValue: z.number().int().min(1).max(100_000),
    durationUnit,
    targetAlertCount: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();

/** Admin-only endpoints with no equivalent in the client-facing API. Role gating happens in the calling app. */
export function adminRoutes(app: FastifyInstance, d: ApiDeps): void {
  app.post('/admin/simulate', async (req) => {
    const body = simulateBody.parse(req.body);
    return d.simulation.run({
      deviceIds: body.deviceIds,
      startAt: body.startAt,
      durationSec: body.durationValue * UNIT_TO_SEC[body.durationUnit],
      targetAlertCount: body.targetAlertCount,
    });
  });
}
