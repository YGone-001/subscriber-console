import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tableSource = read('../src/app/(dashboard)/users/components/UsersTable.tsx');
const createSource = read('../src/app/(dashboard)/users/components/UserCreateForm.tsx');
const progressSource = read('../src/app/(dashboard)/users/components/BulkProgressModal.tsx');
const summarySource = read('../src/app/(dashboard)/users/components/UsersSummaryPanel.tsx');
const permissionsSource = read('../src/app/(dashboard)/users/components/UserPermissions.tsx');
const rolesSource = read('../src/components/users/RoleManagementPanel.tsx');
const createRouteSource = read('../src/app/api/auth/users/route.ts');

test('user row actions expose only implemented contextual operations', () => {
  assert.match(tableSource, /startPasswordReset/);
  assert.match(tableSource, /itemStatus === "active" \? "disabled" : "active"/);
  assert.match(tableSource, /document\.addEventListener\("pointerdown"/);
  assert.doesNotMatch(tableSource, /users_force_logout|users_unlock_account|users_copy_user/);
});

test('user creation includes availability, identity, role guidance, and strength feedback', () => {
  assert.match(createSource, /UsernameField/);
  assert.match(createSource, /PasswordStrengthBar/);
  assert.match(createSource, /newForm\.displayName/);
  assert.match(createSource, /newForm\.email/);
  assert.match(createSource, /roles_desc_/);
  assert.match(createRouteSource, /displayName/);
  assert.match(createRouteSource, /email/);
});

test('bulk operations expose per-user progress and cancellation', () => {
  assert.match(progressSource, /role="progressbar"/);
  assert.match(progressSource, /users_bulk_cancel_remaining/);
  assert.match(progressSource, /item\.status === "failed"/);
});

test('users, approvals, and roles provide direct cross-page navigation', () => {
  assert.match(summarySource, /\/approvals\?status=pending/);
  assert.match(permissionsSource, /href="\/roles"/);
  assert.match(rolesSource, /\/users\?role=/);
  assert.match(rolesSource, /encodeURIComponent\(user\.username\)/);
});
