import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';
import * as permissions from '../src/lib/permissions.ts';
import { MongoServerError } from 'mongodb';
import { randomUUID } from 'node:crypto';

const policy = loadModule('src/lib/userManagementPolicy.ts', { '@/lib/permissions': permissions });
const queryHelpers = loadModule('src/lib/userQuery.ts', { '@/lib/permissions': permissions, '@/lib/userManagementPolicy': policy });

test('user pagination validates bounds, whitelists query fields, and escapes regex search', () => {
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'pageSize=no', 'pageSize=101', 'role=god', 'status=unknown', 'sort=$where', 'order=bad', 'page=1&page=2', '$where=x']) {
    assert.throws(() => queryHelpers.parseUserQuery(new URLSearchParams(query)), /INVALID_QUERY/);
  }
  const query = queryHelpers.parseUserQuery(new URLSearchParams('q=.*(?=a)&role=ops_admin&status=locked&pageSize=10'));
  assert.equal(query.pageSize, 10);
  assert.equal(queryHelpers.escapeUserSearch(query.search), '\\.\\*\\(\\?=a\\)');
  const literal = new RegExp(queryHelpers.escapeUserSearch(query.search));
  assert.equal(literal.test('anything'), false);
  assert.equal(literal.test('.*(?=a)'), true);
});

test('user management policy protects self and privileged targets and restricts assignable roles', () => {
  const root = { username: 'admin', role: 'root', status: 'active' };
  for (const [operation, code] of [['disable', 'SELF_DISABLE_FORBIDDEN'], ['delete', 'SELF_DELETE_FORBIDDEN'], ['role.change', 'SELF_ROLE_CHANGE_FORBIDDEN']]) {
    assert.throws(() => policy.checkUserManagementPolicy(root, root, operation, 'viewer'), new RegExp(code));
  }
  const ops = { username: 'ops', role: 'ops_admin', status: 'active' };
  for (const operation of ['update', 'password.reset', 'disable', 'delete', 'lock', 'role.change']) {
    assert.throws(() => policy.checkUserManagementPolicy(ops, root, operation, 'viewer'), /TARGET_ROLE_PROTECTED/);
  }
  for (const role of ['root', 'super_admin', 'ops_admin']) assert.throws(() => policy.checkUserManagementPolicy(ops, null, 'create', role), /ROLE_ASSIGNMENT_FORBIDDEN/);
  assert.deepEqual(Array.from(policy.assignableRoles(ops)), ['operator', 'auditor', 'viewer']);
  for (const role of ['viewer', 'auditor']) assert.throws(() => policy.checkUserManagementPolicy({ ...ops, role }, root, 'update'), /PERMISSION_DENIED/);
  policy.checkUserManagementPolicy(root, { username: 'other', role: 'root' }, 'update');
});

function lifecycleHarness() {
  let held = null;
  const locks = {
    async insertOne(doc) { if (held) throw new MongoServerError({ code: 11000, message: 'duplicate' }); held = doc; },
    async deleteOne(filter) { if (held?.owner === filter.owner) held = null; },
  };
  const lock = loadModule('src/server/userManagementLock.ts', {
    'node:crypto': { randomUUID }, mongodb: { MongoServerError }, '@/lib/mongo': { getAppCollection: async () => locks }, '@/lib/userManagementPolicy': policy,
  });
  const users = new Map(['a', 'b'].map((username) => [username, { username, role: 'root', status: 'active', security: { sessionVersion: 0 } }]));
  const docs = {
    async findOne({ username }) { return structuredClone(users.get(username) ?? null); },
    async countDocuments() { return [...users.values()].filter((u) => permissions.isSuperAdmin(u.role) && u.status === 'active' && !u.locked).length; },
    async findOneAndUpdate({ username }, update) {
      const user = users.get(username);
      for (const [key, value] of Object.entries(update.$set)) {
        if (key.startsWith('security.')) user.security[key.slice(9)] = value;
        else user[key] = value;
      }
      if (update.$inc) user.security.sessionVersion += update.$inc['security.sessionVersion'];
      return structuredClone(user);
    },
  };
  const repo = loadModule('src/server/repositories/userRepository.ts', {
    mongodb: { MongoServerError }, '@/lib/mongo': { getAppCollection: async () => docs, mongoCollections: { users: 'users' } },
    '@/lib/permissions': permissions, '@/lib/userManagementPolicy': policy, '@/server/userManagementLock': lock,
    '@/lib/userQuery': queryHelpers,
  });
  return { repo, docs, lock, held: () => held, users };
}

test('concurrent administrator demotion/disable serializes through a database lock and preserves one active admin', async () => {
  const h = lifecycleHarness();
  const attempts = await Promise.allSettled([h.repo.updateUser('a', { role: 'viewer' }), h.repo.updateUser('b', { status: 'disabled' })]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(await h.docs.countDocuments(), 1);
  assert.equal(h.held(), null);
  const remaining = [...h.users.values()].find((u) => u.role === 'root' && u.status === 'active');
  await assert.rejects(h.repo.updateUser(remaining.username, { status: 'locked' }), /LAST_ACTIVE_ADMIN/);
  assert.equal(await h.docs.countDocuments(), 1);
  const changed = [...h.users.values()].find((u) => u.security.sessionVersion === 1);
  assert.ok(changed);
});

test('ambiguous write outcomes retain the DB lock; business denials safely release it', async () => {
  const h = lifecycleHarness();
  await assert.rejects(h.lock.withUserManagementLock(async () => { throw new policy.UserManagementError('DENIED'); }), /DENIED/);
  assert.equal(h.held(), null);
  await assert.rejects(h.lock.withUserManagementLock(async () => { throw new Error('network failure'); }), /network failure/);
  assert.ok(h.held());
  await assert.rejects(h.repo.updateUser('a', { role: 'viewer' }), /USER_MANAGEMENT_BUSY/);
});

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
