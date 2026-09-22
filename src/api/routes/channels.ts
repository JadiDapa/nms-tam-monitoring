import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createChannelSchema, updateChannelSchema } from '../../notifications/channel-service.js';
import type { ApiDeps } from '../deps.js';
import { idList, idParams } from './util.js';

const listQuery = z.object({ ids: idList.optional() });

export function channelRoutes(app: FastifyInstance, d: ApiDeps): void {
  app.post('/channels', async (req, reply) => reply.code(201).send(await d.channels.create(createChannelSchema.parse(req.body))));
  app.get('/channels', async (req) => ({ items: await d.channels.list(listQuery.parse(req.query).ids) }));
  app.get('/channels/:id', async (req) => d.channels.get(idParams.parse(req.params).id));
  app.patch('/channels/:id', async (req) => d.channels.update(idParams.parse(req.params).id, updateChannelSchema.parse(req.body)));
  app.delete('/channels/:id', async (req, reply) => {
    await d.channels.remove(idParams.parse(req.params).id);
    return reply.code(204).send();
  });

  /** Sends a real test message and returns the real outcome (sent / failed / not_implemented). */
  app.post('/channels/:id/test', async (req) => {
    const outcome = await d.notifications.sendTest(idParams.parse(req.params).id);
    return { delivered: outcome.kind === 'sent', outcome };
  });
}
