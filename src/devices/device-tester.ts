import { z } from 'zod';
import type { IcmpProbe, IcmpResult } from '../collectors/icmp/types.js';
import type { SnmpPollResult, SnmpProbe } from '../collectors/snmp/types.js';
import { tcpShowsHostAlive, type TcpPortResult, type TcpProbe } from '../collectors/tcp/tcp-probe.js';
import type { Reading } from '../collectors/types.js';
import type { CredentialService } from '../credentials/credential-service.js';
import type { SnmpAuth } from '../credentials/schemas.js';
import { AppError, badRequest } from '../util/errors.js';
import { errorMessage } from '../util/logger.js';
import { hostSchema } from './schemas.js';

export const testDeviceSchema = z
  .object({
    host: hostSchema,
    icmp: z.boolean().default(true),
    icmpCount: z.number().int().min(1).max(10).default(2),
    tcpPorts: z.array(z.number().int().min(1).max(65535)).max(20).default([]),
    snmp: z
      .object({
        credentialId: z.uuid().optional(),
        // accepted alias: the integration contract calls it communityCredentialId
        communityCredentialId: z.uuid().optional(),
        version: z.enum(['v1', 'v2c', 'v3']).optional(),
        port: z.number().int().min(1).max(65535).default(161),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(200).max(30000).default(3000),
    retries: z.number().int().min(0).max(3).default(0),
  })
  .strict();

export type TestDeviceInput = z.infer<typeof testDeviceSchema>;

export interface TestDeviceResult {
  host: string;
  /** any positive evidence (ICMP reply, TCP answer, SNMP response) */
  reachable: boolean;
  /** ICMP average, else the fastest successful TCP connect; null when nothing was measured */
  latencyMs: number | null;
  icmp: IcmpResult | null;
  tcp: TcpPortResult[] | null;
  snmp: null | {
    success: boolean;
    status: SnmpPollResult['status'];
    error: string | null;
    responseMs: number | null;
    system: SnmpPollResult['system'];
    profile: string | null;
    cpu: Reading;
    memory: Reading;
    interfaces: {
      status: string;
      error: string | null;
      count: number;
      items: Array<{ ifIndex: number; name: string; alias: string | null; adminStatus: string | null; operStatus: string | null; speedBps: number | null }>;
    };
  };
}

/**
 * Stateless "test this device now". Runs the real probes and returns exactly what happened.
 * It never writes to the database and never creates monitoring state.
 */
export class DeviceTester {
  private running = 0;

  constructor(
    private readonly icmp: IcmpProbe,
    private readonly tcp: TcpProbe,
    private readonly snmp: SnmpProbe,
    private readonly credentials: CredentialService,
    private readonly maxConcurrent: number,
  ) {}

  async test(input: TestDeviceInput): Promise<TestDeviceResult> {
    if (this.running >= this.maxConcurrent) {
      throw new AppError('TOO_MANY_TESTS', 'Too many device tests running; retry shortly', 429);
    }
    this.running += 1;
    try {
      return await this.run(input);
    } finally {
      this.running -= 1;
    }
  }

  private async resolveAuth(snmp: NonNullable<TestDeviceInput['snmp']>): Promise<SnmpAuth> {
    const id = snmp.credentialId ?? snmp.communityCredentialId;
    if (!id) throw badRequest('snmp.credentialId is required to test SNMP');
    const auth = await this.credentials.resolveSnmpAuth(id);
    if (snmp.version && snmp.version !== auth.version) {
      throw badRequest(`Credential is ${auth.version} but snmp.version is ${snmp.version}`);
    }
    return auth;
  }

  private async run(input: TestDeviceInput): Promise<TestDeviceResult> {
    if (!input.icmp && input.tcpPorts.length === 0 && !input.snmp) {
      throw badRequest('Nothing to test: enable icmp, add tcpPorts, or provide snmp');
    }
    const auth = input.snmp ? await this.resolveAuth(input.snmp) : null;

    const icmpP = input.icmp
      ? (async () => {
          const opts = { count: input.icmpCount, timeoutMs: input.timeoutMs };
          let r = await this.icmp.ping(input.host, opts);
          for (let i = 0; i < input.retries && r.status !== 'ok'; i++) r = await this.icmp.ping(input.host, opts);
          return r;
        })()
      : Promise.resolve(null);
    const tcpP = input.tcpPorts.length > 0
      ? this.tcp.check(input.host, input.tcpPorts, { timeoutMs: input.timeoutMs, retries: input.retries })
      : Promise.resolve(null);
    const snmpP = input.snmp && auth
      ? this.snmp
          .poll({ host: input.host, port: input.snmp.port, auth }, { timeoutMs: input.timeoutMs, retries: input.retries })
          .catch((err): SnmpPollResult => ({
            status: 'error',
            error: errorMessage(err),
            responseMs: null,
            durationMs: 0,
            system: null,
            profileId: null,
            cpu: { status: 'error', value: null, error: errorMessage(err) },
            memory: { status: 'error', value: null, error: errorMessage(err) },
            interfaces: { status: 'error', error: errorMessage(err), rows: [] },
            timings: { systemMs: null, cpuMs: null, memoryMs: null, interfacesMs: null },
            retransmits: 0,
            timeouts: 0,
          }))
      : Promise.resolve(null);

    const [icmp, tcp, snmp] = await Promise.all([icmpP, tcpP, snmpP]);

    const evidence: boolean[] = [];
    if (icmp) evidence.push(icmp.reachable);
    if (tcp) evidence.push(tcp.some(tcpShowsHostAlive));
    if (snmp) evidence.push(snmp.status === 'ok');

    const tcpLatencies = (tcp ?? []).filter((r) => r.status === 'open' && r.latencyMs !== null).map((r) => r.latencyMs!);
    const latencyMs = icmp?.status === 'ok' && icmp.avgMs !== null ? icmp.avgMs : tcpLatencies.length > 0 ? Math.min(...tcpLatencies) : null;

    return {
      host: input.host,
      reachable: evidence.some(Boolean),
      latencyMs,
      icmp,
      tcp,
      snmp: snmp
        ? {
            success: snmp.status === 'ok',
            status: snmp.status,
            error: snmp.error,
            responseMs: snmp.responseMs,
            system: snmp.system,
            profile: snmp.profileId,
            cpu: snmp.cpu,
            memory: snmp.memory,
            interfaces: {
              status: snmp.interfaces.status,
              error: snmp.interfaces.error,
              count: snmp.interfaces.rows.length,
              items: snmp.interfaces.rows.slice(0, 100).map((r) => ({
                ifIndex: r.ifIndex,
                name: r.name,
                alias: r.alias,
                adminStatus: r.adminStatus,
                operStatus: r.operStatus,
                speedBps: r.speedBps,
              })),
            },
          }
        : null,
    };
  }
}
