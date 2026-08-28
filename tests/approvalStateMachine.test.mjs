import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';
import { sanitizeAuditPayload, sanitizeAuditText } from '../src/lib/audit/sanitize.ts';
import { assessApprovalRisk } from '../src/server/approvalRiskPolicy.ts';

function repositoryWith(initial) {
  const records = new Map(initial.map((item) => [item.id, structuredClone(item)]));
  const collection = {
    async findOneAndUpdate(filter, update) {
      const current = records.get(filter.id ?? filter._id);
      if (filter._id) {
        const next = current || { _id: filter._id, value: 0 };
        next.value += update.$inc.value;
        Object.assign(next, update.$set);
        records.set(filter._id, next);
        return structuredClone(next);
      }
      if (!current || (filter.status !== undefined && current.status !== filter.status)) return null;
      Object.assign(current, update.$set);
      if (update.$push?.events) current.events.push(update.$push.events);
      return structuredClone(current);
    },
    async findOne(filter) {
      const value = records.get(filter.id ?? filter._id);
      return value ? structuredClone(value) : null;
    },
  };
  const repository = loadModule('src/server/repositories/approvalRepository.ts', {
    mongodb: {},
    '@/lib/audit/sanitize': { sanitizeAuditPayload, sanitizeAuditText },
    '@/lib/mongo': { mongoCollections: { approvals: 'app_approvals', sequences: 'app_sequences' }, getAppCollection: async () => collection },
    '@/server/approvalRiskPolicy': { assessApprovalRisk },
  });
  return { repository, records };
}

function approval(status = 'pending') {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(), changeId: 'CHG-20260827-00001', title: 'Test change', summary: 'Test change',
    action: 'ACCESS_REQUEST', status, operation: { resourceType: 'user', resourceId: 'alice' },
    riskLevel: 'high', riskAssessment: assessApprovalRisk('ACCESS_REQUEST'), requester: 'alice',
    targetId: 'alice', payload: {}, events: [], createdAt: now, updatedAt: now,
  };
}

function transition(repository, item, nextStatus, eventType = nextStatus) {
  return repository.transitionApproval({
    id: item.id, expectedStatus: item.status, nextStatus, actor: 'reviewer', eventType,
    eventMessage: `Moved to ${nextStatus}`,
  });
}

test('two concurrent approvals produce exactly one CAS success', async () => {
  const item = approval();
  const { repository } = repositoryWith([item]);
  const results = await Promise.all([transition(repository, item, 'approved'), transition(repository, item, 'approved')]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === 'conflict').length, 1);
});

test('approve/reject and cancel/approve races each have one winner', async () => {
  for (const [left, right] of [['approved', 'rejected'], ['cancelled', 'approved']]) {
    const item = approval();
    const { repository } = repositoryWith([item]);
    const results = await Promise.all([transition(repository, item, left), transition(repository, item, right)]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.reason === 'conflict').length, 1);
  }
});

test('competing execution callbacks cannot write two terminal outcomes', async () => {
  const item = approval('executing');
  const { repository } = repositoryWith([item]);
  const results = await Promise.all([transition(repository, item, 'completed'), transition(repository, item, 'failed')]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === 'conflict').length, 1);
});

test('state machine rejects unlisted transitions before storage', async () => {
  const item = approval();
  const { repository } = repositoryWith([item]);
  await assert.rejects(transition(repository, item, 'completed'), /APPROVAL_TRANSITION_NOT_ALLOWED/);
});

function executionService(state, accountRole = 'viewer') {
  const repository = {
    async getApproval(id) { return state.approval.id === id ? structuredClone(state.approval) : null; },
    async transitionApproval(input) {
      if (state.approval.id !== input.id) return { ok: false, reason: 'not_found' };
      if (state.approval.status !== input.expectedStatus || (input.expectedExecutionId && state.approval.execution?.id !== input.expectedExecutionId)) {
        return { ok: false, reason: 'conflict', approval: structuredClone(state.approval) };
      }
      state.approval = {
        ...state.approval, ...input.patch, status: input.nextStatus,
        events: [...state.approval.events, { id: crypto.randomUUID(), timestamp: new Date().toISOString(), type: input.eventType, actor: input.actor, message: input.eventMessage }],
      };
      return { ok: true, approval: structuredClone(state.approval) };
    },
  };
  return loadModule('src/server/approvalExecution.ts', {
    '@/lib/audit': { writeAuditLog: async () => true },
    '@/lib/audit/record': { auditRequestContext: () => ({}) },
    '@/lib/accountSession': { validateCurrentAccount: async ({ username, role }) => ({ userId: username, username, role }) },
    '@/server/approvalExecutors': { executeApproval: async () => ({}) },
    '@/server/subscriberOperationPolicy': {
      executeFrozenSubscriberBatchChange: async () => ({}),
      SubscriberBatchGovernanceError: class extends Error {},
    },
    '@/server/subscriberSingleGovernance': {
      executeFrozenSubscriberUpdate: async () => ({}),
      executeFrozenSubscriberDelete: async () => ({}),
      SubscriberGovernanceError: class extends Error {},
    },
    '@/server/subscriberGovernanceRegistry': {
      assertGovernedOperationCoverage: () => {},
    },
    '@/server/approvalWorkflow': {
      ApprovalWorkflowError: class extends Error {},
      approvalActionEligibility: (item) => ({ canExecute: item.status === 'approved' }),
    },
    '@/server/repositories/approvalRepository': repository,
    '@/server/repositories/userRepository': { getUser: async () => ({ role: accountRole, status: 'active' }) },
  });
}

test('two execute requests claim once and invoke the executor exactly once', async () => {
  const state = { approval: approval('approved') };
  const service = executionService(state);
  let invocations = 0;
  const executor = { async execute() { invocations += 1; return { safe: true }; } };
  const request = new Request('https://ops.test/api/approvals/a/execute');
  const auth = { user: 'reviewer', role: 'root', sessionVersion: 0 };
  const outcomes = await Promise.allSettled([
    service.executeApprovedChange(request, state.approval.id, auth, executor),
    service.executeApprovedChange(request, state.approval.id, auth, executor),
  ]);
  assert.equal(invocations, 1);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected' && item.reason.code === 'APPROVAL_STATE_CONFLICT').length, 1);
  assert.equal(state.approval.status, 'completed');
});

test('execution preconditions detect live-state drift and configured maintenance windows', async () => {
  const changedState = { approval: { ...approval('approved'), before: { role: 'viewer' } } };
  const changedService = executionService(changedState, 'operator');
  await assert.rejects(changedService.validateExecutionPrecondition(changedState.approval), { code: 'APPROVAL_PRECONDITION_CHANGED' });

  const outside = { ...approval('approved'), maintenanceWindow: { start: '2026-08-27T01:00:00.000Z', end: '2026-08-27T02:00:00.000Z' } };
  const windowService = executionService({ approval: outside });
  await assert.rejects(windowService.validateExecutionPrecondition(outside, new Date('2026-08-27T03:00:00.000Z')), { code: 'OUTSIDE_MAINTENANCE_WINDOW' });
});
