# TODO

> 当前任务、blocker、deferred、风险。
> 稳定规则看 `CLAUDE.md`；当前状态看 `AGENTS.md`；历史看 `DEV_LOG.md`。

## Current

| Task | Status | Notes |
|------|--------|-------|
| Phase 7.0 — Platform Services Architecture Freeze | COMPLETE | Architecture freeze, contract inventory, planning validator |
| Phase 7.1 — Platform Health & Status Contract Parity | NOT STARTED | Go shadow implementation for health/status reads |
| Phase 7.2 — Alert Domain Governance & Mutations | NOT STARTED | Acknowledge & workflow direct execution in Go |
| Phase 7.3 — Notification Streaming (SSE) Migration | NOT STARTED | Native Go SSE handler with http.Flusher |
| Phase 7.4 — System Integrity Self-Healing Mutations | NOT STARTED | Go implementation for heal & batch-heal |
| Phase 7.5 — Controlled Platform Services Cutover | NOT STARTED | CUTOVER_TABLE expansion (36 -> 47) & production freeze |

## Deferred

| Item | Reason |
|------|--------|
| `GET /api/audit/export` | Retired governance surface; audit console removed |
| Notification broker / Kafka / Redis | Carrier on-premise single-instance deployment; SSE polling stream sufficient |
| Charging plane migration | Out of scope; billing engine retains raw charging control |

## Blockers

None currently.

## Risks

| Risk | Mitigation |
|------|------------|
| OCS production freeze regression | `ACTUALLY_ROUTED = 36` strictly enforced by migration validator |
| Charging plane exposure | Frozen collections (sessions, reservations, usage, events) excluded from migration |
| JWT_SECRET mismatch across processes | frontend/.env must share same JWT_SECRET as root/.env (verified 2026-09-23) |
