# Approval Complete Call Chain

> **Phase 0 Baseline** — Generated from source code scan on 2026-08-31
> Branch: `develop` | Commit: `1f1cb3fb27c680cc280e898801ca219d445788bb`

## Approval Lifecycle

```
1. CREATE     → pending
2. APPROVE    → approved     (or REJECT → rejected, CANCEL → cancelled, EXPIRE → expired)
3. EXECUTE    → executing    (CAS claim with executionId)
4. COMPLETE   → completed    (or FAIL → failed)
```

## Step-by-Step Chain

### 1. Approval Create

**Who creates**: HTTP route handler (e.g., `PUT /api/subscribers/:imsi`)

**Flow**:
```
Route handler
  → requireCapability('subscriber_write')           [src/lib/authz.ts]
  → evaluateSubscriberOperation(SUBSCRIBER_UPDATE)   [src/server/subscriberGovernanceRegistry.ts]
  → prepareFrozenSubscriberUpdate(imsi, payload)     [src/server/subscriberSingleGovernance.ts]
  → createApprovalRequest({                          [src/server/repositories/approvalRepository.ts]
       action: 'SUBSCRIBER_UPDATE',
       requester: auth.user,
       targetId: imsi,
       payload: frozen,
       before: frozen.before,
       after: frozen.after,
       operationFingerprint: frozen.operationFingerprint
     })
  → logAudit('UPDATE', approval.id, ...)             [src/lib/audit.ts]
```

**Key**: The route does NOT write to the target collection. It only creates an approval document.

### 2. Approval Review (Approve/Reject/Cancel)

**Who reviews**: A different user with `approvals.approve` permission

**Flow**:
```
POST /api/approvals/:id/approve
  → requirePermission('approvals.approve')           [src/lib/authz.ts]
  → approveChange(request, id, auth, body)           [src/server/approvalWorkflow.ts]
    → loadPending(id)                                [checks status, handles expiry]
    → approvalActionEligibility(approval, actor)     [checks maker-checker]
    → currentActor(auth)                             [validates account]
    → transitionApproval({                           [src/server/repositories/approvalRepository.ts]
         expectedStatus: 'pending',
         nextStatus: 'approved',
         actor: auth.user
       })                                            [CAS findOneAndUpdate]
    → auditTransition(request, 'approval.approve', ...)[src/lib/audit.ts]
```

**Self-review blocking**: If `riskLevel` is `high` or `critical`, `requester === actor.user` → blocked (`MAKER_CHECKER_VIOLATION`).

### 3. Approval Execute

**Who executes**: A user with `approvals.execute` permission (can be the approver)

**Flow**:
```
POST /api/approvals/:id/execute
  → requirePermission('approvals.execute')           [src/lib/authz.ts]
  → executeApprovedChange(request, id, auth)         [src/server/approvalExecution.ts]
    → getApproval(id)                                [load current state]
    → approvalActionEligibility(approval, auth)      [check canExecute]
    → actorFor(auth)                                 [validate account]
    → transitionApproval({                           [CAS claim]
         expectedStatus: 'approved',
         nextStatus: 'executing',
         patch: { execution: { id: executionId, startedAt } }
       })
    → writeExecutionAudit('approval.execute.start', ...)
    → validateExecutionPrecondition(approval)        [maintenance window, resource state]
    → executor.execute(approval, request, actor)     [actual mutation]
    → finishExecution({ result })                    [transition to completed/failed]
      → transitionApproval({ nextStatus: 'completed' })
      → writeExecutionAudit('approval.execute.completed', ...)
```

### 4. Executor Dispatch

**File**: `src/server/approvalExecutors.ts` — `defaultExecutor.execute()`

| Approval Action | Executor Path | Target |
|----------------|---------------|--------|
| `ACCESS_REQUEST` | `executeApproval()` → `updateUser()` | `app_users` |
| `TRAFFIC_ADJUSTMENT` (v1) | `executeFrozenOcsBalanceAdjustment()` | `ocs_balances` (CAS) |
| `SUBSCRIBER_BATCH_UPDATE` | `executeFrozenSubscriberBatchChange()` | `subscribers` (bulkWrite) |
| `SUBSCRIBER_UPDATE` | `executeFrozenSubscriberUpdate()` | `subscribers` (replaceOne) |
| `SUBSCRIBER_DELETE` | `executeFrozenSubscriberDelete()` | `subscribers` (deleteOne) |
| `SUBSCRIBER_BULK_DELETE` | `executeFrozenSubscriberBulkDelete()` | `subscribers` (deleteOne×N) |
| `SUBSCRIBER_BATCH_CREATE` | `executeApproval()` → `createSubscribersBatch()` | `subscribers` (bulkWrite) |
| `SUBSCRIBER_IMPORT` | `executeApproval()` → `importSubscribersFromRecords()` | `subscribers` (bulkWrite) |
| `POLICY_CHANGE` | `executeApproval()` → `changeOcsPolicyForSubscribers()` | `ocs_subscribers`, `ocs_balances` |
| `TARIFF_PLAN_MIGRATE` | `executeApproval()` → `migrateTariffPlanSubscribers()` | `ocs_subscribers`, `ocs_balances` |
| `TRAFFIC_ADJUSTMENT` (legacy) | `executeApproval()` → `adjustOcsTrafficBalance()` | `ocs_balances` |
| `TARIFF_PLAN_CREATE` | `executeApproval()` → `createTariffPlan()` | `ocs_tariff_plans` |
| `TARIFF_PLAN_UPDATE` | `executeApproval()` → `updateTariffPlan()` | `ocs_tariff_plans` |
| `TARIFF_PLAN_DELETE` | `executeApproval()` → `deleteTariffPlan()` | `ocs_tariff_plans` |
| `TARIFF_PLAN_RULE_*` | `executeApproval()` → `addTariffPlanRule()` etc. | `ocs_tariff_plans` |
| `RATING_CREATE` | `executeApproval()` → `createRating()` | `app_ratings` |
| `RATING_UPDATE` | `executeApproval()` → `updateRating()` | `app_ratings` |
| `RATING_DELETE` | `executeApproval()` → `deleteRating()` | `app_ratings` |
| `PROFILE_RESTORE` | `executeApproval()` → `restoreProfileVersion()` | `app_profiles` |
| `SYSTEM_HEAL` | `executeApproval()` → `healSubscriberDocument()` | `subscribers` |

### 5. Idempotency

**Approval execution**: CAS on `executionId` field — prevents double-execution.

**Balance adjustments**: Ledger table `ocs_balance_adjustments` with `adjustmentId` — duplicate claims return idempotent result.

**Subscriber batch**: Precondition hash check — stale frozen payloads are rejected.

**Audit logs**: `_id = id` — duplicate inserts are silently ignored.

### 6. Failure Handling

| Failure Point | Behavior | Evidence |
|--------------|----------|----------|
| Precondition changed | `APPROVAL_PRECONDITION_CHANGED` (409) | `approvalExecution.ts:132-162` |
| Outside maintenance window | `OUTSIDE_MAINTENANCE_WINDOW` (409) | `approvalExecution.ts:136` |
| Audit persistence failure | `AUDIT_UNAVAILABLE` (503), mutation committed | `approvalExecution.ts:179-182` |
| Partial batch write | `SUBSCRIBER_BATCH_PARTIAL_WRITE` | `subscriberOperationPolicy.ts:226-228` |
| Balance CAS conflict | `OCS_BALANCE_PRECONDITION_CHANGED` (409) | `ocsBalanceGovernance.ts:191-194` |
| Execution error | `approval.execute.failed` audit, status → `failed` | `approvalExecution.ts:201-225` |

### 7. Audit Trail

Every approval transition produces:
1. **In-document event**: `$push: { events: { id, timestamp, type, actor, message } }` (durable in approval doc)
2. **Separate audit log**: `writeAuditLog()` → `app_audit_logs` collection (best-effort or strict)

Audit actions recorded:
- `approval.approve` / `approval.reject` / `approval.cancel`
- `approval.execute.start` / `approval.execute.completed` / `approval.execute.failed`
- Domain-specific actions (e.g., `subscriber.update`, `ocs.balance.adjust`)

## Key Answers

**Q: Who executes the actual write after approval?**
A: `approvalExecution.ts:executeApprovedChange()` dispatches to `defaultExecutor.execute()` which calls domain-specific frozen payload executors.

**Q: How does the executor bind to an operation?**
A: The `defaultExecutor` switches on `approval.action` string. Each action maps to a specific frozen payload executor.

**Q: What happens when an executor is missing?**
A: Module-load assertions (`assertSubscriberApprovalExecutorCoverage`, etc.) throw on startup if an automatic approval action has no executor.

**Q: Is self-review allowed?**
A: For `low`/`medium` risk: yes. For `high`/`critical` risk: no (`MAKER_CHECKER_VIOLATION`).

**Q: How is duplicate execution prevented?**
A: CAS on `executionId` in `transitionApproval()`. Balance adjustments use a ledger table with `adjustmentId` for idempotency.

**Q: What happens on execution failure?**
A: Status transitions to `failed`. If the mutation already committed (e.g., balance CAS), the error is thrown with `committed: true` to prevent retry.

**Q: Where does audit happen?**
A: Two places: (1) `$push` to approval `events[]` array, (2) `writeAuditLog()` to `app_audit_logs` collection.
