import dgram from 'node:dgram';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemPingProbe } from '../src/collectors/icmp/system-ping.js';
import { SnmpCollector } from '../src/collectors/snmp/collector.js';
import { NetTcpProbe } from '../src/collectors/tcp/tcp-probe.js';
import type { SnmpAuth } from '../src/credentials/schemas.js';
import { deadPort, FakeSnmpDevice } from './helpers/fake-snmp-device.js';

const v2c: SnmpAuth = { version: 'v2c', community: 'public' };

/**
 * A UDP proxy in front of a real SNMP agent that DROPS the first `dropFirst` requests. This produces genuine packet
 * loss on the wire: the SNMP client has to time out and retransmit exactly as it does against a lossy router.
 */
async function lossyProxy(targetPort: number, dropFirst: number) {
  const sock = dgram.createSocket('udp4');
  const upstream = dgram.createSocket('udp4');
  let seen = 0;
  let dropped = 0;
  const clients = new Map<string, { port: number; address: string }>();
  sock.on('message', (msg, rinfo) => {
    seen++;
    if (seen <= dropFirst) {
      dropped++;
      return;
    }
    clients.set('c', { port: rinfo.port, address: rinfo.address });
    upstream.send(msg, targetPort, '127.0.0.1');
  });
  upstream.on('message', (msg) => {
    const c = clients.get('c');
    if (c) sock.send(msg, c.port, c.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
  return {
    port: sock.address().port,
    stats: () => ({ seen, dropped }),
    stop: async () => {
      await new Promise<void>((r) => sock.close(() => r()));
      await new Promise<void>((r) => upstream.close(() => r()));
    },
  };
}

let stoppers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stoppers.map((s) => s()));
  stoppers = [];
});
const agent = async () => {
  const d = await new FakeSnmpDevice({ interfaces: [{ index: 1, name: 'e1', speedMbps: 1000 }] }).start();
  stoppers.push(() => d.stop());
  return d;
};

const collector = new SnmpCollector();

describe('SNMP retries and diagnostics against real packet loss', () => {
  it('healthy agent: 0 retransmits, 0 timeouts, and a duration for every step', async () => {
    const d = await agent();
    const r = await collector.poll({ host: '127.0.0.1', port: d.port, auth: v2c }, { timeoutMs: 500, retries: 2 });
    expect(r.status).toBe('ok');
    expect(r.retransmits).toBe(0);
    expect(r.timeouts).toBe(0);
    for (const k of ['systemMs', 'cpuMs', 'memoryMs', 'interfacesMs'] as const) {
      expect(r.timings[k], k).not.toBeNull();
      expect(r.timings[k]!).toBeGreaterThanOrEqual(0);
    }
  });

  it('a dropped request is retransmitted and the poll still succeeds; retransmits are counted, and cost one timeout each', async () => {
    const d = await agent();
    const proxy = await lossyProxy(d.port, 2); // first two datagrams vanish
    stoppers.push(proxy.stop);
    const r = await collector.poll({ host: '127.0.0.1', port: proxy.port, auth: v2c }, { timeoutMs: 300, retries: 3 });

    expect(proxy.stats().dropped).toBe(2);
    expect(r.status).toBe('ok'); // the retries rescued it
    expect(r.error).toBeNull();
    expect(r.retransmits).toBe(2); // exactly the two dropped packets were re-sent
    expect(r.timeouts).toBe(0); // no operation ultimately failed
    expect(r.timings.systemMs!).toBeGreaterThanOrEqual(2 * 300 - 30); // two timeout periods were burnt on the first request
    expect(r.responseMs!).toBeGreaterThanOrEqual(2 * 300 - 30);
    expect(r.system?.sysName).toBe('fake-router'); // and the data is real
  });

  it('with retries = 0 the same loss is an honest failure (no retransmit, unavailable, null metrics)', async () => {
    const d = await agent();
    const proxy = await lossyProxy(d.port, 1);
    stoppers.push(proxy.stop);
    const r = await collector.poll({ host: '127.0.0.1', port: proxy.port, auth: v2c }, { timeoutMs: 300, retries: 0 });
    expect(r.status).toBe('unavailable');
    expect(r.retransmits).toBe(0);
    expect(r.timeouts).toBe(1);
    expect(r.cpu).toMatchObject({ status: 'unavailable', value: null });
  });

  it('total loss: retries are exhausted, exactly `retries` retransmits are made, then it fails (bounded, not endless)', async () => {
    const d = await agent();
    const proxy = await lossyProxy(d.port, 1_000_000);
    stoppers.push(proxy.stop);
    const t0 = Date.now();
    const r = await collector.poll({ host: '127.0.0.1', port: proxy.port, auth: v2c }, { timeoutMs: 200, retries: 2 });
    expect(r.status).toBe('unavailable');
    expect(r.retransmits).toBe(2);
    expect(r.timeouts).toBe(1);
    expect(proxy.stats().seen).toBe(3); // 1 original + 2 retransmissions, then it stopped
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('after the first timeout the remaining steps are skipped instead of stacking more timeouts', async () => {
    const d = await agent();
    const r = await collector.poll({ host: '127.0.0.1', port: await deadPort(), auth: v2c }, { timeoutMs: 200, retries: 1 });
    expect(r.status).toBe('unavailable');
    expect(r.timings.cpuMs).toBeNull();
    expect(r.timings.memoryMs).toBeNull();
    expect(r.timings.interfacesMs).toBeNull();
    void d;
  });
});

describe('cancellation', () => {
  it('aborting an SNMP poll returns promptly (does not wait for the 5 s x 4 timeouts)', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    const t0 = Date.now();
    const r = await collector.poll({ host: '127.0.0.1', port: await deadPort(), auth: v2c }, { timeoutMs: 5000, retries: 3, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.status).toBe('unavailable');
    expect(r.error).toMatch(/abort/i);
    expect(r.cpu.value).toBeNull();
  });

  it('aborting a running ping kills the process immediately', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const t0 = Date.now();
    // TEST-NET-1 never answers: an un-aborted burst of 5 x 3 s would take 15+ s
    const r = await new SystemPingProbe().ping('192.0.2.55', { count: 5, timeoutMs: 3000, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.status).toBe('error');
    expect(r.error).toBe('Aborted');
    expect(r.packetLossPct).toBeNull(); // an aborted probe has no loss figure: nothing is invented
  });

  it('an already-aborted signal starts nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await new SystemPingProbe().ping('127.0.0.1', { count: 1, timeoutMs: 500, signal: ac.signal });
    expect(r.error).toBe('Aborted');
  });

  it('aborting a TCP check closes the socket', async () => {
    const server = net.createServer(() => undefined); // accepts but the test targets a black hole instead
    server.close();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const [res] = await new NetTcpProbe().check('192.0.2.55', [22], { timeoutMs: 5000, retries: 3, signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(res).toMatchObject({ status: 'error', error: 'Aborted', latencyMs: null });
  });
});
