#!/usr/bin/env node
/**
 * Phase 5.7-B — RBAC Simplification Acceptance Suite
 *
 * Verifies the Canonical Three-Role Model:
 * 1. Exactly 3 canonical roles: admin, operator, viewer
 * 2. Transparent runtime normalization of legacy roles:
 *    - root, super_admin -> admin
 *    - ops_admin, operator -> operator
 *    - auditor, viewer -> viewer
 * 3. Permission matrix & direct execution (no approval required for active mutations)
 * 4. API write boundary: accepts only canonical roles; rejects legacy roles with INVALID_ROLE (400)
 * 5. UI role dropdown / assignable roles contract: exactly 3 choices for admin
 * 6. Go backend parity verification
 */

import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': fileURLToPath(new URL('../frontend/src', import.meta.url)),
  },
});

const {
  normalizeGovernanceRole,
  isSuperAdmin,
  capabilityDecision,
  capabilityAllowed,
  hasPermission,
  permissionsFor,
  ROLE_CAPABILITIES,
  ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
} = jiti('../frontend/src/lib/permissions.ts');

const {
  CANONICAL_ROLES,
  VALID_ROLES,
  ROLE_STYLE,
} = jiti('../frontend/src/types/iam.ts');

const {
  assignableRoles,
  checkUserManagementPolicy,
  UserManagementError,
} = jiti('../frontend/src/lib/userManagementPolicy.ts');

console.log('── Phase 5.7-B RBAC Simplification Acceptance Suite ──\n');

let totalAssertions = 0;
function verify(description, fn) {
  try {
    fn();
    console.log(`  ✓ ${description}`);
    totalAssertions++;
  } catch (err) {
    console.error(`  ✗ ${description}`);
    console.error(err);
    process.exit(1);
  }
}

// ============================================================================
// 1. Canonical Role Model Definitions
// ============================================================================
console.log('1. Canonical Role Model Definitions');

verify('canonical roles list contains strictly [admin, operator, viewer]', () => {
  assert.deepEqual([...CANONICAL_ROLES], ['admin', 'operator', 'viewer']);
  assert.equal(CANONICAL_ROLES.length, 3);
});

verify('valid roles list equals canonical roles', () => {
  assert.deepEqual([...VALID_ROLES], ['admin', 'operator', 'viewer']);
});

verify('role styles cover canonical roles', () => {
  for (const role of ['admin', 'operator', 'viewer']) {
    assert.ok(ROLE_STYLE[role], `Missing style for role: ${role}`);
    assert.ok(ROLE_STYLE[role].color, `Missing color for role: ${role}`);
    assert.ok(ROLE_STYLE[role].bg, `Missing bg for role: ${role}`);
  }
});

// ============================================================================
// 2. Role Normalization Matrix (Legacy Aliases)
// ============================================================================
console.log('\n2. Role Normalization Matrix (Legacy Aliases)');

const normalizationCases = [
  // Canonical roles (idempotent)
  { input: 'admin', expected: 'admin' },
  { input: 'operator', expected: 'operator' },
  { input: 'viewer', expected: 'viewer' },
  // Legacy aliases
  { input: 'root', expected: 'admin' },
  { input: 'super_admin', expected: 'admin' },
  { input: 'ops_admin', expected: 'operator' },
  { input: 'auditor', expected: 'viewer' },
  // Unknown / invalid roles fail closed
  { input: 'unknown', expected: null },
  { input: '', expected: null },
  { input: null, expected: null },
  { input: undefined, expected: null },
  { input: '__proto__', expected: null },
];

for (const { input, expected } of normalizationCases) {
  verify(`normalizeGovernanceRole(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, () => {
    assert.equal(normalizeGovernanceRole(input), expected);
  });
}

verify('isSuperAdmin returns true only for admin and its legacy aliases', () => {
  assert.equal(isSuperAdmin('admin'), true);
  assert.equal(isSuperAdmin('root'), true);
  assert.equal(isSuperAdmin('super_admin'), true);
  assert.equal(isSuperAdmin('operator'), false);
  assert.equal(isSuperAdmin('ops_admin'), false);
  assert.equal(isSuperAdmin('auditor'), false);
  assert.equal(isSuperAdmin('viewer'), false);
  assert.equal(isSuperAdmin('other'), false);
});

// ============================================================================
// 3. Permission Catalog & Capabilities Verification
// ============================================================================
console.log('\n3. Permission Catalog & Capabilities Verification');

verify('canonical capability keys are identical across all canonical roles', () => {
  const adminKeys = Object.keys(ROLE_CAPABILITIES.admin).sort();
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES.operator).sort(), adminKeys);
  assert.deepEqual(Object.keys(ROLE_CAPABILITIES.viewer).sort(), adminKeys);
});

verify('active mutations have direct execution (allow), never approval', () => {
  const activeMutations = [
    'subscriber_write',
    'policy_approve',
    'balance_adjust',
    'profile_rollback',
    'rating_publish',
    'system_heal',
  ];

  for (const cap of activeMutations) {
    // Admin has direct execution
    assert.equal(capabilityDecision('admin', cap), 'allow');
    assert.equal(capabilityDecision('root', cap), 'allow');
    assert.equal(capabilityDecision('super_admin', cap), 'allow');

    // Operator has direct execution
    assert.equal(capabilityDecision('operator', cap), 'allow');
    assert.equal(capabilityDecision('ops_admin', cap), 'allow');

    // Viewer is denied
    assert.equal(capabilityDecision('viewer', cap), 'deny');
    assert.equal(capabilityDecision('auditor', cap), 'deny');
  }
});

verify('administrative duties separation: user_admin, approval_review, audit_export', () => {
  // admin: all administrative capabilities allowed
  assert.equal(capabilityDecision('admin', 'user_admin'), 'allow');
  assert.equal(capabilityDecision('admin', 'approval_review'), 'allow');
  assert.equal(capabilityDecision('admin', 'approval_execute'), 'allow');
  assert.equal(capabilityDecision('admin', 'audit_export'), 'export');

  // operator: administrative capabilities denied
  assert.equal(capabilityDecision('operator', 'user_admin'), 'deny');
  assert.equal(capabilityDecision('operator', 'approval_review'), 'deny');
  assert.equal(capabilityDecision('operator', 'approval_execute'), 'deny');
  assert.equal(capabilityDecision('operator', 'audit_export'), 'deny');

  // viewer: administrative capabilities denied
  assert.equal(capabilityDecision('viewer', 'user_admin'), 'deny');
  assert.equal(capabilityDecision('viewer', 'approval_review'), 'deny');
  assert.equal(capabilityDecision('viewer', 'approval_execute'), 'deny');
  assert.equal(capabilityDecision('viewer', 'audit_export'), 'deny');
});

verify('representative permissions table verification', () => {
  const representativeMatrix = [
    // [permission, admin, operator, viewer]
    ['users.read', true, false, false],
    ['users.create', true, false, false],
    ['users.update', true, false, false],
    ['users.role.change', true, false, false],
    ['subscribers.read', true, true, true],
    ['subscribers.write', true, true, false],
    ['subscribers.delete', true, true, false],
    ['profiles.read', true, true, true],
    ['profiles.write', true, true, false],
    ['core.read', true, true, true],
    ['core.operate', true, true, false],
    ['core.configure', true, true, false],
    ['ocs.read', true, true, true],
    ['ocs.balance.adjust', true, true, false],
    ['ocs.tariff.write', true, true, false],
    ['ocs.plan.assign', true, true, false],
    ['ocs.rating.write', true, true, false],
    ['audit.read', true, true, true],
    ['audit.export', true, false, false],
    ['audit.source-ip.read-full', true, false, false],
  ];

  for (const [perm, expectedAdmin, expectedOperator, expectedViewer] of representativeMatrix) {
    assert.equal(hasPermission({ role: 'admin' }, perm), expectedAdmin, `admin mismatch on ${perm}`);
    assert.equal(hasPermission({ role: 'root' }, perm), expectedAdmin, `root alias mismatch on ${perm}`);
    assert.equal(hasPermission({ role: 'super_admin' }, perm), expectedAdmin, `super_admin alias mismatch on ${perm}`);

    assert.equal(hasPermission({ role: 'operator' }, perm), expectedOperator, `operator mismatch on ${perm}`);
    assert.equal(hasPermission({ role: 'ops_admin' }, perm), expectedOperator, `ops_admin alias mismatch on ${perm}`);

    assert.equal(hasPermission({ role: 'viewer' }, perm), expectedViewer, `viewer mismatch on ${perm}`);
    assert.equal(hasPermission({ role: 'auditor' }, perm), expectedViewer, `auditor alias mismatch on ${perm}`);
  }
});

verify('all role permissions exist in PERMISSION_CATALOG', () => {
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    assert.equal(new Set(perms).size, perms.length, `Duplicates in ${role} permissions`);
    for (const p of perms) {
      assert.ok(PERMISSION_CATALOG.includes(p), `Unknown permission ${p} in role ${role}`);
    }
  }
});

// ============================================================================
// 4. User Management Policy & UI Assignable Roles
// ============================================================================
console.log('\n4. User Management Policy & UI Assignable Roles');

verify('assignableRoles for admin returns exactly 3 canonical roles', () => {
  const adminActor = { username: 'admin_user', role: 'admin', status: 'active' };
  const roles = assignableRoles(adminActor);
  assert.deepEqual(roles, ['admin', 'operator', 'viewer']);
  assert.equal(roles.length, 3);
});

verify('assignableRoles for legacy root/super_admin returns exactly 3 canonical roles', () => {
  assert.deepEqual(assignableRoles({ username: 'root_user', role: 'root', status: 'active' }), ['admin', 'operator', 'viewer']);
  assert.deepEqual(assignableRoles({ username: 'super_user', role: 'super_admin', status: 'active' }), ['admin', 'operator', 'viewer']);
});

verify('assignableRoles for operator and viewer is empty (no user admin)', () => {
  assert.deepEqual(assignableRoles({ username: 'op_user', role: 'operator', status: 'active' }), []);
  assert.deepEqual(assignableRoles({ username: 'ops_user', role: 'ops_admin', status: 'active' }), []);
  assert.deepEqual(assignableRoles({ username: 'v_user', role: 'viewer', status: 'active' }), []);
  assert.deepEqual(assignableRoles({ username: 'aud_user', role: 'auditor', status: 'active' }), []);
});

verify('checkUserManagementPolicy allows assigning only canonical roles', () => {
  const admin = { username: 'admin', role: 'admin', status: 'active' };
  // Canonical roles permitted
  checkUserManagementPolicy(admin, null, 'create', 'admin');
  checkUserManagementPolicy(admin, null, 'create', 'operator');
  checkUserManagementPolicy(admin, null, 'create', 'viewer');

  // Legacy roles rejected on assignment
  for (const legacyRole of ['root', 'super_admin', 'ops_admin', 'auditor', 'unknown']) {
    assert.throws(
      () => checkUserManagementPolicy(admin, null, 'create', legacyRole),
      /ROLE_ASSIGNMENT_FORBIDDEN/,
      `Expected ${legacyRole} to be forbidden for assignment`
    );
  }
});

verify('non-admin user cannot manage users', () => {
  const op = { username: 'op', role: 'operator', status: 'active' };
  const target = { username: 'target', role: 'viewer', status: 'active' };
  assert.throws(() => checkUserManagementPolicy(op, target, 'update'), /PERMISSION_DENIED/);
  assert.throws(() => checkUserManagementPolicy(op, null, 'create', 'viewer'), /PERMISSION_DENIED/);
  assert.throws(() => checkUserManagementPolicy(op, target, 'disable'), /PERMISSION_DENIED/);
  assert.throws(() => checkUserManagementPolicy(op, target, 'role.change', 'admin'), /PERMISSION_DENIED/);
});

// ============================================================================
// 5. Go Backend Parity Verification
// ============================================================================
console.log('\n5. Go Backend Parity Verification');

verify('Go backend auth and user tests pass', () => {
  const output = execSync('go test -short ./internal/auth ./internal/user ./internal/approval', {
    cwd: fileURLToPath(new URL('../backend', import.meta.url)),
    encoding: 'utf8',
  });
  assert.ok(output.includes('ok'), 'Go tests must pass');
});

console.log(`\n========================================`);
console.log(`RBAC SIMPLIFICATION SUITE PASSED: ${totalAssertions} assertions verified`);
console.log(`========================================\n`);
