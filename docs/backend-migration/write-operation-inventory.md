# Write Operation Inventory

> **Phase 0 Baseline** — Generated from source code scan on 2026-08-31
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb`

## Classification Legend

| Mode | Meaning |
|------|---------|
| `DIRECT_GOVERNED` | Route writes directly to repository after permission check; no approval required |
| `APPROVAL_GOVERNED` | Route creates an approval request; actual mutation deferred to approval execution |
| `RUNTIME_INTERNAL` | Internal system operation, not exposed via HTTP |
| `DISABLED` | Operation defined in registry but explicitly disabled |
| `UNKNOWN` | No clear governance evidence found in code |

## Summary

| Mode | Count |
|------|------:|
| DIRECT_GOVERNED | 14 |
| APPROVAL_GOVERNED | 16 |
| RUNTIME_INTERNAL | 4 |
| DISABLED | 11 |
| UNKNOWN | 3 |
| **Total semantic writes** | **46** |

> **Non-GET HTTP operations: 49** (from source scan)
> - 46 semantic write operations (table below)
> - 2 POST endpoints that are semantically reads: `batch/precheck`, `system/audit/scan`
> - 1 GET endpoint that is a dry-run preview: `tariff-plans/:planId/migrate` GET
>
> The discrepancy between 48 (previous count) and 49 (scanner count) was caused by:
> (1) missing the legacy approval POST compat wrapper (`/api/approvals/:id` POST),
> (2) double-counting `batch/precheck` as both a read and a write.
> Correct count: **49 non-GET HTTP operations**, of which **46 are semantic writes**.

## Subscriber Mutations (7 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| `SUBSCRIBER_CREATE` | POST | `/api/subscribers` | DIRECT_GOVERNED | medium | — | route → `createDefaultSubscriber()` | `subscriberGovernanceRegistry.ts:31` — `requiresApproval: false` |
| `SUBSCRIBER_UPDATE` | PUT | `/api/subscribers/:imsi` | APPROVAL_GOVERNED | high | `SUBSCRIBER_UPDATE` | `subscriberSingleGovernance.ts:executeFrozenSubscriberUpdate` | Route creates CHG, executor runs on approve |
| `SUBSCRIBER_DELETE` | DELETE | `/api/subscribers/:imsi` | APPROVAL_GOVERNED | high | `SUBSCRIBER_DELETE` | `subscriberSingleGovernance.ts:executeFrozenSubscriberDelete` | Route creates CHG, executor runs on approve |
| `SUBSCRIBER_BATCH_CREATE` | POST | `/api/subscribers/batch` | APPROVAL_GOVERNED | high | `SUBSCRIBER_BATCH_CREATE` | `approvalExecutors.ts:executeApproval` | Legacy executor path |
| `SUBSCRIBER_BATCH_UPDATE` | POST | `/api/subscribers/batch-update` | APPROVAL_GOVERNED | high | `SUBSCRIBER_BATCH_UPDATE` | `subscriberOperationPolicy.ts:executeFrozenSubscriberBatchChange` | Frozen payload with precondition hash |
| `SUBSCRIBER_BULK_DELETE` | POST | `/api/subscribers/bulk-delete` | APPROVAL_GOVERNED | critical | `SUBSCRIBER_BULK_DELETE` | `subscriberSingleGovernance.ts:executeFrozenSubscriberBulkDelete` | Frozen payload with precondition check |
| `SUBSCRIBER_IMPORT` | POST | `/api/subscribers/import` | APPROVAL_GOVERNED | high | `SUBSCRIBER_IMPORT` / `SUBSCRIBER_IMPORT_OVERWRITE` | `approvalExecutors.ts:executeApproval` | Legacy executor path |

## OCS Balance Mutations (1 operation)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| `OCS_BALANCE_ADJUST` | POST | `/api/subscribers/:imsi/traffic-adjustments` | APPROVAL_GOVERNED | high | `TRAFFIC_ADJUSTMENT` | `ocsBalanceGovernance.ts:executeFrozenOcsBalanceAdjustment` | Frozen payload with version CAS |

## OCS Tariff Plan Mutations (8 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| `OCS_TARIFF_PLAN_CREATE` | POST | `/api/tariff-plans` | APPROVAL_GOVERNED | high | `TARIFF_PLAN_CREATE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry (`OCS_TARIFF_CREATE_NOT_SUPPORTED`), but route creates approval directly |
| `OCS_TARIFF_PLAN_UPDATE` | PUT | `/api/tariff-plans/:planId` | APPROVAL_GOVERNED | high | `TARIFF_PLAN_UPDATE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |
| `OCS_TARIFF_PLAN_DELETE` | DELETE | `/api/tariff-plans/:planId` | APPROVAL_GOVERNED | critical | `TARIFF_PLAN_DELETE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |
| `OCS_TARIFF_RULE_CREATE` | POST | `/api/tariff-plans/:planId/rules` | APPROVAL_GOVERNED | high | `TARIFF_PLAN_RULE_CREATE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |
| `OCS_TARIFF_RULE_UPDATE` | PUT | `/api/tariff-plans/:planId/rules/:ruleId` | APPROVAL_GOVERNED | high | `TARIFF_PLAN_RULE_UPDATE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |
| `OCS_TARIFF_RULE_DELETE` | DELETE | `/api/tariff-plans/:planId/rules/:ruleId` | APPROVAL_GOVERNED | critical | `TARIFF_PLAN_RULE_DELETE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |
| `OCS_TARIFF_RULE_TOGGLE` | — | — | DISABLED | high | — | — | `ocsGovernanceRegistry.ts:75` — `OCS_TARIFF_RULE_TOGGLE_NOT_SUPPORTED` |
| `OCS_PLAN_MIGRATE` | POST | `/api/tariff-plans/:planId/migrate` | APPROVAL_GOVERNED | critical | `TARIFF_PLAN_MIGRATE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |

## OCS Runtime Operations (4 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| `OCS_RUNTIME_RESERVE` | — | — | RUNTIME_INTERNAL | high | — | — | `ocsGovernanceRegistry.ts:81` — no HTTP route |
| `OCS_RUNTIME_CONSUME` | — | — | RUNTIME_INTERNAL | high | — | — | `ocsGovernanceRegistry.ts:82` — no HTTP route |
| `OCS_RUNTIME_RELEASE` | — | — | RUNTIME_INTERNAL | high | — | — | `ocsGovernanceRegistry.ts:83` — no HTTP route |
| `OCS_RUNTIME_USAGE` | — | — | RUNTIME_INTERNAL | high | — | — | `ocsGovernanceRegistry.ts:84` — no HTTP route |

## OCS Rating Mutations (3 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| `OCS_RATING_CREATE` | POST | `/api/ratings` | APPROVAL_GOVERNED | medium | `RATING_CREATE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |
| `OCS_RATING_UPDATE` | PUT | `/api/ratings/:id` | APPROVAL_GOVERNED | high | `RATING_UPDATE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |
| `OCS_RATING_DELETE` | DELETE | `/api/ratings/:id` | APPROVAL_GOVERNED | critical | `RATING_DELETE` | `approvalExecutors.ts:executeApproval` | Disabled in OCS registry, route creates approval |

## Profile Mutations (4 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| — | POST | `/api/profiles` | DIRECT_GOVERNED | — | — | `profileRepository.createProfile` | No governance registry; direct capability check |
| — | PUT | `/api/profiles/:name` | DIRECT_GOVERNED | — | — | `profileRepository.updateProfile` | No governance registry; direct capability check |
| — | DELETE | `/api/profiles/:name` | DIRECT_GOVERNED | — | — | `profileRepository.deleteProfile` | No governance registry; direct capability check |
| — | POST | `/api/profiles/:name/versions/:versionId/restore` | APPROVAL_GOVERNED | high | `PROFILE_RESTORE` | `approvalExecutors.ts:executeApproval` | Route creates approval for restore |

## Auth/User Mutations (7 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| — | POST | `/api/auth/login` | DIRECT_GOVERNED | — | — | inline in route | JWT creation, bcrypt verify |
| — | POST | `/api/auth/logout` | DIRECT_GOVERNED | — | — | inline in route | Cookie clear |
| — | POST | `/api/auth/users` | DIRECT_GOVERNED | — | — | `userRepository.createUser` | Permission check only |
| — | PUT | `/api/auth/users/:username` | DIRECT_GOVERNED | — | — | `userRepository.updateUser` | Permission check only |
| — | DELETE | `/api/auth/users/:username` | DIRECT_GOVERNED | — | — | `userRepository.deleteUser` | Permission check only |
| — | PATCH | `/api/auth/users/:username` | DIRECT_GOVERNED | — | — | `userRepository.updateUser` | Permission check only |
| — | POST | `/api/users` | DIRECT_GOVERNED | — | — | `userRepository.createUser` | Duplicate of auth/users |

## Approval Workflow Mutations (5 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| — | POST | `/api/approvals` | APPROVAL_GOVERNED | — | — | `approvalRepository.createApprovalRequest` | Creates approval doc |
| — | POST | `/api/approvals/:id/approve` | APPROVAL_GOVERNED | — | — | `approvalWorkflow.approveChange` | CAS transition pending→approved |
| — | POST | `/api/approvals/:id/reject` | APPROVAL_GOVERNED | — | — | `approvalWorkflow.rejectChange` | CAS transition pending→rejected |
| — | POST | `/api/approvals/:id/cancel` | APPROVAL_GOVERNED | — | — | `approvalWorkflow.cancelChange` | CAS transition pending→cancelled |
| — | POST | `/api/approvals/:id/execute` | APPROVAL_GOVERNED | — | — | `approvalExecution.executeApprovedChange` | CAS approved→executing→completed/failed |

## System/Alert Mutations (4 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| — | POST | `/api/alerts/acknowledge` | UNKNOWN | — | — | `alertRepository` | No governance evidence |
| — | POST | `/api/alerts/workflow` | UNKNOWN | — | — | `alertRepository` | No governance evidence |
| — | POST | `/api/system/audit/heal` | APPROVAL_GOVERNED | high | `SYSTEM_HEAL` | `approvalExecutors.ts:executeApproval` | Route creates approval |
| — | POST | `/api/system/audit/batch-heal` | APPROVAL_GOVERNED | high | `SYSTEM_HEAL` | `approvalExecutors.ts:executeApproval` | Route creates approval |

## Other Mutations (2 operations)

| Operation ID | HTTP | Path | Mode | Risk | Approval Action | Executor | Evidence |
|-------------|------|------|------|------|-----------------|----------|----------|
| — | POST | `/api/analytics/init` | UNKNOWN | — | — | `analyticsRepository` | No governance evidence |
| — | POST | `/api/subscribers/policy` | APPROVAL_GOVERNED | high | `POLICY_CHANGE` | `approvalExecutors.ts:executeApproval` | Route creates approval |

## Key Findings

1. **Dual registry inconsistency**: The OCS governance registry marks many operations as `DISABLED` (e.g., `OCS_TARIFF_PLAN_CREATE`), but the HTTP routes still create approval requests directly. The approval executor handles them. This means the OCS registry is advisory only for these operations — the actual governance is in the route + approval system.

2. **Profile mutations bypass governance**: Profile CRUD (create, update, delete) has no governance registry entry and no approval requirement. Only `PROFILE_RESTORE` goes through approval.

3. **Alert mutations are UNKNOWN**: The alert acknowledge and workflow endpoints have no clear governance classification.

4. **Core operation registry is intentionally empty**: `coreOperationRegistry` and `coreManagedTargetRegistry` are both empty arrays. No NF control operations exist.

5. **OCS runtime operations have no HTTP routes**: Reserve, consume, release, and usage are internal-only, not exposed via HTTP.
