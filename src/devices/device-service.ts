import type { Database, Queryable } from '../database/db.js';
import { toNumber } from '../database/db.js';
import { badRequest, notFound } from '../util/errors.js';
import type { MetricRepository } from '../metrics/repository.js';
import type { ScheduleEntry } from '../scheduler/scheduler.js';
import type { CreateDeviceInput, UpdateDeviceInput } from './schemas.js';
import type { SnmpAuth } from './snmp-auth.js';
import { StateRepository } from './state-repository.js';
import {
  DEFAULT_POLLING,
  type DeviceConfig,
  type DeviceStateRecord,
  type DeviceType,
  type PollingConfig,
} from './types.js';

interface Row {
  id: string;
  name: string;
  host: string;
  device_type: DeviceType;
  vendor: string | null;
  model: string | null;
  location: string | null;
  enabled: boolean;
  icmp_enabled: boolean;
  tcp_ports: number[];
  snmp_enabled: boolean;
  snmp_auth: SnmpAuth | null;
  snmp_port: number;
  sys_name: string | null;
  sys_descr: string | null;
  sys_object_id: string | null;
  snmp_profile: string | null;
  info_updated_at: Date | null;
  created_at: Date;
  updated_at: Date;
  poll_interval_sec: number;
  timeout_ms: number;
  retry_count: number;
  failure_threshold: number;
  recovery_threshold: number;
  snmp_failure_threshold: number;
  snmp_recovery_threshold: number;
  icmp_count: number;
}

const SELECT = `select d.*, p.poll_interval_sec, p.timeout_ms, p.retry_count, p.failure_threshold, p.recovery_threshold,
  p.snmp_failure_threshold, p.snmp_recovery_threshold, p.icmp_count
  from devices d join polling_config p on p.device_id = d.id`;

const map = (r: Row): DeviceConfig => ({
  id: r.id,
  name: r.name,
  host: r.host,
  deviceType: r.device_type,
  vendor: r.vendor,
  model: r.model,
  location: r.location,
  enabled: r.enabled,
  icmpEnabled: r.icmp_enabled,
  tcpPorts: (r.tcp_ports ?? []).map(Number),
  snmpEnabled: r.snmp_enabled,
  snmpAuth: r.snmp_auth,
  snmpPort: r.snmp_port,
  sysName: r.sys_name,
  sysDescr: r.sys_descr,
  sysObjectId: r.sys_object_id,
  snmpProfile: r.snmp_profile,
  infoUpdatedAt: r.info_updated_at ? new Date(r.info_updated_at) : null,
  createdAt: new Date(r.created_at),
  updatedAt: new Date(r.updated_at),
  polling: {
    pollIntervalSec: r.poll_interval_sec,
    timeoutMs: r.timeout_ms,
    retryCount: r.retry_count,
    failureThreshold: r.failure_threshold,
    recoveryThreshold: r.recovery_threshold,
    snmpFailureThreshold: r.snmp_failure_threshold,
    snmpRecoveryThreshold: r.snmp_recovery_threshold,
    icmpCount: r.icmp_count,
  },
});

export interface ListDevicesQuery {
  enabled?: boolean;
  /** restrict to these device ids (undefined = no restriction, [] = nothing) */
  ids?: string[];
  limit?: number;
  offset?: number;
}

/** One row of the fleet overview: current health + the latest headline metrics, for many devices in one round trip. */
export interface FleetItem {
  deviceId: string;
  name: string;
  host: string;
  enabled: boolean;
  reachability: string;
  reachabilitySince: Date | null;
  snmp: string;
  lastPollAt: Date | null;
  lastError: string | null;
  activeIncidents: number;
  cpuPct: number | null;
  memoryPct: number | null;
  latencyMs: number | null;
}

export class DeviceService {
  private onChange: (deviceId: string) => void = () => undefined;

  constructor(
    private readonly db: Database,
    private readonly metrics: MetricRepository,
    private readonly states: StateRepository = new StateRepository(),
  ) {}

  /** The scheduler registers here to pick up new/changed/removed devices immediately (not only on its next sync). */
  setChangeListener(fn: (deviceId: string) => void): void {
    this.onChange = fn;
  }

  private assertChecks(c: { icmpEnabled: boolean; snmpEnabled: boolean; tcpPorts: number[] }): void {
    if (!c.icmpEnabled && !c.snmpEnabled && c.tcpPorts.length === 0) {
      throw badRequest('Enable at least one check: icmp, snmp or one or more tcp ports');
    }
  }

  async create(input: CreateDeviceInput): Promise<DeviceConfig> {
    this.assertChecks(input);
    if (input.snmpEnabled && !input.snmpAuth) throw badRequest('snmpAuth is required when snmpEnabled is true');
    const polling: PollingConfig = { ...DEFAULT_POLLING, ...input.polling } as PollingConfig;

    const id = await this.db.transaction(async (tx) => {
      const d = await tx.query<{ id: string }>(
        `insert into devices (name, host, device_type, vendor, model, location, enabled, icmp_enabled, tcp_ports,
           snmp_enabled, snmp_auth, snmp_port)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [
          input.name, input.host, input.deviceType, input.vendor ?? null, input.model ?? null, input.location ?? null,
          input.enabled, input.icmpEnabled, input.tcpPorts, input.snmpEnabled,
          input.snmpEnabled ? JSON.stringify(input.snmpAuth ?? null) : null, input.snmpPort,
        ],
      );
      const deviceId = d.rows[0]!.id;
      await tx.query(
        `insert into polling_config (device_id, poll_interval_sec, timeout_ms, retry_count, failure_threshold, recovery_threshold,
           snmp_failure_threshold, snmp_recovery_threshold, icmp_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [deviceId, polling.pollIntervalSec, polling.timeoutMs, polling.retryCount, polling.failureThreshold, polling.recoveryThreshold,
          polling.snmpFailureThreshold, polling.snmpRecoveryThreshold, polling.icmpCount],
      );
      await tx.query('insert into device_state (device_id) values ($1)', [deviceId]);
      return deviceId;
    });

    this.onChange(id);
    return this.get(id);
  }

  async get(id: string, db: Queryable = this.db): Promise<DeviceConfig> {
    const r = await db.query<Row>(`${SELECT} where d.id = $1`, [id]);
    if (r.rowCount === 0) throw notFound('Device', id);
    return map(r.rows[0]!);
  }

  async list(q: ListDevicesQuery = {}): Promise<{ items: DeviceConfig[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.enabled !== undefined) {
      params.push(q.enabled);
      where.push(`d.enabled = $${params.length}`);
    }
    if (q.ids !== undefined) {
      params.push(q.ids);
      where.push(`d.id = any($${params.length}::uuid[])`);
    }
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const offset = Math.max(q.offset ?? 0, 0);
    const [rows, total] = await Promise.all([
      this.db.query<Row>(`${SELECT} ${clause} order by d.name, d.id limit ${limit} offset ${offset}`, params),
      this.db.query<{ n: string }>(`select count(*)::text as n from devices d ${clause}`, params),
    ]);
    return { items: rows.rows.map(map), total: toNumber(total.rows[0]!.n) ?? 0 };
  }

  async update(id: string, patch: UpdateDeviceInput): Promise<DeviceConfig> {
    const current = await this.get(id);
    const next = {
      icmpEnabled: patch.icmpEnabled ?? current.icmpEnabled,
      snmpEnabled: patch.snmpEnabled ?? current.snmpEnabled,
      tcpPorts: patch.tcpPorts ?? current.tcpPorts,
      snmpAuth: patch.snmpAuth === undefined ? current.snmpAuth : (patch.snmpAuth ?? null),
    };
    this.assertChecks(next);
    if (next.snmpEnabled && !next.snmpAuth) throw badRequest('snmpAuth is required when snmpEnabled is true');

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.host !== undefined) set('host', patch.host);
    if (patch.deviceType !== undefined) set('device_type', patch.deviceType);
    if (patch.vendor !== undefined) set('vendor', patch.vendor);
    if (patch.model !== undefined) set('model', patch.model);
    if (patch.location !== undefined) set('location', patch.location);
    if (patch.enabled !== undefined) set('enabled', patch.enabled);
    if (patch.icmpEnabled !== undefined) set('icmp_enabled', patch.icmpEnabled);
    if (patch.tcpPorts !== undefined) set('tcp_ports', patch.tcpPorts);
    if (patch.snmpPort !== undefined) set('snmp_port', patch.snmpPort);
    // keep snmp_enabled / snmp_auth consistent with the DB constraint
    set('snmp_enabled', next.snmpEnabled);
    set('snmp_auth', next.snmpEnabled ? JSON.stringify(next.snmpAuth) : null);
    sets.push('updated_at = now()');

    await this.db.transaction(async (tx) => {
      await tx.query(`update devices set ${sets.join(', ')} where id = $1`, params);
      if (patch.polling && Object.keys(patch.polling).length > 0) {
        const merged = { ...current.polling, ...patch.polling };
        await tx.query(
          `update polling_config set poll_interval_sec = $2, timeout_ms = $3, retry_count = $4, failure_threshold = $5,
             recovery_threshold = $6, snmp_failure_threshold = $7, snmp_recovery_threshold = $8, icmp_count = $9 where device_id = $1`,
          [id, merged.pollIntervalSec, merged.timeoutMs, merged.retryCount, merged.failureThreshold, merged.recoveryThreshold,
            merged.snmpFailureThreshold, merged.snmpRecoveryThreshold, merged.icmpCount],
        );
      }
    });

    this.onChange(id);
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const r = await this.db.query('delete from devices where id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Device', id);
    this.onChange(id);
  }

  /** Devices the scheduler should poll (enabled only), with their own intervals. */
  async schedule(): Promise<ScheduleEntry[]> {
    const r = await this.db.query<{ device_id: string; poll_interval_sec: number }>(
      `select d.id as device_id, p.poll_interval_sec from devices d join polling_config p on p.device_id = d.id where d.enabled`,
    );
    return r.rows.map((x) => ({ deviceId: x.device_id, intervalSec: x.poll_interval_sec }));
  }

  async getState(id: string): Promise<DeviceStateRecord> {
    await this.get(id);
    return this.states.get(this.db, id);
  }

  /** Combined view for GET /devices/:id/status */
  async status(id: string) {
    const device = await this.get(id);
    const [state, latest, active, history] = await Promise.all([
      this.states.get(this.db, id),
      this.metrics.latestDeviceMetrics(id),
      this.db.query<{ n: string }>(`select count(*)::text as n from incidents where device_id = $1 and status <> 'RESOLVED'`, [id]),
      this.states.history(this.db, id, 20),
    ]);
    return { device, state, latestMetrics: latest, activeIncidents: toNumber(active.rows[0]!.n) ?? 0, stateHistory: history };
  }

  /** Health + latest CPU / memory / latency for the given devices (all devices when ids is undefined), set-based. */
  async fleet(ids?: string[]): Promise<FleetItem[]> {
    const filter = ids === undefined ? '' : 'where d.id = any($1::uuid[])';
    const params = ids === undefined ? [] : [ids];
    const r = await this.db.query<{
      id: string;
      name: string;
      host: string;
      enabled: boolean;
      reachability_state: string;
      reachability_since: Date | null;
      snmp_state: string;
      last_poll_at: Date | null;
      last_error: string | null;
      active: string;
      cpu: number | null;
      memory: number | null;
      latency: number | null;
    }>(
      `select d.id, d.name, d.host, d.enabled, s.reachability_state, s.reachability_since, s.snmp_state, s.last_poll_at, s.last_error,
         (select count(*)::text from incidents i where i.device_id = d.id and i.status <> 'RESOLVED') as active,
         (select value from device_metric_samples m where m.device_id = d.id and m.metric = 'cpu_pct' and m.status = 'ok' order by time desc limit 1) as cpu,
         (select value from device_metric_samples m where m.device_id = d.id and m.metric = 'memory_pct' and m.status = 'ok' order by time desc limit 1) as memory,
         (select value from device_metric_samples m where m.device_id = d.id and m.metric = 'icmp_latency_ms' and m.status = 'ok' order by time desc limit 1) as latency
       from devices d join device_state s on s.device_id = d.id ${filter} order by d.name, d.id`,
      params,
    );
    return r.rows.map((x) => ({
      deviceId: x.id,
      name: x.name,
      host: x.host,
      enabled: x.enabled,
      reachability: x.reachability_state,
      reachabilitySince: x.reachability_since ? new Date(x.reachability_since) : null,
      snmp: x.snmp_state,
      lastPollAt: x.last_poll_at ? new Date(x.last_poll_at) : null,
      lastError: x.last_error,
      activeIncidents: toNumber(x.active) ?? 0,
      cpuPct: toNumber(x.cpu),
      memoryPct: toNumber(x.memory),
      latencyMs: toNumber(x.latency),
    }));
  }

  async ensureExists(id: string): Promise<void> {
    const r = await this.db.query('select 1 from devices where id = $1', [id]);
    if (r.rowCount === 0) throw notFound('Device', id);
  }
}

