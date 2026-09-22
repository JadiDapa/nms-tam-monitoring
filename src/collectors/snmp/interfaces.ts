import type { SnmpClient } from './client.js';
import { SnmpError } from './client.js';
import { toBigInt, toNum, toStr } from './codec.js';
import { ADMIN_STATUS, IFX_COL, IF_COL, IF_TYPE_NAME, OID, OPER_STATUS } from './oids.js';
import type { IfStatus, SnmpInterfaceRow, SnmpInterfacesResult } from './types.js';

const IF_COLUMNS = [
  IF_COL.descr,
  IF_COL.type,
  IF_COL.speed,
  IF_COL.adminStatus,
  IF_COL.operStatus,
  IF_COL.inOctets,
  IF_COL.inDiscards,
  IF_COL.inErrors,
  IF_COL.outOctets,
  IF_COL.outDiscards,
  IF_COL.outErrors,
];
const IFX_COLUMNS = [IFX_COL.name, IFX_COL.hcInOctets, IFX_COL.hcOutOctets, IFX_COL.highSpeed, IFX_COL.alias];

const status = (map: Record<number, string>, v: unknown): IfStatus | null => {
  const n = toNum(v);
  return n === null ? null : ((map[n] as IfStatus | undefined) ?? 'unknown');
};

/** ifSpeed saturates at 4294967295 (bps); ifHighSpeed (Mbps) is authoritative when present. */
function speedBps(ifSpeed: unknown, ifHighSpeed: unknown): number | null {
  const high = toNum(ifHighSpeed);
  if (high !== null && high > 0) return high * 1_000_000;
  const low = toNum(ifSpeed);
  if (low !== null && low > 0 && low < 4_294_967_295) return low;
  return null;
}

/**
 * Read the whole interface inventory + counters with two bulk table requests (ifTable + ifXTable),
 * instead of one walk per column.
 *
 * Counter strategy: prefer 64-bit ifHCInOctets/ifHCOutOctets; fall back per interface to the 32-bit ifIn/OutOctets.
 */
export async function collectInterfaces(client: SnmpClient): Promise<SnmpInterfacesResult> {
  const ifTable = await client.tableColumns(OID.ifTable, IF_COLUMNS);
  const indices = Object.keys(ifTable);
  if (indices.length === 0) {
    return { status: 'not_supported', error: 'IF-MIB ifTable returned no rows', rows: [] };
  }

  // ifXTable is optional (SNMPv1-only or very old agents). Only a timeout is treated as a failure.
  let ifX: Record<string, Record<string, unknown>> = {};
  try {
    ifX = await client.tableColumns(OID.ifXTable, IFX_COLUMNS);
  } catch (err) {
    if (err instanceof SnmpError && err.kind === 'timeout') throw err;
  }

  const rows: SnmpInterfaceRow[] = [];
  for (const key of indices.sort((a, b) => Number(a) - Number(b))) {
    const t = ifTable[key]!;
    const x = ifX[key] ?? {};
    const ifIndex = Number(key);
    if (!Number.isInteger(ifIndex)) continue;

    const hcIn = toBigInt(x[IFX_COL.hcInOctets]);
    const hcOut = toBigInt(x[IFX_COL.hcOutOctets]);
    const useHc = hcIn !== null && hcOut !== null;
    const in32 = toBigInt(t[IF_COL.inOctets]);
    const out32 = toBigInt(t[IF_COL.outOctets]);

    const typeNum = toNum(t[IF_COL.type]);
    rows.push({
      ifIndex,
      name: toStr(x[IFX_COL.name]) ?? toStr(t[IF_COL.descr]) ?? `if${ifIndex}`,
      alias: toStr(x[IFX_COL.alias]),
      typeNum,
      typeName: typeNum === null ? null : (IF_TYPE_NAME[typeNum] ?? `type${typeNum}`),
      speedBps: speedBps(t[IF_COL.speed], x[IFX_COL.highSpeed]),
      adminStatus: status(ADMIN_STATUS, t[IF_COL.adminStatus]),
      operStatus: status(OPER_STATUS, t[IF_COL.operStatus]),
      inOctets: useHc ? hcIn : in32,
      outOctets: useHc ? hcOut : out32,
      counterBits: useHc ? 64 : in32 !== null && out32 !== null ? 32 : null,
      inErrors: toBigInt(t[IF_COL.inErrors]),
      outErrors: toBigInt(t[IF_COL.outErrors]),
      inDiscards: toBigInt(t[IF_COL.inDiscards]),
      outDiscards: toBigInt(t[IF_COL.outDiscards]),
    });
  }

  if (rows.length === 0) {
    return { status: 'error', error: 'IF-MIB rows were present but could not be parsed', rows: [] };
  }
  return { status: 'ok', error: null, rows };
}
