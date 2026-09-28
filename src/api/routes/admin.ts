import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';

const jobParams = z.object({ jobId: z.uuid() });

const WEEKDAYS = z.array(z.number().int().min(0).max(6)).min(1).max(7);
const timeOfDaySec = z.number().int().min(0).max(86_400);

const simulateWindow = z
  .object({
    weekdays: WEEKDAYS,
    dailyStartSec: timeOfDaySec,
    dailyEndSec: timeOfDaySec,
    trafficMinBps: z.number().finite().min(0),
    trafficMaxBps: z.number().finite().min(0),
  })
  .strict();

const simulateBody = z
  .object({
    deviceIds: z.array(z.uuid()).min(1).max(1000),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    windows: z.array(simulateWindow).max(20).default([]),
    defaultTrafficMinBps: z.number().finite().min(0),
    defaultTrafficMaxBps: z.number().finite().min(0),
  })
  .strict();

/** Admin-only endpoints with no equivalent in the client-facing API. Role gating happens in the calling app. */
export function adminRoutes(app: FastifyInstance, d: ApiDeps): void {
  app.post('/admin/simulate', async (req, reply) => {
    const body = simulateBody.parse(req.body);
    reply.code(202);
    return d.simulation.start(body);
  });

  app.get('/admin/simulate/:jobId', async (req) => d.simulation.getJob(jobParams.parse(req.params).jobId));
}
