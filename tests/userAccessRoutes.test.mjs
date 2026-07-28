import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const layoutSource = readFileSync(new URL('../src/app/(dashboard)/layout.tsx', import.meta.url), 'utf8');
const usersSource = readFileSync(new URL('../src/app/(dashboard)/users/page.tsx', import.meta.url), 'utf8');
const rolesSource = readFileSync(new URL('../src/components/users/RoleManagementPanel.tsx', import.meta.url), 'utf8');
const approvalsSource = readFileSync(new URL('../src/components/users/ApprovalCenterPanel.tsx', import.meta.url), 'utf8');

test('user access management routes are present as independent pages', () => {
  assert.equal(existsSync(new URL('../src/app/(dashboard)/users/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/roles/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/approvals/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/audit-logs/page.tsx', import.meta.url)), true);
});

test('sidebar exposes users and permissions group without replacing subscribers', () => {
  assert.match(layoutSource, /nav_user_permissions/);
  assert.match(layoutSource, /nav_system_users/);
  assert.match(layoutSource, /nav_roles/);
  assert.match(layoutSource, /nav_approvals/);
  assert.match(layoutSource, /nav_subscriber/);
});

test('system users page no longer renders role matrix or approval center bodies', () => {
  assert.doesNotMatch(usersSource, /users_perm_title/);
  assert.doesNotMatch(usersSource, /approval_center_title/);
  assert.match(usersSource, /users_detail_tab_permissions/);
});

test('role management and approval center keep backend compatibility boundaries explicit', () => {
  assert.match(rolesSource, /ROLE_CAPABILITIES/);
  assert.match(rolesSource, /roles_no_api/);
  assert.match(approvalsSource, /\/api\/approvals/);
  assert.match(approvalsSource, /approvals_approve_only_unavailable/);
});
