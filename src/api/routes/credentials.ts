import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CREDENTIAL_TYPES } from '../../credentials/schemas.js';
import type { ApiDeps } from '../deps.js';
import { idList, idParams } from './util.js';

const listQuery = z.object({ ids: idList.optional() });
const createBody = z
  .object({ name: z.string().trim().min(1).max(200), type: z.enum(CREDENTIAL_TYPES), secret: z.record(z.string(), z.unknown()) })
  .strict();
const rotateBody = z.object({ secret: z.record(z.string(), z.unknown()) }).strict();

/**
 * Credentials are WRITE-ONLY through the API: secrets go in, only metadata comes out.
 * (There is deliberately no endpoint that returns a secret.)
 */
export function credentialRoutes(app: FastifyInstance, d: ApiDeps): void {
  app.post('/credentials', async (req, reply) => reply.code(201).send(await d.credentials.create(createBody.parse(req.body))));
  app.get('/credentials', async (req) => ({ items: await d.credentials.list(listQuery.parse(req.query).ids) }));
  app.get('/credentials/:id', async (req) => d.credentials.get(idParams.parse(req.params).id));
  app.put('/credentials/:id/secret', async (req) => d.credentials.rotateSecret(idParams.parse(req.params).id, rotateBody.parse(req.body).secret));
  app.delete('/credentials/:id', async (req, reply) => {
    await d.credentials.remove(idParams.parse(req.params).id);
    return reply.code(204).send();
  });
}
