import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OCS_PLAN_ID,
  buildTariffPlanAuditFilter,
  buildTariffPlanOperationsSummary,
  isDefaultTariffPlan,
  isValidTariffPlanId,
  shouldBlockTariffPlanDisable,
} from '../src/lib/tariffPlanOperations.ts';
import {
  validateBatchCreatePayload,
  validatePolicyChangePayload,
} from '../src/lib/subscriberValidation.ts';

test('tariff plan operations filter tracks direct and migration audit records', () => {
  const filter = buildTariffPlanAuditFilter('plan.vip-10gb');

  assert.equal(filter.$or.length, 7);
  assert.deepEqual(filter.$or[0], {
    targetId: { $regex: 'tariff-plan:.*plan\\.vip-10gb', $options: 'i' },
  });
  assert.deepEqual(filter.$or.slice(1), [
    { 'oldData.plan_id': 'plan.vip-10gb' },
    { 'newData.plan_id': 'plan.vip-10gb' },
    { 'oldData.sourcePlanId': 'plan.vip-10gb' },
    { 'newData.sourcePlanId': 'plan.vip-10gb' },
    { 'oldData.targetPlanId': 'plan.vip-10gb' },
    { 'newData.targetPlanId': 'plan.vip-10gb' },
  ]);
});

test('tariff management six-stage upgrades stay wired together', () => {
  const customPlanId = 'plan.enterprise_50gb';

  assert.equal(isValidTariffPlanId(customPlanId), true);
  assert.equal(isValidTariffPlanId('plan enterprise 50gb'), false);

  const batchPayload = validateBatchCreatePayload({
    startImsi: '460001234567890',
    count: 3,
    planId: customPlanId,
    strategy: 'skip',
  });
  assert.equal(batchPayload.ok, true);
  assert.equal(batchPayload.value.planId, customPlanId);

  const policyPayload = validatePolicyChangePayload({
    imsiList: ['460001234567890', '460001234567891'],
    planId: customPlanId,
    status: 'active',
    resetBalances: true,
  });
  assert.equal(policyPayload.ok, true);
  assert.equal(policyPayload.value.planId, customPlanId);
  assert.equal(policyPayload.value.resetBalances, true);

  assert.equal(isDefaultTariffPlan(DEFAULT_OCS_PLAN_ID), true);
  assert.equal(isDefaultTariffPlan(customPlanId), false);

  const migrationFilter = buildTariffPlanAuditFilter(customPlanId);
  assert.deepEqual(migrationFilter.$or.slice(3), [
    { 'oldData.sourcePlanId': customPlanId },
    { 'newData.sourcePlanId': customPlanId },
    { 'oldData.targetPlanId': customPlanId },
    { 'newData.targetPlanId': customPlanId },
  ]);

  assert.equal(shouldBlockTariffPlanDisable('active', 'disabled', 2), true);
  assert.equal(shouldBlockTariffPlanDisable('active', 'disabled', 0), false);
  assert.equal(shouldBlockTariffPlanDisable('disabled', 'disabled', 2), false);

  const summary = buildTariffPlanOperationsSummary(
    [
      {
        plan_id: DEFAULT_OCS_PLAN_ID,
        name: 'Default',
        description: '',
        status: 'active',
        rulesCount: 4,
        subscriberCount: 3,
        isDefault: true,
        updated_at: '2026-07-20T00:00:00.000Z',
      },
      {
        plan_id: customPlanId,
        name: 'Enterprise',
        description: '',
        status: 'active',
        rulesCount: 5,
        subscriberCount: 7,
        isDefault: false,
        updated_at: '2026-07-22T09:00:00.000Z',
      },
      {
        plan_id: 'plan.retired',
        name: 'Retired',
        description: '',
        status: 'disabled',
        rulesCount: 2,
        subscriberCount: 0,
        isDefault: false,
      },
    ],
    {
      plan_id: customPlanId,
      name: 'Enterprise',
      description: '',
      status: 'active',
      rulesCount: 5,
      subscriberCount: 7,
      isDefault: false,
      updated_at: '2026-07-22T09:00:00.000Z',
    },
    [
      { timestamp: '2026-07-22T10:00:00.000Z' },
      { timestamp: '2026-07-22T09:30:00.000Z' },
    ]
  );

  assert.deepEqual(summary, {
    totalPlans: 3,
    activePlans: 2,
    disabledPlans: 1,
    totalLinkedSubscribers: 10,
    selectedLinkedSubscribers: 7,
    selectedSharePct: 70,
    recentActivityCount: 2,
    lastChangedAt: '2026-07-22T09:00:00.000Z',
  });
});
