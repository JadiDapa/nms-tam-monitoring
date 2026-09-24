import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../util/errors.js';
import { errorMessage } from '../util/logger.js';
import type { ApiDeps } from './deps.js';
import { adminRoutes } from './routes/admin.js';
import { alertRoutes } from './routes/alerts.js';
import { channelRoutes } from './routes/channels.js';
import { credentialRoutes } from './routes/credentials.js';
import { deviceRoutes } from './routes/devices.js';
import { healthRoutes } from './routes/health.js';
import { incidentRoutes } from './routes/incidents.js';

const PUBLIC_PATHS = new Set(['/health']);

/** 64-bit counters are BigInt internally; JSON has no BigInt, so they are serialised as decimal strings. */
const jsonReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

function apiKeyChecker(keys: string[]) {
  const digests = keys.map((k) => createHash('sha256').update(k).digest());
  return (candidate: string): boolean => {
    const d = createHash('sha256').update(candidate).digest();
    let ok = false;
    // compare against every key (no early exit) and in constant time
    for (const known of digests) if (timingSafeEqual(known, d)) ok = true;
    return ok;
  };
}

function extractKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = headers['x-api-key'];
  return typeof x === 'string' ? x.trim() : null;
}

export async function buildApp(deps: ApiDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
  const log = deps.logger;
  const isAuthorized = apiKeyChecker(deps.config.apiKeys);

  app.setReplySerializer((payload) => JSON.stringify(payload, jsonReplacer));

  // ---- authentication: every route except /health requires an internal API key ----------------------------------
  app.addHook('onRequest', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return;
    const key = extractKey(req.headers);
    if (!key || !isAuthorized(key)) {
      log.warn({ event: 'auth_failed', method: req.method, path: req.url.split('?')[0], ip: req.ip });
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: { code: 'UNAUTHORIZED', message: 'A valid API key is required' } });
    }
  });

  // ---- structured request log (no headers, no bodies, no query values that could hold secrets) -------------------
  app.addHook('onResponse', async (req, reply) => {
    log.info({
      event: 'http_request',
      method: req.method,
      path: req.url.split('?')[0],
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } });
    }
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message } });
    }
    log.error({ event: 'http_error', method: req.method, path: req.url.split('?')[0], error: errorMessage(err) });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));

  await app.register(async (r) => healthRoutes(r, deps));
  await app.register(async (r) => deviceRoutes(r, deps));
  await app.register(async (r) => credentialRoutes(r, deps));
  await app.register(async (r) => channelRoutes(r, deps));
  await app.register(async (r) => alertRoutes(r, deps));
  await app.register(async (r) => incidentRoutes(r, deps));
  await app.register(async (r) => adminRoutes(r, deps));

  return app;
}
