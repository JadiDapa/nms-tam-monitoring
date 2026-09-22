-- Legacy interface_down rules.
--
-- Before migration 002 the default debounce for interface_down was 1/1, i.e. NO debounce (the other rule types
-- are debounced by the health state machines; interface_down was not). Since 002 the default is 2/2.
--
-- Only rules that match ALL of these are converted to 2/2:
--   * condition_type = 'interface_down'
--   * trigger_after = 1 AND clear_after = 1        (the old default; any other value was set on purpose)
--   * created BEFORE migration 002 was applied     (rules created afterwards got the new default or an explicit value,
--                                                   so a 1/1 there is a deliberate choice and is left alone)
-- device_down / snmp_unavailable rules keep 1/1 on purpose (already debounced by the state machines) and
-- metric_threshold rules keep whatever they have.
--
-- Limitation: a client that explicitly chose 1/1 for an interface_down rule before 002 cannot be told apart from the
-- old default. Re-apply it with PATCH /alerts/:id if 1/1 is really wanted; the update is preserved from then on.
--
-- Debounce counters accumulated under the old thresholds no longer describe the new ones, so they are reset for the
-- converted rules only (open incidents are not touched).
with converted as (
  update alert_rules
     set trigger_after = 2,
         clear_after = 2,
         updated_at = now()
   where condition_type = 'interface_down'
     and trigger_after = 1
     and clear_after = 1
     and created_at < coalesce((select applied_at from schema_migrations where name = '002_hardening.sql'), '-infinity'::timestamptz)
  returning id
)
delete from alert_condition_state
 where rule_id in (select id from converted);
