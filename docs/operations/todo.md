# TODO

> 当前任务、blocker、deferred、风险。
> 稳定规则看 `CLAUDE.md`；当前状态看 `AGENTS.md`；历史看 `docs/operations/dev-log.md`。

## Current

| Task | Status | Notes |
|------|--------|-------|
| Repository normalization | DONE | Migration-era naming in active source, tests, CI, current documentation and agent instructions replaced with durable production terminology; enforced by `scripts/test-repository-normalization.mjs` |
| Next work item | NOT AUTHORIZED | No further architecture or feature work is approved. Do not start new work without an explicit task definition. |

Completed delivery history is recorded in `docs/operations/dev-log.md`.

## Deferred

| Item | Reason |
|------|--------|
| `GET /api/audit/export` | Retired governance surface; audit console removed |
| Notification broker / Kafka / Redis | Carrier on-premise single-instance deployment; SSE polling stream sufficient |
| Charging plane migration | Out of scope; billing engine retains raw charging control |

## Blockers

No open blockers. Two known scanner/remediation gaps remain frozen by design in
`docs/backend-migration/remediation-acceptance-corrections.md` (historical evidence).

## Risks

| Risk | Mitigation |
|------|------------|
| OCS management-plane freeze regression | `GoRegistered = 84` strictly enforced by the route inventory validator |
| Charging plane exposure | Frozen collections (sessions, reservations, usage, events) excluded from the management plane |
| JWT_SECRET mismatch across processes | Only Go verifies JWTs; `JWT_SECRET` must match between the Go process and the root operational scripts that bootstrap `app_users` (the Next.js runtime holds no JWT secret) |
