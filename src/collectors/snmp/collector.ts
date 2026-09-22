import { errorReading, unavailableReading, type Reading } from '../types.js';
import { SnmpClient, SnmpError, mapSnmpError } from './client.js';
import { toNum, toStr } from './codec.js';
import { collectInterfaces } from './interfaces.js';
import { OID } from './oids.js';
import { defaultProfileRegistry, type ProfileRegistry } from './profiles/registry.js';
import type {
  SnmpInterfacesResult,
  SnmpOptions,
  SnmpPollResult,
  SnmpProbe,
  SnmpSystemInfo,
  SnmpTarget,
  SnmpTimings,
} from './types.js';

const readingFrom = (err: SnmpError): Reading => ({
  status: err.status,
  value: null,
  error: err.message,
});

const interfacesFrom = (err: SnmpError): SnmpInterfacesResult => ({ status: err.status, error: err.message, rows: [] });

async function readSystem(client: SnmpClient): Promise<SnmpSystemInfo> {
  const [descr, objectId, uptime, name] = await client.get([OID.sysDescr, OID.sysObjectID, OID.sysUpTime, OID.sysName]);
  return {
    sysDescr: toStr(descr?.value),
    sysObjectId: toStr(objectId?.value),
    uptimeTicks: toNum(uptime?.value),
    sysName: toStr(name?.value),
  };
}

const NO_TIMINGS: SnmpTimings = { systemMs: null, cpuMs: null, memoryMs: null, interfacesMs: null };

export class SnmpCollector implements SnmpProbe {
  constructor(
    private readonly registry: ProfileRegistry = defaultProfileRegistry,
    private readonly openClient: (t: SnmpTarget, o: SnmpOptions) => SnmpClient = SnmpClient.open,
  ) {}

  async poll(target: SnmpTarget, opts: SnmpOptions): Promise<SnmpPollResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const client = this.openClient(target, opts);
    const stats = () => ({ retransmits: client.stats.retransmits, timeouts: client.stats.timeouts });
    const timings: SnmpTimings = { ...NO_TIMINGS };

    try {
      // 1. Is there an agent, and who is it? Every later step depends on this.
      let system: SnmpSystemInfo;
      try {
        system = await readSystem(client);
        timings.systemMs = elapsed();
      } catch (err) {
        const e = mapSnmpError(err);
        timings.systemMs = elapsed();
        return {
          status: e.status === 'unavailable' ? 'unavailable' : 'error',
          error: e.message,
          responseMs: null,
          durationMs: elapsed(),
          system: null,
          profileId: null,
          cpu: readingFrom(e),
          memory: readingFrom(e),
          interfaces: interfacesFrom(e),
          timings,
          ...stats(),
        };
      }
      const responseMs = elapsed();
      const profile = this.registry.resolve(system);

      // 2. Independent metric groups. After the first timeout the agent has stopped answering: skip the rest
      //    instead of stacking more timeouts.
      let stalled: SnmpError | null = null;
      const skip = () => new SnmpError('timeout', 'Skipped: SNMP agent stopped answering during this poll');

      const guard = async <T>(run: () => Promise<T>, fail: (e: SnmpError) => T, key: keyof SnmpTimings): Promise<T> => {
        if (stalled) return fail(skip());
        const t = performance.now();
        try {
          return await run();
        } catch (err) {
          const e = mapSnmpError(err);
          if (e.kind === 'timeout') stalled = e;
          return fail(e);
        } finally {
          timings[key] = Math.round(performance.now() - t);
        }
      };

      const ctx = { client, system };
      const cpu = await guard<Reading>(() => profile.collectCpu(ctx), readingFrom, 'cpuMs');
      const memory = await guard<Reading>(() => profile.collectMemory(ctx), readingFrom, 'memoryMs');
      const interfaces = await guard<SnmpInterfacesResult>(() => collectInterfaces(client), interfacesFrom, 'interfacesMs');

      return {
        status: 'ok',
        error: null,
        responseMs,
        durationMs: elapsed(),
        system,
        profileId: profile.id,
        cpu,
        memory,
        interfaces,
        timings,
        ...stats(),
      };
    } catch (err) {
      // Anything unexpected must still produce an honest, structured failure - never a thrown exception.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'error',
        error: msg,
        responseMs: null,
        durationMs: elapsed(),
        system: null,
        profileId: null,
        cpu: errorReading(msg),
        memory: unavailableReading(msg),
        interfaces: { status: 'error', error: msg, rows: [] },
        timings,
        ...stats(),
      };
    } finally {
      client.close();
    }
  }
}
