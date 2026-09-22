import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityAllowed,
  capabilityDecision,
  ROLE_CAPABILITIES,
  hasPermission,
  permissionsFor,
  normalizeGovernanceRole,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
} from '../src/lib/permissions.ts';

test('role capability matrix matches operator guardrails', () => {
  assert.equal(capabilityDecision('root', 'user_admin'), 'allow');
  assert.equal(capabilityDecision('root', 'profile_rollback'), 'allow');
  assert.equal(capabilityDecision('operator', 'subscriber_write'), 'allow');
  assert.equal(capabilityDecision('operator', 'policy_approve'), 'allow');
  assert.equal(capabilityDecision('operator', 'balance_adjust'), 'allow');
  assert.equal(capabilityDecision('operator', 'profile_rollback'), 'allow');
  assert.equal(capabilityDecision('operator', 'user_admin'), 'deny');
  for (const removed of ['approval_review', 'approval_execute', 'audit_view', 'audit_export']) {
    assert.equal(capabilityDecision('root', removed), 'deny');
    assert.equal(capabilityDecision('operator', removed), 'deny');
    assert.equal(capabilityDecision('viewer', removed), 'deny');
  }
  assert.equal(capabilityDecision('viewer', 'subscriber_write'), 'deny');
});

test('capability decisions are binary', () => {
  assert.equal(capabilityAllowed('allow'), true);
  assert.equal(capabilityAllowed('deny'), false);
});

test('all roles expose the same capability keys', () => {
  const rootKeys = Object.keys(ROLE_CAPABILITIES.root).sort();
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES.operator).sort(), rootKeys);
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES.viewer).sort(), rootKeys);
});

test('direct-operation permissions preserve canonical role separation', () => {
  assert.equal(normalizeGovernanceRole('root'), 'admin');
  assert.deepEqual(permissionsFor({ role: 'root' }), permissionsFor({ role: 'admin' }));
  assert.equal(hasPermission({ role: 'viewer' }, 'users.update'), false);
  assert.equal(hasPermission({ role: 'viewer' }, 'audit.export'), false);
  assert.equal(hasPermission({ role: 'auditor' }, 'core.operate'), false);
  assert.equal(hasPermission({ role: 'auditor' }, 'audit.export'), false);
  assert.equal(hasPermission({ role: 'auditor' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'admin' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'root' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'super_admin' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'ops_admin' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'operator' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'viewer' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'operator' }, 'subscribers.write'), true);
  assert.equal(hasPermission({ role: 'viewer' }, 'subscribers.write'), false);
  assert.equal(hasPermission({ role: 'ops_admin' }, 'users.role.change'), false);
});

test('permission evaluation fails closed for missing, unknown and inactive identities', () => {
  for (const user of [null, undefined, {}, { role: 'unknown_role' }, { role: '__proto__' },
    { role: 'root', status: 'disabled' }, { role: 'root', status: 'locked' },
    { role: 'root', status: 'unknown' }, { role: 'root', locked: true }]) {
    assert.equal(hasPermission(user, 'audit.read'), false);
  }
  assert.equal(hasPermission({ role: 'root' }, 'not.a.permission'), false);
  assert.equal(hasPermission({ role: 'root', status: 'active' }, 'users.create'), true);
  for (const permissions of Object.values(ROLE_PERMISSIONS)) {
    assert.equal(new Set(permissions).size, permissions.length);
    assert.ok(permissions.every((permission) => PERMISSION_CATALOG.includes(permission)));
  }
});
