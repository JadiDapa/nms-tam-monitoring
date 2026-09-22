-- Hardening pass.
--  * SNMP availability gets its own failure/recovery thresholds (independent of reachability).
--  * Interfaces get a lifecycle (active/inactive) instead of ever being deleted, and remember whether they were
--    ever operationally UP so "never connected" ports do not raise interface-down incidents.

alter table polling_config
  add column snmp_failure_threshold integer not null default 3 check (snmp_failure_threshold between 1 and 100),
  add column snmp_recovery_threshold integer not null default 2 check (snmp_recovery_threshold between 1 and 100);

-- Existing devices keep their previous behaviour: one shared pair of thresholds applied to both machines.
update polling_config set snmp_failure_threshold = failure_threshold, snmp_recovery_threshold = recovery_threshold;

alter table interfaces
  add column active boolean not null default true,
  add column inactive_since timestamptz,
  add column last_oper_up_at timestamptz;

-- Interfaces already known to be up count as "seen up" from their last observation.
update interfaces set last_oper_up_at = last_seen_at where oper_status = 'up';

create index interfaces_active_idx on interfaces (device_id, active);
