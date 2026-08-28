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
  assert.equal(capabilityDecision('operator', 'policy_approve'), 'approval');
  assert.equal(capabilityDecision('operator', 'balance_adjust'), 'approval');
  assert.equal(capabilityDecision('operator', 'profile_rollback'), 'approval');
  assert.equal(capabilityDecision('operator', 'user_admin'), 'deny');
  assert.equal(capabilityDecision('root', 'approval_review'), 'allow');
  assert.equal(capabilityDecision('root', 'approval_execute'), 'allow');
  assert.equal(capabilityDecision('operator', 'approval_review'), 'deny');
  assert.equal(capabilityDecision('viewer', 'audit_view'), 'allow');
  assert.equal(capabilityDecision('viewer', 'audit_export'), 'deny');
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

test('governance permissions preserve root and separate operation, review and audit duties', () => {
  assert.equal(normalizeGovernanceRole('root'), 'super_admin');
  assert.deepEqual(permissionsFor({ role: 'root' }), permissionsFor({ role: 'super_admin' }));
  assert.equal(hasPermission({ role: 'viewer' }, 'users.update'), false);
  assert.equal(hasPermission({ role: 'viewer' }, 'audit.export'), false);
  assert.equal(hasPermission({ role: 'auditor' }, 'core.operate'), false);
  assert.equal(hasPermission({ role: 'auditor' }, 'audit.export'), true);
  assert.equal(hasPermission({ role: 'auditor' }, 'audit.source-ip.read-full'), true);
  assert.equal(hasPermission({ role: 'root' }, 'audit.source-ip.read-full'), true);
  assert.equal(hasPermission({ role: 'super_admin' }, 'audit.source-ip.read-full'), true);
  assert.equal(hasPermission({ role: 'ops_admin' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'operator' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'viewer' }, 'audit.source-ip.read-full'), false);
  assert.equal(hasPermission({ role: 'operator' }, 'approvals.create'), true);
  assert.equal(hasPermission({ role: 'operator' }, 'approvals.approve'), false);
  assert.equal(hasPermission({ role: 'ops_admin' }, 'approvals.approve'), true);
  assert.equal(hasPermission({ role: 'ops_admin' }, 'users.role.change'), true); // resource policy restricts targets/assignments
});

test('permission evaluation fails closed for missing, unknown and inactive identities', () => {
  for (const user of [null, undefined, {}, { role: 'admin' }, { role: '__proto__' },
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
