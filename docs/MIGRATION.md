# Migration from the NetPulse prototype (`nms-refs-new`)

The prototype's monitor was inspected file by file (`server/monitor.ts`, `snmp.ts`, `network.ts`, `notifications.ts`,
and the routes in `server.ts`) before this engine was written. This document records what was kept, what was rebuilt,
what was deliberately removed, and what is new.

```
Existing functionality ──► Reused ──► Redesigned ──► Removed ──► New
```

## 1. What was genuinely real in the prototype

| Area | Verdict |
|---|---|
| ICMP via the OS `ping` | **Real** (but parsed with English-only/Windows-only regexes) |
| TCP connect check | **Real** |
| SNMP v1/v2c/v3 GET + walks through `net-snmp` | **Real** and well chosen |
| CPU via `hrProcessorLoad`, memory via `hrStorage`, interface table, 64-bit `ifHC*` counters, `ifHighSpeed` | **Real**, good OID strategy |
| Telegram Bot API call | **Real** |
| Webhook POST with HMAC signature | **Real** |
| SQLite persistence | Real, but not what production needs |

## 2. Reused (idea and OID strategy carried over)

| From the prototype | Where it lives now |
|---|---|
| Standard OIDs (sysDescr/sysUpTime/sysName, hrProcessorLoad, hrStorage, IF-MIB, ifXTable) | `src/collectors/snmp/oids.ts` |
| v1/v2c/v3 session creation and v3 security-level derivation | `src/collectors/snmp/client.ts` (`createSession`) |
| Preference for 64-bit `ifHC*` counters with a 32-bit fallback | `src/collectors/snmp/interfaces.ts` (per interface) |
| `ifHighSpeed` preferred over the saturating `ifSpeed` | `interfaces.ts` (`speedBps`) |
| Counter64 arrives as a big-endian Buffer | `src/collectors/snmp/codec.ts` (now kept as `BigInt`) |
| Delta-based traffic rate idea | `src/metrics/traffic.ts` (rewritten, see below) |
| Telegram / signed-webhook delivery | `src/notifications/telegram.ts`, `webhook.ts` |
| TCP fallback for "is it alive" | `src/collectors/tcp/tcp-probe.ts` |

## 3. Redesigned (same goal, different and safer design)

| Prototype behaviour | Problem | New design |
|---|---|---|
| One `setInterval(5s)` looping over every device sequentially | Slow devices delay everyone; cycles overlap; per-device interval and timeout ignored | `src/scheduler/`: per-device schedule, no overlapping polls per device, bounded worker pool, hard poll timeout, graceful shutdown |
| A device is offline after one missed ping | Flapping, false outages | `src/devices/health-state.ts`: `UP → DEGRADED → DOWN → RECOVERING → UP` with `failureThreshold` / `recoveryThreshold`; separate machine for SNMP so "reachable but SNMP dead" is representable |
| 15 parallel subtree walks per device per poll | Heavy on the router | Two bulk table reads (`ifTable`, `ifXTable`) plus CPU/storage reads |
| Errors swallowed in walks | Partial data looked complete | Errors propagate; a hard per-operation deadline prevents hangs (found by testing against a real agent) |
| "Total bandwidth" = sum of all interfaces | Counts the same traffic on bridge, VLAN and port several times | **Per-interface** rates only; aggregation is left to the UI |
| 32-bit wrap arithmetic applied to 64-bit counters | Wrong values | Wrap handled only for 32-bit counters, verified against link speed; 64-bit decrease = reset; reboot detected from `sysUpTime` |
| First sample and failures got random/previous values | Fake data | First sample `rate = null` with a reason (`first_sample`, `counter_reset`, `device_reboot`, …) |
| Alert severity chosen from CPU/latency regardless of the rule | Wrong severities | Severity comes from the rule and only the rule |
| Alerting inside the polling loop | Coupled, untestable | `PollSnapshot → AlertEvaluator → IncidentManager → NotificationService` (collection is separate from evaluation) |
| Per-rule 3-minute in-memory cooldown | Lost on restart, no incident concept | Persistent debounce counters, persistent incidents, cooldown after resolution |
| Ping parsing by locale-specific text ("Received =", "kehilangan") | Breaks on other languages/OSes | Reply detection by `TTL=<n>` and latency by `=<n>ms`; hostname resolved by the engine, not by `ping` |
| Ping host "sanitised" by stripping characters | Weak | Strict host validation, resolved by the engine, passed as a single argv element (no shell) |
| SQLite, everything in one file | Not multi-service | PostgreSQL (own schema) behind a `Database` interface; metrics behind a `MetricRepository` |
| Plain-text SNMP communities / Telegram tokens | Secret exposure | AES-256-GCM at rest, write-only API, redacted logs |
| Alert history status hard-coded to "delivered" | Misleading | One row per delivery **attempt**: `PENDING / SENT / FAILED` with the real error |
| HTML injected into Telegram from device names | Markup injection | All dynamic values HTML-escaped |

## 4. Removed (deliberately not carried over)

| Removed | Why |
|---|---|
| **All simulation / random jitter** for CPU, memory, bandwidth, latency | The engine must never invent a value. Missing data is `null` + `unavailable` + the real error |
| Simulated health for private IPs (`10.x`, `192.168.99.x`) that did not answer | Fake "healthy" |
| Hard-coded `dev-04` special case | Test scaffolding |
| Add-device flow that saved unreachable devices as "online" with latency 2.5 ms | Fake success. `POST /devices/test` now returns the real result and the caller decides |
| `POST /devices/:id/restart` and interface toggle that only edited the database and logged "soft reload executed" | Misleading; the engine is a monitor, not a device controller |
| Fake email success (`dispatchEmailTest`) | Email now returns `NOT_IMPLEMENTED` and is recorded as `FAILED` |
| Unauthenticated `/tools/ping`, `/tools/probe`, `/discovery/scan` | An open network scanner. Not exposed; probing exists only as the authenticated, concurrency-limited `POST /devices/test` |
| Subnet discovery that guessed vendor/type from the last IP octet ("router → Cisco") | Invented data. Vendor identity comes from `sysDescr`/`sysObjectID` |
| Mock REST endpoints returning hard-coded JSON | Replaced by real endpoints |
| Gemini AI log analysis / reports | Out of scope for the engine (belongs in the application layer) |
| Topology hand-placement, UI, API-key management screens | UI concerns; the engine has no UI |

## 5. Hardening pass (changes after the first live test)

Found by running the first version against two real MikroTik routers, then fixed:

| First version | Problem seen live | Now |
|---|---|---|
| Next poll reserved at `start + interval` | A 16 s poll (15 s interval) was followed 3 s later by another poll | `next = start + interval` only if the poll finished within the interval, else `finish + interval` (no back-to-back / catch-up polls) |
| `interface_down` = admin up + oper down | 15 critical incidents on unused ports of one router, 1 on the other | Requires the interface to have been **seen up**, confirmed for 2 polls, resolves after 2 UP polls |
| One failure/recovery threshold pair for both machines | SNMP could not be tuned independently | Separate `snmpFailureThreshold` / `snmpRecoveryThreshold` |
| Missing interfaces were only "last seen" | No lifecycle | `active`/`inactive` with reactivation; counters restart on reappearance |
| Abort only discarded results | Collectors kept running after a timeout/shutdown | Abort cancels ping, TCP and SNMP immediately |
| Slow polls could only be seen as a total | Could not tell retries from slow OIDs | Real retransmit/timeout counts and per-step timings |
| Delivery status `PENDING/SENT/FAILED` rows | "Retrying" had to be inferred | API summary phases `REQUESTED / SENT / RETRYING / FAILED` |

Upgrade notes (migration `002_hardening.sql`, applied automatically):

* existing devices keep their behaviour: the SNMP thresholds are initialised from their existing reachability thresholds;
* alert rules created **before** this change keep their stored `triggerAfter/clearAfter` (1/1). The "must have been seen up" gate already
  removes the false alerts; set them to 2/2 with `PATCH /alerts/:id` to also get the new debounce;
* interfaces currently reporting up are treated as "seen up" from their last observation.

### Migration 003: legacy `interface_down` rules

Before 002 the default debounce for `interface_down` was 1/1, i.e. **no** debounce. That was an oversight (the other rule types are
debounced by the health state machines and their 1/1 is intentional). Since 002 the default is 2/2. `003_legacy_interface_down_debounce.sql`
converts a rule to 2/2 only if **all** of these hold: `condition_type = 'interface_down'`, `trigger_after = 1 AND clear_after = 1`,
and it was created **before** migration 002 was applied. It does **not** touch:

* any other rule type (`device_down` / `snmp_unavailable` stay 1/1 by design; `metric_threshold` keeps its values),
* any `interface_down` rule with another value (customised on purpose),
* any rule created after 002 (a 1/1 there is an explicit choice).

Limitation: a client that explicitly chose 1/1 for an `interface_down` rule before 002 is indistinguishable from the old default.
Set it again with `PATCH /alerts/:id` if 1/1 is wanted; it is preserved from then on (the migration runs once).
The debounce counters of converted rules are reset; open incidents are untouched. In the real deployment there were **0** rules
when 003 was applied, so nothing was converted; the behaviour is covered by `tests/migration-legacy-rules.test.ts` on a staged database.

## 6. New (did not exist in the prototype)

- Health state machines with thresholds (reachability and SNMP separately) + state history
- Persistent **incidents** (`OPEN → ACKNOWLEDGED → RESOLVED`), one active incident per condition enforced by the database, recovery notifications, cooldown
- Alert rule types: metric threshold, device down, SNMP unavailable, interface down
- Notification **delivery log** with attempts, exponential-backoff retry, `NOT_IMPLEMENTED` for email
- SSRF-safe outbound HTTP (private/loopback/metadata addresses blocked at connect time; redirects not followed)
- Encrypted credential store with key rotation
- Authenticated internal REST API, request validation, structured logs with secret redaction
- Vendor **profile** extension point (`src/collectors/snmp/profiles/`)
- `MetricRepository` port (PostgreSQL implementation now, time-series later)
- Per-interface raw counters (`BigInt`) and derived rates with explicit reasons when a rate is unavailable
- Retention job, migrations, 310 automated tests (real SNMP agent, real ICMP/TCP, real HTTP, real engine process with OS signals, embedded PostgreSQL)
