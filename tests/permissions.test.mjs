import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityAllowed,
  capabilityDecision,
  ROLE_CAPABILITIES,
} from '../src/lib/permissions.ts';

test('role capability matrix matches operator guardrails', () => {
  assert.equal(capabilityDecision('root', 'user_admin'), 'allow');
  assert.equal(capabilityDecision('root', 'profile_rollback'), 'allow');
  assert.equal(capabilityDecision('operator', 'subscriber_write'), 'allow');
  assert.equal(capabilityDecision('operator', 'policy_approve'), 'approval');
  assert.equal(capabilityDecision('operator', 'balance_adjust'), 'approval');
  assert.equal(capabilityDecision('operator', 'user_admin'), 'deny');
  assert.equal(capabilityDecision('viewer', 'audit_export'), 'export');
  assert.equal(capabilityDecision('viewer', 'subscriber_write'), 'deny');
});

test('approval and export decisions require explicit route opt-in', () => {
  assert.equal(capabilityAllowed('allow'), true);
  assert.equal(capabilityAllowed('approval'), false);
  assert.equal(capabilityAllowed('approval', { allowApproval: true }), true);
  assert.equal(capabilityAllowed('export'), false);
  assert.equal(capabilityAllowed('export', { allowExport: true }), true);
  assert.equal(capabilityAllowed('deny', { allowApproval: true, allowExport: true }), false);
});

test('all roles expose the same capability keys', () => {
  const rootKeys = Object.keys(ROLE_CAPABILITIES.root).sort();
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES.operator).sort(), rootKeys);
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES.viewer).sort(), rootKeys);
});
