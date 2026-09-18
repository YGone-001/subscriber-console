import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadModule } from './helpers/loadModule.mjs';
import * as permissions from '../src/lib/permissions.ts';

function subscriber(imsi, access = 32, downlink = 50) {
  return {
    imsi, access_restriction_data: access,
    ambr: { downlink: { value: downlink, unit: 3 }, uplink: { value: 25, unit: 3 } },
    // These intentionally prove that snapshots never copy authentication material.
    security: { k: 'K-MUST-NOT-LEAK', op: 'OP-MUST-NOT-LEAK', opc: 'OPC-MUST-NOT-LEAK' },
  };
}

function serviceHarness(docs, mutationResult = { matchedCount: 1, modifiedCount: 1 }) {
  const captured = { updates: [] };
  const service = loadModule('src/server/subscriberOperationPolicy.ts', {
    'node:crypto': { createHash },
    '@/lib/permissions': permissions,
    '@/lib/subscriberValidation': { validateImsi: (value) => ({ ok: /^\d{15}$/.test(String(value)), value: String(value) }) },
    '@/server/repositories/subscriberRepository': {
      findSubscriberDocuments: async () => docs,
      applyGovernedSubscriberConditionalUpdates: async (updates) => { captured.updates = updates; return mutationResult; },
    },
  }, { Buffer });
  return { service, captured };
}

const request = { imsis: ['460001234567890'], patch: { accessRestrictionData: 0, ambr: { downlink: { value: 100, unit: 3 } } }, reason: '变更核心网订阅用户带宽' };

test('frozen snapshot contains only allowlisted before/after values and never subscriber security material', async () => {
  const { service } = serviceHarness([subscriber(request.imsis[0])]);
  const input = service.validateSubscriberBatchChangeRequest(request);
  const frozen = await service.prepareFrozenSubscriberBatchChange(input);
  const serialized = JSON.stringify(frozen);
  assert.match(serialized, /access_restriction_data/);
  assert.match(serialized, /ambr\.downlink\.value/);
  assert.doesNotMatch(serialized, /K-MUST-NOT-LEAK|OP-MUST-NOT-LEAK|OPC-MUST-NOT-LEAK|security/);
  assert.equal(frozen.targets[0].before.access_restriction_data, 32);
  assert.equal(frozen.targets[0].after.access_restriction_data, 0);
});

test('execution writes the frozen after values with frozen before values as conditional filters', async () => {
  const doc = subscriber(request.imsis[0]);
  const { service, captured } = serviceHarness([doc]);
  const frozen = await service.prepareFrozenSubscriberBatchChange(service.validateSubscriberBatchChangeRequest(request));
  const result = await service.executeFrozenSubscriberBatchChange(frozen);
  assert.equal(result.modified, 1);
  assert.equal(captured.updates.length, 1);
  assert.equal(captured.updates[0].expected.access_restriction_data, 32);
  assert.equal(captured.updates[0].next.access_restriction_data, 0);
  assert.equal(captured.updates[0].expected['ambr.downlink.value'], 50);
  assert.equal(captured.updates[0].next['ambr.downlink.value'], 100);
});

test('live-state drift blocks execution before any conditional write is attempted', async () => {
  const doc = subscriber(request.imsis[0]);
  const { service, captured } = serviceHarness([doc]);
  const frozen = await service.prepareFrozenSubscriberBatchChange(service.validateSubscriberBatchChangeRequest(request));
  doc.ambr.downlink.value = 80;
  await assert.rejects(service.executeFrozenSubscriberBatchChange(frozen), { code: 'SUBSCRIBER_BATCH_PRECONDITION_CHANGED' });
  assert.equal(captured.updates.length, 0);
});

test('partial conditional writes fail closed and carry an accurate partial-mutation result', async () => {
  const secondImsi = '460001234567891';
  const { service } = serviceHarness([subscriber(request.imsis[0]), subscriber(secondImsi)], { matchedCount: 1, modifiedCount: 1 });
  const frozen = await service.prepareFrozenSubscriberBatchChange(service.validateSubscriberBatchChangeRequest({ ...request, imsis: [request.imsis[0], secondImsi] }));
  await assert.rejects(service.executeFrozenSubscriberBatchChange(frozen), (error) => {
    assert.equal(error.code, 'SUBSCRIBER_BATCH_PARTIAL_WRITE');
    assert.equal(error.details.partialMutation, true);
    assert.equal(error.details.expected, 2);
    return true;
  });
});
