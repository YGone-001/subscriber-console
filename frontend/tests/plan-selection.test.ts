import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planThresholdExceedsQuota,
  selectDefaultPlanId,
} from '../src/features/subscribers/plan-selection';

test('plan selection: prefers the API-marked default plan', () => {
  assert.equal(selectDefaultPlanId([
    { plan_id: 'plan_a', status: 'active' },
    { plan_id: 'default_plan', status: 'active', isDefault: true },
  ]), 'default_plan');
});

test('plan selection: never selects a disabled default plan', () => {
  assert.equal(selectDefaultPlanId([
    { plan_id: 'plan_default_legacy', status: 'disabled', isDefault: true },
    { plan_id: 'plan_a', status: 'active' },
  ]), 'plan_a');
});

test('plan selection: falls back to the first active plan, then the first plan', () => {
  assert.equal(selectDefaultPlanId([
    { plan_id: 'plan_x', status: 'disabled' },
    { plan_id: 'plan_y' },
  ]), 'plan_y');
  assert.equal(selectDefaultPlanId([{ plan_id: 'plan_x', status: 'disabled' }]), 'plan_x');
  assert.equal(selectDefaultPlanId([]), '');
});

test('plan threshold: flags a threshold above the granted quota', () => {
  assert.equal(planThresholdExceedsQuota({
    plan_id: 'plan_broken',
    quota_per_grant: 10485760,
    volume_threshold: 1073741824,
  }), true);
  assert.equal(planThresholdExceedsQuota({
    plan_id: 'plan_ok',
    quota_per_grant: 10485760,
    volume_threshold: 8388608,
  }), false);
  assert.equal(planThresholdExceedsQuota({
    plan_id: 'plan_unconfigured',
    quota_per_grant: 0,
    volume_threshold: 1073741824,
  }), false);
  assert.equal(planThresholdExceedsQuota(undefined), false);
});
