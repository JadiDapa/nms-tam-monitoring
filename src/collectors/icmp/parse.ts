export interface ParsedPing {
  received: number;
  latenciesMs: number[];
}

// A genuine echo reply always carries a TTL value ("TTL=54" on Windows, "ttl=57" on Linux/macOS), in any UI language.
// Error lines from routers ("Destination host unreachable", "TTL expired in transit") do not have "TTL=<digits>".
const REPLY_LINE = /\bttl\s*[=:]\s*\d+/i;
// "time=12.3 ms", "time<1ms", "waktu=3ms", "zeit=3ms": locale independent because we only anchor on "=|<" + number + "ms".
const LATENCY = /[=<]\s*(\d+(?:[.,]\d+)?)\s*ms\b/i;

/**
 * Extract replies and latencies from `ping` output. Windows can only report whole milliseconds and prints
 * "<1ms" for faster replies; that is recorded as 1 ms (an upper bound), never as an invented sub-millisecond value.
 */
export function parsePingOutput(output: string, sent: number): ParsedPing {
  const latenciesMs: number[] = [];
  let received = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!REPLY_LINE.test(line)) continue;
    received += 1;
    const m = LATENCY.exec(line);
    if (m) {
      const v = Number(m[1]!.replace(',', '.'));
      if (Number.isFinite(v)) latenciesMs.push(v);
    }
  }
  // Duplicate replies (Linux "DUP!") must not push loss below zero.
  return { received: Math.min(received, sent), latenciesMs };
}

export function summarizeLatency(values: number[]): { min: number | null; avg: number | null; max: number | null } {
  if (values.length === 0) return { min: null, avg: null, max: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, avg: Math.round(avg * 1000) / 1000, max };
}
