import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tableSource = read('../src/app/(dashboard)/users/components/UsersTable.tsx');
const tableStyles = read('../src/app/(dashboard)/users/components/UsersTable.module.css');
const toolbarStyles = read('../src/app/(dashboard)/users/components/UsersToolbar.module.css');
const userUtilsSource = read('../src/app/(dashboard)/users/utils.ts');
const createSource = read('../src/app/(dashboard)/users/components/UserCreateForm.tsx');
const progressSource = read('../src/app/(dashboard)/users/components/BulkProgressModal.tsx');
const permissionsSource = read('../src/app/(dashboard)/users/components/UserPermissions.tsx');
const rolePageSource = read('../src/app/(dashboard)/roles/page.tsx');
const createRouteSource = read('../src/app/api/auth/users/route.ts');

test('user row actions expose only implemented contextual operations', () => {
  assert.match(tableSource, /startPasswordReset/);
  assert.match(tableSource, /itemStatus === "active" \? "disabled" : "active"/);
  assert.match(tableSource, /document\.addEventListener\("pointerdown"/);
  assert.doesNotMatch(tableSource, /users_force_logout|users_copy_user/);
  assert.match(tableSource, /users_unlock_account/);
  assert.match(tableSource, /canManage/);
});

test('system-user table keeps actions visible and maps every desktop column', () => {
  assert.match(tableSource, /createPortal/);
  assert.match(tableSource, /openMoreMenu/);
  assert.match(tableSource, /document\.body/);
  assert.match(tableSource, /position: "fixed"/);
  assert.match(tableSource, /<colgroup>/);
  assert.match(tableSource, /styles\.actionsColumn/);
  assert.match(tableSource, /styles\.lastLoginCol/);
  assert.doesNotMatch(tableSource, /styles\.createdAtCol/);
  assert.doesNotMatch(tableSource, /users_detail_created_at/);
  assert.match(tableSource, /formatLatestLoginTime\(item\.security\?\.lastLoginAt, item\.lastLoginAt\)/);
  assert.match(userUtilsSource, /export function getLatestLoginAt/);
  assert.match(userUtilsSource, /time > new Date\(latest\)\.getTime\(\)/);
  assert.match(userUtilsSource, /formatDateTime\(latest\)\.slice\(0, 16\)/);
  assert.match(tableStyles, /min-width: 1050px/);
  assert.match(tableStyles, /table-layout: fixed/);
  assert.match(tableStyles, /\.actionsColumn \{ width: 210px; \}/);
  assert.match(tableStyles, /\.actionsCol[\s\S]*text-align: left !important/);
  assert.match(tableStyles, /\.rowActions \{ justify-content: flex-start; \}/);
  assert.match(tableStyles, /\.userPreview \{ display: none; \}/);
  assert.match(tableStyles, /\.userCol[\s\S]*width: 260px/);
  assert.match(tableStyles, /\.moreMenu[\s\S]*z-index: 100/);
  assert.match(toolbarStyles, /text-overflow: ellipsis/);
  assert.match(toolbarStyles, /\.search :global\(\.btn\)[\s\S]*white-space: nowrap/);
  assert.doesNotMatch(toolbarStyles, /min-width: 320px/);
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

test('role details stay within the user drawer and the legacy role page redirects', () => {
  assert.match(permissionsSource, /PERMISSION_CATALOG/);
  assert.match(permissionsSource, /hasPermission/);
  assert.doesNotMatch(permissionsSource, /href="\/roles"/);
  assert.match(rolePageSource, /redirect\("\/users"\)/);
});
