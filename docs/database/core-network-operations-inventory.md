# Core Network Operational Surface Inventory

**Repository:** `subscriber-console`
**Branch:** `develop`
**Inventory date:** 2026-08-31

## Conclusion

No Core / NF operational HTTP write routes exist in this repository. No managed
core-network targets are registered. No production executor exists for an NF
restart, reload, start, stop, reconcile, or remote service action.

The repository contains subscriber provisioning, OCS administration, and
subscriber/OCS data-integrity repairs. Those are application-data operations;
they are not evidence that this console controls the running state of AMF,
SMF, UPF, AUSF, BSF, NRF, NSSF, PCF, SCP, SEEP, UDM, UDR,
MME, HSS, SGWC, SGWU, PCRF, OCS, Docker, Kubernetes, or a remote host.

The current architecture therefore keeps the safe readiness posture:

- `coreManagedTargetRegistry` is empty.
- `coreOperationRegistry` is empty.
- `automaticCoreOperationExecutorIds` is empty.
- Any future automatic definition without a server-owned executor fails with
  `CORE_OPERATION_EXECUTOR_MISSING`.
- No SSH, shell, `systemctl`, Docker, Kubernetes, or arbitrary command path
  was added.

## Existing system-facing surface

| Operation | HTTP route | Target | Current behavior | Permission / guard | Classification | Existing executor |
| --- | --- | --- | --- | --- | --- | --- |
| Comprehensive health read | `GET /api/system/health` | Application data health | Reads Mongo-backed database, OCS, HSS subscriber, and security health summaries | Authenticated session | `READ_ONLY` | Repository read queries only |
| Mongo health read | `GET /api/system/mongo/health` | Mongo readiness | Reads Mongo readiness, collections, and indexes | Authenticated session | `READ_ONLY` | Repository read queries only |
| Integrity scan | `POST /api/system/audit/scan` | Subscriber/OCS data | Scans data consistency; the POST verb does not mutate a managed target | `admin` or `operator` | `READ_ONLY` | Repository read queries only |
| Targeted data heal | `POST /api/system/audit/heal` | Subscriber/OCS documents | Corrects subscriber, balance, tariff, profile, or reservation data | `system_heal`; direct execution for `admin` and `operator` | `DIRECT_GOVERNED` data remediation | `healSubscriberDocument` |
| Batch data heal | `POST /api/system/audit/batch-heal` | Subscriber/OCS documents | Applies bounded per-anomaly data remediation | `system_heal`; direct execution for `admin` and `operator` | `DIRECT_GOVERNED` data remediation | `batchHealSubscriberDocuments` |

`SYSTEM_HEAL` remains governed by the RBAC capability gate and the
best-effort operation log. It is deliberately not registered as a core
operational action because its target is stored subscriber/OCS data, not an NF
runtime process.

## Operation and target registry

The current production registries are intentionally empty:

```text
Managed core-network targets: 0
Core operational actions: 0
Automatic core executors: 0
```

No common telecom name is pre-registered. `AMF`, `SMF`, `UPF`, `MME`,
`P-CSCF`, and `S-CSCF` become managed targets only after a real,
server-owned binding and a trusted executor are introduced.

## Command and remote-operation safety

The inventory searched `backend/`, `frontend/src/`, `deploy/`, and `scripts`
for `child_process`, `exec`, `execFile`, `spawn`, `systemctl`, `service`,
Docker, Kubernetes, SSH, Supervisor, and PM2 control surfaces.

No OS-command or remote-execution implementation was found in application
source. The browser has no command, service name, binary path, script path,
host, or executor argument API.

## Future configuration governance

Configuration governance may be introduced only after separately defining
versioned configuration snapshots, semantic validation, redaction, staged
application, rollback planning, and the reload/restart dependency boundary.
This readiness registry is not permission to add a shell or remote-control
implementation.
