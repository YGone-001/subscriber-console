import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const layoutSource = readFileSync(new URL('../src/app/(dashboard)/components/AppSidebar.tsx', import.meta.url), 'utf8');
const usersSource = readFileSync(new URL('../src/app/(dashboard)/users/page.tsx', import.meta.url), 'utf8');
const usersToolbarSource = readFileSync(new URL('../src/app/(dashboard)/users/components/UsersToolbar.tsx', import.meta.url), 'utf8');
const usersSummarySource = readFileSync(new URL('../src/app/(dashboard)/users/components/UsersSummaryPanel.tsx', import.meta.url), 'utf8');
const rolesSource = readFileSync(new URL('../src/components/users/RoleManagementPanel.tsx', import.meta.url), 'utf8');
const approvalsSource = readFileSync(new URL('../src/components/users/ApprovalCenterPanel.tsx', import.meta.url), 'utf8');

test('user access management routes are present as independent pages', () => {
  assert.equal(existsSync(new URL('../src/app/(dashboard)/users/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/roles/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/approvals/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/audit-logs/page.tsx', import.meta.url)), true);
});

test('sidebar exposes users and permissions group without replacing subscribers', () => {
  const routeRegistrySource = readFileSync(new URL('../src/lib/navigationRoutes.ts', import.meta.url), 'utf8');
  assert.match(layoutSource, /nav_user_permissions/);
  assert.match(routeRegistrySource, /nav_system_users/);
  assert.match(routeRegistrySource, /nav_roles/);
  assert.match(routeRegistrySource, /nav_approvals/);
  assert.match(routeRegistrySource, /nav_subscriber/);
});

test('system users page no longer renders role matrix or approval center bodies', () => {
  assert.doesNotMatch(usersSource, /users_perm_title/);
  assert.doesNotMatch(usersSource, /approval_center_title/);
  assert.match(usersSource, /users_detail_tab_permissions/);
});

test('role management presents the built-in policy without inactive mutation controls', () => {
  assert.match(rolesSource, /ROLE_CAPABILITIES/);
  assert.match(rolesSource, /roles_view_permissions/);
  assert.doesNotMatch(rolesSource, /roles_no_api|roles_copy|roles_builtin_protected|editingRole|buildPermissionDiff/);
});

test('system user directory keeps only high-frequency filters visible', () => {
  assert.match(usersToolbarSource, /users_search_ph/);
  assert.match(usersToolbarSource, /users_filter_all_roles/);
  assert.match(usersToolbarSource, /users_filter_all_statuses/);
  assert.doesNotMatch(usersToolbarSource, /users_more_filters|users_export|RefreshCw|SlidersHorizontal/);
  assert.doesNotMatch(usersSummarySource, /users_pending_approval/);
});

test('approval center remains backed by its dedicated API', () => {
  assert.match(approvalsSource, /\/api\/approvals/);
  assert.match(approvalsSource, /approvals_approve_only_unavailable/);
});
