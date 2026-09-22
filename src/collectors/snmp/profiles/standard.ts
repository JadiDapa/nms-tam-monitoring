import { errorReading, notSupportedReading, okReading, type Reading } from '../../types.js';
import { toNum, toStr } from '../codec.js';
import { HR_STORAGE_COL, OID } from '../oids.js';
import type { SnmpContext, SnmpProfile } from './profile.js';

/**
 * CPU: HOST-RESOURCES-MIB hrProcessorLoad = "average % non-idle over the last minute" per processor.
 * The device CPU is the arithmetic mean over all processors that report a valid 0-100 value.
 */
export async function standardCpu({ client }: SnmpContext): Promise<Reading> {
  const rows = await client.walk(OID.hrProcessorLoad);
  if (rows.length === 0) return notSupportedReading('hrProcessorLoad not implemented by this device');

  const loads = rows.map((r) => toNum(r.value)).filter((v): v is number => v !== null && v >= 0 && v <= 100);
  if (loads.length === 0) return errorReading('hrProcessorLoad returned no valid values');
  return okReading(loads.reduce((a, b) => a + b, 0) / loads.length);
}

const MEMORY_DESCR = /(main|physical|system)?\s*(memory|ram)\b/i;
const NOT_MEMORY = /(virtual|swap|cache|buffer|flash|disk|storage|nvram|partition|\/)/i;

/**
 * Memory: HOST-RESOURCES-MIB hrStorageTable. Prefer the entry typed hrStorageRam; otherwise fall back to a
 * description that clearly names main memory. used / size is unit-independent (allocationUnits cancels out).
 */
export async function standardMemory({ client }: SnmpContext): Promise<Reading> {
  const table = await client.tableColumns(OID.hrStorageTable, [
    HR_STORAGE_COL.type,
    HR_STORAGE_COL.descr,
    HR_STORAGE_COL.allocationUnits,
    HR_STORAGE_COL.size,
    HR_STORAGE_COL.used,
  ]);
  const entries = Object.values(table);
  if (entries.length === 0) return notSupportedReading('hrStorageTable not implemented by this device');

  const candidates = entries
    .map((e) => ({
      type: toStr(e[HR_STORAGE_COL.type]),
      descr: toStr(e[HR_STORAGE_COL.descr]) ?? '',
      size: toNum(e[HR_STORAGE_COL.size]),
      used: toNum(e[HR_STORAGE_COL.used]),
    }))
    .filter((e) => e.size !== null && e.size > 0 && e.used !== null && e.used >= 0);

  const byType = candidates.filter((e) => e.type === OID.hrStorageRam);
  const byDescr = candidates.filter((e) => MEMORY_DESCR.test(e.descr) && !NOT_MEMORY.test(e.descr));
  const pool = byType.length > 0 ? byType : byDescr;
  if (pool.length === 0) return notSupportedReading('No RAM entry found in hrStorageTable');

  // Several RAM rows: the one describing main memory wins, otherwise the largest.
  const best =
    pool.find((e) => /main|physical/i.test(e.descr)) ?? pool.slice().sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]!;
  const pct = (best.used! / best.size!) * 100;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100.5) return errorReading('hrStorage RAM values are inconsistent');
  return okReading(Math.min(100, pct));
}

/** Fallback profile: matches everything and uses the standard MIBs. */
export const standardProfile: SnmpProfile = {
  id: 'standard',
  matches: () => true,
  collectCpu: standardCpu,
  collectMemory: standardMemory,
};
