import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadModule } from './helpers/loadModule.mjs';
import * as permissions from '../src/lib/permissions.ts';
import * as security from '../src/lib/security.ts';
import * as iam from '../src/types/iam.ts';
import bcrypt from 'bcryptjs';

function routeHarness() {
  const records = [];
  const users = new Map([['admin', { username: 'admin', role: 'root', status: 'active' }]]);
  const response = { NextResponse: { json: (body, init) => Response.json(body, init) } };
  const policy = loadModule('src/lib/userManagementPolicy.ts', { '@/lib/permissions': permissions });
  const query = loadModule('src/lib/userQuery.ts', { '@/lib/permissions': permissions, '@/lib/userManagementPolicy': policy });
  const guards = loadModule('src/lib/authz.ts', { 'next/server': response, '@/lib/permissions': permissions, '@/lib/audit': { scheduleAuditLog: (event) => records.push(event) }, '@/lib/audit/record': { auditRequestContext: () => ({}) } });
  const repo = {
    getUser: async (username) => users.get(username) ?? null,
    getSafeUser: async (username) => users.get(username) ?? null,
    safeUser: ({ passwordHash, ...user }) => { void passwordHash; return user; },
    async createUser(user, authorize) { await authorize(); users.set(user.username, user); return user; },
    async updateUser(username, updates, authorize) {
      const existing = users.get(username);
      if (!existing) return null;
      await authorize(existing);
      const next = { ...existing, ...updates };
      users.set(username, next);
      return { existing, next };
    },
  };
  const account = loadModule('src/lib/accountSession.ts', { '@/lib/permissions': permissions, '@/server/repositories/userRepository': repo });
  const service = loadModule('src/server/userManagement.ts', { 'next/server': response, '@/lib/audit': { writeAuditLog: async (event) => records.push(event) }, '@/lib/audit/record': { auditRequestContext: () => ({}) }, '@/lib/authz': guards, '@/lib/accountSession': account, '@/lib/userManagementPolicy': policy });
  const dependencies = { 'next/server': response, bcryptjs: bcrypt, '@/lib/authz': guards, '@/lib/rateLimit': { enforceRateLimit: async () => ({ ok: true }) }, '@/lib/security': security, '@/lib/permissions': permissions, '@/lib/userManagementPolicy': policy, '@/lib/userQuery': query, '@/server/repositories/userRepository': repo, '@/server/userManagement': service, '@/types/iam': iam, '@/server/repositories/auditRepository': { listAuditLogsForUser: async () => [] } };
  return { records, users, create: loadModule('src/app/api/auth/users/route.ts', dependencies), target: loadModule('src/app/api/auth/users/[username]/route.ts', dependencies) };
}

test('user route handlers enforce policy and emit create, role, disable, password and denial audit evidence', async () => {
  const h = routeHarness();
  const request = (body, role = 'root') => new Request('http://test/api/users/phase2_test', { method: 'POST', headers: { 'x-user': role === 'root' ? 'admin' : 'readonly', 'x-user-role': role, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const context = { params: Promise.resolve({ username: 'phase2_test' }) };
  const create = await h.create.POST(request({ username: 'phase2_test', displayName: 'Phase 2 test', password: 'Strong-Sample!2026', role: 'operator', email: '' }));
  assert.equal(create.status, 201);
  assert.equal((await h.target.PATCH(request({ role: 'auditor' }), context)).status, 200);
  assert.equal((await h.target.PATCH(request({ status: 'disabled' }), context)).status, 200);
  assert.equal((await h.target.PATCH(request({ password: 'Rotated-Sample!2026' }), context)).status, 200);
  assert.equal((await h.target.PATCH(request({ role: 'root' }, 'viewer'), context)).status, 403);
  const own = await h.target.PATCH(request({ role: 'viewer' }), { params: Promise.resolve({ username: 'admin' }) });
  assert.equal((await own.json()).code, 'SELF_ROLE_CHANGE_FORBIDDEN');
  for (const action of ['user.create', 'user.role.change', 'user.disable', 'user.password.reset']) assert.ok(h.records.some((record) => record.action === action && record.result === 'success'));
  assert.ok(h.records.some((record) => record.result === 'denied'));
  const password = h.records.find((record) => record.action === 'user.password.reset');
  assert.equal(password.before, undefined);
  assert.equal(password.after, undefined);
  assert.equal(password.metadata.passwordReset, true);
  assert.doesNotMatch(JSON.stringify(h.records), /Strong-Sample|Rotated-Sample|passwordHash|\$2[aby]\$/);
});

test('legacy DELETE remains a policy-protected soft disable and forbidden fields are explicit', async () => {
  const h = routeHarness();
  h.users.set('target', { username: 'target', role: 'operator', status: 'active' });
  const req = (body) => new Request('http://test/api/auth/users/target', { method: 'DELETE', headers: { 'x-user': 'admin', 'x-user-role': 'root' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const context = { params: Promise.resolve({ username: 'target' }) };
  assert.equal((await h.target.DELETE(req(), context)).status, 200);
  assert.equal(h.users.get('target').status, 'disabled');
  assert.equal((await h.target.PATCH(req({ security: { sessionVersion: 0 } }), context)).status, 400);
});

const layoutSource = readFileSync(new URL('../src/app/(dashboard)/components/AppSidebar.tsx', import.meta.url), 'utf8');
const usersSource = readFileSync(new URL('../src/app/(dashboard)/users/page.tsx', import.meta.url), 'utf8');
const usersToolbarSource = readFileSync(new URL('../src/app/(dashboard)/users/components/UsersToolbar.tsx', import.meta.url), 'utf8');
const usersSummarySource = readFileSync(new URL('../src/app/(dashboard)/users/components/UsersSummaryPanel.tsx', import.meta.url), 'utf8');
const usersTableSource = readFileSync(new URL('../src/app/(dashboard)/users/components/UsersTable.tsx', import.meta.url), 'utf8');
const usersBulkActionSource = readFileSync(new URL('../src/app/(dashboard)/users/components/BulkActionBar.tsx', import.meta.url), 'utf8');
const userDrawerSource = readFileSync(new URL('../src/app/(dashboard)/users/components/UserDrawer.tsx', import.meta.url), 'utf8');
const userBasicInfoSource = readFileSync(new URL('../src/app/(dashboard)/users/components/UserBasicInfo.tsx', import.meta.url), 'utf8');
const approvalsSource = readFileSync(new URL('../src/components/users/ApprovalCenterPanel.tsx', import.meta.url), 'utf8');
const approvalsRouteSource = readFileSync(new URL('../src/app/api/approvals/route.ts', import.meta.url), 'utf8');
const approvalAuditRouteSource = readFileSync(new URL('../src/app/api/approvals/[id]/audit/route.ts', import.meta.url), 'utf8');
const approvalExecutorSource = readFileSync(new URL('../src/server/approvalExecutors.ts', import.meta.url), 'utf8');
const approvalReviewRouteSource = readFileSync(new URL('../src/app/api/approvals/[id]/route.ts', import.meta.url), 'utf8');
const approvalWorkflowSource = readFileSync(new URL('../src/server/approvalWorkflow.ts', import.meta.url), 'utf8');
const approvalExecutionSource = readFileSync(new URL('../src/server/approvalExecution.ts', import.meta.url), 'utf8');
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

test('system user table keeps scan-critical columns and leaves creation time in user details', () => {
  assert.match(usersTableSource, /users_col_user/);
  assert.match(usersTableSource, /users_role/);
  assert.match(usersTableSource, /users_status/);
  assert.match(usersTableSource, /users_last_login/);
  assert.doesNotMatch(usersTableSource, /users_contact|users_detail_created_by|users_force_logout|users_copy_user/);
  assert.match(usersTableSource, /users_unlock_account/);
  assert.doesNotMatch(usersTableSource, /users_detail_created_at/);
  assert.match(userBasicInfoSource, /users_detail_created_at/);
  assert.match(usersBulkActionSource, /users_bulk_export/);
  assert.match(usersTableSource, /users_more_actions/);
  assert.doesNotMatch(`${usersTableSource}\n${usersBulkActionSource}`, /users_bulk_delete|Trash2|handleDelete/);
  assert.match(usersTableSource, /colSpan=\{6\}/);
});

test('system user deletion is retired and the compatibility endpoint preserves identity history', () => {
  assert.doesNotMatch(userRouteSource, /deleteUser|deleteOne|logAudit\('DELETE'/);
  assert.match(userRouteSource, /deletion \? \{ status: 'disabled' \}/);
  assert.match(userRouteSource, /recheckUserPolicy/);
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

test('approval audit trails use the dedicated approval read boundary', () => {
  assert.match(approvalAuditRouteSource, /requirePermission\(request, 'approvals\.read'\)/);
  assert.doesNotMatch(approvalAuditRouteSource, /requireCapability\(request, 'user_admin'\)/);
  assert.match(approvalAuditRouteSource, /listAuditLogsForApproval/);
});

test('change review and execution use independent permissions and maker-checker policy', () => {
  assert.match(approvalReviewRouteSource, /approvals\.approve/);
  assert.match(approvalWorkflowSource, /requiresIndependentReviewer/);
  assert.match(approvalWorkflowSource, /approval\.requester === actor\.user/);
  assert.match(approvalExecutionSource, /approvalActionEligibility/);
  assert.match(approvalExecutionSource, /nextStatus: 'executing'/);
  assert.doesNotMatch(approvalReviewRouteSource, /requireCapability\(request, 'user_admin'\)/);
});
