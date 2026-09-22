-- Monitoring engine schema, version 1.
-- Relational configuration/state lives here. Time-series style data (device_metric_samples, interface_samples)
-- is accessed ONLY through the MetricRepository so it can move to a time-series database later.

-- ---------------------------------------------------------------------------------------------------------------
-- Credentials (encrypted at rest: AES-256-GCM, see src/credentials). Never returned by the API.
-- ---------------------------------------------------------------------------------------------------------------
create table credentials (
  id uuid primary key,
  name text not null unique,
  type text not null check (type in ('snmp_v1', 'snmp_v2c', 'snmp_v3', 'telegram_bot', 'webhook_secret')),
  secret_encrypted text not null,
  key_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------------
-- Devices + per-device polling configuration
-- ---------------------------------------------------------------------------------------------------------------
create table devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  host text not null,
  device_type text not null default 'unknown'
    check (device_type in ('router', 'switch', 'firewall', 'server', 'access_point', 'gateway', 'unknown')),
  vendor text,
  model text,
  location text,
  enabled boolean not null default true,

  icmp_enabled boolean not null default true,
  tcp_ports integer[] not null default '{}',

  snmp_enabled boolean not null default false,
  snmp_credential_id uuid references credentials (id) on delete restrict,
  snmp_port integer not null default 161 check (snmp_port between 1 and 65535),

  -- Real values reported by the device itself (null until first successful SNMP poll)
  sys_name text,
  sys_descr text,
  sys_object_id text,
  snmp_profile text,
  info_updated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint devices_snmp_needs_credential check (not snmp_enabled or snmp_credential_id is not null),
  constraint devices_has_a_check check (icmp_enabled or snmp_enabled or cardinality(tcp_ports) > 0)
);
create index devices_enabled_idx on devices (enabled);

create table polling_config (
  device_id uuid primary key references devices (id) on delete cascade,
  poll_interval_sec integer not null default 30 check (poll_interval_sec between 5 and 86400),
  timeout_ms integer not null default 3000 check (timeout_ms between 200 and 60000),
  retry_count integer not null default 1 check (retry_count between 0 and 5),
  failure_threshold integer not null default 3 check (failure_threshold between 1 and 100),
  recovery_threshold integer not null default 2 check (recovery_threshold between 1 and 100),
  icmp_count integer not null default 3 check (icmp_count between 1 and 10)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Interfaces (inventory + the previous counter sample needed for rate calculation)
-- Rate state lives here, not in the metric store, so it works with any MetricRepository backend.
-- ---------------------------------------------------------------------------------------------------------------
create table interfaces (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete cascade,
  if_index integer not null,
  name text not null,
  alias text,
  if_type integer,
  if_type_name text,
  speed_bps bigint,
  admin_status text,
  oper_status text,
  monitored boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  last_counter_at timestamptz,
  last_in_octets numeric(20, 0),
  last_out_octets numeric(20, 0),
  last_counter_bits smallint,

  unique (device_id, if_index)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Device health state (two independent state machines: reachability and SNMP agent) + history
-- ---------------------------------------------------------------------------------------------------------------
create table device_state (
  device_id uuid primary key references devices (id) on delete cascade,

  reachability_state text not null default 'UNKNOWN'
    check (reachability_state in ('UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'RECOVERING')),
  reachability_failures integer not null default 0,
  reachability_successes integer not null default 0,
  reachability_since timestamptz,

  snmp_state text not null default 'UNKNOWN'
    check (snmp_state in ('UNKNOWN', 'UP', 'DEGRADED', 'DOWN', 'RECOVERING')),
  snmp_failures integer not null default 0,
  snmp_successes integer not null default 0,
  snmp_since timestamptz,

  last_poll_at timestamptz,
  last_poll_duration_ms integer,
  last_success_at timestamptz,
  last_error text,
  last_uptime_ticks bigint
);

create table device_state_history (
  id bigserial primary key,
  device_id uuid not null references devices (id) on delete cascade,
  kind text not null check (kind in ('reachability', 'snmp')),
  from_state text not null,
  to_state text not null,
  reason text,
  at timestamptz not null default now()
);
create index device_state_history_device_idx on device_state_history (device_id, at desc);

-- ---------------------------------------------------------------------------------------------------------------
-- Metric samples. status is one of: ok | unavailable | error | not_supported. value is NULL unless status = 'ok'
-- (packet loss is the exception: 100 % loss is a real measurement even when latency is unavailable).
-- ---------------------------------------------------------------------------------------------------------------
create table device_metric_samples (
  time timestamptz not null,
  device_id uuid not null references devices (id) on delete cascade,
  metric text not null,
  dimension text,
  value double precision,
  status text not null check (status in ('ok', 'unavailable', 'error', 'not_supported')),
  error text
);
create index device_metric_samples_lookup_idx on device_metric_samples (device_id, metric, time desc);
create index device_metric_samples_time_idx on device_metric_samples (time);

create table interface_samples (
  time timestamptz not null,
  device_id uuid not null references devices (id) on delete cascade,
  interface_id uuid not null references interfaces (id) on delete cascade,
  in_octets numeric(20, 0),
  out_octets numeric(20, 0),
  in_errors bigint,
  out_errors bigint,
  in_discards bigint,
  out_discards bigint,
  in_bps double precision,
  out_bps double precision,
  rate_note text,
  counter_bits smallint,
  admin_status text,
  oper_status text,
  status text not null check (status in ('ok', 'unavailable', 'error', 'not_supported')),
  error text
);
create index interface_samples_lookup_idx on interface_samples (interface_id, time desc);
create index interface_samples_device_idx on interface_samples (device_id, time desc);
create index interface_samples_time_idx on interface_samples (time);

-- ---------------------------------------------------------------------------------------------------------------
-- Notification channels
-- ---------------------------------------------------------------------------------------------------------------
create table notification_channels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null check (type in ('telegram', 'webhook', 'email')),
  config jsonb not null default '{}'::jsonb,       -- non-secret settings only (chatId, url, ...)
  credential_id uuid references credentials (id) on delete restrict,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------------------
-- Alert rules, incidents, deliveries
-- ---------------------------------------------------------------------------------------------------------------
create table alert_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  device_id uuid references devices (id) on delete cascade,     -- null = applies to every device
  condition_type text not null
    check (condition_type in ('metric_threshold', 'device_down', 'snmp_unavailable', 'interface_down')),
  metric text,
  operator text check (operator in ('>', '>=', '<', '<=', '==', '!=')),
  threshold double precision,
  severity text not null check (severity in ('info', 'warning', 'critical')),
  trigger_after integer not null default 1 check (trigger_after between 1 and 1000),
  clear_after integer not null default 1 check (clear_after between 1 and 1000),
  cooldown_sec integer not null default 0 check (cooldown_sec >= 0),
  notify_on_recovery boolean not null default true,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint alert_rules_threshold_fields check (
    condition_type <> 'metric_threshold' or (metric is not null and operator is not null and threshold is not null)
  )
);

create table alert_rule_channels (
  rule_id uuid not null references alert_rules (id) on delete cascade,
  channel_id uuid not null references notification_channels (id) on delete cascade,
  primary key (rule_id, channel_id)
);

-- Persistent debounce counters so a restart does not reset "3 consecutive breaches" logic.
create table alert_condition_state (
  rule_id uuid not null references alert_rules (id) on delete cascade,
  device_id uuid not null references devices (id) on delete cascade,
  subject_key text not null default '',            -- '' for device-level, interface uuid for interface-level
  consecutive_breaches integer not null default 0,
  consecutive_ok integer not null default 0,
  last_value double precision,
  last_evaluated_at timestamptz,
  primary key (rule_id, device_id, subject_key)
);

create table incidents (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid references alert_rules (id) on delete set null,
  rule_name text not null,
  device_id uuid not null references devices (id) on delete cascade,
  interface_id uuid references interfaces (id) on delete set null,
  subject_key text not null default '',
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'OPEN' check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  title text not null,
  metric text,
  value double precision,
  threshold double precision,
  error text,
  triggered_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at timestamptz,
  resolution_reason text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
-- The database itself refuses a second active incident for the same condition.
create unique index incidents_one_active_per_condition
  on incidents (rule_id, device_id, subject_key)
  where status <> 'RESOLVED';
create index incidents_status_idx on incidents (status, triggered_at desc);
create index incidents_device_idx on incidents (device_id, triggered_at desc);

-- One row per delivery ATTEMPT. A failed attempt stays FAILED; a retry is a new PENDING row (attempt + 1).
create table notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents (id) on delete cascade,
  channel_id uuid references notification_channels (id) on delete set null,
  channel_type text not null,
  event text not null check (event in ('triggered', 'recovered')),
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED')),
  attempt integer not null default 1,
  scheduled_at timestamptz not null default now(),
  locked_until timestamptz,
  attempted_at timestamptz,
  sent_at timestamptz,
  error_code text,
  error text,
  response_status integer,
  created_at timestamptz not null default now()
);
create index notification_deliveries_due_idx on notification_deliveries (scheduled_at) where status = 'PENDING';
create index notification_deliveries_incident_idx on notification_deliveries (incident_id, created_at);
