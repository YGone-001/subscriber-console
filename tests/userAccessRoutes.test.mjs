import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const layoutSource = readFileSync(new URL('../src/app/(dashboard)/components/AppSidebar.tsx', import.meta.url), 'utf8');
const usersSource = readFileSync(new URL('../src/app/(dashboard)/users/page.tsx', import.meta.url), 'utf8');
const usersToolbarSource = readFileSync(new URL('../src/app/(dashboard)/users/components/UsersToolbar.tsx', import.meta.url), 'utf8');
const usersSummarySource = readFileSync(new URL('../src/app/(dashboard)/users/components/UsersSummaryPanel.tsx', import.meta.url), 'utf8');
const usersTableSource = readFileSync(new URL('../src/app/(dashboard)/users/components/UsersTable.tsx', import.meta.url), 'utf8');
const usersBulkActionSource = readFileSync(new URL('../src/app/(dashboard)/users/components/BulkActionBar.tsx', import.meta.url), 'utf8');
const userDrawerSource = readFileSync(new URL('../src/app/(dashboard)/users/components/UserDrawer.tsx', import.meta.url), 'utf8');
const approvalsSource = readFileSync(new URL('../src/components/users/ApprovalCenterPanel.tsx', import.meta.url), 'utf8');
const approvalsRouteSource = readFileSync(new URL('../src/app/api/approvals/route.ts', import.meta.url), 'utf8');
const approvalAuditRouteSource = readFileSync(new URL('../src/app/api/approvals/[id]/audit/route.ts', import.meta.url), 'utf8');
const approvalExecutorSource = readFileSync(new URL('../src/server/approvalExecutors.ts', import.meta.url), 'utf8');
const approvalReviewRouteSource = readFileSync(new URL('../src/app/api/approvals/[id]/route.ts', import.meta.url), 'utf8');
const rolePageSource = readFileSync(new URL('../src/app/(dashboard)/roles/page.tsx', import.meta.url), 'utf8');
const userRouteSource = readFileSync(new URL('../src/app/api/auth/users/[username]/route.ts', import.meta.url), 'utf8');

test('user access management routes are present as independent pages', () => {
  assert.equal(existsSync(new URL('../src/app/(dashboard)/users/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/roles/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/approvals/page.tsx', import.meta.url)), true);
  assert.equal(existsSync(new URL('../src/app/(dashboard)/audit-logs/page.tsx', import.meta.url)), true);
});

test('sidebar separates operations governance from system settings without replacing subscribers', () => {
  const routeRegistrySource = readFileSync(new URL('../src/lib/navigationRoutes.ts', import.meta.url), 'utf8');
  assert.match(layoutSource, /nav_operations_governance/);
  assert.match(layoutSource, /nav_system_settings/);
  assert.match(routeRegistrySource, /nav_system_users/);
  assert.doesNotMatch(routeRegistrySource, /nav_roles/);
  assert.match(routeRegistrySource, /nav_approvals/);
  assert.match(routeRegistrySource, /nav_subscriber/);
});

test('legacy role route redirects to system users instead of exposing a standalone page', () => {
  assert.match(rolePageSource, /redirect\("\/users"\)/);
  assert.doesNotMatch(rolePageSource, /RoleManagementPanel/);
});

test('system users page no longer renders role matrix or approval center bodies', () => {
  assert.doesNotMatch(usersSource, /users_perm_title/);
  assert.doesNotMatch(usersSource, /approval_center_title/);
  assert.match(userDrawerSource, /UserPermissions/);
});

test('system user directory keeps only high-frequency filters visible', () => {
  assert.match(usersToolbarSource, /users_search_ph/);
  assert.match(usersToolbarSource, /users_filter_all_roles/);
  assert.match(usersToolbarSource, /users_filter_all_statuses/);
  assert.doesNotMatch(usersToolbarSource, /users_more_filters|users_export|RefreshCw|SlidersHorizontal/);
  assert.doesNotMatch(usersSummarySource, /users_pending_approval/);
});

test('system user table keeps scan-critical columns and hides secondary actions in overflow', () => {
  assert.match(usersTableSource, /users_col_user/);
  assert.match(usersTableSource, /users_role/);
  assert.match(usersTableSource, /users_status/);
  assert.match(usersTableSource, /users_last_login/);
  assert.doesNotMatch(usersTableSource, /users_contact|users_detail_created_by|users_force_logout|users_unlock_account|users_copy_user/);
  assert.match(usersBulkActionSource, /users_bulk_export/);
  assert.match(usersTableSource, /users_more_actions/);
  assert.doesNotMatch(`${usersTableSource}\n${usersBulkActionSource}`, /users_bulk_delete|Trash2|handleDelete/);
  assert.match(usersTableSource, /colSpan=\{6\}/);
});

test('system user deletion is retired and the compatibility endpoint preserves identity history', () => {
  assert.doesNotMatch(userRouteSource, /deleteUser|deleteOne|logAudit\('DELETE'/);
  assert.match(userRouteSource, /updateUser\(username, \{ status: 'disabled' \}\)/);
  assert.match(userRouteSource, /account history was preserved/);
});

test('approval center keeps the review queue focused and supports safe self-service access requests', () => {
  assert.match(approvalsSource, /\/api\/approvals/);
  assert.match(approvalsSource, /access_request_submit/);
  assert.match(approvalsSource, /access_request_pending/);
  assert.doesNotMatch(approvalsSource, /approvals_approve_only_unavailable/);
  assert.doesNotMatch(approvalsSource, /setRequester|setAction|setStatus|setRisk|setFrom|setTo/);
});

test('self-service access requests are viewer-only, deduplicated, approved by Root, and audited', () => {
  assert.match(approvalsRouteSource, /export async function POST/);
  assert.match(approvalsRouteSource, /user\.role !== 'viewer'/);
  assert.match(approvalsRouteSource, /getPendingAccessRequest/);
  assert.match(approvalsRouteSource, /requestedRole: 'operator'/);
  assert.match(approvalExecutorSource, /approval\.action === 'ACCESS_REQUEST'/);
  assert.match(approvalExecutorSource, /currentUser\.role !== 'viewer'/);
  assert.match(approvalExecutorSource, /updateUser\(currentUser\.username, \{ role: 'operator' \}\)/);
  assert.match(approvalExecutorSource, /logAudit/);
});

test('approval audit trails are available to the requester without widening the audit log boundary', () => {
  assert.match(approvalAuditRouteSource, /requireAuth/);
  assert.match(approvalAuditRouteSource, /auth\.auth\.role !== 'root' && approval\.requester !== auth\.auth\.user/);
  assert.doesNotMatch(approvalAuditRouteSource, /requireCapability\(request, 'user_admin'\)/);
  assert.match(approvalAuditRouteSource, /listAuditLogsForApproval/);
});

test('change review uses independent capabilities and explicitly blocks self-review', () => {
  assert.match(approvalReviewRouteSource, /requireCapability\(request, 'approval_review'\)/);
  assert.match(approvalReviewRouteSource, /requireCapability\(request, 'approval_execute'\)/);
  assert.match(approvalReviewRouteSource, /approval\.requester === auth\.auth\.user/);
  assert.doesNotMatch(approvalReviewRouteSource, /requireCapability\(request, 'user_admin'\)/);
});
