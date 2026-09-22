import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { summarizeDeliveries } from '../../notifications/notification-service.js';
import type { ApiDeps } from '../deps.js';
import { idList, idParams, paging } from './util.js';

const listQuery = z.object({
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ACTIVE']).optional(),
  deviceId: z.uuid().optional(),
  deviceIds: idList.optional(),
  ruleId: z.uuid().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  ...paging,
});
const ackBody = z.object({ by: z.string().trim().min(1).max(200).optional() }).strict().default({});

export function incidentRoutes(app: FastifyInstance, d: ApiDeps): void {
  app.get('/incidents', async (req) => d.incidents.list(listQuery.parse(req.query)));

  app.get('/incidents/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const [incident, deliveries] = await Promise.all([d.incidents.get(id), d.notifications.listForIncident(id)]);
    // notifications = every attempt (audit trail); deliverySummary = one row per channel/event with its current phase
    return { incident, notifications: deliveries, deliverySummary: summarizeDeliveries(deliveries) };
  });

  app.post('/incidents/:id/acknowledge', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = ackBody.parse(req.body ?? {});
    return d.incidents.acknowledge(id, body.by ?? null);
  });
}
