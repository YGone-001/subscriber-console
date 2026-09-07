import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal fakes for governed approval deps
function makeFakeApprovalRequest() {
  let calls = [];
  const fn = async (input) => {
    calls.push(input);
    return {
      id: `approval-${calls.length}`,
      action: input.action,
      requester: input.requester,
      requesterContext: input.requesterContext,
      targetId: input.targetId,
      summary: input.summary,
      payload: input.payload,
      status: 'pending',
    };
  };
  fn.calls = calls;
  return fn;
}

function makeFakeWriteAuditLog({ fail = false } = {}) {
  let calls = [];
  const fn = async (input, opts) => {
    calls.push({ input, opts });
    if (fail) throw new Error('AUDIT_WRITE_FAILED');
  };
  fn.calls = calls;
  return fn;
}

// Import the real production service
const { createGovernedApproval, ApprovalCreationError } = await import('../src/server/approvalCreator.ts');

// ─── PART E: ApprovalCreator Success Test ───
test('createGovernedApproval: success path calls repository once and strict audit once', async () => {
  const fakeRepo = makeFakeApprovalRequest();
  const fakeAudit = makeFakeWriteAuditLog();

  const actor = { type: 'user', username: 'operator1', role: 'operator' };
  const result = await createGovernedApproval({
    action: 'SUBSCRIBER_BATCH_CREATE',
    requester: 'operator1',
    requesterContext: actor,
    targetId: 'subscriber:batch:454000000000001',
    summary: 'Batch create 5 subscriber(s) from 454000000000001',
    payload: { version: 2 },
    operation: { resourceType: 'subscriber_batch', resourceId: '454000000000001' },
    operationFingerprint: 'abc123',
  }, actor, { createApprovalRequest: fakeRepo, writeAuditLog: fakeAudit });

  // Repository insert exactly 1
  assert.equal(fakeRepo.calls.length, 1);
  assert.equal(fakeRepo.calls[0].action, 'SUBSCRIBER_BATCH_CREATE');

  // Strict approval.create audit exactly 1
  assert.equal(fakeAudit.calls.length, 1);
  assert.equal(fakeAudit.calls[0].opts.failureMode, 'strict');
  assert.equal(fakeAudit.calls[0].input.module, 'approvals');
  assert.equal(fakeAudit.calls[0].input.action, 'approval.create');
  assert.match(fakeAudit.calls[0].input.targetId, /^approval:/);
  assert.equal(fakeAudit.calls[0].input.result, 'success');

  // Actor passed correctly
  assert.equal(fakeAudit.calls[0].input.actor.username, 'operator1');
  assert.equal(fakeAudit.calls[0].input.actor.role, 'operator');

  // Approval returned
  assert.ok(result);
  assert.equal(result.id, 'approval-1');
});

// ─── PART F: requesterContext Test ───
test('createGovernedApproval: fresh actor requesterContext is persisted', async () => {
  const fakeRepo = makeFakeApprovalRequest();
  const fakeAudit = makeFakeWriteAuditLog();

  const actor = { type: 'user', username: 'operator1', role: 'operator' };
  await createGovernedApproval({
    action: 'SUBSCRIBER_BATCH_CREATE',
    requester: 'operator1',
    requesterContext: actor,
    targetId: 'subscriber:batch:454000000000001',
    summary: 'Batch create 3 subscriber(s)',
    payload: {},
    operation: { resourceType: 'subscriber_batch', resourceId: '454000000000001' },
    operationFingerprint: 'def456',
  }, actor, { createApprovalRequest: fakeRepo, writeAuditLog: fakeAudit });

  // Persistence input must contain requester and requesterContext
  assert.equal(fakeRepo.calls[0].requester, 'operator1');
  assert.deepEqual(fakeRepo.calls[0].requesterContext, {
    type: 'user',
    username: 'operator1',
    role: 'operator',
  });
});

// ─── PART G: Approval Audit Failure Test ───
test('createGovernedApproval: audit failure throws ApprovalCreationError with approval retained', async () => {
  const fakeRepo = makeFakeApprovalRequest();
  const fakeAudit = makeFakeWriteAuditLog({ fail: true });

  const actor = { type: 'user', username: 'operator1', role: 'operator' };

  await assert.rejects(
    () => createGovernedApproval({
      action: 'SUBSCRIBER_BATCH_CREATE',
      requester: 'operator1',
      requesterContext: actor,
      targetId: 'subscriber:batch:454000000000001',
      summary: 'Batch create 5 subscriber(s)',
      payload: {},
      operation: { resourceType: 'subscriber_batch', resourceId: '454000000000001' },
      operationFingerprint: 'abc123',
    }, actor, { createApprovalRequest: fakeRepo, writeAuditLog: fakeAudit }),
    (err) => {
      assert.ok(err instanceof ApprovalCreationError);
      assert.equal(err.code, 'AUDIT_UNAVAILABLE');
      // Approval retained — not rolled back
      assert.ok(err.approval);
      assert.equal(err.approval.id, 'approval-1');
      return true;
    }
  );

  // Approval insert count = 1
  assert.equal(fakeRepo.calls.length, 1);
  // Audit count = 1 (attempted)
  assert.equal(fakeAudit.calls.length, 1);
});

// ─── PART H: Duplicate Audit Test ───
test('createGovernedApproval: exactly one audit event, no legacy duplicate', async () => {
  const fakeRepo = makeFakeApprovalRequest();
  const fakeAudit = makeFakeWriteAuditLog();

  const actor = { type: 'user', username: 'operator1', role: 'operator' };
  await createGovernedApproval({
    action: 'SUBSCRIBER_BATCH_CREATE',
    requester: 'operator1',
    requesterContext: actor,
    targetId: 'subscriber:batch:454000000000001',
    summary: 'Batch create 5 subscriber(s)',
    payload: {},
    operation: { resourceType: 'subscriber_batch', resourceId: '454000000000001' },
    operationFingerprint: 'abc123',
  }, actor, { createApprovalRequest: fakeRepo, writeAuditLog: fakeAudit });

  // Exactly 1 approval insert, exactly 1 audit, no more
  assert.equal(fakeRepo.calls.length, 1);
  assert.equal(fakeAudit.calls.length, 1);
  // Audit action is approval.create, not some other duplicate
  assert.equal(fakeAudit.calls[0].input.action, 'approval.create');
});
