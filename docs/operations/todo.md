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
| Phase 7.5 — Controlled Platform Services Cutover | PASS / FROZEN | 11 Phase 7 operations Go production-owned; independently accepted |
| Phase 8.0 — Next.js Backend Removal Architecture Freeze | PASS / FROZEN | Residual API inventory + source-derived readiness validator |
| Phase 8.1 — Residual API Go Implementation & Shadow Parity | PASS / FROZEN | 33-operation canonical remainder; 11 newly implemented Go shadows; 81 parity scenarios / 122 assertions |
| Phase 8.2 — Residual Production Cutover & Retired Surface Removal | PASS / FROZEN | 33 canonical + 2 legacy read aliases + 2 Go-native reads cut over; 6 non-canonical mutation methods retired; `CUTOVER_TABLE = 84`, `ACTUALLY_ROUTED = 84`, `node_production_operations = 0` |
| Phase 8.3 — Next.js Business Backend Physical Removal | PASS / FROZEN | `frontend/src/app/api/**` (54 route.ts / 72 operations) and `frontend/src/server/**` (33 files) physically deleted; 7 backend-only lib helpers removed; minimal read-only proxy session account store extracted; `next_business_backend_removed = true`, `active_server_imports = 0`, `CUTOVER_TABLE = 84`; frozen boundary SHA `342589aa5c00cb8152980c77bfc73f05b82ca64a` |
| Phase 8.4 — Frontend Dependency & Residual Node Runtime Cleanup | IMPLEMENTED / NOT SELF-FROZEN | `bcryptjs` removed (zero frontend consumers); 5 dead Node-era libs + orphaned `ChangeDiff.tsx` deleted; `mongo.ts` collapsed into read-only `sessionMongo.ts` (`app_users` only, `findOne`, readers = 1 / writers = 0); `CUTOVER_TABLE = 84`, `backend_production_changes = 0`; independent acceptance pending |
| Phase 8.5 — Proxy / Deployment Boundary Finalization | IMPLEMENTED / NOT SELF-FROZEN | Nginx edge owns `/api` routing (Next `127.0.0.1:13333`, Go `127.0.0.1:18888`); `proxy.ts` reduced to a UI-only navigation guard; `CUTOVER_TABLE` retired, the derived 84 Go registrations are the route authority; frontend deps 19 -> 16 (`jose` / `mongodb` / `jiti`); new suite `scripts/test-phase-8-deployment-boundary.mjs` + CI job; independent acceptance pending |
| Phase 8.6 | NOT STARTED | Not authorized |

## Deferred

| Item | Reason |
|------|--------|
| `GET /api/audit/export` | Retired governance surface; audit console removed |
| Notification broker / Kafka / Redis | Carrier on-premise single-instance deployment; SSE polling stream sufficient |
| Charging plane migration | Out of scope; billing engine retains raw charging control |

## Blockers

No open blockers. Phase 7.0-7.5 and Phase 8.0-8.3 are independently accepted and frozen at `342589aa5c00cb8152980c77bfc73f05b82ca64a`. Phase 8.4 and Phase 8.5 are implemented and awaiting independent acceptance; Phase 8.6 is not authorized yet. Two known scanner/remediation residual gaps remain frozen by design in `docs/backend-migration/remediation-acceptance-corrections.md`.

## Risks

| Risk | Mitigation |
|------|------------|
| OCS production freeze regression | `ACTUALLY_ROUTED = 84` strictly enforced by migration validator |
| Charging plane exposure | Frozen collections (sessions, reservations, usage, events) excluded from migration |
| JWT_SECRET mismatch across processes | After Phase 8.5 only Go verifies JWTs; `JWT_SECRET` must match between the Go process and the root operational scripts that bootstrap `app_users` (the Next.js runtime no longer holds a JWT secret) |
