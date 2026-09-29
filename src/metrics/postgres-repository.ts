import type { CollectStatus } from '../collectors/types.js';
import { toBigInt, toNumber, type Database } from '../database/db.js';
import type {
  DeviceMetricBucket,
  DeviceMetricQuery,
  DeviceMetricSample,
  InterfaceBucket,
  InterfaceSample,
  InterfaceSampleQuery,
  MetricRepository,
} from './repository.js';

const CHUNK = 500;
const MAX_LIMIT = 10_000;

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const big = (v: bigint | null): string | null => (v === null ? null : v.toString());

interface DeviceRow {
  time: Date;
  device_id: string;
  metric: string;
  dimension: string | null;
  value: number | null;
  status: CollectStatus;
  error: string | null;
}

interface InterfaceRow {
  time: Date;
  device_id: string;
  interface_id: string;
  in_octets: string | null;
  out_octets: string | null;
  in_errors: string | null;
  out_errors: string | null;
  in_discards: string | null;
  out_discards: string | null;
  in_bps: number | null;
  out_bps: number | null;
  rate_note: string | null;
  counter_bits: number | null;
  admin_status: string | null;
  oper_status: string | null;
  status: CollectStatus;
  error: string | null;
}

const IF_COLUMNS = `time, device_id, interface_id, in_octets::text as in_octets, out_octets::text as out_octets,
  in_errors::text as in_errors, out_errors::text as out_errors, in_discards::text as in_discards,
  out_discards::text as out_discards, in_bps, out_bps, rate_note, counter_bits, admin_status, oper_status, status, error`;

const toDeviceSample = (r: DeviceRow): DeviceMetricSample => ({
  time: new Date(r.time),
  deviceId: r.device_id,
  metric: r.metric,
  dimension: r.dimension,
  value: toNumber(r.value),
  status: r.status,
  error: r.error,
});

const toInterfaceSample = (r: InterfaceRow): InterfaceSample => ({
  time: new Date(r.time),
  deviceId: r.device_id,
  interfaceId: r.interface_id,
  inOctets: toBigInt(r.in_octets),
  outOctets: toBigInt(r.out_octets),
  inErrors: toBigInt(r.in_errors),
  outErrors: toBigInt(r.out_errors),
  inDiscards: toBigInt(r.in_discards),
  outDiscards: toBigInt(r.out_discards),
  inBps: toNumber(r.in_bps),
  outBps: toNumber(r.out_bps),
  rateNote: r.rate_note,
  counterBits: r.counter_bits === null ? null : (Number(r.counter_bits) as 32 | 64),
  adminStatus: r.admin_status,
  operStatus: r.oper_status,
  status: r.status,
  error: r.error,
});

/** Default implementation: plain PostgreSQL tables (append-only, indexed by (device, metric, time)). */
export class PostgresMetricRepository implements MetricRepository {
  constructor(private readonly db: Database) {}

  async writeDeviceMetrics(samples: DeviceMetricSample[]): Promise<void> {
    for (const batch of chunks(samples, CHUNK)) {
      const params: unknown[] = [];
      const rows = batch.map((s, i) => {
        const o = i * 7;
        params.push(s.time, s.deviceId, s.metric, s.dimension, s.value, s.status, s.error);
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`;
      });
      await this.db.query(
        `insert into device_metric_samples (time, device_id, metric, dimension, value, status, error) values ${rows.join(', ')}`,
        params,
      );
    }
  }

  async writeInterfaceSamples(samples: InterfaceSample[]): Promise<void> {
    for (const batch of chunks(samples, CHUNK)) await this.insertInterfaceBatch(batch);
  }

  private async insertInterfaceBatch(batch: InterfaceSample[]): Promise<void> {
    const params: unknown[] = [];
    const rows = batch.map((s, i) => {
      const o = i * 17;
      params.push(
        s.time, s.deviceId, s.interfaceId,
        big(s.inOctets), big(s.outOctets), big(s.inErrors), big(s.outErrors), big(s.inDiscards), big(s.outDiscards),
        s.inBps, s.outBps, s.rateNote, s.counterBits, s.adminStatus, s.operStatus, s.status, s.error,
      );
      return `(${Array.from({ length: 17 }, (_, k) => `$${o + k + 1}`).join(', ')})`;
    });
    await this.db.query(
      `insert into interface_samples
         (time, device_id, interface_id, in_octets, out_octets, in_errors, out_errors, in_discards, out_discards,
          in_bps, out_bps, rate_note, counter_bits, admin_status, oper_status, status, error)
       values ${rows.join(', ')}`,
      params,
    );
  }

  async queryDeviceMetrics(q: DeviceMetricQuery): Promise<DeviceMetricSample[]> {
    const where = ['device_id = $1'];
    const params: unknown[] = [q.deviceId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.metric) add('metric = ?', q.metric);
    if (q.dimension) add('dimension = ?', q.dimension);
    if (q.from) add('time >= ?', q.from);
    if (q.to) add('time <= ?', q.to);
    const limit = Math.min(Math.max(q.limit ?? 500, 1), MAX_LIMIT);
    const order = q.order === 'asc' ? 'asc' : 'desc';
    const r = await this.db.query<DeviceRow>(
      `select time, device_id, metric, dimension, value, status, error from device_metric_samples
       where ${where.join(' and ')} order by time ${order} limit ${limit}`,
      params,
    );
    return r.rows.map(toDeviceSample);
  }

  async queryInterfaceSamples(q: InterfaceSampleQuery): Promise<InterfaceSample[]> {
    const where = ['device_id = $1'];
    const params: unknown[] = [q.deviceId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.interfaceId) add('interface_id = ?', q.interfaceId);
    if (q.from) add('time >= ?', q.from);
    if (q.to) add('time <= ?', q.to);
    const limit = Math.min(Math.max(q.limit ?? 500, 1), MAX_LIMIT);
    const order = q.order === 'asc' ? 'asc' : 'desc';
    const r = await this.db.query<InterfaceRow>(
      `select ${IF_COLUMNS} from interface_samples where ${where.join(' and ')} order by time ${order} limit ${limit}`,
      params,
    );
    return r.rows.map(toInterfaceSample);
  }

  async queryDeviceMetricBuckets(q: DeviceMetricQuery & { bucketSec: number }): Promise<DeviceMetricBucket[]> {
    const params: unknown[] = [q.deviceId, q.bucketSec];
    const where = ['device_id = $1', `status = 'ok'`];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.metric) add('metric = ?', q.metric);
    if (q.dimension) add('dimension = ?', q.dimension);
    if (q.from) add('time >= ?', q.from);
    if (q.to) add('time <= ?', q.to);
    const limit = Math.min(Math.max(q.limit ?? 500, 1), MAX_LIMIT);
    const order = q.order === 'desc' ? 'desc' : 'asc';
    const r = await this.db.query<{ bucket: Date; metric: string; dimension: string | null; avg: number | null; max: number | null; n: string }>(
      `select date_bin(make_interval(secs => $2), time, timestamptz '2000-01-01') as bucket, metric, dimension,
              avg(value) as avg, max(value) as max, count(*)::text as n
       from device_metric_samples where ${where.join(' and ')}
       group by bucket, metric, dimension order by bucket ${order} limit ${limit}`,
      params,
    );
    return r.rows.map((x) => ({
      time: new Date(x.bucket),
      metric: x.metric,
      dimension: x.dimension,
      avg: toNumber(x.avg),
      max: toNumber(x.max),
      samples: toNumber(x.n) ?? 0,
    }));
  }

  async queryInterfaceBuckets(q: InterfaceSampleQuery & { bucketSec: number }): Promise<InterfaceBucket[]> {
    const params: unknown[] = [q.deviceId, q.bucketSec];
    const where = ['device_id = $1'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.interfaceId) add('interface_id = ?', q.interfaceId);
    if (q.from) add('time >= ?', q.from);
    if (q.to) add('time <= ?', q.to);
    const limit = Math.min(Math.max(q.limit ?? 500, 1), MAX_LIMIT);
    const order = q.order === 'desc' ? 'desc' : 'asc';
    const r = await this.db.query<{
      bucket: Date; interface_id: string; in_avg: number | null; in_max: number | null; out_avg: number | null; out_max: number | null; n: string;
    }>(
      `select date_bin(make_interval(secs => $2), time, timestamptz '2000-01-01') as bucket, interface_id,
              avg(in_bps) as in_avg, max(in_bps) as in_max, avg(out_bps) as out_avg, max(out_bps) as out_max, count(*)::text as n
       from interface_samples where ${where.join(' and ')}
       group by bucket, interface_id order by bucket ${order} limit ${limit}`,
      params,
    );
    return r.rows.map((x) => ({
      time: new Date(x.bucket),
      interfaceId: x.interface_id,
      inBpsAvg: toNumber(x.in_avg),
      inBpsMax: toNumber(x.in_max),
      outBpsAvg: toNumber(x.out_avg),
      outBpsMax: toNumber(x.out_max),
      samples: toNumber(x.n) ?? 0,
    }));
  }

  async latestDeviceMetrics(deviceId: string): Promise<DeviceMetricSample[]> {
    const r = await this.db.query<DeviceRow>(
      `select distinct on (metric, dimension) time, device_id, metric, dimension, value, status, error
       from device_metric_samples where device_id = $1 order by metric, dimension, time desc`,
      [deviceId],
    );
    return r.rows.map(toDeviceSample);
  }

  async latestInterfaceSamples(deviceId: string): Promise<InterfaceSample[]> {
    const r = await this.db.query<InterfaceRow>(
      `select distinct on (interface_id) ${IF_COLUMNS} from interface_samples
       where device_id = $1 order by interface_id, time desc`,
      [deviceId],
    );
    return r.rows.map(toInterfaceSample);
  }

  async firstInterfaceSampleAt(deviceId: string): Promise<Date | null> {
    const r = await this.db.query<{ t: Date | null }>('select min(time) as t from interface_samples where device_id = $1', [deviceId]);
    const t = r.rows[0]?.t ?? null;
    return t ? new Date(t) : null;
  }

  async purgeOlderThan(cutoff: Date): Promise<{ deviceMetrics: number; interfaceSamples: number }> {
    const a = await this.db.query('delete from device_metric_samples where time < $1', [cutoff]);
    const b = await this.db.query('delete from interface_samples where time < $1', [cutoff]);
    return { deviceMetrics: a.rowCount, interfaceSamples: b.rowCount };
  }
}
