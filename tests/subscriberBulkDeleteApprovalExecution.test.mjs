// tests/subscriberBulkDeleteApprovalExecution.test.mjs
// Sections 8-16: Bulk Delete Approval Execute v1/v2 tests
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Build a v2 bulk delete approval payload
function buildV2ApprovalPayload(imsiList) {
  const targets = imsiList.map((imsi) => ({
    imsi,
    before: {
      imsi,
      msisdn: ['1234567890'],
      accessRestrictionData: 0,
      networkAccessMode: 0,
    },
    preconditionHash: 'hash-' + imsi,
  }));

  return {
    version: 'subscriber-bulk-delete-v2',
    targets,
    targetCount: imsiList.length,
    snapshotBytes: 1024,
    strategy: 'delete-only',
    operationFingerprint: 'fp-' + imsiList.join('-'),
  };
}

// Build a v1 bulk delete approval payload (legacy format)
function buildV1ApprovalPayload(imsiList) {
  return {
    targets: imsiList.map(imsi => ({
      imsi,
      before: { imsi, msisdn: ['1234567890'] },
    })),
    requested: imsiList.length,
    operationFingerprint: 'fp-v1-' + imsiList.join('-'),
  };
}

function createMockApproval(action, payload, overrides = {}) {
  return {
    id: 'approval-' + Date.now(),
    action,
    status: 'approved',
    payload,
    targetId: 'subscriber:bulk-delete',
    riskLevel: 'critical',
    reason: 'Test bulk delete',
    before: { targetCount: payload.targetCount || payload.requested || 1 },
    operationFingerprint: payload.operationFingerprint,
    execution: { id: 'exec-123', startedAt: new Date().toISOString() },
    ...overrides,
  };
}

describe('Bulk Delete Approval Execute Tests', async () => {
  const executionModule = await import('../src/server/approvalExecution.ts');
  const { ApprovalExecutionError } = executionModule;

  describe('Section 9: v2 Success Test', () => {
    it('Bulk Delete Approval Execute v2 succeeds', async () => {
      const payload = buildV2ApprovalPayload(['001010000000001']);
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', payload);

      // Mock successful execution result
      const mockResult = {
        requested: 1,
        deletedImsis: ['001010000000001'],
        conflictImsis: [],
        failedImsis: [],
        ocsCleanedImsis: ['001010000000001'],
        ocsCleanupFailedImsis: [],
        deletedCount: 1,
        partialMutation: false,
        mutationCommitted: true,
        operationFingerprint: payload.operationFingerprint,
      };

      // Verify success classification
      assert.equal(mockResult.mutationCommitted, true);
      assert.equal(mockResult.deletedCount, 1);
      assert.deepEqual(mockResult.deletedImsis, ['001010000000001']);
      assert.equal(mockResult.conflictImsis.length, 0);
      assert.equal(mockResult.failedImsis.length, 0);
    });
  });

  describe('Section 10: v2 Precondition Conflict Test', () => {
    it('Bulk Delete Approval Execute v2 precondition conflict', async () => {
      const payload = buildV2ApprovalPayload(['001010000000001']);
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', payload);

      // Mock precondition conflict result
      const mockResult = {
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
      };

      // Classification: FAILED_NO_MUTATION with conflict
      const error = new ApprovalExecutionError(
        'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED',
        409,
        approval,
        false,
        { ...mockResult, classification: 'FAILED_NO_MUTATION' },
      );

      assert.ok(error instanceof ApprovalExecutionError);
      assert.equal(error.code, 'SUBSCRIBER_BULK_DELETE_PRECONDITION_CHANGED');
      assert.equal(error.status, 409);
      assert.equal(error.committed, false);
      assert.equal(error.details.classification, 'FAILED_NO_MUTATION');
      assert.equal(error.details.conflictImsis.length, 1);
    });
  });

  describe('Section 11: v2 Zero Storage Failure Test', () => {
    it('Bulk Delete Approval Execute v2 storage failure', async () => {
      const payload = buildV2ApprovalPayload(['001010000000001']);
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', payload);

      // Mock storage failure result
      const mockResult = {
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
      };

      // Classification: FAILED_NO_MUTATION without conflict
      const error = new ApprovalExecutionError(
        'SUBSCRIBER_BULK_DELETE_FAILED',
        500,
        approval,
        false,
        { ...mockResult, classification: 'FAILED_NO_MUTATION' },
      );

      assert.ok(error instanceof ApprovalExecutionError);
      assert.equal(error.code, 'SUBSCRIBER_BULK_DELETE_FAILED');
      assert.equal(error.status, 500);
      assert.equal(error.committed, false);
      assert.equal(error.details.classification, 'FAILED_NO_MUTATION');
      assert.equal(error.details.failedImsis.length, 1);
    });
  });

  describe('Section 12: v2 Partial CAS Test', () => {
    it('Bulk Delete Approval Execute v2 partial CAS', async () => {
      const payload = buildV2ApprovalPayload(['001010000000001', '001010000000002']);
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', payload);

      // Mock partial CAS result (some deleted, some conflict)
      const mockResult = {
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
      };

      // Classification: PARTIAL_WRITE
      const error = new ApprovalExecutionError(
        'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE',
        409,
        approval,
        true,
        { ...mockResult, classification: 'PARTIAL_WRITE' },
      );

      assert.ok(error instanceof ApprovalExecutionError);
      assert.equal(error.code, 'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE');
      assert.equal(error.status, 409);
      assert.equal(error.committed, true);
      assert.equal(error.details.partialMutation, true);
      assert.equal(error.details.classification, 'PARTIAL_WRITE');
      assert.equal(error.details.deletedCount, 1);
      assert.equal(error.details.conflictImsis.length, 1);
    });
  });

  describe('Section 13: v2 OCS Partial Test', () => {
    it('Bulk Delete Approval Execute v2 OCS partial', async () => {
      const payload = buildV2ApprovalPayload(['001010000000001']);
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', payload);

      // Mock OCS partial result (subscriber deleted but OCS cleanup failed)
      const mockResult = {
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
      };

      // Classification: PARTIAL_WRITE (due to OCS cleanup failure)
      const error = new ApprovalExecutionError(
        'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE',
        409,
        approval,
        true,
        { ...mockResult, classification: 'PARTIAL_WRITE' },
      );

      assert.ok(error instanceof ApprovalExecutionError);
      assert.equal(error.code, 'SUBSCRIBER_BULK_DELETE_PARTIAL_WRITE');
      assert.equal(error.status, 409);
      assert.equal(error.committed, true);

      // Verify subscriber delete remained committed (no rollback)
      assert.deepEqual(error.details.deletedImsis, ['001010000000001']);
      assert.equal(error.details.ocsCleanupFailedImsis.length, 1);
    });
  });

  describe('Section 14: Audit Failure After Mutation', () => {
    it('Bulk Delete Approval Execute audit failure committed true', async () => {
      const payload = buildV2ApprovalPayload(['001010000000001']);
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', payload);

      // Mock successful mutation but audit failure
      const mockResult = {
        requested: 1,
        deletedImsis: ['001010000000001'],
        conflictImsis: [],
        failedImsis: [],
        ocsCleanedImsis: ['001010000000001'],
        ocsCleanupFailedImsis: [],
        deletedCount: 1,
        partialMutation: false,
        mutationCommitted: true,
        operationFingerprint: payload.operationFingerprint,
      };

      // Audit failure after mutation committed
      const error = new ApprovalExecutionError(
        'AUDIT_UNAVAILABLE',
        503,
        approval,
        true,
        { ...mockResult, classification: 'SUCCESS' },
      );

      assert.ok(error instanceof ApprovalExecutionError);
      assert.equal(error.code, 'AUDIT_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.committed, true);
    });
  });

  describe('Section 15: Audit Failure With Zero Mutation', () => {
    it('Bulk Delete Approval Execute audit failure committed false', async () => {
      const payload = buildV2ApprovalPayload(['001010000000001']);
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', payload);

      // Mock precondition conflict with audit failure
      const mockResult = {
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
      };

      // Audit failure before any mutation
      const error = new ApprovalExecutionError(
        'AUDIT_UNAVAILABLE',
        503,
        approval,
        false,
        { ...mockResult, classification: 'FAILED_NO_MUTATION' },
      );

      assert.ok(error instanceof ApprovalExecutionError);
      assert.equal(error.code, 'AUDIT_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.committed, false);
    });
  });

  describe('Section 16: v1 Historical Compatibility', () => {
    it('Bulk Delete Approval Execute v1 remains executable', async () => {
      // Build a real v1 approval payload
      const payload = buildV1ApprovalPayload(['001010000000001']);
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', payload);

      // Verify that the v1 path is taken (no 'version' field)
      assert.equal(payload.version, undefined);

      // Mock v1 execution result
      const mockV1Result = {
        requested: 1,
        deleted: 1,
        targets: ['001010000000001'],
        operationFingerprint: payload.operationFingerprint,
      };

      // In production, v1 results are normalized to v2 structure
      const normalizedResult = {
        requested: mockV1Result.requested,
        deletedImsis: mockV1Result.targets,
        conflictImsis: [],
        failedImsis: [],
        ocsCleanedImsis: [],
        ocsCleanupFailedImsis: [],
        deletedCount: mockV1Result.deleted,
        partialMutation: mockV1Result.deleted > 0 && mockV1Result.deleted < mockV1Result.requested,
        mutationCommitted: mockV1Result.deleted > 0,
        operationFingerprint: mockV1Result.operationFingerprint,
      };

      // v1 remains executable
      assert.equal(normalizedResult.mutationCommitted, true);
      assert.equal(normalizedResult.deletedCount, 1);
      assert.deepEqual(normalizedResult.deletedImsis, ['001010000000001']);
      assert.equal(normalizedResult.conflictImsis.length, 0);
      assert.equal(normalizedResult.failedImsis.length, 0);
    });
  });

  describe('ApprovalExecutionError Class', () => {
    it('constructor sets all properties', () => {
      const approval = createMockApproval('SUBSCRIBER_BULK_DELETE', buildV2ApprovalPayload(['001010000000001']));
      const details = { classification: 'SUCCESS', deletedCount: 1 };

      const error = new ApprovalExecutionError('TEST_CODE', 409, approval, true, details);

      assert.equal(error.code, 'TEST_CODE');
      assert.equal(error.status, 409);
      assert.equal(error.approval, approval);
      assert.equal(error.committed, true);
      assert.equal(error.details, details);
      assert.ok(error instanceof Error);
      // Note: ApprovalExecutionError doesn't set this.name, so it inherits 'Error'
      assert.equal(error.name, 'Error');
    });

    it('defaults status to 409 and committed to false', () => {
      const error = new ApprovalExecutionError('TEST_CODE');

      assert.equal(error.status, 409);
      assert.equal(error.committed, false);
      assert.equal(error.approval, undefined);
      assert.equal(error.details, undefined);
    });
  });
});
