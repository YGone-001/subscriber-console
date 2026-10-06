/*
 * User management surface contract.
 *
 * Covers the acceptance points for the user detail and creation surfaces: the
 * three access states render their own badge, the management policy refuses the
 * self and protected-account operations the server also refuses, the password
 * policy rejects weak input, and both pages offer an unsaved-changes prompt
 * instead of silently dropping edits.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/providers/I18nProvider';
import { RoleBadge } from '../src/components/iam/RoleBadge';
import { StatusBadge } from '../src/components/iam/StatusBadge';
import { UnsavedChangesDialog } from '../src/components/ui/UnsavedChangesGuard';
import { isPasswordStrong } from '../src/lib/security';
import { userManagementActions, assignableRoles, type ManagementActor } from '../src/lib/userManagementPolicy';
import { isBulkMutableUser, isProtectedSystemUser } from '../src/lib/userAccessManagement';
import { normalizeRole, normalizeStatus, displayValue, formatDateTime } from '../src/features/users/utils';

function render(element: ReactElement): string {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => { calls += 1; throw new Error('a presentational surface must not call fetch'); }) as typeof fetch;
  try {
    const markup = renderToStaticMarkup(createElement(I18nProvider, null, element));
    assert.equal(calls, 0, 'rendering must not perform any network access');
    return markup;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const ADMIN_ACTOR: ManagementActor = { username: 'admin', role: 'admin', status: 'active' };
const OPERATOR_ACTOR: ManagementActor = { username: 'ops', role: 'operator', status: 'active' };
const VIEWER_ACTOR: ManagementActor = { username: 'viewer', role: 'viewer', status: 'active' };

/* ------------------------------------------------------- access states -- */

test('the three access states each render their own status label', () => {
  const active = render(createElement(StatusBadge, { status: 'active' }));
  assert.match(active, /已启用|Enabled/, 'active must read as enabled');
  assert.match(active, /iam-module__[a-zA-Z0-9_-]*success|badge/);

  const disabled = render(createElement(StatusBadge, { status: 'disabled' }));
  assert.match(disabled, /已停用|Disabled/);

  const locked = render(createElement(StatusBadge, { status: 'locked', locked: true }));
  assert.match(locked, /已锁定|Locked/);

  assert.notEqual(active, disabled);
  assert.notEqual(disabled, locked);
});

test('a locked account is driven by the locked flag, matching the server contract', () => {
  /* The list payload reports `status` plus a separate `locked` boolean; the badge
   * must follow the boolean, which is what the server sets for a locked account. */
  const withFlag = render(createElement(StatusBadge, { status: 'locked', locked: true }));
  const withoutFlag = render(createElement(StatusBadge, { status: 'locked' }));
  assert.match(withFlag, /已锁定|Locked/);
  assert.doesNotMatch(withoutFlag, /已锁定|Locked/);
});

test('role badges render the canonical three-role vocabulary', () => {
  assert.match(render(createElement(RoleBadge, { role: 'admin' })), /管理员|Admin/);
  assert.match(render(createElement(RoleBadge, { role: 'operator' })), /操作员|Operator/);
  assert.match(render(createElement(RoleBadge, { role: 'viewer' })), /查看员|Viewer/);
});

test('a historical role still renders through its canonical mapping', () => {
  assert.match(render(createElement(RoleBadge, { role: 'root' })), /管理员|Admin/);
  assert.match(render(createElement(RoleBadge, { role: 'auditor' })), /查看员|Viewer/);
});

/* ------------------------------------------- last-administrator protection -- */

test('an administrator can never disable, lock or re-role their own account', () => {
  const selfActions = userManagementActions(ADMIN_ACTOR, { username: 'admin', role: 'admin' });
  for (const operation of ['disable', 'lock', 'role.change', 'delete'] as const) {
    assert.ok(!selfActions.includes(operation), `self ${operation} must not be offered`);
  }
  assert.ok(selfActions.includes('password.reset'), 'self password reset stays available');
  assert.ok(selfActions.includes('update'), 'self profile update stays available');
});

test('the protected administrator account is never bulk-mutable', () => {
  assert.equal(isProtectedSystemUser({ username: 'admin' }, 'someone'), true);
  assert.equal(isProtectedSystemUser({ username: 'someone' }, 'someone'), true);
  assert.equal(isProtectedSystemUser({ username: 'other' }, 'someone'), false);

  assert.equal(isBulkMutableUser({ username: 'admin', role: 'admin' }, 'ops'), false, 'the built-in admin is protected');
  assert.equal(isBulkMutableUser({ username: 'ops', role: 'admin' }, 'ops'), false, 'the acting administrator is protected');
  assert.equal(isBulkMutableUser({ username: 'target', role: 'admin' }, 'ops'), false, 'any administrator is protected');
  assert.equal(isBulkMutableUser({ username: 'target', role: 'operator' }, 'ops'), true);
  assert.equal(isBulkMutableUser({ username: 'target', role: 'viewer' }, 'ops'), true);
});

test('the offered operations follow the actor capability, not just the target', () => {
  const target = { username: 'target', role: 'operator' };
  const adminActions = userManagementActions(ADMIN_ACTOR, target);
  const operatorActions = userManagementActions(OPERATOR_ACTOR, target);
  const viewerActions = userManagementActions(VIEWER_ACTOR, target);

  assert.ok(adminActions.includes('disable'));
  assert.ok(adminActions.includes('lock'));
  assert.ok(adminActions.includes('role.change'));

  assert.ok(!operatorActions.includes('role.change'), 'an operator may not change roles');
  assert.ok(!operatorActions.includes('password.reset'), 'an operator may not reset passwords');

  assert.deepEqual(viewerActions, [], 'a viewer is offered no management operation at all');
});

test('only an administrator may assign roles, and only from the canonical set', () => {
  assert.deepEqual(assignableRoles(ADMIN_ACTOR), ['admin', 'operator', 'viewer']);
  assert.deepEqual(assignableRoles(OPERATOR_ACTOR), []);
  assert.deepEqual(assignableRoles(VIEWER_ACTOR), []);
});

/* ------------------------------------------------------ password policy -- */

test('the password policy rejects short, over-long and username-bearing input', () => {
  assert.equal(isPasswordStrong('Str0ng!pass', 'jdoe'), true);
  assert.equal(isPasswordStrong('short1!', 'jdoe'), false, 'fewer than 8 characters');
  assert.equal(isPasswordStrong('   a1!   ', 'jdoe'), false, 'whitespace is trimmed before counting');
  assert.equal(isPasswordStrong('jdoe-Secret1!', 'jdoe'), false, 'must not contain the username');
  assert.equal(isPasswordStrong('JDOE-Secret1!', 'jdoe'), false, 'the username check is case-insensitive');
  assert.equal(isPasswordStrong('a'.repeat(80) + '1!', 'jdoe'), false, 'over 72 UTF-8 bytes');
  assert.equal(isPasswordStrong(undefined, 'jdoe'), false, 'a missing password is not strong');
  assert.equal(isPasswordStrong(12345678, 'jdoe'), false, 'a non-string is not strong');
});

/* ------------------------------------------------- unsaved changes guard -- */

test('the unsaved-changes prompt offers keep-editing and discard, and renders nothing when closed', () => {
  const labels = {
    title: 'Discard unsaved changes?',
    description: 'Your edits have not been saved.',
    keepEditingLabel: 'Keep editing',
    discardLabel: 'Discard changes',
  };
  const open = render(createElement(UnsavedChangesDialog, {
    open: true, ...labels, onKeepEditing: () => {}, onDiscard: () => {},
  }));
  assert.match(open, /role="alertdialog"/);
  assert.match(open, /aria-modal="true"/);
  assert.match(open, /Keep editing/);
  assert.match(open, /Discard changes/);

  const closed = render(createElement(UnsavedChangesDialog, {
    open: false, ...labels, onKeepEditing: () => {}, onDiscard: () => {},
  }));
  assert.equal(closed, '', 'a closed prompt renders nothing');
});

test('both management surfaces wire the unsaved-changes guard', () => {
  const root = resolve(import.meta.dirname, '..', 'src', 'features', 'users');
  for (const file of ['UserDetailPage.tsx', 'UserCreatePage.tsx']) {
    const source = readFileSync(resolve(root, file), 'utf8');
    assert.match(source, /useUnsavedChangesGuard\(/, `${file} must guard unsaved edits`);
    assert.match(source, /<UnsavedChangesDialog/, `${file} must render the prompt`);
  }
});

/* ------------------------------------------------ restored presentation -- */

test('the creation surface no longer reuses the login card or hard-coded copy', () => {
  const root = resolve(import.meta.dirname, '..', 'src', 'features', 'users');
  const create = readFileSync(resolve(root, 'UserCreatePage.tsx'), 'utf8');
  const detail = readFileSync(resolve(root, 'UserDetailPage.tsx'), 'utf8');

  assert.doesNotMatch(create, /login-card/, 'the login card must not be reused as a form shell');
  assert.match(create, /styles\.createFormNarrow/, 'the reference form shell must be used');

  /* User-visible copy must come from the dictionary, not from string literals. */
  for (const [file, source] of [['UserCreatePage.tsx', create], ['UserDetailPage.tsx', detail]] as const) {
    const jsxText = source.match(/>[^<>{}\n]*[A-Za-z]{3,}[^<>{}\n]*</g) ?? [];
    const english = jsxText.filter((chunk) => !chunk.includes('IMSI') && !chunk.includes('OK'));
    assert.deepEqual(english, [], `${file} still contains hard-coded English copy: ${english.join(' | ')}`);
  }
});

test('the detail surface keeps the structured sections and the canonical role options', () => {
  const root = resolve(import.meta.dirname, '..', 'src', 'features', 'users');
  const detail = readFileSync(resolve(root, 'UserDetailPage.tsx'), 'utf8');
  for (const key of ['users_form_basic', 'users_form_role', 'users_security_state']) {
    assert.ok(detail.includes(key), `the detail surface must keep the ${key} section`);
  }
  assert.match(detail, /normalizedRole/, 'the server-normalised role must drive the role field');
  assert.match(detail, /assignableRoles/, 'the assignable role set must come from the response');
  assert.match(detail, /userManagementActions/, 'the action set must come from the shared policy');
});

/* ---------------------------------------------------------- value helpers -- */

test('role and status normalisation keep unknown input from reaching a badge', () => {
  assert.equal(normalizeRole('root'), 'admin');
  assert.equal(normalizeRole('ops_admin'), 'operator');
  assert.throws(() => normalizeRole('not_a_role'), /UNKNOWN_ROLE/);
  assert.equal(normalizeStatus('locked'), 'locked');
  assert.equal(normalizeStatus(undefined), 'active');
  assert.equal(normalizeStatus('nonsense'), 'active');
});

test('empty profile fields render as a placeholder rather than a blank input', () => {
  assert.equal(displayValue(undefined), '—');
  assert.equal(displayValue('   '), '—');
  assert.equal(displayValue('Operator One'), 'Operator One');
  assert.equal(formatDateTime(undefined), '—');
  assert.equal(formatDateTime('not-a-date'), '—');
  assert.match(formatDateTime('2026-10-06T04:22:32.621Z'), /^2026-10-06 \d{2}:\d{2}:\d{2}$/);
});
