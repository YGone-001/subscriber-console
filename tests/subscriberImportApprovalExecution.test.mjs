// tests/subscriberImportApprovalExecution.test.mjs
// Subscriber Import Approval Execute v2 — production executor path
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function approvalDocument(payload, status = 'approved') {
  const now = new Date().toISOString();
  return {
    id: `approval-${crypto.randomUUID()}`,
    changeId: `CHG-${Date.now()}`,
    title: 'Test subscriber import',
    summary: 'Test subscriber import',
    action: 'SUBSCRIBER_IMPORT',
    status,
    operation: { resourceType: 'subscriber_import', resourceId: 'import' },
    riskLevel: 'high',
    riskAssessment: { level: 'high', factors: [] },
    requester: 'testuser',
    targetId: 'subscriber:csv-import',
    payload,
    before: { targetCount: payload.targetCount || 1 },
    operationFingerprint: payload.operationFingerprint,
    execution: { id: `exec-${Date.now()}` },
    events: [],
    createdAt: now,
    updatedAt: now,
  };
}

function v2Payload(records) {
  const targets = records.map((r) => ({
    imsi: r.imsi,
    state: r.state || 'absent',
    recordIntentHash: `hash-${r.imsi}`,
  }));
  return {
    version: 'subscriber-import-v2',
    records,
    targets,
    targetCount: records.length,
    summary: {
      rowCount: records.length,
      createCount: records.filter((r) => r.state !== 'present').length,
      skipCount: records.filter((r) => r.state === 'present').length,
      fieldNames: [],
      fileHash: `filehash-${records.map((r) => r.imsi).join('-')}`,
    },
    strategy: 'skip-existing-create-only',
    snapshotBytes: 1024,
    operationFingerprint: `fp-${records.map((r) => r.imsi).join('-')}`,
  };
}

// Fake in-memory approval repository with state machine transitions
function createFakeApprovalRepo(initialApproval) {
  const records = new Map();
  records.set(initialApproval.id, structuredClone(initialApproval));
  const transitions = [];

  return {
    repo: {
      async getApproval(id) {
        return records.get(id) || null;
      },
      async transitionApproval(input) {
        transitions.push(input);
        const rec = records.get(input.id);
        if (!rec) return { ok: false, reason: 'not_found' };
        if (rec.status !== input.expectedStatus) {
          return { ok: false, reason: 'conflict', approval: structuredClone(rec) };
        }
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
    },
    transitions,
  };
}

// Build governance spies
function createGovernanceSpies(overrides = {}) {
  const calls = {
    assertFrozenSubscriberImportV2: 0,
    executeFrozenSubscriberImportV2: 0,
    classifyImportResult: 0,
  };

  return {
    calls,
    module: {
      assertFrozenSubscriberImportV2(payload) {
        calls.assertFrozenSubscriberImportV2++;
        if (!payload || payload.version !== 'subscriber-import-v2') {
          throw new Error('INVALID_SUBSCRIBER_IMPORT_PAYLOAD');
        }
        return payload;
      },
      async executeFrozenSubscriberImportV2(frozen) {
        calls.executeFrozenSubscriberImportV2++;
        if (overrides.v2Result) return overrides.v2Result;
        const createdImsis = frozen.targets.filter((t) => t.state === 'absent').map((t) => t.imsi);
        return {
          requested: frozen.targetCount,
          intendedCreateCount: frozen.summary.createCount,
          createdImsis,
          skippedImsis: frozen.targets.filter((t) => t.state === 'present').map((t) => t.imsi),
          conflictImsis: [],
          failedImsis: [],
          ocsProvisionedImsis: createdImsis,
          ocsProvisioningFailedImsis: [],
          createdCount: createdImsis.length,
          partialMutation: false,
          mutationCommitted: true,
          operationFingerprint: frozen.operationFingerprint,
        };
      },
      classifyImportResult(result) {
        calls.classifyImportResult++;
        if (result.createdCount === result.intendedCreateCount &&
            result.conflictImsis.length === 0 &&
            result.failedImsis.length === 0 &&
            result.ocsProvisioningFailedImsis.length === 0) return 'SUCCESS';
        if (result.createdCount > 0) return 'PARTIAL_WRITE';
        return 'FAILED_NO_MUTATION';
      },
      executeFrozenSubscriberBulkDeleteV2: async () => ({}),
      executeFrozenSubscriberBulkDelete: async () => ({}),
      assertFrozenBulkDeleteV2: () => {},
      classifyBulkDeleteResult: () => 'SUCCESS',
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
// Tests
// ---------------------------------------------------------------------------

test('Import Approval Execute v2 succeeds through production executor', async () => {
  const records = [
    { imsi: '454000000000001', access_restriction_data: 32, traffic_total: 1000, traffic_balance: 1000, sms_total: 100, sms_balance: 100, plan_id: 'plan1' },
    { imsi: '454000000000002', access_restriction_data: 32, traffic_total: 2000, traffic_balance: 2000, sms_total: 200, sms_balance: 200, plan_id: 'plan2' },
  ];
  const frozen = v2Payload(records);
  const approval = approvalDocument(frozen);
  const { repo } = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies();
  const { service, auditCalls } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  const result = await service.executeApprovedChange(request, approval.id, auth);

  // v2 executor was called
  assert.equal(govSpies.calls.assertFrozenSubscriberImportV2, 1);
  assert.equal(govSpies.calls.executeFrozenSubscriberImportV2, 1);

  // Business audit was called with correct action
  const importAudit = auditCalls.find((a) => a.action === 'subscriber.import');
  assert.ok(importAudit, 'subscriber.import audit must be called');
  assert.equal(importAudit.result, 'success');
  assert.equal(importAudit.metadata.classification, 'SUCCESS');
  assert.equal(importAudit.metadata.mutationCommitted, true);
});

test('Import Approval Execute v2 conflict returns FAILED_NO_MUTATION', async () => {
  const records = [{ imsi: '454000000000001', state: 'absent' }];
  const frozen = v2Payload(records);
  const approval = approvalDocument(frozen);
  const { repo } = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v2Result: {
      requested: 1,
      intendedCreateCount: 1,
      createdImsis: [],
      skippedImsis: [],
      conflictImsis: ['454000000000001'],
      failedImsis: [],
      ocsProvisionedImsis: [],
      ocsProvisioningFailedImsis: [],
      createdCount: 0,
      partialMutation: false,
      mutationCommitted: false,
      operationFingerprint: frozen.operationFingerprint,
    },
  });
  const { service, auditCalls } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  const result = await service.executeApprovedChange(request, approval.id, auth);

  assert.equal(govSpies.calls.assertFrozenSubscriberImportV2, 1);
  assert.equal(govSpies.calls.executeFrozenSubscriberImportV2, 1);

  const importAudit = auditCalls.find((a) => a.action === 'subscriber.import');
  assert.ok(importAudit, 'subscriber.import audit must be called');
  assert.equal(importAudit.result, 'failed');
  assert.equal(importAudit.metadata.classification, 'FAILED_NO_MUTATION');
  assert.equal(importAudit.metadata.mutationCommitted, false);
});

test('Import Approval Execute v2 partial write', async () => {
  const records = [
    { imsi: '454000000000001', state: 'absent' },
    { imsi: '454000000000002', state: 'absent' },
  ];
  const frozen = v2Payload(records);
  const approval = approvalDocument(frozen);
  const { repo } = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v2Result: {
      requested: 2,
      intendedCreateCount: 2,
      createdImsis: ['454000000000001'],
      skippedImsis: [],
      conflictImsis: ['454000000000002'],
      failedImsis: [],
      ocsProvisionedImsis: ['454000000000001'],
      ocsProvisioningFailedImsis: [],
      createdCount: 1,
      partialMutation: true,
      mutationCommitted: true,
      operationFingerprint: frozen.operationFingerprint,
    },
  });
  const { service, auditCalls } = createExecutionService(repo, govSpies);

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  // PARTIAL_WRITE with committed=true is re-thrown from executeApprovedChange
  try {
    await service.executeApprovedChange(request, approval.id, auth);
    assert.fail('expected ApprovalExecutionError');
  } catch (error) {
    assert.equal(error.code, 'SUBSCRIBER_IMPORT_PARTIAL_WRITE');
    assert.equal(error.committed, true);
    assert.equal(error.status, 409);
  }

  assert.equal(govSpies.calls.assertFrozenSubscriberImportV2, 1);
  assert.equal(govSpies.calls.executeFrozenSubscriberImportV2, 1);

  const importAudit = auditCalls.find((a) => a.action === 'subscriber.import');
  assert.ok(importAudit, 'subscriber.import audit must be called');
  assert.equal(importAudit.metadata.classification, 'PARTIAL');
  assert.equal(importAudit.metadata.mutationCommitted, true);
});

test('Import Approval Execute v2 audit failure committed true', async () => {
  const records = [{ imsi: '454000000000001', state: 'absent' }];
  const frozen = v2Payload(records);
  const approval = approvalDocument(frozen);
  const { repo } = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies();

  const { service } = createExecutionService(repo, govSpies, { throwForAction: 'subscriber.import' });

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  try {
    await service.executeApprovedChange(request, approval.id, auth);
    assert.fail('Expected ApprovalExecutionError');
  } catch (error) {
    assert.equal(error.code, 'AUDIT_UNAVAILABLE');
    assert.equal(error.committed, true);
  }
});

test('Import Approval Execute v2 audit failure committed false', async () => {
  const records = [{ imsi: '454000000000001', state: 'absent' }];
  const frozen = v2Payload(records);
  const approval = approvalDocument(frozen);
  const { repo } = createFakeApprovalRepo(approval);
  const govSpies = createGovernanceSpies({
    v2Result: {
      requested: 1,
      intendedCreateCount: 1,
      createdImsis: [],
      skippedImsis: [],
      conflictImsis: ['454000000000001'],
      failedImsis: [],
      ocsProvisionedImsis: [],
      ocsProvisioningFailedImsis: [],
      createdCount: 0,
      partialMutation: false,
      mutationCommitted: false,
      operationFingerprint: frozen.operationFingerprint,
    },
  });

  const { service } = createExecutionService(repo, govSpies, { throwForAction: 'subscriber.import' });

  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'testuser', role: 'super_admin', sessionVersion: 0 };

  // When committed=false, executeApprovedChange catches the error and calls finishExecution
  // instead of re-throwing. The result is an approval document with error info in execution.
  const result = await service.executeApprovedChange(request, approval.id, auth);

  assert.equal(govSpies.calls.assertFrozenSubscriberImportV2, 1);
  assert.equal(govSpies.calls.executeFrozenSubscriberImportV2, 1);

  // The approval should have error information in execution
  assert.ok(result.execution, 'Expected execution in result');
  assert.equal(result.execution.error?.code, 'AUDIT_UNAVAILABLE');
});
