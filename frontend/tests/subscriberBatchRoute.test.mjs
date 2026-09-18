import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Helpers ───

function makeRequest(body, { user = 'testuser', role = 'operator' } = {}) {
  return new Request('http://localhost/api/subscribers/batch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-test-user': user,
      'x-test-role': role,
    },
    body: JSON.stringify(body),
  });
}

const VALID_PAYLOAD = {
  startImsi: '454000000000001',
  count: 3,
  trafficTotal: 10737418240,
  trafficBalance: 10737418240,
  smsTotal: 100,
  smsBalance: 100,
  profileName: 'default',
  planId: 'plan_default',
};

function makeDeps(overrides = {}) {
  return {
    requireCapability: overrides.requireCapability ?? (() => ({ ok: true, auth: { user: 'operator1', role: 'operator' } })),
    enforceRateLimit: overrides.enforceRateLimit ?? (async () => ({ ok: true })),
    validateCurrentAccount: overrides.validateCurrentAccount ?? (async () => ({
      userId: 'user-1',
      username: 'operator1',
      role: 'operator',
      normalizedRole: overrides.role ?? 'operator',
      status: 'active',
      sessionVersion: 0,
    })),
    evaluateSubscriberOperationForActor: overrides.evaluateSubscriberOperationForActor ?? (() => ({
      allowed: true,
      action: 'SUBSCRIBER_BATCH_CREATE',
      permission: 'subscribers.write',
      riskLevel: 'high',
      requiresApproval: overrides.requiresApproval ?? true,
      requiresIndependentReviewer: true,
      executionMode: 'automatic',
      snapshotStrategy: 'batch-precondition',
      operation: 'SUBSCRIBER_BATCH_CREATE',
      governanceMode: overrides.governanceMode ?? 'APPROVAL_GOVERNED',
      executable: true,
    })),
    precheckSubscriberRange: overrides.precheckSubscriberRange ?? (async () => ({
      conflictCount: 0,
      conflictImsis: [],
    })),
    prepareFrozenBatchCreateV2: overrides.prepareFrozenBatchCreateV2 ?? (async () => ({
      version: 'subscriber-batch-create-v2',
      startImsi: '454000000000001',
      count: 3,
      expectedAbsentImsis: ['454000000000001', '454000000000002', '454000000000003'],
      effectiveOcs: {
        planId: 'plan_default',
        trafficTotal: 10737418240,
        trafficBalance: 10737418240,
        smsTotal: 100,
        smsBalance: 100,
      },
      profile: { requestedName: 'default', state: 'absent', preconditionHash: '' },
      strategy: 'create-only',
      operationFingerprint: 'test-fingerprint-abc123',
    })),
    writeAuditLog: overrides.writeAuditLog ?? (async () => {}),
    createGovernedApproval: overrides.createGovernedApproval ?? (async () => ({
      id: 'approval-test',
      action: 'SUBSCRIBER_BATCH_CREATE',
      status: 'pending',
    })),
    executeFrozenBatchCreate: overrides.executeFrozenBatchCreate ?? (async () => ({
      createdCount: 3,
      failedCount: 0,
      createdImsis: ['454000000000001', '454000000000002', '454000000000003'],
      failedImsis: [],
      conflictImsis: [],
      subscriberFailedImsis: [],
      partialMutation: false,
      metrics: { insertedCount: 3, durationMs: 50 },
    })),
  };
}

// Import real production handler factory
const { createBatchCreateHandler } = await import('../src/app/api/subscribers/batch/route.ts');

// ─── PART J: Operator Route Test ───
test('POST /api/subscribers/batch: operator → 202 approval_required', async () => {
  let approvalCalls = 0;
  const handler = createBatchCreateHandler(makeDeps({
    role: 'operator',
    governanceMode: 'APPROVAL_GOVERNED',
    requiresApproval: true,
    createGovernedApproval: async () => {
      approvalCalls++;
      return { id: 'approval-op', action: 'SUBSCRIBER_BATCH_CREATE', status: 'pending' };
    },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 202);
  assert.equal(body.outcome, 'approval_required');
  assert.equal(body.requiresApproval, true);
  assert.equal(approvalCalls, 1);
});

// ─── PART K: ops_admin Route Test ───
test('POST /api/subscribers/batch: ops_admin → 202 approval_required', async () => {
  let approvalCalls = 0;
  const handler = createBatchCreateHandler(makeDeps({
    role: 'ops_admin',
    governanceMode: 'APPROVAL_GOVERNED',
    requiresApproval: true,
    createGovernedApproval: async () => {
      approvalCalls++;
      return { id: 'approval-ops', action: 'SUBSCRIBER_BATCH_CREATE', status: 'pending' };
    },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 202);
  assert.equal(body.outcome, 'approval_required');
  assert.equal(body.requiresApproval, true);
  assert.equal(approvalCalls, 1);
});

// ─── PART L: super_admin Route Test ───
test('POST /api/subscribers/batch: super_admin → 201 direct execution', async () => {
  let executorCalls = 0;
  let auditCalls = 0;
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    requiresApproval: false,
    createGovernedApproval: async () => { throw new Error('should not be called'); },
    executeFrozenBatchCreate: async () => {
      executorCalls++;
      return {
        createdCount: 3, failedCount: 0,
        createdImsis: ['454000000000001', '454000000000002', '454000000000003'],
        failedImsis: [], conflictImsis: [], subscriberFailedImsis: [],
        partialMutation: false,
        metrics: { insertedCount: 3, durationMs: 50 },
      };
    },
    writeAuditLog: async (input) => {
      assert.equal(input.module, 'subscribers');
      assert.equal(input.action, 'BATCH_CREATE');
      assert.equal(input.result, 'success');
      assert.equal(input.metadata.governanceMode, 'DIRECT_GOVERNED');
      auditCalls++;
    },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.outcome, 'executed');
  assert.equal(executorCalls, 1);
  assert.equal(auditCalls, 1);
});

// ─── PART M: root Route Test ───
test('POST /api/subscribers/batch: root → 201 direct execution', async () => {
  let executorCalls = 0;
  let auditCalls = 0;
  const handler = createBatchCreateHandler(makeDeps({
    role: 'root',
    governanceMode: 'DIRECT_GOVERNED',
    requiresApproval: false,
    createGovernedApproval: async () => { throw new Error('should not be called'); },
    executeFrozenBatchCreate: async () => {
      executorCalls++;
      return {
        createdCount: 3, failedCount: 0,
        createdImsis: ['454000000000001', '454000000000002', '454000000000003'],
        failedImsis: [], conflictImsis: [], subscriberFailedImsis: [],
        partialMutation: false,
        metrics: { insertedCount: 3, durationMs: 50 },
      };
    },
    writeAuditLog: async () => { auditCalls++; },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 201);
  assert.equal(body.outcome, 'executed');
  assert.equal(executorCalls, 1);
  assert.equal(auditCalls, 1);
});

// ─── PART N: Request-Time Conflict Test ───
test('POST /api/subscribers/batch: precheck conflict → 409 before approval/execution', async () => {
  let approvalCalls = 0;
  let executorCalls = 0;
  let auditCalls = 0;
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    precheckSubscriberRange: async () => ({
      conflictCount: 2,
      conflictImsis: ['454000000000001', '454000000000002'],
    }),
    createGovernedApproval: async () => { approvalCalls++; return {}; },
    executeFrozenBatchCreate: async () => { executorCalls++; return {}; },
    writeAuditLog: async () => { auditCalls++; },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.error, 'SUBSCRIBER_CREATE_PRECONDITION_CHANGED');
  assert.equal(approvalCalls, 0);
  assert.equal(executorCalls, 0);
  assert.equal(auditCalls, 0);
});

// ─── PART P: FAILED_NO_MUTATION Conflict Race ───
test('POST /api/subscribers/batch: zero-created race conflict → 409 after audit', async () => {
  let auditCalls = 0;
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    executeFrozenBatchCreate: async () => ({
      createdCount: 0, failedCount: 2,
      createdImsis: [], failedImsis: ['454000000000001', '454000000000002'],
      conflictImsis: ['454000000000001', '454000000000002'],
      subscriberFailedImsis: [],
      partialMutation: false,
      metrics: { insertedCount: 0, durationMs: 10 },
    }),
    writeAuditLog: async (input) => {
      auditCalls++;
      assert.equal(input.result, 'failed');
      assert.equal(input.metadata.classification, 'FAILED_NO_MUTATION');
    },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.error, 'SUBSCRIBER_CREATE_PRECONDITION_CHANGED');
  assert.equal(body.partialMutation, false);
  // Audit was invoked (FAILED_NO_MUTATION now gets strict evidence)
  assert.equal(auditCalls, 1);
});

// ─── PART Q: FAILED_NO_MUTATION Non-Conflict ───
test('POST /api/subscribers/batch: zero-created non-conflict → 500 after audit', async () => {
  let auditCalls = 0;
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    executeFrozenBatchCreate: async () => ({
      createdCount: 0, failedCount: 2,
      createdImsis: [], failedImsis: ['454000000000001', '454000000000002'],
      conflictImsis: [],
      subscriberFailedImsis: ['454000000000001', '454000000000002'],
      partialMutation: false,
      metrics: { insertedCount: 0, durationMs: 10 },
    }),
    writeAuditLog: async (input) => {
      auditCalls++;
      assert.equal(input.result, 'failed');
      assert.equal(input.metadata.classification, 'FAILED_NO_MUTATION');
      assert.equal(input.metadata.partialMutation, false);
    },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 500);
  assert.equal(body.error, 'SUBSCRIBER_BATCH_CREATE_FAILED');
  assert.equal(body.partialMutation, false);
  // No 201
  assert.notEqual(res.status, 201);
  // Audit was invoked
  assert.equal(auditCalls, 1);
});

// ─── PART R: Zero-Write Strict Audit Failure ───
test('POST /api/subscribers/batch: zero-write + audit failure → 503 committed=false', async () => {
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    executeFrozenBatchCreate: async () => ({
      createdCount: 0, failedCount: 2,
      createdImsis: [], failedImsis: ['454000000000001', '454000000000002'],
      conflictImsis: [],
      subscriberFailedImsis: ['454000000000001', '454000000000002'],
      partialMutation: false,
      metrics: { insertedCount: 0, durationMs: 10 },
    }),
    writeAuditLog: async () => { throw new Error('AUDIT_WRITE_FAILED'); },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.equal(body.error, 'AUDIT_UNAVAILABLE');
  assert.equal(body.code, 'AUDIT_UNAVAILABLE');
  assert.equal(body.committed, false);
});

// ─── PART S: Full Success Audit Failure ───
test('POST /api/subscribers/batch: full success + audit failure → 503 committed=true', async () => {
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    executeFrozenBatchCreate: async () => ({
      createdCount: 3, failedCount: 0,
      createdImsis: ['454000000000001', '454000000000002', '454000000000003'],
      failedImsis: [], conflictImsis: [], subscriberFailedImsis: [],
      partialMutation: false,
      metrics: { insertedCount: 3, durationMs: 50 },
    }),
    writeAuditLog: async () => { throw new Error('AUDIT_WRITE_FAILED'); },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.equal(body.error, 'AUDIT_UNAVAILABLE');
  assert.equal(body.committed, true);
});

// ─── PART T: Partial Audit Failure ───
test('POST /api/subscribers/batch: partial write + audit failure → 503 committed=true', async () => {
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    executeFrozenBatchCreate: async () => ({
      createdCount: 1, failedCount: 2,
      createdImsis: ['454000000000001'],
      failedImsis: ['454000000000002', '454000000000003'],
      conflictImsis: [], subscriberFailedImsis: ['454000000000002', '454000000000003'],
      partialMutation: true,
      metrics: { insertedCount: 1, durationMs: 50 },
    }),
    writeAuditLog: async () => { throw new Error('AUDIT_WRITE_FAILED'); },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 503);
  assert.equal(body.error, 'AUDIT_UNAVAILABLE');
  assert.equal(body.committed, true);
});

// ─── PART U: Successful Partial Classification ───
test('POST /api/subscribers/batch: partial write success → 409 partialMutation=true', async () => {
  let auditCalls = 0;
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    executeFrozenBatchCreate: async () => ({
      createdCount: 1, failedCount: 2,
      createdImsis: ['454000000000001'],
      failedImsis: ['454000000000002', '454000000000003'],
      conflictImsis: [], subscriberFailedImsis: ['454000000000002', '454000000000003'],
      partialMutation: true,
      metrics: { insertedCount: 1, durationMs: 50 },
    }),
    writeAuditLog: async (input) => {
      auditCalls++;
      assert.equal(input.result, 'failed');
      assert.equal(input.metadata.classification, 'PARTIAL_WRITE');
    },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  const body = await res.json();

  assert.equal(res.status, 409);
  assert.equal(body.error, 'SUBSCRIBER_BATCH_CREATE_PARTIAL_WRITE');
  assert.equal(body.partialMutation, true);
  assert.equal(auditCalls, 1);
  // No success response
  assert.notEqual(body.outcome, 'executed');
});

// ─── PART O (evidence): FAILED_NO_MUTATION audit ordering ───
test('POST /api/subscribers/batch: FAILED_NO_MUTATION is audited before response (PART O fix)', async () => {
  const callOrder = [];
  const handler = createBatchCreateHandler(makeDeps({
    role: 'super_admin',
    governanceMode: 'DIRECT_GOVERNED',
    executeFrozenBatchCreate: async () => {
      callOrder.push('execute');
      return {
        createdCount: 0, failedCount: 1,
        createdImsis: [], failedImsis: ['454000000000001'],
        conflictImsis: [], subscriberFailedImsis: ['454000000000001'],
        partialMutation: false,
        metrics: { insertedCount: 0, durationMs: 5 },
      };
    },
    writeAuditLog: async () => { callOrder.push('audit'); },
  }));

  const res = await handler(makeRequest(VALID_PAYLOAD));
  callOrder.push('response');

  // Audit must happen BEFORE response
  assert.deepEqual(callOrder, ['execute', 'audit', 'response']);
  assert.equal(res.status, 500);
});
