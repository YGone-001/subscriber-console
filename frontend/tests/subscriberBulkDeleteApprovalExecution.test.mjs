// tests/subscriberBulkDeleteApprovalExecution.test.mjs
// Sections 8-16: Bulk Delete Approval Execute v1/v2 — production executor path
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approvalDocument(action, payload, status = 'approved') {
  const now = new Date().toISOString();
  return {
    id: `approval-${crypto.randomUUID()}`,
    changeId: `CHG-${Date.now()}`,
    title: 'Test bulk delete',
    summary: 'Test bulk delete',
    action,
    status,
    operation: { resourceType: 'subscriber', resourceId: 'bulk-delete' },
    riskLevel: 'critical',
    riskAssessment: { level: 'critical', factors: [] },
    requester: 'testuser',
    targetId: 'subscriber:bulk-delete',
    payload,
    before: { targetCount: payload.targetCount || payload.requested || 1 },
    operationFingerprint: payload.operationFingerprint,
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

function v2Payload(imsiList) {
  const targets = imsiList.map((imsi) => ({
    imsi,
    before: { imsi, msisdn: ['1234567890'], accessRestrictionData: 0, networkAccessMode: 0 },
    preconditionHash: `hash-${imsi}`,
  }));
  return {
    version: 'subscriber-bulk-delete-v2',
    targets,
    targetCount: imsiList.length,
    snapshotBytes: 1024,
    strategy: 'delete-only',
    operationFingerprint: `fp-${imsiList.join('-')}`,
  };
}

function v1Payload(imsiList) {
  return {
    targets: imsiList.map((imsi) => ({ imsi, before: { imsi, msisdn: ['1234567890'] } })),
    requested: imsiList.length,
    operationFingerprint: `fp-v1-${imsiList.join('-')}`,
  };
}

// Fake in-memory approval repository with state machine transitions
function createFakeApprovalRepo(initialApproval) {
  const records = new Map();
  if (initialApproval) records.set(initialApproval.id, structuredClone(initialApproval));
  const transitions = [];

  return {
    records,
    transitions,
    async getApproval(id) {
      const rec = records.get(id);
      return rec ? structuredClone(rec) : null;
    },
    async transitionApproval(input) {
      transitions.push(input);
      const rec = records.get(input.id);
      if (!rec) return { ok: false, reason: 'not_found' };
      if (rec.status !== input.expectedStatus) {
        return { ok: false, reason: 'conflict', approval: structuredClone(rec) };
      }
      if (input.expectedExecutionId && rec.execution?.id !== input.expectedExecutionId) {
        return { ok: false, reason: 'conflict', approval: structuredClone(rec) };
      }
      // Apply transition
      const patch = input.patch || {};
      rec.status = input.nextStatus;
      rec.execution = { ...rec.execution, ...patch.execution };
      rec.result = patch.result;
      rec.error = patch.error;
      rec.executedAt = patch.executedAt;
      rec.events.push({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: input.eventType,
        actor: input.actor,
        message: input.eventMessage,
      });
      rec.updatedAt = new Date().toISOString();
      return { ok: true, approval: structuredClone(rec) };
    },
  };
}

// Build governance spies that track call counts
function createGovernanceSpies(overrides = {}) {
  const calls = {
    assertFrozenBulkDeleteV2: 0,
    executeFrozenSubscriberBulkDeleteV2: 0,
    executeFrozenSubscriberBulkDelete: 0,
    classifyBulkDeleteResult: 0,
  };

  return {
    calls,
    module: {
      assertFrozenBulkDeleteV2(payload) {
        calls.assertFrozenBulkDeleteV2++;
        // Return a minimal valid frozen structure
        return {
          version: 'subscriber-bulk-delete-v2',
          targets: payload.targets || [],
          targetCount: payload.targetCount || 0,
          snapshotBytes: payload.snapshotBytes || 0,
          strategy: 'delete-only',
          operationFingerprint: payload.operationFingerprint || '',
        };
      },
      async executeFrozenSubscriberBulkDeleteV2(frozen) {
        calls.executeFrozenSubscriberBulkDeleteV2++;
        if (overrides.v2Result) return overrides.v2Result;
        return {
          requested: frozen.targetCount,
          deletedImsis: frozen.targets.map((t) => t.imsi),
          conflictImsis: [],
          failedImsis: [],
          ocsCleanedImsis: frozen.targets.map((t) => t.imsi),
          ocsCleanupFailedImsis: [],
          deletedCount: frozen.targetCount,
          partialMutation: false,
          mutationCommitted: true,
          operationFingerprint: frozen.operationFingerprint,
        };
      },
      async executeFrozenSubscriberBulkDelete(payload) {
        calls.executeFrozenSubscriberBulkDelete++;
        if (overrides.v1Result) return overrides.v1Result;
        const targets = Array.isArray(payload.targets) ? payload.targets : [];
        return {
          requested: payload.requested || targets.length,
          deleted: payload.requested || targets.length,
          targets: targets.map((t) => (typeof t === 'string' ? t : t.imsi)),
          operationFingerprint: payload.operationFingerprint || '',
        };
      },
      classifyBulkDeleteResult(deletedCount, requested, conflictCount, failedCount, ocsCleanupFailureCount) {
        calls.classifyBulkDeleteResult++;
        if (deletedCount === requested && conflictCount === 0 && failedCount === 0 && ocsCleanupFailureCount === 0) return 'SUCCESS';
        if (deletedCount > 0) return 'PARTIAL_WRITE';
        return 'FAILED_NO_MUTATION';
      },
      executeFrozenSubscriberDelete: async () => ({}),
      executeFrozenSubscriberUpdate: async () => ({}),
      SubscriberGovernanceError: class extends Error {
        constructor(code) { super(code); this.code = code; }
      },
    },
  };
}

// Build the service module with injected dependencies
function createExecutionService(repo, governanceSpies, auditOverrides = {}) {
  const auditCalls = [];

  const mockWriteAuditLog = async (input, opts) => {
    auditCalls.push(input);
    if (auditOverrides.throwForAction && input.action === auditOverrides.throwForAction) {
      throw new Error('audit service down');
    }
    return true;
  };

  const service = loadModule('src/server/approvalExecution.ts', {
    '@/lib/audit': { writeAuditLog: mockWriteAuditLog },
    '@/lib/audit/record': { auditRequestContext: () => ({}) },
    '@/lib/accountSession': { validateCurrentAccount: async ({ username, role }) => ({ userId: username, username, role }) },
    '@/server/approvalExecutors': { executeApproval: async () => ({}) },
    '@/server/subscriberOperationPolicy': {
      executeFrozenSubscriberBatchChange: async () => ({}),
      executeFrozenSubscriberBatchUpdate: async () => ({}),
      assertFrozenSubscriberBatchUpdateV2: () => ({}),
      assertFrozenSubscriberBatchPayload: () => ({}),
      classifyBatchUpdateResult: () => 'SUCCESS',
      SubscriberBatchGovernanceError: class extends Error { constructor(code) { super(code); this.code = code; } },
    },
    '@/server/subscriberSingleGovernance': governanceSpies.module,
    '@/server/subscriberGovernanceRegistry': { assertGovernedOperationCoverage: () => {} },
    '@/server/ocsGovernanceRegistry': { assertOcsGovernedOperationCoverage: () => {} },
    '@/server/coreOperationRegistry': { assertCoreOperationExecutorCoverage: () => {} },
    '@/server/ocsBalanceGovernance': {
      executeFrozenOcsBalanceAdjustment: async () => ({}),
      OcsBalanceGovernanceError: class extends Error { constructor(code) { super(code); this.code = code; } },
    },
    '@/server/approvalWorkflow': {
      ApprovalWorkflowError: class extends Error { constructor(code) { super(code); this.code = code; } },
      approvalActionEligibility: (item) => ({ canExecute: item.status === 'approved' }),
    },
    '@/server/repositories/approvalRepository': repo,
    '@/server/repositories/userRepository': { getUser: async () => ({ role: 'super_admin', status: 'active' }) },
    '@/server/repositories/ocsBillingRepository': { getTariffPlan: async () => null },
    '@/server/repositories/ratingRepository': { getRating: async () => null },
  });

  return { service, auditCalls };
}

// ---------------------------------------------------------------------------
// Section 8: v2 Success — Production Path
// ---------------------------------------------------------------------------
test('Bulk Delete Approval Execute v2 succeeds through production executor', async () => {
  const payload = v2Payload(['001010000000001']);
  const approval = approvalDocument('SUBSCRIBER_BULK_DELETE', payload);
  const repo = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies();
  const { service, auditCalls } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  const result = await service.executeApprovedChange(request, approval.id, auth);

  // v2 executor was called, legacy was not
  assert.equal(govSpies.calls.assertFrozenBulkDeleteV2, 1);
  assert.equal(govSpies.calls.executeFrozenSubscriberBulkDeleteV2, 1);
  assert.equal(govSpies.calls.executeFrozenSubscriberBulkDelete, 0);

  // Business audit was called with correct action
  const batchAudit = auditCalls.find((a) => a.action === 'subscriber.batch.delete');
  assert.ok(batchAudit, 'subscriber.batch.delete audit must be called');
  assert.equal(batchAudit.result, 'success');
  assert.equal(batchAudit.metadata.classification, 'SUCCESS');
  assert.equal(batchAudit.metadata.mutationCommitted, true);

  // Approval transitioned to completed
  assert.equal(result.status, 'completed');
  assert.equal(result.execution.success, true);
});

// ---------------------------------------------------------------------------
// Section 9: v2 Precondition Conflict — Production Classification
// ---------------------------------------------------------------------------
test('Bulk Delete Approval Execute v2 precondition conflict through production executor', async () => {
  const payload = v2Payload(['001010000000001']);
  const approval = approvalDocument('SUBSCRIBER_BULK_DELETE', payload);
  const repo = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v2Result: {
      requested: 1,
      deletedImsis: [],
      conflictImsis: ['001010000000001'],
      failedImsis: [],
      ocsCleanedImsis: [],
      ocsCleanupFailedImsis: [],
      deletedCount: 0,
      partialMutation: false,
      mutationCommitted: false,
      operationFingerprint: payload.operationFingerprint,
    },
  });
  const { service, auditCalls } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  const result = await service.executeApprovedChange(request, approval.id, auth);

  // Production classified and rejected
  assert.equal(govSpies.calls.classifyBulkDeleteResult, 1);

  // Business audit called with failed result
  const batchAudit = auditCalls.find((a) => a.action === 'subscriber.batch.delete');
  assert.ok(batchAudit);
  assert.equal(batchAudit.result, 'failed');
  assert.equal(batchAudit.metadata.classification, 'FAILED_NO_MUTATION');
  assert.equal(batchAudit.metadata.mutationCommitted, false);

  // Approval transitioned to failed with correct error
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED');
});

// ---------------------------------------------------------------------------
// Section 10: v2 Zero Storage Failure
// ---------------------------------------------------------------------------
test('Bulk Delete Approval Execute v2 storage failure through production executor', async () => {
  const payload = v2Payload(['001010000000001']);
  const approval = approvalDocument('SUBSCRIBER_BULK_DELETE', payload);
  const repo = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v2Result: {
      requested: 1,
      deletedImsis: [],
      conflictImsis: [],
      failedImsis: ['001010000000001'],
      ocsCleanedImsis: [],
      ocsCleanupFailedImsis: [],
      deletedCount: 0,
      partialMutation: false,
      mutationCommitted: false,
      operationFingerprint: payload.operationFingerprint,
    },
  });
  const { service, auditCalls } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  const result = await service.executeApprovedChange(request, approval.id, auth);

  // Business audit called with failed result
  const batchAudit = auditCalls.find((a) => a.action === 'subscriber.batch.delete');
  assert.ok(batchAudit);
  assert.equal(batchAudit.result, 'failed');
  assert.equal(batchAudit.metadata.classification, 'FAILED_NO_MUTATION');

  // Approval transitioned to failed
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'SUBSCRIBER_BULK_DELETE_FAILED');
  assert.equal(result.result.classification, 'FAILED_NO_MUTATION');
});

// ---------------------------------------------------------------------------
// Section 11: v2 Partial CAS
// ---------------------------------------------------------------------------
test('Bulk Delete Approval Execute v2 partial CAS through production executor', async () => {
  const payload = v2Payload(['001010000000001', '001010000000002']);
  const approval = approvalDocument('SUBSCRIBER_BULK_DELETE', payload);
  const repo = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v2Result: {
      requested: 2,
      deletedImsis: ['001010000000001'],
      conflictImsis: ['001010000000002'],
      failedImsis: [],
      ocsCleanedImsis: ['001010000000001'],
      ocsCleanupFailedImsis: [],
      deletedCount: 1,
      partialMutation: true,
      mutationCommitted: true,
      operationFingerprint: payload.operationFingerprint,
    },
  });
  const { service, auditCalls } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  // committed=true → production rethrows instead of converting to failed approval
  await assert.rejects(
    service.executeApprovedChange(request, approval.id, auth),
    (error) => {
      assert.equal(error.code, 'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE');
      assert.equal(error.status, 409);
      assert.equal(error.committed, true);
      assert.equal(error.details.classification, 'PARTIAL_WRITE');
      return true;
    },
  );

  // Business audit was called
  const batchAudit = auditCalls.find((a) => a.action === 'subscriber.batch.delete');
  assert.ok(batchAudit);
  assert.equal(batchAudit.metadata.partialMutation, true);
});

// ---------------------------------------------------------------------------
// Section 12: v2 OCS Partial
// ---------------------------------------------------------------------------
test('Bulk Delete Approval Execute v2 OCS partial through production executor', async () => {
  const payload = v2Payload(['001010000000001']);
  const approval = approvalDocument('SUBSCRIBER_BULK_DELETE', payload);
  const repo = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v2Result: {
      requested: 1,
      deletedImsis: ['001010000000001'],
      conflictImsis: [],
      failedImsis: [],
      ocsCleanedImsis: [],
      ocsCleanupFailedImsis: ['001010000000001'],
      deletedCount: 1,
      partialMutation: true,
      mutationCommitted: true,
      operationFingerprint: payload.operationFingerprint,
    },
  });
  const { service } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  await assert.rejects(
    service.executeApprovedChange(request, approval.id, auth),
    (error) => {
      assert.equal(error.code, 'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE');
      assert.equal(error.status, 409);
      assert.equal(error.committed, true);
      assert.deepEqual(error.details.deletedImsis, ['001010000000001']);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Section 13: Business Audit Failure After Mutation (committed=true)
// ---------------------------------------------------------------------------
test('Bulk Delete Approval Execute v2 audit failure committed true through production executor', async () => {
  const payload = v2Payload(['001010000000001']);
  const approval = approvalDocument('SUBSCRIBER_BULK_DELETE', payload);
  const repo = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies(); // success result
  const { service, auditCalls } = createExecutionService(repo, govSpies, {
    throwForAction: 'subscriber.batch.delete',
  });

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  // v2 executor was called before audit failure
  await assert.rejects(
    service.executeApprovedChange(request, approval.id, auth),
    (error) => {
      assert.equal(error.code, 'AUDIT_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.committed, true);
      return true;
    },
  );

  // Verify v2 executor was actually called
  assert.equal(govSpies.calls.executeFrozenSubscriberBulkDeleteV2, 1);
});

// ---------------------------------------------------------------------------
// Section 14: Business Audit Failure With Zero Mutation (committed=false)
// ---------------------------------------------------------------------------
test('Bulk Delete Approval Execute v2 audit failure committed false through production executor', async () => {
  const payload = v2Payload(['001010000000001']);
  const approval = approvalDocument('SUBSCRIBER_BULK_DELETE', payload);
  const repo = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v2Result: {
      requested: 1,
      deletedImsis: [],
      conflictImsis: ['001010000000001'],
      failedImsis: [],
      ocsCleanedImsis: [],
      ocsCleanupFailedImsis: [],
      deletedCount: 0,
      partialMutation: false,
      mutationCommitted: false,
      operationFingerprint: payload.operationFingerprint,
    },
  });
  const { service, auditCalls } = createExecutionService(repo, govSpies, {
    throwForAction: 'subscriber.batch.delete',
  });

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  const result = await service.executeApprovedChange(request, approval.id, auth);

  // committed=false → production converts to failed approval
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'AUDIT_UNAVAILABLE');
  assert.equal(result.result.classification, 'FAILED_NO_MUTATION');
  assert.equal(result.result.mutationCommitted, false);
});

// ---------------------------------------------------------------------------
// Section 15: v1 Historical Compatibility
// ---------------------------------------------------------------------------
test('Bulk Delete Approval Execute v1 remains executable through production executor', async () => {
  const payload = v1Payload(['001010000000001']);
  const approval = approvalDocument('SUBSCRIBER_BULK_DELETE', payload);
  const repo = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v1Result: {
      requested: 1,
      deleted: 1,
      targets: ['001010000000001'],
      operationFingerprint: payload.operationFingerprint,
    },
  });
  const { service, auditCalls } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  const result = await service.executeApprovedChange(request, approval.id, auth);

  // Legacy executor was called, v2 was not
  assert.equal(govSpies.calls.executeFrozenSubscriberBulkDelete, 1);
  assert.equal(govSpies.calls.executeFrozenSubscriberBulkDeleteV2, 0);

  // Business audit called with success
  const batchAudit = auditCalls.find((a) => a.action === 'subscriber.batch.delete');
  assert.ok(batchAudit);
  assert.equal(batchAudit.result, 'success');
  assert.equal(batchAudit.metadata.classification, 'SUCCESS');
  assert.equal(batchAudit.metadata.mutationCommitted, true);

  // Production normalizes v1 result — approval completed
  assert.equal(result.status, 'completed');
  assert.equal(result.execution.success, true);
  assert.equal(result.result.deletedCount, 1);
  assert.deepEqual(result.result.deletedImsis, ['001010000000001']);
});
