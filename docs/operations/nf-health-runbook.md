# NF Health Operations Runbook

Operational guidance for the read-only NF Health / Telemetry plane. This
runbook never authorizes process control, configuration changes or network
mutations.

Related: [NF Health / Telemetry foundation](../architecture/nf-health-telemetry.md)

## 1. Deployment Characteristics

NF Health inspects locally managed network functions through two read-only
paths:

```text
systemd path   fixed `systemctl show` on server-approved unit names
process path   bounded /proc comm scan for approved process names
```

Do not assume every network function runs as a systemd unit. Identify the
effective process names and service mappings first, then configure the
service-unit allowlist accordingly.

```bash
# Read-only inspection examples. Never use start/stop/restart/reload here.
systemctl is-active <unit>
systemctl show <unit> --property=ActiveState,SubState,MainPID
ps -eo pid,comm | grep <process-name>
```

## 2. Configuration

Server-owned allowlists, default deny:

```text
NF_HEALTH_ALLOWED_TARGETS   comma-separated host:port metrics destinations
NF_HEALTH_SERVICE_UNITS     comma-separated approved service units / process names
NF_HEALTH_TLS_CA_FILE       optional CA bundle for https metrics endpoints
```

Example (adjust to the verified local topology):

```bash
export NF_HEALTH_ALLOWED_TARGETS="127.0.0.5:9090,127.0.0.4:9090"
export NF_HEALTH_SERVICE_UNITS="amfd,smfd"
```

Unapproved destinations return HTTP 403 `NF_HEALTH_DESTINATION_NOT_ALLOWED`.
Unapproved service units return HTTP 403 `NF_HEALTH_SERVICE_UNIT_NOT_ALLOWED`.

## 3. Metrics Endpoint Verification

Before configuring a target, confirm the listener is real:

```bash
curl --max-time 5 --silent --show-error --fail \
  http://127.0.0.5:9090/metrics | head
```

Do not dump full metrics bodies into committed logs. Inspect only family names,
types, help text and sanitized samples.

Do not assume every network function exposes `/metrics`. Do not assume metrics
introduced in newer product branches exist in the deployed build.

## 4. Monitoring Target Lifecycle

```text
1. Confirm the Discovery candidate exists
2. Confirm the metrics destination is allowlisted
3. Confirm the service unit / process name is allowlisted
4. Create the target with collectionMode=manual first
5. Trigger Collect Now and inspect the three layers
6. Only then enable collectionMode=scheduled
```

Targets are never auto-created for every discovered NF. One target references
one Discovery candidate and cannot be duplicated against the same candidate
(HTTP 409 `NF_HEALTH_TARGET_CONFLICT`).

## 5. Manual Collection

Authorized operators use `POST /api/nf-health/targets/{targetId}/collect`
through the NF Health detail page **Collect Now** action.

Expected outcomes:

| Condition | Result |
|---|---|
| target disabled | HTTP 409 `NF_HEALTH_TARGET_DISABLED` |
| collection already running | HTTP 409 `NF_HEALTH_COLLECTION_IN_PROGRESS` |
| repeated collection inside the minimum interval | HTTP 429 `NF_HEALTH_COLLECTION_RATE_LIMITED` with `Retry-After` |
| endpoint unreachable | run status `partial` or `failed`; last good sample preserved |
| metrics body invalid | interface layer not healthy; `NF_HEALTH_METRICS_INVALID` |

The UI must not claim success before server confirmation and must not
auto-retry failed collections.

## 6. Interpreting Layer States

```text
L1 healthy     process/unit is running. Not a service-delivery claim.
L2 healthy     the probed HTTP metrics endpoint answered with valid data.
L3 evidence    registered service metrics were sampled; activity alone is not health.
not_configured that layer is not configured for this target.
unknown        evidence exists but cannot be interpreted (for example permission denial).
stale          retained evidence that is no longer fresh.
```

Never read L2 healthy as PFCP/NGAP/Diameter/SIP health. Never read L1 healthy
as UE registration success. Never convert a missing metric into zero.

## Root-owned local process evidence

When the console runs as an unprivileged user, Linux may deny access to a
root-owned NF's `/proc/<pid>/exe`. A matching process name then remains
`unverified` / `unknown`. Do not run the web service as root or relax procfs
protections to turn that result green.

The optional `process-evidence` executable is a one-shot procfs reader. A root
operator installs it independently with the supplied service and timer. It reads
only process identity (name, PID, start ticks, executable and boot ID), accepts a
root-owned list of at most 64 exact names, and atomically publishes
`/run/xcloud-process-evidence/latest.json` every 20 seconds. It has no network
server, network client, shell, NF configuration writer or process-control API.
The bounded scan emits only positive identities; absence never proves downtime.

Build as the development user, then review the artifact before installation:

```sh
cd backend
go build -o /absolute/staging/path/process-evidence ./cmd/process-evidence
```

Run only the installation step from an existing root terminal:

```sh
sh deploy/process-evidence/install.sh /absolute/staging/path/process-evidence
```

The installer backs up replaced files, retains an existing operator policy, and
starts only `xcloud-process-evidence.service` and its timer. It does not restart
any NF or console process. Configure the console deployment with
`NF_HEALTH_PROCESS_SNAPSHOT=/run/xcloud-process-evidence/latest.json` and apply
that environment through the existing console runtime procedure.

The console consults the file only after its own exact-name inspection found a
process whose executable was unreadable. Every parent directory and the file
must be root-owned, not group/world writable and not a symlink. The reader rejects
files above 1 MiB, evidence older than 60 seconds, future timestamps, different
boot IDs, exited/reused PIDs and changed names. Failed checks preserve the local
`unverified` result. Accepted L1 evidence includes additive `processObservedAt`
and `processSource=root_owned_snapshot` provenance. Existing histories are not
rewritten. The app cannot invoke the writer or change its policy.

To disable this path, remove the environment variable and apply the ordinary
console update procedure; then an operator can disable only the evidence timer.
Local process checks continue and report any remaining permission gap honestly.

## Enable metrics on an existing process target

The target editor allows an explicit collector transition for resource-native
targets that already have an authorized local inspection source. A transition
retains `resourceId`, `candidateId`, service kind and process binding. The API
accepts optional `target.collectorProfile` in the existing revision-bound PUT;
omitting it retains the stored profile. A transition to `http_metrics` requires
an allowlisted metrics endpoint. A transition to `process_only` removes HTTP
endpoints/probes and still requires the authorized local source. Rejected or
stale-revision writes do not change the target.

Metadata advertises `collectorProfileTransitions` so an older backend keeps the
editor's profile selector locked during a rolling update. The separate
`processSnapshotConfigured` flag means a path is configured, not that its file
has passed trust/freshness validation.

Confirm which running resource owns an endpoint before declaring the association,
especially where SMF/PGW-C or UPF/PGW-U configurations share an address. Start with
manual collection, inspect L1/L2 and accepted metric families, then restore the
approved schedule. Preserve the original target and its history. Historical
counters and active-session gauges remain observations, not current service
success; the interval evaluator is still not implemented.

## 7. Freshness Troubleshooting

```text
lastAttemptAt moves on every collection attempt
lastSuccessAt moves only on successful collection
lastMeasuredAt moves only when a sample is persisted
```

If `lastMeasuredAt` is old while `lastAttemptAt` is recent, collections are
failing and the last valid measurement is intentionally preserved. Inspect the
latest run's `errorCode` and `errorSummary`.

## 8. Scheduled Collection

Scheduled collection is opt-in per target. Limits:

```text
default interval 120s
minimum interval  60s
global concurrent  2
per-target         1
```

The scheduler checks due work every 15 seconds, independently of target periods.
It still admits at most two network collections and 32 process-only collections
per pass, with shared manual/scheduled concurrency gates. A target is never
collected before its own interval. Large populations still require capacity
review; a configured interval is not proof that every target was sampled on time.

If scheduled samples stop arriving:

1. Confirm the target is still `enabled` and `collectionMode=scheduled`.
2. Confirm the Go process is running (the scheduler is in-process).
3. Inspect recent runs for timeout or connection errors.
4. Confirm the destination is still reachable from the host.

## 9. Safety Rules

Never perform any of the following from NF Health operations:

```text
systemctl restart | stop | reload <any network function>
kill / pkill of network function processes
change PLMN, DNN or S-NSSAI configuration
modify subscriber databases
change routing or firewall rules
create PFCP associations
send SIP REGISTER or INVITE
modify Diameter sessions
generate synthetic UE registrations
alter network function registration status
```

There is no remote shell, no generic command execution API and no NF control
endpoint.

## 10. Live Acceptance Gate

Local live verification is a separate mandatory gate and is never required on
the CI runner:

```bash
ALLOW_LIVE_NF_HEALTH_READONLY=1 \
node scripts/test-nf-health-live-integration.mjs
```

The live test only issues bounded, read-only collection through the real Go
API. It uses an isolated MongoDB test database and cleans up only test-owned
data and child processes.

If a metric family is not exported by the deployed build, report the precise
limitation. Never change network function configuration to satisfy a test.

## 11. Retention

Telemetry samples expire via MongoDB TTL (`expiresAt` + `nf_health_samples_ttl`).
Default retention is 7 days, maximum 30 days. Runs and targets are retained so
operators can explain collection failures and configuration changes. Audit
records are never purged by NF Health.


## Latest-evidence query indexes

The bounded latest-sample and latest-run aggregations sort by target identity,
measurement/attempt time and a descending document-ID tie-break. On a large
history, the default ID index alone forces collection scans and a blocking sort.
The required compound indexes are defined once in
scripts/lib/nf-health-read-indexes.mjs and shared by the full initializer and
the focused repair command.

Run from the repository root:

```sh
node scripts/migrate-nf-health-read-indexes.mjs
node scripts/migrate-nf-health-read-indexes.mjs --apply
```

The first command makes no database connection. Apply creates only two
non-unique read indexes in the configured Ops database; it does not provision
accounts, rewrite evidence, drop indexes, add TTL or change NFs. Existing indexes
remain. The full bootstrap has other maintenance effects and is not a substitute
for this focused repair.

After repair, inspect the latest-evidence query plan and run a fresh inspection.
A successful read can still contain unhealthy or unmeasured layers. Do not relax
timeouts or convert those states into passes to mask an index problem.
