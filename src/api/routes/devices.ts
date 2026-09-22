import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { testDeviceSchema, type TestDeviceInput } from '../../devices/device-tester.js';
import { createDeviceSchema, updateDeviceSchema } from '../../devices/schemas.js';
import { AppError, notFound } from '../../util/errors.js';
import type { ApiDeps } from '../deps.js';
import { idAndChildParams, idList, idParams, paging, timeRange } from './util.js';

const listQuery = z.object({ enabled: z.enum(['true', 'false']).optional(), ids: idList.optional(), ...paging });
const fleetQuery = z.object({ ids: idList.optional() });
const ifaceQuery = z.object({ active: z.enum(['true', 'false']).optional() });
/** bucketSec turns the raw history into one aggregated row per time bucket (avg / max), which is what charts need */
const bucketSec = z.coerce.number().int().min(5).max(86400).optional();
const metricsQuery = z.object({ metric: z.string().max(100).optional(), dimension: z.string().max(100).optional(), limit: paging.limit, bucketSec, ...timeRange });
const samplesQuery = z.object({ limit: paging.limit, bucketSec, ...timeRange });
const monitoredBody = z.object({ monitored: z.boolean() }).strict();

export function deviceRoutes(app: FastifyInstance, d: ApiDeps): void {
  // ---- stateless test (nothing is saved) ----------------------------------------------------------------------------
  app.post('/devices/test', async (req) => d.deviceTester.test(testDeviceSchema.parse(req.body)));

  // ---- CRUD ---------------------------------------------------------------------------------------------------------
  app.post('/devices', async (req, reply) => reply.code(201).send(await d.devices.create(createDeviceSchema.parse(req.body))));

  app.get('/devices', async (req) => {
    const q = listQuery.parse(req.query);
    return d.devices.list({ enabled: q.enabled === undefined ? undefined : q.enabled === 'true', ids: q.ids, limit: q.limit, offset: q.offset });
  });

  /** Health + latest headline metrics for many devices in one call (dashboards). */
  app.get('/fleet', async (req) => {
    const items = await d.devices.fleet(fleetQuery.parse(req.query).ids);
    return { items, count: items.length };
  });

  app.get('/devices/:id', async (req) => d.devices.get(idParams.parse(req.params).id));

  app.patch('/devices/:id', async (req) => d.devices.update(idParams.parse(req.params).id, updateDeviceSchema.parse(req.body)));

  app.delete('/devices/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    await d.devices.remove(id);
    d.polls.forgetDevice(id);
    return reply.code(204).send();
  });

  // ---- live state ---------------------------------------------------------------------------------------------------
  app.get('/devices/:id/status', async (req) => d.devices.status(idParams.parse(req.params).id));

  /** Test an EXISTING device with its stored configuration. Read-only: no state, metrics or incidents are written. */
  app.post('/devices/:id/test', async (req) => {
    const { id } = idParams.parse(req.params);
    const dev = await d.devices.get(id);
    const input: TestDeviceInput = {
      host: dev.host,
      icmp: dev.icmpEnabled,
      icmpCount: dev.polling.icmpCount,
      tcpPorts: dev.tcpPorts,
      snmp: dev.snmpEnabled && dev.snmpCredentialId ? { credentialId: dev.snmpCredentialId, port: dev.snmpPort } : undefined,
      timeoutMs: dev.polling.timeoutMs,
      retries: dev.polling.retryCount,
    };
    return d.deviceTester.test(input);
  });

  /** Poll now and persist the result exactly like a scheduled poll. Shares an in-flight poll if one is running. */
  app.post('/devices/:id/poll', async (req) => {
    const { id } = idParams.parse(req.params);
    await d.devices.ensureExists(id);
    const summary = await d.runPollNow(id);
    if (summary.error) throw new AppError('POLL_FAILED', `Poll could not be completed: ${summary.error}`, 502);
    const report = d.polls.lastReport(id);
    if (!report) throw new AppError('POLL_FAILED', 'Poll finished but produced no report', 502);
    return report;
  });

  // ---- history ------------------------------------------------------------------------------------------------------
  app.get('/devices/:id/metrics', async (req) => {
    const { id } = idParams.parse(req.params);
    await d.devices.ensureExists(id);
    const { bucketSec: bucket, ...q } = metricsQuery.parse(req.query);
    if (bucket) {
      const items = await d.metrics.queryDeviceMetricBuckets({ deviceId: id, bucketSec: bucket, ...q });
      return { items, count: items.length, bucketSec: bucket };
    }
    const items = await d.metrics.queryDeviceMetrics({ deviceId: id, ...q });
    return { items, count: items.length };
  });

  app.get('/devices/:id/interfaces', async (req) => {
    const { id } = idParams.parse(req.params);
    await d.devices.ensureExists(id);
    const { active } = ifaceQuery.parse(req.query);
    const [all, latest] = await Promise.all([d.interfaces.listForDevice(d.db, id), d.metrics.latestInterfaceSamples(id)]);
    const inventory = active === undefined ? all : all.filter((i) => i.active === (active === 'true'));
    const byId = new Map(latest.map((s) => [s.interfaceId, s]));
    const items = inventory.map((i) => {
      const s = byId.get(i.id) ?? null;
      return {
        id: i.id,
        ifIndex: i.ifIndex,
        name: i.name,
        alias: i.alias,
        type: i.ifTypeName,
        speedBps: i.speedBps,
        adminStatus: i.adminStatus,
        operStatus: i.operStatus,
        monitored: i.monitored,
        /** ACTIVE = present in the latest complete walk; inactive interfaces keep their history */
        active: i.active,
        inactiveSince: i.inactiveSince,
        /** null = never observed operationally up (unused port); interface-down alerts require it to be set */
        lastOperUpAt: i.lastOperUpAt,
        lastSeenAt: i.lastSeenAt,
        latest: s && {
          time: s.time,
          inOctets: s.inOctets,
          outOctets: s.outOctets,
          inErrors: s.inErrors,
          outErrors: s.outErrors,
          inDiscards: s.inDiscards,
          outDiscards: s.outDiscards,
          inBps: s.inBps,
          outBps: s.outBps,
          rateNote: s.rateNote,
          counterBits: s.counterBits,
        },
      };
    });
    return { items, count: items.length };
  });

  app.get('/devices/:id/interfaces/:childId/metrics', async (req) => {
    const { id, childId } = idAndChildParams.parse(req.params);
    await d.devices.ensureExists(id);
    const { bucketSec: bucket, ...q } = samplesQuery.parse(req.query);
    if (bucket) {
      const items = await d.metrics.queryInterfaceBuckets({ deviceId: id, interfaceId: childId, bucketSec: bucket, ...q });
      return { items, count: items.length, bucketSec: bucket };
    }
    const items = await d.metrics.queryInterfaceSamples({ deviceId: id, interfaceId: childId, ...q });
    return { items, count: items.length };
  });

  app.patch('/devices/:id/interfaces/:childId', async (req) => {
    const { id, childId } = idAndChildParams.parse(req.params);
    const { monitored } = monitoredBody.parse(req.body);
    const ok = await d.interfaces.setMonitored(d.db, id, childId, monitored);
    if (!ok) throw notFound('Interface', childId);
    return { id: childId, monitored };
  });
}
