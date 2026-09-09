// tests/subscriberBulkDeleteRoute.test.mjs
// Section 15: Canonical Node Route Tests for Bulk Delete
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock the dependencies
function createMockDeps(overrides = {}) {
  return {
    requireCapability: mock.fn((request, capability) => {
      const url = new URL(request.url);
      const role = url.searchParams.get('role') || 'operator';
      const user = url.searchParams.get('user') || 'testuser';
      return {
        ok: true,
        auth: { user, role, sessionVersion: 1 },
      };
    }),
    enforceRateLimit: mock.fn(async () => ({ ok: true })),
    validateImsiList: mock.fn((imsiList) => {
      if (!Array.isArray(imsiList) || imsiList.length === 0) {
        return { ok: false, error: 'imsiList is required' };
      }
      // Check for duplicates
      if (new Set(imsiList).size !== imsiList.length) {
        return { ok: false, error: 'INVALID_BULK_DELETE_REQUEST' };
      }
      return { ok: true, value: imsiList };
    }),
    validateCurrentAccount: mock.fn(async ({ username, role }) => ({
      userId: 'user-123',
      username,
      normalizedRole: role,
      role,
    })),
    prepareFrozenSubscriberBulkDelete: mock.fn(async (imsiList) => ({
      version: 'subscriber-bulk-delete-v2',
      targets: imsiList.map((imsi) => ({
        imsi,
        before: { imsi, msisdn: ['1234567890'], accessRestrictionData: 0, networkAccessMode: 0 },
        preconditionHash: 'hash-' + imsi,
      })),
      targetCount: imsiList.length,
      snapshotBytes: 1024,
      strategy: 'delete-only',
      operationFingerprint: 'fp-' + imsiList.join('-'),
    })),
    evaluateSubscriberOperationForActor: mock.fn((operation, role) => {
      if (role === 'super_admin' || role === 'root') {
        return { executable: true, governanceMode: 'DIRECT_GOVERNED' };
      }
      return { executable: true, governanceMode: 'APPROVAL_GOVERNED' };
    }),
    listActiveSubscriberApprovals: mock.fn(async () => []),
    createGovernedApproval: mock.fn(async (input) => ({
      id: 'approval-' + Date.now(),
      action: input.action,
      status: 'pending',
      operationFingerprint: input.operationFingerprint,
    })),
    writeAuditLog: mock.fn(async () => {}),
    executeFrozenSubscriberBulkDeleteV2: mock.fn(async (frozen) => ({
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
    })),
    ...overrides,
  };
}

function createRequest(imsiList, role = 'operator', user = 'testuser') {
  return new Request(`http://localhost/api/subscribers/bulk-delete?role=${role}&user=${user}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imsiList }),
  });
}

describe('Bulk Delete Route Tests', async () => {
  // Import the handler factory
  const { createBulkDeleteHandler } = await import('../src/app/api/subscribers/bulk-delete/route.ts');

  describe('Section 15: Approval Path', () => {
    it('operator → 202 Approval', async () => {
      const deps = createMockDeps();
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'operator');
      const response = await handler(request);
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.requiresApproval, true);
      assert.ok(body.approval);
      assert.equal(deps.createGovernedApproval.mock.callCount(), 1);
      assert.equal(deps.executeFrozenSubscriberBulkDeleteV2.mock.callCount(), 0);
    });

    it('ops_admin → 202 Approval', async () => {
      const deps = createMockDeps();
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'ops_admin');
      const response = await handler(request);
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.requiresApproval, true);
      assert.equal(deps.createGovernedApproval.mock.callCount(), 1);
    });
  });

  describe('Section 15: Direct Path', () => {
    it('super_admin → 200 Direct', async () => {
      const deps = createMockDeps();
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.outcome, 'executed');
      assert.equal(body.requiresApproval, false);
      assert.equal(deps.createGovernedApproval.mock.callCount(), 0);
      assert.equal(deps.executeFrozenSubscriberBulkDeleteV2.mock.callCount(), 1);
    });

    it('root → 200 Direct', async () => {
      const deps = createMockDeps();
      deps.evaluateSubscriberOperationForActor = mock.fn(() => ({
        executable: true,
        governanceMode: 'DIRECT_GOVERNED',
      }));
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'root');
      const response = await handler(request);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.outcome, 'executed');
    });
  });

  describe('Section 15: Duplicate Tests', () => {
    it('operator exact duplicate → 202 idempotent', async () => {
      const deps = createMockDeps();
      // Return an existing approval with the same fingerprint
      deps.listActiveSubscriberApprovals = mock.fn(async (action) => {
        if (action === 'SUBSCRIBER_BULK_DELETE') {
          return [{
            id: 'existing-1',
            action: 'SUBSCRIBER_BULK_DELETE',
            status: 'pending',
            operationFingerprint: 'fp-001010000000001',
            payload: { targets: [{ imsi: '001010000000001' }] },
          }];
        }
        return [];
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'operator');
      const response = await handler(request);
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.idempotent, true);
      assert.equal(deps.createGovernedApproval.mock.callCount(), 0);
    });

    it('direct exact duplicate → 409', async () => {
      const deps = createMockDeps();
      deps.listActiveSubscriberApprovals = mock.fn(async (action) => {
        if (action === 'SUBSCRIBER_BULK_DELETE') {
          return [{
            id: 'existing-1',
            action: 'SUBSCRIBER_BULK_DELETE',
            status: 'pending',
            operationFingerprint: 'fp-001010000000001',
            payload: { targets: [{ imsi: '001010000000001' }] },
          }];
        }
        return [];
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, 'ACTIVE_CHANGE_CONFLICT');
      assert.equal(deps.executeFrozenSubscriberBulkDeleteV2.mock.callCount(), 0);
    });
  });

  describe('Section 15: Active Overlap Tests', () => {
    it('single UPDATE overlap → 409', async () => {
      const deps = createMockDeps();
      deps.listActiveSubscriberApprovals = mock.fn(async (action) => {
        if (action === 'SUBSCRIBER_UPDATE') {
          return [{
            id: 'existing-1',
            action: 'SUBSCRIBER_UPDATE',
            status: 'pending',
            payload: { imsi: '001010000000001' },
          }];
        }
        return [];
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, 'ACTIVE_CHANGE_CONFLICT');
    });

    it('single DELETE overlap → 409', async () => {
      const deps = createMockDeps();
      deps.listActiveSubscriberApprovals = mock.fn(async (action) => {
        if (action === 'SUBSCRIBER_DELETE') {
          return [{
            id: 'existing-1',
            action: 'SUBSCRIBER_DELETE',
            status: 'pending',
            payload: { imsi: '001010000000001' },
          }];
        }
        return [];
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 409);
    });

    it('Batch Update overlap → 409', async () => {
      const deps = createMockDeps();
      deps.listActiveSubscriberApprovals = mock.fn(async (action) => {
        if (action === 'SUBSCRIBER_BATCH_UPDATE') {
          return [{
            id: 'existing-1',
            action: 'SUBSCRIBER_BATCH_UPDATE',
            status: 'pending',
            payload: { targets: [{ imsi: '001010000000001' }] },
          }];
        }
        return [];
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 409);
    });

    it('Bulk Delete overlap → 409', async () => {
      const deps = createMockDeps();
      deps.listActiveSubscriberApprovals = mock.fn(async (action) => {
        if (action === 'SUBSCRIBER_BULK_DELETE') {
          return [{
            id: 'existing-1',
            action: 'SUBSCRIBER_BULK_DELETE',
            status: 'pending',
            operationFingerprint: 'different-fingerprint',
            payload: { targets: [{ imsi: '001010000000001' }] },
          }];
        }
        return [];
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 409);
    });
  });

  describe('Section 15: Validation Tests', () => {
    it('duplicate IMSI request → 400', async () => {
      const deps = createMockDeps();
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001', '001010000000001'], 'operator');
      const response = await handler(request);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, 'INVALID_BULK_DELETE_REQUEST');
    });
  });

  describe('Section 16: Node Direct Outcome Tests', () => {
    it('success → 200', async () => {
      const deps = createMockDeps();
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.outcome, 'executed');
      assert.equal(body.requiresApproval, false);
    });

    it('zero conflict → 409 PRECONDITION_CHANGED', async () => {
      const deps = createMockDeps();
      deps.executeFrozenSubscriberBulkDeleteV2 = mock.fn(async () => {
        throw new (await import('../src/server/subscriberSingleGovernance.ts')).SubscriberGovernanceError(
          'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED',
          { conflictImsis: ['001010000000001'] },
        );
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED');
      assert.equal(body.committed, false);
      assert.equal(body.partialMutation, false);
      assert.equal(deps.writeAuditLog.mock.callCount(), 1);
    });

    it('zero storage → 500 BULK_DELETE_FAILED', async () => {
      const deps = createMockDeps();
      deps.executeFrozenSubscriberBulkDeleteV2 = mock.fn(async () => {
        throw new Error('mongo: connection lost');
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 500);
      const body = await response.json();
      assert.equal(body.code, 'SUBSCRIBER_BULK_DELETE_FAILED');
      assert.equal(body.committed, false);
      assert.equal(body.partialMutation, false);
    });

    it('partial → 409 PARTIAL_WRITE', async () => {
      const deps = createMockDeps();
      deps.executeFrozenSubscriberBulkDeleteV2 = mock.fn(async (frozen) => ({
        requested: frozen.targetCount,
        deletedImsis: ['001010000000001'],
        conflictImsis: ['001010000000002'],
        failedImsis: [],
        ocsCleanedImsis: ['001010000000001'],
        ocsCleanupFailedImsis: [],
        deletedCount: 1,
        partialMutation: true,
        mutationCommitted: true,
        operationFingerprint: frozen.operationFingerprint,
      }));
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001', '001010000000002'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, 'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE');
      assert.equal(body.committed, true);
      assert.equal(body.partialMutation, true);
    });

    it('OCS partial → 409 PARTIAL_WRITE', async () => {
      const deps = createMockDeps();
      deps.executeFrozenSubscriberBulkDeleteV2 = mock.fn(async (frozen) => ({
        requested: frozen.targetCount,
        deletedImsis: ['001010000000001'],
        conflictImsis: [],
        failedImsis: [],
        ocsCleanedImsis: [],
        ocsCleanupFailedImsis: ['001010000000001'],
        deletedCount: 1,
        partialMutation: true,
        mutationCommitted: true,
        operationFingerprint: frozen.operationFingerprint,
      }));
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, 'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE');
      assert.equal(body.committed, true);
    });
  });

  describe('Section 17: Node Audit Failure Tests', () => {
    it('zero-write + audit failure → 503', async () => {
      const deps = createMockDeps();
      deps.executeFrozenSubscriberBulkDeleteV2 = mock.fn(async () => {
        throw new (await import('../src/server/subscriberSingleGovernance.ts')).SubscriberGovernanceError(
          'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED',
          { conflictImsis: ['001010000000001'] },
        );
      });
      deps.writeAuditLog = mock.fn(async () => {
        throw new Error('audit service down');
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error, 'AUDIT_UNAVAILABLE');
      assert.equal(body.committed, false);
    });

    it('mutation committed + audit failure → 503', async () => {
      const deps = createMockDeps();
      deps.writeAuditLog = mock.fn(async () => {
        throw new Error('audit service down');
      });
      const handler = createBulkDeleteHandler(deps);
      const request = createRequest(['001010000000001'], 'super_admin');
      const response = await handler(request);
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.error, 'AUDIT_UNAVAILABLE');
      assert.equal(body.committed, true);
    });
  });
});
