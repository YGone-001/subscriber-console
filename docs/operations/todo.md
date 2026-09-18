# TODO

> 当前任务、blocker、deferred、风险。
> 稳定规则看 `CLAUDE.md`；当前状态看 `AI_CONTEXT.md`；历史看 `DEV_LOG.md`。

## Current

| Task | Status | Notes |
|------|--------|-------|
| Phase 5.2 — OCS write governance | NOT STARTED | Balance adjust, tariff CRUD with approval workflow |
| Phase 5.3 — OCS tariff/balance writes | NOT STARTED | Depends on 5.2 governance foundation |
| Phase 6 — Auth + User Management | NOT STARTED | Login, logout, users, roles |

## Deferred

| Item | Reason |
|------|--------|
| `GET /api/audit/export` | Writes audit evidence; Node remains owner |
| `POST /api/approvals/:id/execute` | Business mutation executor; Node remains owner |
| Login / Logout | Auth session management; Node remains owner until Phase 6 |
| `ACTUALLY_ROUTED` for OCS reads | Read shadow only; cutover requires production verification |

## Blockers

None currently.

## Risks

| Risk | Mitigation |
|------|------------|
| OCS write migration scope | Phase 5.0 architecture freeze defines exact boundary |
| Charging plane exposure | Frozen collections (sessions, reservations, usage, events) excluded from migration |
