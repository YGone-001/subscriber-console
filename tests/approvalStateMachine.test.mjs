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
