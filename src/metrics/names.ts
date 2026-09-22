/** Canonical names of device-level metrics. Interface metrics live in interface samples (per interface). */
export const Metric = {
  IcmpLatencyMs: 'icmp_latency_ms',
  IcmpPacketLossPct: 'icmp_packet_loss_pct',
  TcpPortOpen: 'tcp_port_open', // dimension = port; value 1 open / 0 closed (refused)
  TcpConnectMs: 'tcp_connect_ms', // dimension = port
  SnmpResponseMs: 'snmp_response_ms',
  SnmpInterfaceCount: 'snmp_interface_count',
  CpuPct: 'cpu_pct',
  MemoryPct: 'memory_pct',
  SysUptimeSeconds: 'sys_uptime_seconds',
  /** total wall-clock of the probes of one poll (ICMP + TCP + SNMP run in parallel) */
  PollCollectMs: 'poll_collect_ms',
  /** SNMP packets re-sent after a per-request timeout during one poll */
  SnmpRetransmits: 'snmp_retransmits',
  /** duration of one SNMP step; dimension = system | cpu | memory | interfaces */
  SnmpStepMs: 'snmp_step_ms',
} as const;

export type MetricName = (typeof Metric)[keyof typeof Metric];

/** Metrics an alert rule may compare against a threshold. */
export const DEVICE_THRESHOLD_METRICS = [
  Metric.CpuPct,
  Metric.MemoryPct,
  Metric.IcmpLatencyMs,
  Metric.IcmpPacketLossPct,
] as const;

export const INTERFACE_THRESHOLD_METRICS = ['if_in_bps', 'if_out_bps'] as const;

export const ALL_THRESHOLD_METRICS: readonly string[] = [...DEVICE_THRESHOLD_METRICS, ...INTERFACE_THRESHOLD_METRICS];
