# NF Discovery Runbook

> Operational procedures for the read-only NF discovery observation plane.
> Authority is the running source and the automated tests. This runbook never
> instructs operators to restart, reconfigure or mutate a live network function.

Related documents:

- [NF discovery foundation](../architecture/nf-discovery.md)
- [Deployment](deployment.md)
- [RBAC model](rbac-model.md)

## 1. Scope

Discovery performs bounded, read-only registry observation. It is safe to run
alongside a live core. The following are always out of scope for discovery
operations:

```text
NF registration writes (PUT / PATCH / DELETE)
NF subscription creation
NF configuration changes
NF process restart or reload
SBI listener or endpoint mutation
Routing table or firewall changes
```

## 2. Prerequisites

1. The registry destination is allowlisted in `DISCOVERY_ALLOWED_TARGETS`.
2. The operator holds `core.read`; mutations require `core.configure`.
3. MongoDB `xcloud_ops` is reachable and the three discovery collections exist
   after `scripts/init-mongo-indexes.mjs`.

Default deny is intentional. An allowlisted NF service endpoint observed inside
a profile is data, not authorization to connect to it.

## 3. Configure a source

```text
UI: Discovery -> Add Source
API: POST /api/discovery/sources
```

Required fields:

```text
name
adapterType   (canonical value: nrf)
baseUrl       (must be allowlisted)
transportMode (h2c | h2_tls)
```

Rejections:

| Code | HTTP | Meaning |
|---|---|---|
| `DISCOVERY_TARGET_NOT_ALLOWED` | 403 | Destination not in the allowlist |
| `DISCOVERY_REVISION_CONFLICT` | 409 | CAS revision mismatch on update |
| `DISCOVERY_SCAN_RATE_LIMITED` | 429 | Per-source minimum interval not elapsed |

## 4. Run a scan

```text
UI: Discovery -> Scan
API: POST /api/discovery/sources/{sourceId}/scan
```

- One active scan per source and globally.
- Minimum interval per source is 60 seconds.
- A complete successful scan may mark previously seen candidates `missing`.
- A failed or truncated scan never marks candidates missing.

Interpret `run.status`:

| Status | Meaning |
|---|---|
| `success` | Complete observation; absence may be inferred |
| `partial` | Truncated; absence is not inferred |
| `failed` | Read failed; existing observations retained |
| `running` | In progress |

## 5. Link and unlink

Linking attaches an existing, non-retired Inventory resource UUID to a
candidate. Unlink clears that metadata.

```text
POST /api/discovery/candidates/{candidateId}/link
POST /api/discovery/candidates/{candidateId}/unlink
```

Both require `expectedRevision`. Linking never creates or updates Inventory
resources, never provisions anything, and never creates Topology edges.

## 6. Observation is not health

Do not present observation state as operational health. A candidate in `missing`
means it was absent from a complete successful scan. It does not mean the NF is
down, degraded, or retired.

Keep these axes separate in every report and dashboard:

```text
registry status
observation state
Inventory lifecycle
Topology lifecycle
operational health
```

## 7. Live verification (optional)

A gated live read-only suite exists for environments that intentionally expose a
local registry:

```bash
ALLOW_LIVE_NRF_READONLY=1 node scripts/test-nrf-live-integration.mjs
```

The suite refuses to run without the explicit flag, issues only bounded GET
requests through the Go adapter, never prints live NFProfile payloads, and never
writes to the live registry. Ordinary unit tests and CI never contact a live
registry.

## 8. Troubleshooting

| Symptom | Action |
|---|---|
| 403 `DISCOVERY_TARGET_NOT_ALLOWED` | Add the destination to `DISCOVERY_ALLOWED_TARGETS` and restart the Go service |
| 429 `DISCOVERY_SCAN_RATE_LIMITED` | Wait for `Retry-After`; do not lower the production interval |
| `partial` run | Response limit hit; candidates were not marked missing |
| `failed` run | Check transport and allowlist; observations are retained |
| Candidates never appear | Confirm the source is enabled and the scan status is `success` |

## 9. Evidence retention

`app_discovery_runs` is retained under the documented application retention
policy and is not TTL-deleted. Operation logs are best-effort and non-blocking.
