import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_OCS_PLAN_ID,
  buildTariffPlanAuditFilter,
  buildTariffPlanOperationsSummary,
  isDefaultTariffPlan,
  isValidTariffPlanId,
  shouldBlockTariffPlanDisable,
  validateTariffRule,
  detectRuleConflicts,
  normalizeImportedPlan,
  exportTariffPlanJson,
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

test('validateTariffRule validates required fields and number constraints', () => {
  const valid = validateTariffRule({
    rule_id: 'rule_vol_5g',
    apn: 'internet',
    rating_group_id: 100,
    service_identifier: 1,
    charging_type: 'data_volume',
    rates: '0.05',
    currency: 'USD',
    quota_per_grant: 10485760,
    validity_time: 300,
    volume_threshold: 8388608,
    priority: 10,
    status: 'active',
  });
  assert.equal(valid.isValid, true);
  assert.equal(valid.errors.length, 0);

  const invalid = validateTariffRule({
    rule_id: '',
    apn: 'invalid APN with spaces!',
    rating_group_id: -5,
    service_identifier: 'abc',
    rates: '-10',
  });
  assert.equal(invalid.isValid, false);
  assert.ok(invalid.errors.length >= 3);
});

test('detectRuleConflicts identifies overlapping APN, RG, SI rules', () => {
  const rules = [
    { rule_id: 'rule_1', apn: 'internet', rating_group_id: 100, service_identifier: 1, priority: 5 },
    { rule_id: 'rule_2', apn: 'internet', rating_group_id: 100, service_identifier: 1, priority: 10 },
    { rule_id: 'rule_3', apn: 'ims', rating_group_id: 200, service_identifier: 1, priority: 1 },
  ];

  const conflicts = detectRuleConflicts(rules);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].rule_ids, ['rule_1', 'rule_2']);
  assert.equal(conflicts[0].signature.apn, 'internet');
  assert.equal(conflicts[0].signature.rating_group_id, 100);
});

test('normalizeImportedPlan validates and cleans imported tariff JSON', () => {
  const rawJson = {
    plan_id: 'plan_imported_50gb',
    name: 'Imported 50GB',
    description: 'Imported test plan',
    status: 'active',
    quota_per_grant: 52428800,
    validity_time: 600,
    volume_threshold: 41943040,
    rules: [
      {
        rule_id: 'r_data',
        apn: 'internet',
        rating_group_id: 100,
        service_identifier: 1,
        charging_type: 'data_volume',
        rates: '0.01',
      },
    ],
  };

  const normalized = normalizeImportedPlan(rawJson);
  assert.equal(normalized.isValid, true);
  assert.equal(normalized.plan.plan_id, 'plan_imported_50gb');
  assert.equal(normalized.plan.rules.length, 1);
  assert.equal(normalized.plan.rules[0].rule_id, 'r_data');

  const exported = exportTariffPlanJson(normalized.plan);
  assert.equal(exported.plan_id, 'plan_imported_50gb');
  assert.equal(exported.rules.length, 1);
});

