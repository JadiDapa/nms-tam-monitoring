import type { FastifyInstance } from 'fastify';
import type { ApiDeps } from '../deps.js';

export function healthRoutes(app: FastifyInstance, d: ApiDeps): void {
  /**
   * Public (used by process managers / load balancers). Exposes no device or customer data.
   * 200 = engine healthy, 503 = database unreachable.
   */
  app.get('/health', async (_req, reply) => {
    let dbOk = true;
    try {
      await d.db.query('select 1');
    } catch {
      dbOk = false;
    }
    const body = {
      status: dbOk ? 'ok' : 'degraded',
      version: d.version,
      uptimeSec: Math.round((Date.now() - d.startedAt) / 1000),
      database: dbOk ? 'ok' : 'unreachable',
      scheduler: d.scheduler ? d.scheduler.stats() : 'disabled',
    };
    return reply.code(dbOk ? 200 : 503).send(body);
  });
}
