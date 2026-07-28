import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPermissionDiff,
  buildUserQueryString,
  getUserAccessStatusMeta,
  isBulkMutableUser,
  isProtectedSystemUser,
  normalizePermissionEffect,
  parsePositivePage,
  permissionEffectToDecisionKey,
} from '../src/lib/userAccessManagement.ts';

test('user status mapping uses stable UI states', () => {
  assert.deepEqual(getUserAccessStatusMeta('active'), {
    status: 'active',
    labelKey: 'users_status_enabled',
    tone: 'success',
  });
  assert.deepEqual(getUserAccessStatusMeta('disabled'), {
    status: 'disabled',
    labelKey: 'users_status_disabled',
    tone: 'neutral',
  });
  assert.deepEqual(getUserAccessStatusMeta('active', true), {
    status: 'locked',
    labelKey: 'users_status_locked',
    tone: 'danger',
  });
});

test('permission decisions normalize to allow approval_required deny', () => {
  assert.equal(normalizePermissionEffect('allow'), 'allow');
  assert.equal(normalizePermissionEffect('export'), 'allow');
  assert.equal(normalizePermissionEffect('approval'), 'approval_required');
  assert.equal(normalizePermissionEffect('deny'), 'deny');
  assert.equal(permissionEffectToDecisionKey('approval_required'), 'approval');
});

test('user query string omits default filters and keeps active state', () => {
  assert.equal(buildUserQueryString({ q: '  root ', role: 'all', status: 'active', page: 2, pageSize: 20 }), 'q=root&status=active&page=2&pageSize=20');
  assert.equal(buildUserQueryString({ role: 'all', status: 'all', page: 1, pageSize: 10 }), '');
  assert.equal(parsePositivePage('3'), 3);
  assert.equal(parsePositivePage('-1'), 1);
});

test('root and current user protection stays consistent for single and bulk actions', () => {
  assert.equal(isProtectedSystemUser({ username: 'admin' }, 'operator1'), true);
  assert.equal(isProtectedSystemUser({ username: 'operator1' }, 'operator1'), true);
  assert.equal(isProtectedSystemUser({ username: 'operator2' }, 'operator1'), false);
  assert.equal(isBulkMutableUser({ username: 'root-user', role: 'root' }, 'operator1'), false);
  assert.equal(isBulkMutableUser({ username: 'operator2', role: 'operator' }, 'operator1'), true);
});

test('permission diff classifies added removed and dangerous downgrades', () => {
  const diff = buildPermissionDiff(
    { user_admin: 'deny', audit_export: 'allow', system_heal: 'approval_required', rating_publish: 'allow' },
    { user_admin: 'allow', audit_export: 'deny', system_heal: 'deny', rating_publish: 'approval_required' },
  );

  assert.deepEqual(diff.map((item) => [item.key, item.category]), [
    ['audit_export', 'removed'],
    ['rating_publish', 'allow_to_approval'],
    ['system_heal', 'approval_to_deny'],
    ['user_admin', 'added'],
  ]);
});
