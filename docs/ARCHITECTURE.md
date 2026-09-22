# Architecture

## Overview

```
                Next.js (dashboard / admin)            ← owns users, clients, tiers, UI
                          │  HTTPS/HTTP + API key
                ┌─────────▼──────────────────────────────────────────────┐
                │ Monitoring Engine (this project, no UI)                 │
                │                                                         │
                │  API ─ validate ─► services                             │
                │                                                         │
                │  Scheduler ──► WorkerPool ──► PollService               │
                │                                 │  ICMP ┐               │
                │                                 │  TCP  ├ collectors    │
                │                                 │  SNMP ┘ (+ profiles)  │
                │                                 ▼                       │
                │            Health state machines · Metric storage       │
                │                                 │  PollSnapshot         │
                │                                 ▼                       │
                │      AlertEvaluator ─► IncidentManager ─► deliveries    │
                │                                              │          │
                │                          NotificationWorker ─┴► Telegram│
                │                                                 Webhook │
                └───────────────┬──────────────────────────────────────────┘
                                │
                         PostgreSQL (schema `nms_monitoring`)
```

The engine runs on its own (`npm start`). It needs only PostgreSQL. Next.js is just an HTTP client.

## Module map

| Path | Responsibility |
|---|---|
| `src/scheduler/` | Per-device next-due schedule, no-overlap, bounded `WorkerPool`, hard timeout, graceful stop |
| `src/collectors/icmp` | Reachability, latency, packet loss (OS `ping`, behind the `IcmpProbe` interface, abortable) |
| `src/collectors/tcp` | TCP connect checks (open / closed / timeout), abortable |
| `src/collectors/snmp` | `net-snmp` client (retransmit counting, cancellation), standard MIB collection, interface table, **profiles** |
| `src/devices` | Device config, `PollService` (orchestrates one poll), health state machine, interface inventory + lifecycle, stateless `DeviceTester` |
| `src/metrics` | `MetricRepository` port, PostgreSQL implementation, traffic-rate maths |
| `src/alerts` | Pure rule evaluation, incident lifecycle, rule CRUD |
| `src/notifications` | Providers (Telegram, webhook, email stub), delivery worker with retry, channels, SSRF-safe HTTP |
| `src/credentials` | AES-256-GCM `SecretBox`, credential service |
| `src/api` | Fastify app, auth, routes (no business logic) |
| `src/database`, `migrations/` | `Database` abstraction, SQL migration runner, schema |

## Scheduler

**Model.** One 1-second tick, but every device has its **own next-due time**. It is not a "poll everything every N seconds" loop.

| Rule | Behaviour |
|---|---|
| Per-device interval | `pollIntervalSec` (5 s – 24 h) per device |
| One active poll per device | A device is never polled while one of its polls is running (scheduled and manual polls share it) |
| Bounded concurrency | At most `SCHEDULER_CONCURRENCY` (default 20) polls run at once; the rest wait in a FIFO queue |
| Next-due time | Recomputed when a poll **finishes** (below) |
| First poll | Spread over the interval by a deterministic hash of the device id (no thundering herd) |
| Hard timeout | A poll running longer than `POLL_HARD_TIMEOUT_MS` (default 60 s) is aborted: collectors are cancelled (ping killed, SNMP requests failed, sockets closed) and its result is discarded |
| Graceful shutdown | Stop scheduling → wait for running polls up to `SHUTDOWN_TIMEOUT_MS` → abort the rest |

**After a poll finishes** (success, failure or timeout alike):

```
poll took <  interval :  next = poll START  + interval     steady cadence, no drift
poll took >= interval :  next = poll FINISH + interval     missed slots are SKIPPED, never caught up
```

Examples with `interval = 15 s`:

| Poll duration | Polls start at (s) | Notes |
|---|---|---|
| 5 s | 0, 15, 30, 45 … | normal |
| 15 s (== interval) | 0, 30, 60 … | a full interval of quiet after it |
| 16 s | 0, 31, 62 … | **no back-to-back poll** (this was the bug: the old rule started the next poll ~1 s after) |
| 20 s | 0, 35, 70 … | |
| 40 s (> 2× interval) | 0, 55, 110 … | one poll, then quiet: no burst of catch-up polls |

These exact sequences are asserted by `tests/scheduler-semantics.test.ts` (deterministic fake clock). Re-enabling the old rule makes 4 of those tests fail.

## Graceful shutdown

Implemented in `src/lifecycle.ts` (shared by `src/main.ts` and the shutdown tests).

**Signals**

| Signal | Delivered when | Windows | Linux / macOS |
|---|---|---|---|
| `SIGINT` | Ctrl+C | yes | yes |
| `SIGTERM` | `kill`, systemd, Docker/PM2 stop | **impossible**: a Windows "kill" is `TerminateProcess`, the process gets no chance to clean up | yes |
| `SIGBREAK` | Ctrl+Break, console window closed | yes | n/a |
| `SIGHUP` | terminal closed | (console close) | yes |

On Windows, run the engine in a console (or under a wrapper that sends Ctrl+C / Ctrl+Break on stop) to get a graceful shutdown. A service manager that simply terminates the process skips it; the engine is still safe (state is only written at the end of a poll, in one transaction) but polls in progress are lost and connections are closed by the OS.

**Sequence and policy**

1. `shutdown_requested`: the HTTP server stops accepting new connections **immediately**; the scheduler stops creating polls.
2. **Running polls get up to `SHUTDOWN_TIMEOUT_MS` (default 30 s) to finish** and are persisted normally (`scheduler_stopped clean=true`).
3. Polls still running after that are **aborted**: ping processes are killed, TCP sockets destroyed, SNMP requests failed and sockets closed, results discarded (`scheduler_stopped clean=false`).
4. Requests that were waiting for those polls are answered (`502 POLL_FAILED` for an aborted one) and the HTTP server drains; connections that went idle are closed repeatedly, anything still open after 3 s is force-closed.
5. The notification worker stops; the PostgreSQL pool closes.
6. `shutdown_complete` is logged with `exitCode` and `activeResources` (still-active libuv handles after a short settle; `{}` or only stdio pipes means nothing leaked), then the process exits **0**. Exit code 1 only for fatal errors or a failed step; a safety-net timer force-exits (code 1) `SHUTDOWN_TIMEOUT_MS + 5 s` after the request.

Fixed by the acceptance pass: the scheduler's shutdown budget timer was never cleared (it kept the process alive after a clean stop), and an in-flight `POST /devices/:id/poll` could deadlock the HTTP close against the scheduler stop until the force-exit fired.

## Timeouts and retries

Configured per device (`polling_config`), with these defaults: `timeoutMs = 3000`, `retryCount = 1`, `icmpCount = 3`.

| Protocol | Timeout | Retry |
|---|---|---|
| ICMP | `timeoutMs` per echo; a burst of `icmpCount` echoes | A burst with **zero** replies is repeated up to `retryCount` times. A burst with some replies is a real measurement (e.g. 33 % loss) and is **not** retried |
| TCP | `timeoutMs` per connect | Timeouts/errors retried up to `retryCount`; a refusal is a definitive answer and is never retried |
| SNMP | `timeoutMs` per request; each multi-request operation also has a deadline of `max(5 s, 4 × timeoutMs × (retries + 1))` | net-snmp re-sends a request after each timeout, up to `retryCount` times. Each re-send is counted (`snmp_retransmits`) |
| Whole poll | `POLL_HARD_TIMEOUT_MS` | none: the next poll is one interval later |

* After the first SNMP timeout in a poll, the remaining SNMP steps are **skipped** (marked unavailable) instead of stacking more timeouts.
* Cost model: every SNMP retransmit costs one full `timeoutMs`. `snmp_retransmits × timeoutMs` is the time lost to (probably) dropped UDP packets. Slow-but-answered requests (e.g. 400 ms) cost no retransmit.

### Poll diagnostics (real measurements, stored as metrics)

`poll_collect_ms` (total collection time), `snmp_retransmits`, and `snmp_step_ms` with dimension `system | cpu | memory | interfaces`. A step that never ran has no sample (not a made-up 0). The `poll_completed` log line carries the same numbers.

## One poll, step by step

1. **Scheduler** decides a device is due (never twice at once) and submits a job to the worker pool.
2. **PollService** loads the device + polling config, decrypts the SNMP credential (in memory only).
3. ICMP, TCP and SNMP run in parallel with the device's own `timeout` and `retryCount`, all cancellable.
4. Results become **metric samples**. Only genuinely measured values get `status = ok`; everything else is
   `unavailable | error | not_supported` with `value = null` and the real error text.
5. One database transaction: interface inventory + counter state + lifecycle, both health state machines, device identity
   (`sysName`/`sysDescr`/…, only when the device reported them), poll bookkeeping. **An aborted poll writes nothing.**
6. Samples are appended to the metric store (a storage failure is logged but does not hide the health verdict).
7. A `PollSnapshot` goes to the **AlertEvaluator**, which produces verdicts (`breach | ok | unknown`) per rule and subject.
8. **IncidentManager** turns verdicts into persistent incidents and queues notification deliveries in the same transaction.
9. The **NotificationWorker** sends deliveries, recording every attempt.

## Data honesty rules

* A value is real (`ok`), or it is `null` with a status: `unavailable` (timed out / not answering), `error`
  (auth failure, malformed data, probe could not run), `not_supported` (device does not implement it).
* Packet loss of 100 % is a genuine measurement; latency in that case is `unavailable`.
* The first interface sample, a counter reset, a reboot, an ambiguous 32-bit interval: `rate = null` with `rate_note`.
* An alert on an `unknown` verdict neither opens nor closes an incident.
* There is no code path that generates random or estimated monitoring values.

## Health state machines

Two **independent** machines per device:

| Machine | Question | Evidence | Thresholds (defaults) |
|---|---|---|---|
| **reachability** | Can we reach the device at all? | any positive result from ICMP, TCP or SNMP | `failureThreshold = 3`, `recoveryThreshold = 2` |
| **snmp** | Is the SNMP agent answering? | an SNMP response | `snmpFailureThreshold = 3`, `snmpRecoveryThreshold = 2` |

Both use the same states:

```
UNKNOWN ─success─► UP ─failure─► DEGRADED ─failures ≥ threshold─► DOWN ─success─► RECOVERING ─successes ≥ threshold─► UP
                    ▲                │ success                          ▲              │ failure
                    └────────────────┘                                  └──────────────┘
```

* One failed poll is only `DEGRADED`. `DOWN` needs `failureThreshold` **consecutive** failures. Leaving `DOWN` needs `recoveryThreshold` consecutive successes.
* Thresholds are per device and configurable through the API (`polling`); the four values are independent.
* **`ICMP = UP` with `SNMP = DOWN` is a valid, expected state**: CPU, memory and interface metrics are `null` (unavailable), the device is **not** marked down, and no fake values appear.
* Transitions are stored in `device_state_history`.

## Interfaces: lifecycle and alert semantics

Identity is `(device, ifIndex)`. Interfaces are **never deleted** by polling.

| State | Meaning |
|---|---|
| `active` | present in the most recent **complete** interface walk |
| `inactive` (`inactive_since`) | was known, but is missing from a complete walk (typical for dynamic PPP/L2TP/tunnel interfaces) |

* A failed or partial interface read (timeout, SNMP down) changes nothing: only a complete walk can mark interfaces inactive.
* Reappearing reactivates the **same** record with its history. Its counters restart (`first_sample`): no rate is computed across the outage.
* Disappearing is **not** a device failure and does not alert; an open interface incident for it is resolved (`subject_removed`).
* `last_oper_up_at` records when the interface was last observed operationally up (`null` = never seen up).
* **Limitation:** because identity is the ifIndex, a device that re-uses one ifIndex for a different logical interface (some platforms renumber after a reboot) will merge the two histories. RouterOS assigns increasing indexes to dynamic interfaces (e.g. 15 910 937), so this is rare there.

### `interface_down` alert

An incident needs **all** of:

1. administratively **up**,
2. operationally **down** (`down`, `lowerLayerDown`, `notPresent`),
3. **previously observed operationally up** (`last_oper_up_at` set),
4. the DOWN state confirmed for `triggerAfter` consecutive polls (**default 2**).

It resolves after `clearAfter` consecutive UP polls (**default 2**). Consequences:

* unused ports, empty SFP cages, never-connected NICs → **no incident**, however long they stay down
* administratively disabled interfaces → no incident (and an open one resolves)
* `UP, UP, DOWN, DOWN` → incident · `DOWN, DOWN, …` → still the same single incident · `UP, UP` → resolved
* one transient DOWN → nothing
* limitation: an interface that is already down the first time the engine sees it cannot be told apart from an unused one, so it does not alert until it has been seen up.

## Traffic

Per interface: raw `in/out octets` (BigInt, exact above 2^53) and derived `in/out bps`. **There is no router-wide "total bandwidth" metric**, because summing interfaces double-counts the same traffic on bridges, VLANs and physical ports. Any aggregate is a UI decision (e.g. *max interface utilisation*).
Previous counters live on the `interfaces` row, so rate calculation does not depend on the metric backend.
Counter source per interface: `ifHCIn/OutOctets` (64-bit) when available, otherwise 32-bit with wrap handling checked against link speed. A 32-bit counter at line rate over too long an interval is `ambiguous_32bit` → `null`; a 64-bit decrease is `counter_reset`; a `sysUpTime` decrease is `device_reboot`; a change between 32/64-bit sources is `counter_source_changed`.

## Incidents

* States `OPEN → ACKNOWLEDGED → RESOLVED`; every incident stores rule, device, interface, severity (from the **rule** only), `triggeredAt`, `acknowledgedAt/By`, `resolvedAt`, `lastSeenAt`, metric/value/threshold.
* A partial unique index allows only one active incident per `(rule, device, subject)`; concurrent evaluators cannot duplicate.
* Debounce: open after `triggerAfter` consecutive breaches, resolve after `clearAfter` consecutive healthy evaluations (counters are persisted, so a restart does not reset them).
* **`unknown` never resolves an incident.** If the CPU measurement fails while a CPU incident is open, the incident stays open (use an `snmp_unavailable` rule to be told about the measurement outage itself).
* `cooldownSec`: after a resolution, the same condition cannot re-open for that long.
* Disabling/deleting a rule, or an interface disappearing, resolves the incidents involved (with a reason).

## Notifications

`notification_deliveries` holds one row per **attempt** (`PENDING → SENT | FAILED`). The API summarises each (channel, event) into a phase:

| Phase | Meaning |
|---|---|
| `REQUESTED` | queued, first attempt not made yet |
| `SENT` | the destination accepted it. **The only state that means delivered** |
| `RETRYING` | at least one attempt failed and another is scheduled (`nextAttemptAt`) |
| `FAILED` | gave up: non-retryable error, `NOT_IMPLEMENTED`, or attempts exhausted |

* Retryable failures (network errors, HTTP 5xx/408/425/429) create a new `PENDING` row (attempt + 1) with exponential backoff `NOTIFICATION_BACKOFF_BASE_SEC × 2^(n-1)` (max 1 h), up to `NOTIFICATION_MAX_ATTEMPTS` (default 5). Non-retryable failures (HTTP 4xx, blocked target, missing config) stop immediately.
* The failed attempts stay in the table with their real error; a later success does not erase them.
* Claiming uses `FOR UPDATE SKIP LOCKED` (safe with several workers).
* Email returns `NOT_IMPLEMENTED` (failed, not retried). Nothing is ever reported delivered unless the endpoint accepted it.
* Webhooks are signed: `X-NMS-Signature: sha256=HMAC(secret, "<timestamp>.<body>")`.
* Error text never contains tokens or secrets (Telegram errors are scrubbed of the bot token).

## Security model

| Concern | Control |
|---|---|
| API authentication | Every endpoint except `GET /health` needs `Authorization: Bearer <key>` or `X-API-Key` (constant-time comparison; several keys for rotation). `/health` exposes no device or customer data |
| Scanning abuse | There are no discovery/scan/ping endpoints. Probing exists only as `POST /devices/test`, behind the API key and limited to `TEST_MAX_CONCURRENCY` concurrent tests; the host must be a valid IP/hostname (never a flag or shell string) |
| Secrets at rest | SNMP communities/v3 keys, Telegram tokens and webhook secrets are AES-256-GCM encrypted, bound to their row (AAD), with key rotation. Credentials are **write-only** through the API |
| Secrets in output | API responses never contain secrets; validation errors do not echo them; logs are redacted (and a test asserts a running engine's logs contain neither a community string nor an API key) |
| Config file | `.env` is git-ignored; `.env.example` holds placeholders only |
| SQL | Every value is a `$n` parameter. The few interpolated fragments are constants, fixed column names, `asc/desc`, or clamped integers (audited) |
| SSRF (outbound) | Webhook/Telegram targets are validated **at connect time**: private, loopback, link-local, CGNAT and metadata ranges are blocked by default; redirects are not followed; only http(s). `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` opts out for internal receivers |
| Webhook authenticity | HMAC-SHA256 signature over `timestamp.body`; receivers can verify it (verified in tests and in the live run) |
| Network exposure | Binds to `127.0.0.1` by default; deploy on a private network |
| Not included | No per-IP rate limiting of failed authentication, no multi-tenant authorisation (a valid key is fully trusted). Put the engine behind your own network controls |

## Extension points

### Vendor SNMP profiles
Create `src/collectors/snmp/profiles/mikrotik.ts`:

```ts
export const mikrotikProfile: SnmpProfile = {
  id: 'mikrotik',
  matches: (sys) => sys.sysObjectId?.startsWith('1.3.6.1.4.1.14988') ?? false,
  // collectCpu / collectMemory are optional; anything omitted falls back to the standard MIBs
};
```
then `defaultProfileRegistry.register(mikrotikProfile)` in `profiles/registry.ts`. Generic polling code never contains vendor OIDs.

### Metric storage
Implement `MetricRepository` (`src/metrics/repository.ts`) for TimescaleDB / InfluxDB / ClickHouse and pass it as
`createEngine({ metrics })`. Collectors, scheduler, state machine and alerting do not change.

### Future collectors
`PollService` consumes probes through interfaces (`IcmpProbe`, `TcpProbe`, `SnmpProbe`); a syslog receiver, trap receiver or
flow collector is a new module that writes samples/events and, if needed, feeds the same `AlertEvaluator`.
Not implemented in this version, by design.

## Scaling notes (and honest limits)

* One engine instance runs the scheduler. Two instances would poll every device twice. (The notification worker is
  multi-instance safe; the scheduler is not.)
* Interface samples grow quickly: `interfaces × (86400 / interval)` rows per day per device. Retention
  (`METRICS_RETENTION_DAYS`) deletes old rows; for large fleets move `MetricRepository` to a time-series store or
  partition the tables. Toggle `monitored=false` on interfaces nobody graphs.
* A wrong SNMP v1/v2c community is indistinguishable from a timeout (agents drop the request silently).
* ICMP uses the OS `ping`: a burst of 3 takes ~2 s, so keep `pollIntervalSec` comfortably above that.

## Known behaviours

* **Hard-aborted polls record no observation.** The per-probe timeouts (`timeoutMs` × retries) are what turn an unresponsive device into `unavailable` metrics and state-machine failures. The hard timeout (`POLL_HARD_TIMEOUT_MS`, 60 s) is a safety net for a poll that hangs beyond those; an aborted poll writes nothing and does not move the state machine. A device whose polls *always* hit the hard timeout would therefore not change state (`poll_failed` is logged). No such case exists with the current collectors: ICMP, TCP and SNMP all have their own bounded timeouts.
* **Interface identity is the ifIndex.** A new ifIndex that carries an old interface's name is a *new* interface (the old one stays inactive); the same ifIndex re-used under a different name reuses (and renames) the old record.
* A poll of a device with SNMP disabled has no SNMP state; the `snmp_unavailable` rule then cannot fire.

## External issue: SNMP performance anomaly (BGP-INTEGRA-CCR2116)

**External SNMP performance anomaly under investigation. Not currently demonstrated to be caused by the monitoring engine.**

Every minute, for about 12 s (seconds ~59–12), that router's SNMP agent answers each request in 0.5–1.9 s instead of ~10 ms. It was reproduced by an independent probe (one GET every 500 ms) with the engine and the old prototype both stopped. The engine tolerates it (no false failure, no schedule drift). No change was made to timeouts, retries, `maxRepetitions` or concurrency because of it.

## Deferred optimizations

* **Parallel SNMP collection.** The steps of one SNMP poll (system, CPU, memory, interface tables; ~10 round trips) run sequentially, so per-request latency adds up. Running them concurrently on one session would shrink slow polls. Deliberately **not** done: the sequential implementation is stable and verified.
* Per-device SNMP `maxRepetitions` (smaller values were measured to be worse on the routers tested).

## Live validation (2026-09-19)

Run against two real MikroTik routers (CCR2116 and CCR2216, SNMP v2c + ICMP, read-only) for **10.9 minutes** with the
engine's own scheduler: 15 s interval, 3 s timeout, 1 retry, thresholds at their defaults. The older prototype
(`nms-refs-new`) was stopped during the run and restarted afterwards, so it was not polling the same routers.
Nothing was written to the routers. Credentials were never printed; a scan of the engine log for the community strings,
the API key and the webhook secret found **0 occurrences**. All devices, rules, channels and credentials created for the
test were deleted afterwards.

| | BGP-INTEGRA-CCR2116 | RT-POLDA-SUMSEL |
|---|---|---|
| Polls executed / SNMP ok / ICMP ok | 43 / 43 / 43 | 43 / 43 / 43 |
| Poll duration avg / p50 / p95 / max | 4219 / 2114 / 10886 / 11397 ms | 2434 / 2126 / 3302 / 5765 ms |
| Start-to-start spacing | 15.1 s every time (0 overlaps) | 15.1 s every time (0 overlaps) |
| SNMP operations that finally timed out | 0 | 0 |
| SNMP retransmits (each costs one 3 s timeout) | 4 | 9 |
| ICMP packet loss | 1 of 43 bursts lost 1 of 3 echoes (avg 0.78 %) | 0 |
| CPU (avg, min–max) | 0.00 % | 9.81 % (9.19–10.81) |
| Memory | 3.55 % | 4.77 % |
| Interfaces | 19 (4 ever seen up, 15 never) | 31 (21 ever seen up, 10 never) |
| Interface errors / discards (cumulative) | 0 / 0 | 0 in-errors, 0 out-errors, 0 in-discards, 9 out-discards |
| State transitions | first observation only (UNKNOWN → UP, both machines) | same |
| Incidents | **0** | 1 (the deliberate CPU > 5 % test rule) |

* **Interface-down false alerts: fixed.** The same rule type produced 15 + 1 critical incidents before the change. It now produced **0**: the 25 never-connected ports were correctly ignored.
* **Notifications.** The one real incident produced one webhook delivery: phase `SENT`, 1 attempt, delivered to a local receiver that verified the HMAC signature (1/1 valid).
* **Data integrity.** No sample was marked `ok` with a null value.

### Slow polls: what was found

Slow polls **still occurred on the BGP router after the prototype was stopped**, so the prototype was not the cause.

* **BGP router: ~89 % of its SNMP time was answered-but-slow requests, only ~11 % was retransmits.** The slow polls are the ones that start inside a recurring ~12 s window at the top of every minute (about :59 to :12). An independent probe (one GET every 500 ms, engine and prototype both stopped) reproduced it: 21 of 217 requests took over 500 ms and all slow requests fell in the seconds 0–12 of the minute (p50 11 ms otherwise). That points at the router (or another system querying it at minute boundaries), not at the engine or a particular OID: when the window is active each of the ~10 sequential SNMP round trips of a poll takes 0.5–1.9 s.
* **RT-POLDA router: mostly lost packets.** 72 % of its SNMP time was retransmits (every lost request costs one full 3 s timeout); single GETs showed 1 timeout in 254 (0.4 %), and no periodic pattern. Smaller GETBULK sizes made this **worse** (more round trips, more losses), so the default `maxRepetitions = 20` was kept.
* **Timeouts.** 3 s is not too short: the slowest answered requests on the BGP router took 1.9 s, so a shorter timeout would only add duplicate requests to an already slow agent. It is generous for RT-POLDA (answers p99 ≈ 90 ms), where ~1.5 s would recover a lost packet twice as fast; that is a per-device setting (`timeoutMs`), not a new default.
* The engine handled all of this without a single false failure: no operation timed out, no state left UP, and slow polls did not shift the schedule.

Not exercised live (covered only by automated tests): a poll longer than its interval, hard timeout/abort, graceful shutdown, dynamic interfaces disappearing/reappearing, and any DOWN transition. No interface disappeared during the run, and the routers stayed healthy.

