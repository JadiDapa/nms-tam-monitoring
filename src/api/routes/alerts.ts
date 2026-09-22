import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createRuleSchema, updateRuleSchema } from '../../alerts/rules.js';
import type { ApiDeps } from '../deps.js';
import { idList, idParams } from './util.js';

const listQuery = z.object({ ids: idList.optional() });

/**
 * "Alerts" are alert RULE definitions (what to watch, threshold, severity, channels).
 * What fires from a rule is an INCIDENT (see /incidents).
 */
export function alertRoutes(app: FastifyInstance, d: ApiDeps): void {
  app.get('/alerts', async (req) => ({ items: await d.rules.list(listQuery.parse(req.query).ids) }));
  app.post('/alerts', async (req, reply) => reply.code(201).send(await d.rules.create(createRuleSchema.parse(req.body))));
  app.get('/alerts/:id', async (req) => d.rules.get(idParams.parse(req.params).id));
  app.patch('/alerts/:id', async (req) => d.rules.update(idParams.parse(req.params).id, updateRuleSchema.parse(req.body)));
  app.delete('/alerts/:id', async (req, reply) => {
    await d.rules.remove(idParams.parse(req.params).id);
    return reply.code(204).send();
  });
}
