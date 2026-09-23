# TODO

> 当前任务、blocker、deferred、风险。
> 稳定规则看 `CLAUDE.md`；当前状态看 `AGENTS.md`；历史看 `DEV_LOG.md`。

## Current

| Task | Status | Notes |
|------|--------|-------|
| Phase 5.7-C push to origin develop | PENDING | Commit `4952483` ready; user must push manually |
| Phase 5.7-C exact-final-SHA CI verification | PENDING | Requires push; all 4 jobs must SUCCESS at final SHA |
| Phase 5.7-D or Phase 6 planning | NOT STARTED | Next phase decision after 5.7-C CI green |

## Deferred

| Item | Reason |
|------|--------|
| `GET /api/audit/export` | Writes audit evidence; Node remains owner |
| Login / Logout | Auth session management; Node remains owner until Phase 6 |

## Blockers

| Blocker | Impact |
|---------|--------|
| Phase 5.7-C push requires user credentials | CI acceptance cannot complete until pushed |

## Risks

| Risk | Mitigation |
|------|------------|
| OCS production freeze regression | `ACTUALLY_ROUTED = 26` strictly enforced by migration validator |
| Charging plane exposure | Frozen collections (sessions, reservations, usage, events) excluded from migration |
| JWT_SECRET mismatch across processes | frontend/.env must share same JWT_SECRET as root/.env (verified 2026-09-23) |
