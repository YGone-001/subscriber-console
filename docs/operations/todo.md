# TODO

> 当前任务、blocker、deferred、风险。
> 稳定规则看 `CLAUDE.md`；当前状态看 `AGENTS.md`；历史看 `DEV_LOG.md`。

## Current

| Task | Status | Notes |
|------|--------|-------|
| Phase 7.0 — Platform Services Architecture Freeze | PASS / FROZEN | Architecture freeze, contract inventory, planning validator |
| Phase 7.1 — Platform Health & Status Contract Parity | PASS / FROZEN | Go health/status read parity (full acceptance matrix closed) |
| Phase 7.2 — Alert Domain Governance & Mutations | PASS / FROZEN | Acknowledge & workflow mutation parity (full acceptance matrix closed) |
| Phase 7.3 — Notification Streaming (SSE) Migration | PASS / FROZEN | Go SSE parity complete and verified; Run #140 PASS |
| Phase 7.4 — System Integrity Self-Healing Mutations | PASS / FROZEN | RS01-RS05 frozen as one continuous persistent-state sequence (96 mandatory callbacks executed, `rs_interstep_fixture_writes = 0`); independently accepted |
| Phase 7.5 — Controlled Platform Services Cutover | IMPLEMENTED / NOT FROZEN | 11 Phase 7 operations Go production-owned; independent acceptance pending |
| Phase 8.0 — Next.js Backend Removal Architecture Freeze | PASS / FROZEN | Residual API inventory + source-derived readiness validator |
| Phase 8.1 — Residual API Go Implementation & Shadow Parity | COMPLETE | 33-operation canonical remainder; 11 newly implemented Go shadows; 81 parity scenarios / 122 assertions |
| Phase 8.2 — Residual Production Cutover & Retired Surface Removal | IMPLEMENTED / NOT FROZEN | 33 canonical + 2 legacy read aliases + 2 Go-native reads cut over; 6 non-canonical mutation methods retired; `CUTOVER_TABLE = 84`, `ACTUALLY_ROUTED = 84`, `node_production_operations = 0`; independent acceptance pending |

## Deferred

| Item | Reason |
|------|--------|
| `GET /api/audit/export` | Retired governance surface; audit console removed |
| Notification broker / Kafka / Redis | Carrier on-premise single-instance deployment; SSE polling stream sufficient |
| Charging plane migration | Out of scope; billing engine retains raw charging control |

## Blockers

Phase 7.5 is implemented and NOT FROZEN pending independent acceptance. Phase 8.2 is implemented and NOT FROZEN pending independent acceptance; Phase 8.3 is NOT STARTED. Two known scanner/remediation residual gaps remain frozen by design in `docs/backend-migration/remediation-acceptance-corrections.md`.

## Risks

| Risk | Mitigation |
|------|------------|
| OCS production freeze regression | `ACTUALLY_ROUTED = 84` strictly enforced by migration validator |
| Charging plane exposure | Frozen collections (sessions, reservations, usage, events) excluded from migration |
| JWT_SECRET mismatch across processes | frontend/.env must share same JWT_SECRET as root/.env (verified 2026-09-23) |
