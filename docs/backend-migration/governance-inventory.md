# Governance Inventory

> **Phase 0 Baseline** — Generated from source code scan on 2026-08-31
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb`

## Architecture Overview

The governance system has three layers:

```
HTTP Route
    ↓
Governance Registry (operation definition)
    ↓
Approval Repository (CHG creation)
    ↓
Approval Workflow (review/approve/reject)
    ↓
Approval Executor (actual mutation)
    ↓
Repository → MongoDB
    ↓
Audit Log
```

## 1. Subscriber Governance Registry

**File**: `src/server/subscriberGovernanceRegistry.ts`

| Operation | Permission | Risk | Requires Approval | Independent Reviewer | Execution Mode | Snapshot Strategy |
|-----------|-----------|------|-------------------|---------------------|----------------|-------------------|
| `SUBSCRIBER_CREATE` | `subscribers.write` | medium | No | No | automatic | none |
| `SUBSCRIBER_UPDATE` | `subscribers.write` | high | Yes | Yes | automatic | single-state |
| `SUBSCRIBER_DELETE` | `subscribers.write` | high | Yes | Yes | automatic | single-state |
| `SUBSCRIBER_BATCH_CREATE` | `subscribers.write` | high | Yes | Yes | automatic | batch-precondition |
| `SUBSCRIBER_BATCH_UPDATE` | `subscribers.write` | high | Yes | Yes | automatic | batch-precondition |
| `SUBSCRIBER_BULK_DELETE` | `subscribers.write` | critical | Yes | Yes | automatic | batch-precondition |
| `SUBSCRIBER_IMPORT` | `subscribers.write` | high | Yes | Yes | automatic | normalized-import |

**Evidence**: `subscriberGovernanceRegistry.ts:30-38` — all 7 operations defined.

**Key function**: `evaluateSubscriberOperation(operation)` returns `{ allowed, executable, ...definition }`.

**Governance enforcement point**: Routes call `evaluateSubscriberOperation()` before creating approvals.

## 2. Subscriber Operation Policy (Batch)

**File**: `src/server/subscriberOperationPolicy.ts`

Defines `SUBSCRIBER_BATCH_UPDATE` governance for batch operations:
- Max 100 targets per batch
- Max 512KB snapshot size
- Frozen payload with precondition hash
- Sensitive field detection (security, k, op, opc, amf, sqn, imsi, msisdn, slice)

**Key function**: `prepareFrozenSubscriberBatchChange(input)` → `FrozenSubscriberBatchChange`

## 3. Subscriber Single Governance

**File**: `src/server/subscriberSingleGovernance.ts`

Provides frozen payload preparation and execution for:
- `FrozenSubscriberUpdate` — single subscriber update with before/after snapshot
- `FrozenSubscriberDelete` — single subscriber delete with before snapshot
- `FrozenSubscriberBulkDelete` — multiple subscriber delete with before snapshots

**Security**: `assertNoAuthenticationMaterialChange()` blocks changes to K, OP/OPc, AMF, SQN via governed paths.

## 4. OCS Governance Registry

**File**: `src/server/ocsGovernanceRegistry.ts`

| Operation | Permission | Risk | Governance Mode | Execution Class | Human Executable |
|-----------|-----------|------|-----------------|-----------------|------------------|
| `OCS_BALANCE_ADJUST` | `ocs.balance.adjust` | high | APPROVAL_GOVERNED | administrative | Yes |
| `OCS_BALANCE_RESET` | `ocs.balance.reset` | critical | DISABLED | administrative | No |
| `OCS_TARIFF_PLAN_CREATE` | `ocs.tariff.write` | high | DISABLED | administrative | No |
| `OCS_TARIFF_PLAN_UPDATE` | `ocs.tariff.write` | high | DISABLED | administrative | No |
| `OCS_TARIFF_PLAN_DELETE` | `ocs.tariff.write` | critical | DISABLED | administrative | No |
| `OCS_TARIFF_RULE_CREATE` | `ocs.tariff.write` | high | DISABLED | administrative | No |
| `OCS_TARIFF_RULE_UPDATE` | `ocs.tariff.write` | high | DISABLED | administrative | No |
| `OCS_TARIFF_RULE_DELETE` | `ocs.tariff.write` | critical | DISABLED | administrative | No |
| `OCS_TARIFF_RULE_TOGGLE` | `ocs.tariff.write` | high | DISABLED | administrative | No |
| `OCS_PLAN_ASSIGN` | `ocs.plan.assign` | high | DISABLED | administrative | No |
| `OCS_PLAN_MIGRATE` | `ocs.plan.assign` | critical | DISABLED | administrative | No |
| `OCS_RATING_CREATE` | `ocs.rating.write` | high | DISABLED | administrative | No |
| `OCS_RATING_UPDATE` | `ocs.rating.write` | high | DISABLED | administrative | No |
| `OCS_RATING_DELETE` | `ocs.rating.write` | critical | DISABLED | administrative | No |
| `OCS_RUNTIME_RESERVE` | `ocs.runtime.execute` | high | RUNTIME_INTERNAL | runtime | No |
| `OCS_RUNTIME_CONSUME` | `ocs.runtime.execute` | high | RUNTIME_INTERNAL | runtime | No |
| `OCS_RUNTIME_RELEASE` | `ocs.runtime.execute` | high | RUNTIME_INTERNAL | runtime | No |
| `OCS_RUNTIME_USAGE` | `ocs.runtime.execute` | high | RUNTIME_INTERNAL | runtime | No |

**Only 1 of 18 operations is APPROVAL_GOVERNED**: `OCS_BALANCE_ADJUST`.

**13 operations are DISABLED** — their `disabledCode` explains why (e.g., `OCS_TARIFF_CREATE_NOT_SUPPORTED`).

**4 operations are RUNTIME_INTERNAL** — no HTTP route exposure.

## 5. OCS Balance Governance

**File**: `src/server/ocsBalanceGovernance.ts`

Implements the actual balance adjustment execution:
- Frozen payload: `FrozenOcsBalanceAdjustment` with schema `ocs-balance-adjustment-v1`
- Version-based optimistic concurrency (CAS on `version` field)
- Ledger table: `ocs_balance_adjustments` for idempotency
- Invariant enforcement: `total = used + reserved + available`

## 6. Core Operation Registry

**File**: `src/server/coreOperationRegistry.ts`

**Intentionally empty** — both `coreManagedTargetRegistry` and `coreOperationRegistry` are `[]`.

From the source:
> "The current repository has no managed NF runtime target and no trusted restart/reload/heal executor. Keep both registries intentionally empty."

**No NF control operations exist**. No restart, reload, heal, or deploy executors.

## 7. Approval Risk Policy

**File**: `src/server/approvalRiskPolicy.ts`

| Approval Action | Risk Level | Reason |
|----------------|-----------|--------|
| `ACCESS_REQUEST` | high | Changes an account authorization boundary |
| `POLICY_CHANGE` | high | Changes live subscriber policy assignment |
| `TRAFFIC_ADJUSTMENT` | high | Changes a charging balance |
| `TARIFF_PLAN_CREATE` | high | Adds a charging tariff plan |
| `TARIFF_PLAN_UPDATE` | high | Changes an active charging tariff plan |
| `TARIFF_PLAN_DELETE` | critical | Removes a charging tariff plan |
| `TARIFF_PLAN_RULE_CREATE` | high | Adds a charging tariff rule |
| `TARIFF_PLAN_RULE_UPDATE` | high | Changes an active charging tariff rule |
| `TARIFF_PLAN_RULE_DELETE` | critical | Removes an active charging tariff rule |
| `TARIFF_PLAN_RULE_TOGGLE` | high | Changes a charging tariff rule state |
| `RATING_CREATE` | medium | Adds a charging rule |
| `RATING_UPDATE` | high | Changes an active charging rule |
| `RATING_DELETE` | critical | Removes an active charging rule |
| `TARIFF_PLAN_MIGRATE` | critical | Moves multiple subscribers between plans |
| `PROFILE_RESTORE` | high | Restores a previous configuration snapshot |
| `SYSTEM_HEAL` | high | Writes corrective state to a managed resource |
| `SUBSCRIBER_BATCH_CREATE` | high | Creates multiple subscriber records |
| `SUBSCRIBER_BATCH_UPDATE` | high | Changes live core subscriber access/AMBR in bulk |
| `SUBSCRIBER_CREATE` | medium | Creates a new subscriber record |
| `SUBSCRIBER_UPDATE` | high | Changes governed core subscriber configuration |
| `SUBSCRIBER_DELETE` | high | Physically deletes subscriber provisioning |
| `SUBSCRIBER_IMPORT` | high | Imports new subscriber records only |
| `SUBSCRIBER_IMPORT_OVERWRITE` | critical | Imports records that overwrite existing subscribers |
| `SUBSCRIBER_BULK_DELETE` | critical | Deletes multiple subscriber records |
| `SUBSCRIBER_PROFILE_APPLY` | high | Applies a profile to live subscriber configuration |

**Maker-checker policy**: `requiresIndependentReviewer(risk)` returns `true` for `high` and `critical`.

## 8. Approval Workflow

**File**: `src/server/approvalWorkflow.ts`

State machine:
```
pending → approved → executing → completed
pending → approved → executing → failed
pending → rejected
pending → cancelled
pending → expired
```

**Self-review blocking**: High/critical risk approvals require an independent reviewer (cannot be the requester).

## 9. Approval Executors

**File**: `src/server/approvalExecutors.ts`

The `defaultExecutor` handles these approval actions:
- `ACCESS_REQUEST` → `executeApproval()` (legacy)
- `TRAFFIC_ADJUSTMENT` (with `ocs-balance-adjustment-v1` schema) → `executeFrozenOcsBalanceAdjustment()`
- `SUBSCRIBER_BATCH_UPDATE` → `executeFrozenSubscriberBatchChange()`
- `SUBSCRIBER_UPDATE` → `executeFrozenSubscriberUpdate()`
- `SUBSCRIBER_DELETE` → `executeFrozenSubscriberDelete()`
- `SUBSCRIBER_BULK_DELETE` → `executeFrozenSubscriberBulkDelete()`
- All others → `executeApproval()` (legacy executor)

**Coverage assertions** (run at module load):
- `assertSubscriberApprovalExecutorCoverage()` — all 6 subscriber approval actions have executors
- `assertOcsExecutorCoverage()` — `TRAFFIC_ADJUSTMENT` has executor
- `assertCoreOperationExecutorCoverage()` — core registry is empty, so no missing executors

## 10. Governance Chain Diagram

```
HTTP Route (e.g., PUT /api/subscribers/:imsi)
    ↓
requireCapability('subscriber_write')         ← authz.ts
    ↓
evaluateSubscriberOperation(SUBSCRIBER_UPDATE) ← subscriberGovernanceRegistry.ts
    ↓
prepareFrozenSubscriberUpdate(imsi, payload)   ← subscriberSingleGovernance.ts
    ↓
createApprovalRequest({action: 'SUBSCRIBER_UPDATE', ...}) ← approvalRepository.ts
    ↓
[Returns 202 with approval object]
    ↓
[Reviewer calls POST /api/approvals/:id/approve]
    ↓
approveChange() → transitionApproval(pending→approved) ← approvalWorkflow.ts
    ↓
[Executor calls POST /api/approvals/:id/execute]
    ↓
executeApprovedChange() → validateExecutionPrecondition() ← approvalExecution.ts
    ↓
defaultExecutor.execute(approval) ← approvalExecutors.ts
    ↓
executeFrozenSubscriberUpdate(payload) ← subscriberSingleGovernance.ts
    ↓
updateSubscriberFromLegacy() ← subscriberRepository.ts
    ↓
MongoDB replaceOne (with precondition check)
    ↓
writeAuditLog() ← audit.ts
```
