/**
 * Tests for executeSubscriberProfileApplyApproval.
 *
 * Tests the approval executor for SUBSCRIBER_PROFILE_APPLY v1:
 * - Success happy path
 * - Drift detection (assertion returns null)
 * - Re-read storage failure
 * - Execute storage failure
 * - Actor validation
 * - Audit failure handling
 * - SecurityChanged metadata
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import { executeSubscriberProfileApplyApproval, ApprovalExecutionError } from '@/server/approvalExecution';

import type { GovernanceActor } from '@/types/governance';
import type { ApprovalDocument } from '@/server/repositories/approvalRepository';
import type { ProfileApplyAssertion } from '@/server/subscriberProfileApplyGovernance';
import type { XcloudSubscriberDocument } from '@/types/xcloud';
import type { WriteAuditInput, AuditWriteOptions } from '@/lib/audit';

function makeApproval(overrides?: Record<string, unknown>): ApprovalDocument {
  return {
    id: 'approval-profile-apply-001',
    action: 'SUBSCRIBER_PROFILE_APPLY',
    status: 'approved',
    targetId: 'test-imsi',
    actor: 'approver_a',
    approver: 'approver_a',
    payload: {
      version: 'subscriber-profile-apply-v1',
      imsi: 'test-imsi',
      profileName: 'premium-5g',
      subscriberPreconditionHash: 'sub-hash-001',
      profilePreconditionHash: 'profile-hash-001',
      operationFingerprint: 'fp-001',
      before: {
        imsi: 'test-imsi',
        enabled: true,
        security: {},
        ambr: {},
        sliceList: [],
        profileName: 'basic-4g',
      },
      afterPreview: {
        imsi: 'test-imsi',
        enabled: true,
        profileName: 'premium-5g',
      },
      ...overrides,
    },
  } as unknown as ApprovalDocument;
}

function makeActor(): GovernanceActor {
  return { type: 'user', username: 'approver_a', role: 'ops_admin' };
}

function makeAssertion(): ProfileApplyAssertion {
  return {
    intent: {
      version: 'subscriber-profile-apply-v1',
      imsi: 'test-imsi',
      profileName: 'premium-5g',
      subscriberPreconditionHash: 'sub-hash-001',
      profilePreconditionHash: 'profile-hash-001',
      before: {},
      afterPreview: {},
      operationFingerprint: 'fp-001',
    },
    currentSubscriber: {
      imsi: 'test-imsi',
      enabled: true,
      security: {},
      profileName: 'basic-4g',
    } as unknown as XcloudSubscriberDocument,
    profile: {
      name: 'premium-5g',
      auth: {},
      ambr: {},
      sliceList: [],
    } as Record<string, unknown>,
  } as unknown as ProfileApplyAssertion;
}

function makeExecutionResult(classification = 'APPLIED_EFFECTIVE') {
  return {
    restored: {
      imsi: 'test-imsi',
      enabled: true,
      profileName: 'premium-5g',
    } as unknown as XcloudSubscriberDocument,
    classification,
    committed: true,
    securityChanged: false,
  };
}

function makeDeps() {
  return {
    assertFrozen: async () => makeAssertion(),
    executeFrozen: async () => makeExecutionResult(),
    writeAudit: async (_input: WriteAuditInput, _options?: AuditWriteOptions) => true,
    replaceSubscriberCAS: async () => true,
  };
}

describe('executeSubscriberProfileApplyApproval', () => {
  it('happy path: success with audit', async () => {
    const deps = makeDeps();
    let auditCalled = false;
    const originalWriteAudit = deps.writeAudit;
    deps.writeAudit = async (input: WriteAuditInput, options?: AuditWriteOptions) => {
      auditCalled = true;
      return originalWriteAudit(input, options);
    };

    const result = await executeSubscriberProfileApplyApproval(makeApproval(), makeActor(), deps);

    assert.strictEqual(result.imsi, 'test-imsi');
    assert.strictEqual(result.profileName, 'premium-5g');
    assert.strictEqual(result.approvalId, 'approval-profile-apply-001');
    assert.ok(auditCalled, 'writeAudit should have been called');
  });

  it('drift: assert returns null → 409', async () => {
    const deps = makeDeps();
    deps.assertFrozen = async () => null as unknown as ProfileApplyAssertion;

    try {
      await executeSubscriberProfileApplyApproval(makeApproval(), makeActor(), deps);
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e instanceof ApprovalExecutionError);
      assert.strictEqual((e as ApprovalExecutionError).code, 'SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED');
      assert.strictEqual((e as ApprovalExecutionError).status, 409);
    }
  });

  it('storage failure: assert throws → 500', async () => {
    const deps = makeDeps();
    deps.assertFrozen = async () => { throw new Error('DB error'); };

    try {
      await executeSubscriberProfileApplyApproval(makeApproval(), makeActor(), deps);
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e instanceof ApprovalExecutionError);
      assert.strictEqual((e as ApprovalExecutionError).code, 'SUBSCRIBER_PROFILE_APPLY_FAILED');
      assert.strictEqual((e as ApprovalExecutionError).status, 500);
    }
  });

  it('execute failure: throws 409 → re-throws 409', async () => {
    const deps = makeDeps();
    deps.executeFrozen = async () => {
      const err = Object.assign(new Error('drift'), { code: 'SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED' });
      throw err;
    };

    try {
      await executeSubscriberProfileApplyApproval(makeApproval(), makeActor(), deps);
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e instanceof ApprovalExecutionError);
      assert.strictEqual((e as ApprovalExecutionError).code, 'SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED');
      assert.strictEqual((e as ApprovalExecutionError).status, 409);
    }
  });

  it('execute failure: storage error → 500', async () => {
    const deps = makeDeps();
    deps.executeFrozen = async () => { throw new Error('CAS failed'); };

    try {
      await executeSubscriberProfileApplyApproval(makeApproval(), makeActor(), deps);
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e instanceof ApprovalExecutionError);
      assert.strictEqual((e as ApprovalExecutionError).code, 'SUBSCRIBER_PROFILE_APPLY_FAILED');
      assert.strictEqual((e as ApprovalExecutionError).status, 500);
    }
  });

  it('actor validation: missing username → 500', async () => {
    const deps = makeDeps();

    try {
      await executeSubscriberProfileApplyApproval(makeApproval(), { type: 'user', username: '', role: 'ops_admin' }, deps);
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e instanceof ApprovalExecutionError);
      assert.strictEqual((e as ApprovalExecutionError).status, 500);
    }
  });

  it('actor validation: missing role → 500', async () => {
    const deps = makeDeps();

    try {
      await executeSubscriberProfileApplyApproval(makeApproval(), { type: 'user', username: 'a', role: '' }, deps);
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e instanceof ApprovalExecutionError);
      assert.strictEqual((e as ApprovalExecutionError).status, 500);
    }
  });

  it('audit failure on success path → 503', async () => {
    const deps = makeDeps();
    deps.writeAudit = async () => { throw new Error('audit down'); };

    try {
      await executeSubscriberProfileApplyApproval(makeApproval(), makeActor(), deps);
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e instanceof ApprovalExecutionError);
      assert.strictEqual((e as ApprovalExecutionError).code, 'AUDIT_UNAVAILABLE');
      assert.strictEqual((e as ApprovalExecutionError).status, 503);
    }
  });

  it('securityChanged in audit metadata', async () => {
    const deps = makeDeps();
    let auditMetadata: Record<string, unknown> | undefined;
    const result = makeExecutionResult('APPLIED_SECURITY_CHANGED');
    result.securityChanged = true;
    deps.executeFrozen = async () => result;
    deps.writeAudit = async (input: WriteAuditInput) => {
      auditMetadata = (input as unknown as Record<string, unknown>).metadata as Record<string, unknown>;
      return true;
    };

    await executeSubscriberProfileApplyApproval(makeApproval(), makeActor(), deps);

    assert.ok(auditMetadata, 'audit metadata should exist');
    assert.strictEqual(auditMetadata!.securityChanged, true);
  });
});
