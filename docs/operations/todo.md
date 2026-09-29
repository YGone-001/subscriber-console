# TODO

> 当前任务、blocker、deferred、风险。
> 稳定规则看 `CLAUDE.md`；当前状态看 `AGENTS.md`；历史看 `DEV_LOG.md`。

## Current

| Task | Status | Notes |
|------|--------|-------|
| Phase 7.0 — Platform Services Architecture Freeze | COMPLETE | Architecture freeze, contract inventory, planning validator |
| Phase 7.1 — Platform Health & Status Contract Parity | COMPLETE | Go shadow implementation for health/status reads (33/33 tests PASS) |
| Phase 7.2 — Alert Domain Governance & Mutations | COMPLETE | Acknowledge & workflow direct execution shadow in Go (42/42 tests PASS) |
| Phase 7.3 — Notification Streaming (SSE) Migration | COMPLETE / FROZEN | Go SSE handler complete and verified; Run #140 PASS |
| Phase 7.4 — System Integrity Self-Healing Mutations | COMPLETE / FROZEN | Remediation parity closed (106/106); two known scanner/remediation residual gaps explicitly accepted and frozen |
| Phase 7.5 — Controlled Platform Services Cutover | IMPLEMENTED / NOT FROZEN | 11 Phase 7 operations Go production-owned; `CUTOVER_TABLE = 47`, `ACTUALLY_ROUTED = 47`; independent acceptance pending |

## Deferred

| Item | Reason |
|------|--------|
| `GET /api/audit/export` | Retired governance surface; audit console removed |
| Notification broker / Kafka / Redis | Carrier on-premise single-instance deployment; SSE polling stream sufficient |
| Charging plane migration | Out of scope; billing engine retains raw charging control |

## Blockers

Phase 7.5 implemented and NOT FROZEN pending independent acceptance. Phase 8 is NOT STARTED. Two known scanner/remediation residual gaps remain frozen by design in `docs/backend-migration/remediation-acceptance-corrections.md`.

## Risks

| Risk | Mitigation |
|------|------------|
| OCS production freeze regression | `ACTUALLY_ROUTED = 47` strictly enforced by migration validator |
| Charging plane exposure | Frozen collections (sessions, reservations, usage, events) excluded from migration |
| JWT_SECRET mismatch across processes | frontend/.env must share same JWT_SECRET as root/.env (verified 2026-09-23) |
