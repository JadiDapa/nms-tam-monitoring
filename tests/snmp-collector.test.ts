import * as snmp from 'net-snmp';
import { afterEach, describe, expect, it } from 'vitest';
import { SnmpCollector } from '../src/collectors/snmp/collector.js';
import type { SnmpAuth } from '../src/credentials/schemas.js';
import { deadPort, FakeSnmpDevice, startGarbageResponder, type FakeDeviceOptions } from './helpers/fake-snmp-device.js';

const FAST = { timeoutMs: 400, retries: 0 };
const v2c = (community = 'public'): SnmpAuth => ({ version: 'v2c', community });

let devices: FakeSnmpDevice[] = [];
const spawn = async (o: FakeDeviceOptions = {}) => {
  const d = await new FakeSnmpDevice(o).start();
  devices.push(d);
  return d;
};
afterEach(async () => {
  await Promise.all(devices.map((d) => d.stop()));
  devices = [];
});

const collector = new SnmpCollector();
const poll = (port: number, auth: SnmpAuth = v2c()) => collector.poll({ host: '127.0.0.1', port, auth }, FAST);

describe('SNMP collector against a real SNMP agent', () => {
  it('collects real system info, CPU, memory and interfaces over v2c', async () => {
    const dev = await spawn({
      sysName: 'core-rtr',
      sysDescr: 'RouterOS CCR2116',
      uptimeTicks: 8_640_000,
      cpuLoads: [10, 30, 20, 40],
      memory: [
        { descr: 'main memory', type: '1.3.6.1.2.1.25.2.1.2', size: 2000, used: 500 },
        { descr: 'flash', type: '1.3.6.1.2.1.25.2.1.4', size: 100, used: 90 },
      ],
      interfaces: [
        { index: 1, name: 'ether1', alias: 'uplink', speedMbps: 1000, in32: 111, out32: 222, inHc: 5_000_000_000_000n, outHc: 7_000_000_000_000n, inErrors: 3, outDiscards: 4 },
        { index: 2, name: 'ether2', speedMbps: 10000, oper: 2, inHc: 1n, outHc: 2n },
      ],
    });

    const r = await poll(dev.port);

    expect(r.status).toBe('ok');
    expect(r.system).toMatchObject({ sysName: 'core-rtr', sysDescr: 'RouterOS CCR2116', uptimeTicks: 8_640_000 });
    expect(r.system?.sysObjectId).toBe('1.3.6.1.4.1.99999.1');
    expect(r.profileId).toBe('standard');
    expect(r.responseMs).toBeGreaterThanOrEqual(0);

    expect(r.cpu).toEqual({ status: 'ok', value: 25, error: null }); // mean of 10,30,20,40
    expect(r.memory).toEqual({ status: 'ok', value: 25, error: null }); // RAM entry only, flash ignored

    expect(r.interfaces.status).toBe('ok');
    const [e1, e2] = r.interfaces.rows;
    expect(e1).toMatchObject({
      ifIndex: 1,
      name: 'ether1',
      alias: 'uplink',
      typeName: 'ethernetCsmacd',
      speedBps: 1_000_000_000,
      adminStatus: 'up',
      operStatus: 'up',
      counterBits: 64, // 64-bit HC counters are preferred over the 32-bit ones
      inOctets: 5_000_000_000_000n,
      outOctets: 7_000_000_000_000n,
      inErrors: 3n,
      outDiscards: 4n,
    });
    expect(e2).toMatchObject({ ifIndex: 2, name: 'ether2', operStatus: 'down', speedBps: 10_000_000_000, inOctets: 1n, outOctets: 2n });
  });

  it('keeps full precision for 64-bit counters above 2^53', async () => {
    const big = 18_000_000_000_000_000_000n; // > Number.MAX_SAFE_INTEGER
    const dev = await spawn({ interfaces: [{ index: 1, name: 'e1', inHc: big, outHc: big - 1n }] });
    const r = await poll(dev.port);
    expect(r.interfaces.rows[0]?.inOctets).toBe(big);
    expect(r.interfaces.rows[0]?.outOctets).toBe(big - 1n);
  });

  it('falls back to 32-bit counters when ifXTable is not implemented', async () => {
    const dev = await spawn({ ifX: false, interfaces: [{ index: 1, name: 'ge-0/0/1', in32: 1000, out32: 2000, speedMbps: 100 }] });
    const r = await poll(dev.port);
    expect(r.interfaces.status).toBe('ok');
    expect(r.interfaces.rows[0]).toMatchObject({ name: 'descr-ge-0/0/1', counterBits: 32, inOctets: 1000n, outOctets: 2000n, speedBps: 100_000_000 });
  });

  it('reports not_supported (not a fake number) for OIDs the device does not implement', async () => {
    const dev = await spawn({ cpuLoads: null, memory: null, interfaces: [] });
    const r = await poll(dev.port);
    expect(r.status).toBe('ok'); // the agent answers
    expect(r.cpu).toMatchObject({ status: 'not_supported', value: null });
    expect(r.memory).toMatchObject({ status: 'not_supported', value: null });
    expect(r.interfaces).toMatchObject({ status: 'not_supported', rows: [] });
    expect(r.system?.sysName).toBe('fake-router');
  });

  it('reports unavailable with the real error on SNMP timeout (nothing listening)', async () => {
    const r = await poll(await deadPort());
    expect(r.status).toBe('unavailable');
    expect(r.error).toMatch(/timed out/i);
    expect(r.system).toBeNull();
    for (const reading of [r.cpu, r.memory]) {
      expect(reading).toMatchObject({ status: 'unavailable', value: null });
      expect(reading.error).toBeTruthy();
    }
    expect(r.interfaces).toMatchObject({ status: 'unavailable', rows: [] });
  });

  it('treats a wrong v2c community as unavailable (agents silently drop it)', async () => {
    const dev = await spawn({ community: 'secret' });
    const r = await poll(dev.port, v2c('wrong'));
    expect(r.status).toBe('unavailable');
    expect(r.cpu.value).toBeNull();
  });

  it('does not crash on malformed (non-SNMP) response bytes', async () => {
    const garbage = await startGarbageResponder();
    try {
      const r = await poll(garbage.port);
      expect(['unavailable', 'error']).toContain(r.status);
      expect(r.cpu.value).toBeNull();
      expect(r.error).toBeTruthy();
    } finally {
      await garbage.stop();
    }
  });

  it('flags a malformed value (hrProcessorLoad outside 0-100) as error, never as a number', async () => {
    const dev = await spawn({ cpuLoads: [250, -5] });
    const r = await poll(dev.port);
    expect(r.cpu).toMatchObject({ status: 'error', value: null });
    expect(r.cpu.error).toMatch(/no valid values/);
    // other metrics are unaffected
    expect(r.status).toBe('ok');
    expect(r.memory.status).toBe('ok');
  });

  it('works over SNMPv3 authPriv (SHA + AES)', async () => {
    const dev = await spawn({
      v3: { name: 'monitor', authProtocol: snmp.AuthProtocols.sha, authKey: 'authpassword1', privProtocol: snmp.PrivProtocols.aes, privKey: 'privpassword1' },
      interfaces: [{ index: 1, name: 'e1' }],
    });
    const r = await poll(dev.port, {
      version: 'v3',
      username: 'monitor',
      authProtocol: 'SHA',
      authKey: 'authpassword1',
      privProtocol: 'AES',
      privKey: 'privpassword1',
    });
    expect(r.status).toBe('ok');
    expect(r.system?.sysName).toBe('fake-router');
    expect(r.interfaces.rows).toHaveLength(1);
  });

  it('reports SNMPv3 failure honestly (wrong key) instead of returning data', async () => {
    const dev = await spawn({ v3: { name: 'monitor', authProtocol: snmp.AuthProtocols.sha, authKey: 'authpassword1' } });
    const r = await poll(dev.port, { version: 'v3', username: 'monitor', authProtocol: 'SHA', authKey: 'not-the-right-key' });
    expect(r.status).not.toBe('ok');
    expect(r.cpu.value).toBeNull();
    expect(r.system).toBeNull();
  });

  it('works over SNMPv1', async () => {
    const dev = await spawn({ interfaces: [{ index: 1, name: 'e1', in32: 5, out32: 6 }] });
    const r = await poll(dev.port, { version: 'v1', community: 'public' });
    expect(r.status).toBe('ok');
    expect(r.system?.sysName).toBe('fake-router');
    expect(r.cpu.status).toBe('ok');
  });
});
