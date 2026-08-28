import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';
import * as permissions from '../src/lib/permissions.ts';

const service = loadModule('src/server/subscriberOperationPolicy.ts', {
  'node:crypto': { createHash: () => ({ update: () => ({ digest: () => 'test-hash' }) }) },
  '@/lib/permissions': permissions,
  '@/lib/subscriberValidation': { validateImsi: (value) => ({ ok: /^\d{15}$/.test(String(value)), value: String(value) }) },
  '@/server/repositories/subscriberRepository': {},
});
const { changedFieldNames, evaluateSubscriberOperationPolicy, SubscriberBatchGovernanceError, validateSubscriberBatchChangeRequest } = service;

const valid = {
  imsis: ['460001234567890', '460001234567891'],
  patch: { accessRestrictionData: 0, ambr: { downlink: { value: 100, unit: 3 } } },
  reason: '计划维护窗口内调整接入和下行带宽',
  ticketId: 'CHG-20260828-001',
};

test('subscriber batch policy always requires approval, including root', () => {
  const input = validateSubscriberBatchChangeRequest(valid);
  for (const role of ['root', 'super_admin', 'ops_admin', 'operator']) {
    const policy = evaluateSubscriberOperationPolicy({ role }, input);
    assert.equal(policy.allowed, true, role);
    assert.equal(policy.requiresApproval, true, role);
    assert.equal(policy.requiresIndependentReviewer, true, role);
    assert.equal(policy.riskLevel, 'high', role);
  }
});

test('batch request has a strict DTO and explicitly rejects secret fields and Mongo operators', () => {
  assert.throws(() => validateSubscriberBatchChangeRequest({ ...valid, patch: { security: { k: 'secret' } } }), { code: 'UNSUPPORTED_SUBSCRIBER_FIELD' });
  assert.throws(() => validateSubscriberBatchChangeRequest({ ...valid, patch: { '$set': { accessRestrictionData: 0 } } }), { code: 'UNSUPPORTED_SUBSCRIBER_FIELD' });
  assert.throws(() => validateSubscriberBatchChangeRequest({ ...valid, imsis: ['460001234567890', '460001234567890'] }), { code: 'INVALID_BATCH_REQUEST' });
  assert.throws(() => validateSubscriberBatchChangeRequest({ ...valid, reason: '  ' }), { code: 'INVALID_BATCH_REQUEST' });
  assert.throws(() => validateSubscriberBatchChangeRequest({ ...valid, imsis: Array.from({ length: 101 }, (_, index) => `46000123456${String(index).padStart(4, '0')}`) }), { code: 'BATCH_SIZE_EXCEEDED' });
});

test('allowlist maps only access restriction and explicit AMBR directions', () => {
  assert.deepEqual([...changedFieldNames(validateSubscriberBatchChangeRequest(valid).patch)], ['access_restriction_data', 'ambr.downlink']);
  assert.ok(SubscriberBatchGovernanceError);
});
