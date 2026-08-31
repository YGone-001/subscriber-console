# Phase 8 — Core Network Operational Surface Inventory

**Repository:** `subscriber-console`
**Branch baseline before this phase:** `develop` at `bd56460`
**Inventory date:** 2026-08-31

## Conclusion

No Core / NF operational HTTP write routes exist in this repository. No managed
core-network targets are registered. No production executor exists for an NF
restart, reload, start, stop, reconcile, or remote service action.

The repository contains subscriber provisioning, OCS administration, and
subscriber/OCS data-integrity repairs. Those are application-data operations;
they are not evidence that this console controls the running state of AMF,
SMF, UPF, MME, IMS, Open5GS, Kamailio, Docker, Kubernetes, or a remote host.

Phase 8 therefore follows the safe **8.5 readiness** path:

- `coreManagedTargetRegistry` is empty.
- `coreOperationRegistry` is empty.
- `automaticCoreOperationExecutorIds` is empty.
- Any future `APPROVAL_GOVERNED` + `automatic` definition without a
  server-owned executor fails with `CORE_OPERATION_EXECUTOR_MISSING`.
- No SSH, shell, `systemctl`, Docker, Kubernetes, or arbitrary command path
  was added.

## Existing system-facing surface

| Operation | HTTP route | Target | Current behavior | Permission / guard | Classification | Existing executor |
| --- | --- | --- | --- | --- | --- | --- |
| Comprehensive health read | `GET /api/system/health` | Application data health | Reads Mongo-backed database, OCS, HSS subscriber, and security health summaries | Authenticated session | `READ_ONLY` | Repository read queries only |
| Mongo health read | `GET /api/system/mongo/health` | Mongo readiness | Reads Mongo readiness, collections, and indexes | Authenticated session | `READ_ONLY` | Repository read queries only |
| Integrity scan | `POST /api/system/audit/scan` | Subscriber/OCS data | Scans data consistency; the POST verb does not mutate a managed target | Root or operator | `READ_ONLY` | Repository read queries only |
| Targeted data heal | `POST /api/system/audit/heal` | Subscriber/OCS documents | Corrects subscriber, balance, tariff, profile, or reservation data | `system_heal`; operator requests approval, root/ops-admin policy may execute directly | `DIRECT_GOVERNED` / `APPROVAL_GOVERNED` data remediation | `healSubscriberDocument` |
| Batch data heal | `POST /api/system/audit/batch-heal` | Subscriber/OCS documents | Applies bounded per-anomaly data remediation | `system_heal`; operator requests approval, root/ops-admin policy may execute directly | `DIRECT_GOVERNED` / `APPROVAL_GOVERNED` data remediation | `batchHealSubscriberDocuments` |

`SYSTEM_HEAL` remains governed by the existing approval and audit design. It
is deliberately not registered as a Phase 8 core operational action because
its target is stored subscriber/OCS data, not an NF runtime process.

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

The inventory searched `src/app/api`, `src/server`, `src/lib`, and `scripts`
for `child_process`, `exec`, `execFile`, `spawn`, `systemctl`, `service`,
Docker, Kubernetes, SSH, Supervisor, and PM2 control surfaces.

No OS-command or remote-execution implementation was found in application
source. The browser has no command, service name, binary path, script path,
host, or executor argument API.

## Phase 9 readiness

Phase 9 may introduce configuration governance only after separately defining
versioned configuration snapshots, semantic validation, redaction, staged
application, rollback planning, and the reload/restart dependency boundary.
It must not use this Phase 8 readiness registry as permission to add a shell
or remote-control implementation.
