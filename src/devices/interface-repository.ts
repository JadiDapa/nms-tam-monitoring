import { randomUUID } from 'node:crypto';
import type { SnmpInterfaceRow } from '../collectors/snmp/types.js';
import { toBigInt, toNumber, type Queryable } from '../database/db.js';
import type { CounterSample } from '../metrics/traffic.js';

export interface InterfaceRecord {
  id: string;
  deviceId: string;
  ifIndex: number;
  name: string;
  alias: string | null;
  ifType: number | null;
  ifTypeName: string | null;
  speedBps: number | null;
  adminStatus: string | null;
  operStatus: string | null;
  monitored: boolean;
  /**
   * Lifecycle. ACTIVE = present in the most recent complete interface walk. INACTIVE = it disappeared (typical for
   * dynamic PPP/L2TP/tunnel interfaces). Inactive interfaces are never deleted: their history and incidents stay.
   */
  active: boolean;
  inactiveSince: Date | null;
  /** last time the interface was observed operationally UP; null = never seen up (e.g. an unused port) */
  lastOperUpAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** previous counter sample, used to derive rates. null until the first counters were stored. */
  lastCounters: CounterSample | null;
}

interface Row {
  id: string;
  device_id: string;
  if_index: number;
  name: string;
  alias: string | null;
  if_type: number | null;
  if_type_name: string | null;
  speed_bps: string | null;
  admin_status: string | null;
  oper_status: string | null;
  monitored: boolean;
  active: boolean;
  inactive_since: Date | null;
  last_oper_up_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  last_counter_at: Date | null;
  last_in_octets: string | null;
  last_out_octets: string | null;
  last_counter_bits: number | null;
}

const SELECT = `id, device_id, if_index, name, alias, if_type, if_type_name, speed_bps::text as speed_bps, admin_status,
  oper_status, monitored, active, inactive_since, last_oper_up_at, first_seen_at, last_seen_at, last_counter_at, last_in_octets::text as last_in_octets,
  last_out_octets::text as last_out_octets, last_counter_bits`;

const map = (r: Row): InterfaceRecord => {
  const inO = toBigInt(r.last_in_octets);
  const outO = toBigInt(r.last_out_octets);
  const bits = r.last_counter_bits === null ? null : (Number(r.last_counter_bits) as 32 | 64);
  return {
    id: r.id,
    deviceId: r.device_id,
    ifIndex: Number(r.if_index),
    name: r.name,
    alias: r.alias,
    ifType: r.if_type,
    ifTypeName: r.if_type_name,
    speedBps: toNumber(r.speed_bps),
    adminStatus: r.admin_status,
    operStatus: r.oper_status,
    monitored: r.monitored,
    active: r.active,
    inactiveSince: r.inactive_since ? new Date(r.inactive_since) : null,
    lastOperUpAt: r.last_oper_up_at ? new Date(r.last_oper_up_at) : null,
    firstSeenAt: new Date(r.first_seen_at),
    lastSeenAt: new Date(r.last_seen_at),
    lastCounters:
      r.last_counter_at && inO !== null && outO !== null && bits !== null
        ? { inOctets: inO, outOctets: outO, at: new Date(r.last_counter_at).getTime(), bits }
        : null,
  };
};

/** softwareLoopback (24) interfaces are not worth a time series by default; everything else is monitored. */
const monitoredByDefault = (row: SnmpInterfaceRow): boolean => row.typeNum !== 24;

export class InterfaceRepository {
  async listForDevice(db: Queryable, deviceId: string): Promise<InterfaceRecord[]> {
    const r = await db.query<Row>(`select ${SELECT} from interfaces where device_id = $1 order by if_index`, [deviceId]);
    return r.rows.map(map);
  }

  async get(db: Queryable, deviceId: string, interfaceId: string): Promise<InterfaceRecord | null> {
    const r = await db.query<Row>(`select ${SELECT} from interfaces where device_id = $1 and id = $2`, [deviceId, interfaceId]);
    return r.rowCount === 0 ? null : map(r.rows[0]!);
  }

  /**
   * Insert new interfaces / refresh existing ones (identified by device + ifIndex) and store the newest counter
   * sample. `monitored` is never overwritten, so an operator's choice survives polling.
   * Returns id + monitored for every row, keyed by ifIndex.
   */
  async upsertFromPoll(
    db: Queryable,
    deviceId: string,
    rows: SnmpInterfaceRow[],
    at: Date,
  ): Promise<Map<number, { id: string; monitored: boolean }>> {
    const result = new Map<number, { id: string; monitored: boolean }>();
    const COLS = 17;
    for (let start = 0; start < rows.length; start += 100) {
      const batch = rows.slice(start, start + 100);
      const params: unknown[] = [];
      const values = batch.map((row, i) => {
        const o = i * COLS;
        const haveCounters = row.inOctets !== null && row.outOctets !== null && row.counterBits !== null;
        params.push(
          randomUUID(), deviceId, row.ifIndex, row.name, row.alias, row.typeNum, row.typeName,
          row.speedBps === null ? null : String(row.speedBps), row.adminStatus, row.operStatus, monitoredByDefault(row), at,
          haveCounters ? at : null,
          haveCounters ? row.inOctets!.toString() : null,
          haveCounters ? row.outOctets!.toString() : null,
          haveCounters ? row.counterBits : null,
          row.operStatus === 'up' ? at : null,
        );
        return `(${Array.from({ length: COLS }, (_, k) => `$${o + k + 1}`).join(', ')})`;
      });
      const r = await db.query<{ id: string; if_index: number; monitored: boolean }>(
        `insert into interfaces (id, device_id, if_index, name, alias, if_type, if_type_name, speed_bps, admin_status,
           oper_status, monitored, last_seen_at, last_counter_at, last_in_octets, last_out_octets, last_counter_bits, last_oper_up_at)
         values ${values.join(', ')}
         on conflict (device_id, if_index) do update set
           name = excluded.name, alias = excluded.alias, if_type = excluded.if_type, if_type_name = excluded.if_type_name,
           speed_bps = excluded.speed_bps, admin_status = excluded.admin_status, oper_status = excluded.oper_status,
           last_seen_at = excluded.last_seen_at,
           -- (re)appearing in the walk always makes the interface active again; its history stays attached
           active = true, inactive_since = null,
           last_oper_up_at = coalesce(excluded.last_oper_up_at, interfaces.last_oper_up_at),
           last_counter_at = coalesce(excluded.last_counter_at, interfaces.last_counter_at),
           last_in_octets = coalesce(excluded.last_in_octets, interfaces.last_in_octets),
           last_out_octets = coalesce(excluded.last_out_octets, interfaces.last_out_octets),
           last_counter_bits = coalesce(excluded.last_counter_bits, interfaces.last_counter_bits)
         returning id, if_index, monitored`,
        params,
      );
      for (const x of r.rows) result.set(Number(x.if_index), { id: x.id, monitored: x.monitored });
    }
    return result;
  }

  /**
   * After a COMPLETE interface walk: every known active interface that was not part of it becomes inactive.
   * Nothing is deleted. Returns the interfaces that just went inactive.
   */
  async markMissingInactive(db: Queryable, deviceId: string, presentIfIndexes: number[], at: Date): Promise<Array<{ id: string; ifIndex: number; name: string }>> {
    const r = await db.query<{ id: string; if_index: number; name: string }>(
      `update interfaces set active = false, inactive_since = $3
       where device_id = $1 and active and not (if_index = any($2::int[]))
       returning id, if_index, name`,
      [deviceId, presentIfIndexes, at],
    );
    return r.rows.map((x) => ({ id: x.id, ifIndex: Number(x.if_index), name: x.name }));
  }

  async setMonitored(db: Queryable, deviceId: string, interfaceId: string, monitored: boolean): Promise<boolean> {
    const r = await db.query('update interfaces set monitored = $3 where device_id = $1 and id = $2', [deviceId, interfaceId, monitored]);
    return r.rowCount > 0;
  }
}
