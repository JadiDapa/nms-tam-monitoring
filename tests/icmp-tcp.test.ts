import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { parsePingOutput, summarizeLatency } from '../src/collectors/icmp/parse.js';
import { isValidTarget, SystemPingProbe } from '../src/collectors/icmp/system-ping.js';
import { NetTcpProbe, tcpShowsHostAlive } from '../src/collectors/tcp/tcp-probe.js';

describe('ping output parsing (locale independent)', () => {
  it('Windows English', () => {
    const out = [
      'Pinging 10.0.0.1 with 32 bytes of data:',
      'Reply from 10.0.0.1: bytes=32 time=12ms TTL=54',
      'Reply from 10.0.0.1: bytes=32 time=14ms TTL=54',
      'Request timed out.',
      'Reply from 10.0.0.1: bytes=32 time<1ms TTL=54',
      'Packets: Sent = 4, Received = 3, Lost = 1 (25% loss)',
    ].join('\r\n');
    const p = parsePingOutput(out, 4);
    expect(p.received).toBe(3);
    expect(p.latenciesMs).toEqual([12, 14, 1]);
  });

  it('Windows Indonesian', () => {
    const out = [
      'Membalas dari 10.0.0.1: bytes=32 waktu=8ms TTL=62',
      'Waktu permintaan habis.',
      'Membalas dari 10.0.0.1: bytes=32 waktu=10ms TTL=62',
      'Paket: Terkirim = 3, Diterima = 2, Hilang = 1 (33% hilang)',
    ].join('\r\n');
    const p = parsePingOutput(out, 3);
    expect(p.received).toBe(2);
    expect(p.latenciesMs).toEqual([8, 10]);
  });

  it('Linux with fractional milliseconds', () => {
    const out = [
      'PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.',
      '64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms',
      '64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=11.9 ms',
      '--- 1.1.1.1 ping statistics ---',
      '2 packets transmitted, 2 received, 0% packet loss, time 1001ms',
    ].join('\n');
    const p = parsePingOutput(out, 2);
    expect(p.received).toBe(2);
    expect(p.latenciesMs).toEqual([12.3, 11.9]);
  });

  it('comma decimal separators', () => {
    expect(parsePingOutput('64 bytes from x: ttl=64 time=0,412 ms', 1).latenciesMs).toEqual([0.412]);
  });

  it('router error replies are NOT counted as replies', () => {
    const out = [
      'Reply from 192.168.1.1: Destination host unreachable.',
      'Reply from 192.168.1.1: TTL expired in transit.',
      'Request timed out.',
    ].join('\r\n');
    expect(parsePingOutput(out, 3).received).toBe(0);
  });

  it('duplicate replies cannot exceed packets sent', () => {
    const line = '64 bytes from x: icmp_seq=1 ttl=64 time=1.0 ms (DUP!)';
    expect(parsePingOutput([line, line, line].join('\n'), 2).received).toBe(2);
  });

  it('summarises latency', () => {
    expect(summarizeLatency([10, 20, 30])).toEqual({ min: 10, avg: 20, max: 30 });
    expect(summarizeLatency([])).toEqual({ min: null, avg: null, max: null });
  });
});

describe('ping target validation', () => {
  it.each(['10.0.0.1', '2001:db8::1', 'router-1.example.com', 'host'])('accepts %s', (h) => expect(isValidTarget(h)).toBe(true));
  it.each(['-c 1000000', '--help', '10.0.0.1; rm -rf /', '$(id)', 'a b', '', '-f'])('rejects %j', (h) => expect(isValidTarget(h)).toBe(false));
});

describe('real ICMP through the OS ping', () => {
  const probe = new SystemPingProbe();

  it('loopback is reachable, with real latency and 0% loss', async () => {
    const r = await probe.ping('127.0.0.1', { count: 2, timeoutMs: 1000 });
    expect(r.status).toBe('ok');
    expect(r.reachable).toBe(true);
    expect(r.received).toBe(2);
    expect(r.packetLossPct).toBe(0);
    expect(r.avgMs).not.toBeNull();
    expect(r.error).toBeNull();
  });

  it('a non-answering address is unavailable with 100% loss (a real measurement) and NO fabricated latency', async () => {
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): guaranteed not to answer
    const r = await probe.ping('192.0.2.1', { count: 1, timeoutMs: 400 });
    expect(r.status).toBe('unavailable');
    expect(r.reachable).toBe(false);
    expect(r.packetLossPct).toBe(100);
    expect(r.avgMs).toBeNull();
    expect(r.error).toMatch(/no echo reply/i);
  });

  it('rejects a malicious host without spawning anything', async () => {
    const r = await probe.ping('-c 100000 127.0.0.1', { count: 1, timeoutMs: 300 });
    expect(r.status).toBe('error');
    expect(r.error).toBe('Invalid host');
  });

  it('reports DNS failure as an error, not as "down"', async () => {
    const r = await probe.ping('this-host-does-not-exist.invalid', { count: 1, timeoutMs: 300 });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/DNS resolution failed/);
  });
});

describe('TCP checks', () => {
  const probe = new NetTcpProbe();
  const listen = () =>
    new Promise<net.Server>((resolve) => {
      const s = net.createServer((sock) => sock.end());
      s.listen(0, '127.0.0.1', () => resolve(s));
    });

  it('open port with real connect latency', async () => {
    const s = await listen();
    try {
      const port = (s.address() as net.AddressInfo).port;
      const [r] = await probe.check('127.0.0.1', [port], { timeoutMs: 500, retries: 0 });
      expect(r).toMatchObject({ port, status: 'open', error: null });
      expect(r!.latencyMs).not.toBeNull();
      expect(tcpShowsHostAlive(r!)).toBe(true);
    } finally {
      s.close();
    }
  });

  it('closed port: refused = the host is alive but nothing listens', async () => {
    const s = await listen();
    const port = (s.address() as net.AddressInfo).port;
    await new Promise((r) => s.close(r));
    const [r] = await probe.check('127.0.0.1', [port], { timeoutMs: 500, retries: 0 });
    expect(r!.status).toBe('closed');
    expect(tcpShowsHostAlive(r!)).toBe(true);
  });

  it('filtered / unreachable host times out with null latency', async () => {
    const [r] = await probe.check('192.0.2.1', [22], { timeoutMs: 300, retries: 0 });
    expect(['timeout', 'error']).toContain(r!.status);
    expect(r!.latencyMs).toBeNull();
    expect(tcpShowsHostAlive(r!)).toBe(false);
  });

  it('checks several ports independently', async () => {
    const s = await listen();
    try {
      const open = (s.address() as net.AddressInfo).port;
      const results = await probe.check('127.0.0.1', [open, 1], { timeoutMs: 500, retries: 0 });
      expect(results.map((r) => r.status)).toEqual(['open', 'closed']);
    } finally {
      s.close();
    }
  });
});
