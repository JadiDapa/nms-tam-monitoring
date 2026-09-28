# nms-monitoring

Standalone network **monitoring engine**. No UI. It polls devices (ICMP, TCP, SNMP v1/v2c/v3), keeps per-device
health state, evaluates alert rules, manages incidents, delivers notifications, and exposes an authenticated internal
REST API for the Next.js NMS application.

> **No fake data.** Every value is measured, or it is `null` with a status (`unavailable`, `error`, `not_supported`)
> and the real error. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What changed from the prototype:
> [docs/MIGRATION.md](docs/MIGRATION.md).

## Requirements

* Node.js ≥ 22
* PostgreSQL ≥ 13 (uses `gen_random_uuid()`); tested on 18
* The host needs the standard `ping` command (Windows / Linux / macOS)
* Network access from the engine host to the devices (UDP 161 for SNMP, ICMP, and any TCP ports you check)

## Quick start

```bash
npm install
cp .env.example .env          # fill DATABASE_URL, ENGINE_API_KEYS, ENGINE_ENCRYPTION_KEY
npm run migrate               # creates schema "nms_monitoring" (also runs automatically on start)
npm run dev                   # or:  npm run build && npm start
curl http://127.0.0.1:8088/health
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"     # ENGINE_API_KEYS
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # ENGINE_ENCRYPTION_KEY
```

> Back up `ENGINE_ENCRYPTION_KEY` separately from the database. Without it the stored SNMP / Telegram / webhook
> secrets cannot be recovered.

The engine keeps all of its tables in its own schema (`DATABASE_SCHEMA`, default `nms_monitoring`), so it can share a
database with Prisma/Next.js without touching `public`.

## Deployment (no Docker)

Build once, run with any process manager:

```bash
npm ci && npm run build
NODE_ENV=production node dist/main.js         # reads .env in the working directory, or real environment variables
```

* **Linux:** a systemd unit with `WorkingDirectory=/opt/nms-monitoring`, `ExecStart=/usr/bin/node dist/main.js`,
  `Restart=always`, `EnvironmentFile=/etc/nms-monitoring.env`. `SIGTERM`/`SIGINT`/`SIGHUP` trigger the graceful shutdown.
* **Windows:** graceful shutdown is triggered by **Ctrl+C** (`SIGINT`) or **Ctrl+Break** (`SIGBREAK`, also console close).
  `SIGTERM` does not exist on Windows: a plain "kill" or service stop that terminates the process skips the graceful path
  (state is still consistent, because it is only written at the end of a poll, but running polls are lost). Use a console, or
  a service wrapper configured to send Ctrl+C / Ctrl+Break on stop.
* Shutdown policy: running polls get up to `SHUTDOWN_TIMEOUT_MS` to finish, then are aborted; exit code 0. See
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#graceful-shutdown).
* **PM2:** `pm2 start dist/main.js --name nms-monitoring`.
* Keep the engine on a private network; it binds to `127.0.0.1` by default.

## Calling it from Next.js

```ts
// servers/services/monitoring-engine.ts  (server-side only; never expose the key to the browser)
const BASE = process.env.MONITORING_ENGINE_URL!;
const KEY = process.env.MONITORING_ENGINE_API_KEY!;

async function engine<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...init.headers },
    cache: 'no-store',
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error?.message ?? `Engine error ${res.status}`);
  return body as T;
}

// "Test device now" before saving
const result = await engine('/devices/test', {
  method: 'POST',
  body: JSON.stringify({ host: '10.0.0.1', icmp: true, tcpPorts: [22, 443], snmp: { auth: { version: 'v2c', community: 'public' }, port: 161 } }),
});
```

Typical flow for "add device": `POST /devices/test` (SNMP auth is typed in on the request) → if the operator accepts the
real result, `POST /devices` → `POST /devices/:id/poll` for an immediate first reading.

## API

All endpoints except `/health` need `Authorization: Bearer <key>` or `X-API-Key: <key>`. Errors are
`{ "error": { "code", "message", "details?" } }`. 64-bit counters are returned as decimal **strings**.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + DB check (public, no sensitive data) |
| POST | `/devices/test` | **Stateless** probe of `{host, icmp, tcpPorts, snmp}`; returns only real results; saves nothing |
| POST | `/devices` · GET `/devices` · GET/PATCH/DELETE `/devices/:id` | Device CRUD (+ per-device polling config) |
| GET | `/devices/:id/status` | Health state, identity, latest metrics, state history, active incidents |
| POST | `/devices/:id/test` | Stateless test using the stored configuration |
| POST | `/devices/:id/poll` | Poll now (persists like a scheduled poll); returns the full report |
| GET | `/devices/:id/metrics?metric&dimension&from&to&limit&order&bucketSec` | Device metric history. With `bucketSec` (5-86400) it returns one row per time bucket instead: `{time, metric, dimension, avg, max, samples}` over successful samples only (for charts) |
| GET | `/devices/:id/interfaces?active=true` | Interface inventory + latest counters/rates. Each interface has `active` / `inactiveSince` (dynamic interfaces are kept, not deleted) and `lastOperUpAt` (null = never seen up) |
| GET | `/devices/:id/interfaces/:ifId/metrics?from&to&limit&bucketSec` | Per-interface traffic history; with `bucketSec`: `{time, interfaceId, inBpsAvg, inBpsMax, outBpsAvg, outBpsMax, samples}` |
| GET | `/fleet?ids=` | Health + latest CPU / memory / latency + active-incident count for many devices in one call (dashboards). A device that was never polled reports `null`s |
| PATCH | `/devices/:id/interfaces/:ifId` | `{monitored: boolean}` |
| GET | `/incidents?status&deviceId&deviceIds&ruleId&severity&limit&offset` | List (`status=ACTIVE` = open + acknowledged) |
| GET | `/incidents/:id` | Incident + `notifications` (every attempt) + `deliverySummary` (one row per channel/event: `REQUESTED / SENT / RETRYING / FAILED`) |
| POST | `/incidents/:id/acknowledge` | `{by?}` |
| GET | `/alerts` | Alert **rules** with active-incident counts |
| POST/GET/PATCH/DELETE | `/alerts[/:id]` | Rule management |
| POST/GET/PATCH/DELETE | `/channels[/:id]` · POST `/channels/:id/test` | Notification channels (telegram, webhook, email\*) |
| POST/GET/DELETE | `/credentials[/:id]` · PUT `/credentials/:id/secret` | **Write-only** notification secrets (Telegram bot token, webhook secret). SNMP auth is not a credential: it is sent as `snmpAuth` when the device is created and stored on the device, unencrypted |

\**`?ids=a,b,c` filter.** `GET /devices`, `/credentials`, `/channels`, `/alerts`, `/fleet` accept it, and `/incidents` accepts `deviceIds`. This is how the web app asks for only the objects one client owns. Absent = no filter; present but empty = matches **nothing** (never "everything"). The engine itself has no notion of clients; who owns what is the web app's job.

* email is accepted as a channel type but delivery is `NOT_IMPLEMENTED` and recorded as failed.

"Alerts" are rule definitions; what fires from a rule is an **incident**.

### Polling configuration (per device)

```jsonc
"polling": {
  "pollIntervalSec": 30,        // 5 - 86400
  "timeoutMs": 3000,            // per ICMP echo / SNMP request / TCP connect
  "retryCount": 1,              // extra attempts after a timeout (ICMP: only zero-reply bursts)
  "icmpCount": 3,               // echoes per burst
  "failureThreshold": 3,        // reachability: consecutive failures -> DOWN
  "recoveryThreshold": 2,       //               consecutive successes -> UP
  "snmpFailureThreshold": 3,    // SNMP availability: consecutive failures -> DOWN
  "snmpRecoveryThreshold": 2    //                    consecutive successes -> UP
}
```

### Alert rules

```jsonc
{ "name": "High CPU", "deviceId": "<uuid or omit for all devices>", "conditionType": "metric_threshold",
  "metric": "cpu_pct", "operator": ">", "threshold": 80, "severity": "warning",
  "triggerAfter": 3, "clearAfter": 2, "cooldownSec": 300, "notifyOnRecovery": true, "channelIds": ["<uuid>"] }
```

`conditionType`: `metric_threshold` · `device_down` · `snmp_unavailable` · `interface_down`.
Metrics: `cpu_pct`, `memory_pct`, `icmp_latency_ms`, `icmp_packet_loss_pct`, `if_in_bps`, `if_out_bps` (per interface).
Severity is always the rule's `severity`.

`interface_down` only fires for an interface that is administratively up, went operationally down, **and had previously been seen up**,
confirmed for `triggerAfter` consecutive polls (default **2**); it resolves after `clearAfter` consecutive UP polls (default **2**).
Unused ports, empty SFP cages and administratively disabled interfaces never raise it. Defaults per rule type:
`metric_threshold` 3/2, `interface_down` 2/2, `device_down` and `snmp_unavailable` 1/1 (already debounced by the state machines).

## Behaviour reference

Details, diagrams and tables are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). In short:

* **Scheduling.** Every device has its own next-due time; exactly one active poll per device; bounded global concurrency
  (`SCHEDULER_CONCURRENCY`). After a poll: `next = start + interval` if it finished within the interval, otherwise
  `next = finish + interval`. A slow poll is never followed by a back-to-back or catch-up poll.
* **Timeouts / retries.** Per-device `timeoutMs` and `retryCount`; a poll is hard-aborted after `POLL_HARD_TIMEOUT_MS`
  (pings killed, SNMP requests failed, results discarded). Real SNMP retransmit/timeout counts and per-step timings are
  stored with every poll (`snmp_retransmits`, `snmp_step_ms`, `poll_collect_ms`).
* **State machines.** Reachability and SNMP availability are separate, each with its own failure/recovery thresholds
  (defaults 3 / 2). `ICMP UP + SNMP DOWN` is valid: SNMP metrics are `null`, the device is not marked down.
* **Interfaces.** Never deleted. `active` / `inactive` lifecycle; per-interface traffic only (no router-wide sum).
* **Incidents.** `OPEN → ACKNOWLEDGED → RESOLVED`, one active incident per condition, an unavailable measurement never resolves one.
* **Notifications.** One row per attempt, exponential backoff, bounded attempts; phases `REQUESTED / SENT / RETRYING / FAILED`.
  Only `SENT` means the endpoint accepted the message.
* **Security.** API key on everything except `/health`, encrypted write-only credentials, redacted logs, SSRF-safe outbound HTTP,
  parameterised SQL, no scan endpoints.

## Acceptance status

The remaining failure scenarios were tested explicitly (see the test list below): reachability DOWN/recovery with incidents,
SNMP DOWN while ICMP stays UP (real agent stopped and restarted), interface down semantics and interface disappearance
(real agent), scheduler overrun (fake clock and real time), hard timeout against a probe that never answers, migration of
legacy alert rules, and graceful shutdown of the real engine process (Windows: Ctrl+C and Ctrl+Break; also `dist/main.js`
against PostgreSQL). Known limits and deferred items are listed in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#known-behaviours).

## Validation status

* Automated tests: see "Tests" below.
* **Live, read-only run on two real MikroTik routers** (10.9 min, 43 polls each, engine scheduler): no false interface-down incidents,
  every poll on a steady 15.1 s cadence with no overlaps, real per-interface traffic, one real incident delivered and signature-verified,
  0 secrets in the logs. One router's SNMP agent has a recurring ~12 s slow window each minute (reproduced independently of the engine),
  which makes some polls take 7–11 s. Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#live-validation-2026-09-19).

## Configuration

See [.env.example](.env.example): every option is documented there. The process refuses to start on invalid
configuration and never prints secret values.

## Tests

```bash
npm test          # 316 tests (315 run + 1 POSIX-only skipped on Windows), ~2 min: includes real-process shutdown tests
npm run typecheck
```

The suite uses **real** components wherever possible: a real SNMP agent on UDP loopback (v1, v2c, v3 authPriv,
timeouts, garbage responses, missing tables), real `ping` to `127.0.0.1`, real TCP sockets, real local HTTP servers for
Telegram/webhook, and an embedded PostgreSQL (PGlite) for the database logic. Probes are scripted only where a scenario
needs a device to *behave badly on demand* (flapping, timeouts, reboots).

## Not included in this version (by design)

Syslog / SNMP trap / flow collection, vendor-specific profiles, email delivery, multi-tenant authorization,
horizontal scaling of the scheduler, a time-series store. The seams for them exist; see ARCHITECTURE.md.
