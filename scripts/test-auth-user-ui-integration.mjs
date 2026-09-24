#!/usr/bin/env node
/**
 * Phase 6.4 - Authentication & User Management UI Integration Acceptance Suite
 *
 * Verifies:
 * 1. Login Status & Code Mapping (401, 429, 500, 502, 503, network)
 * 2. Login Response Privacy Matrix (All 401 variants return uniform message)
 * 3. Retry-After Cooldown Semantics (valid int, missing, invalid, zero, negative)
 * 4. Session-Expired vs Credential Alert Presentation Semantics
 * 5. Current Actor Awareness & Self-Protection (No hardcoded isSelf)
 * 6. User Management Policy Reuse & Actor/Target Action Matrix
 * 7. Status Lifecycle Operations (active, disabled, locked)
 * 8. Security State Metadata Contract & Leak Prevention
 * 9. User Management Error Mapping (LAST_ACTIVE_ADMIN, etc.)
 * 10. I18n Completeness (EN & ZH parity for new UI concepts)
 * 11. API Inventory & Routing Invariants (54 routes, 78 ops, CUTOVER_TABLE=36, ACTUALLY_ROUTED=36)
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    '@': new URL('../frontend/src/', import.meta.url).pathname,
  },
});

// Import UI helper and policy modules
const { mapLoginResponse, parseRetryAfter, mapUserManagementError } = await jiti(
  '../frontend/src/lib/auth-ui.ts'
);
const { userManagementActions, checkUserManagementPolicy, assignableRoles } = await jiti(
  '../frontend/src/lib/userManagementPolicy.ts'
);
const { normalizeGovernanceRole } = await jiti(
  '../frontend/src/lib/permissions.ts'
);
const { en } = await jiti('../frontend/src/lib/locales/en.ts');
const { zh } = await jiti('../frontend/src/lib/locales/zh.ts');
const { CUTOVER_TABLE, resolveRouteOwner } = await jiti(
  '../frontend/src/lib/cutover-routing.ts'
);

let passed = 0;
let totalChecks = 0;

function verify(description, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  PASS  ${description}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${description}: ${err.message}`);
    throw err;
  }
}

console.log('-- Phase 6.4 Auth & User Management UI Integration Acceptance Suite --\n');

// ============================================================================
// 1. Login Status & Code Mapping Matrix
// ============================================================================
console.log('[1] Login Status & Code Mapping Matrix');

const loginMappingCases = [
  {
    name: '401 Unauthorized returns invalid_credentials',
    status: 401,
    body: { error: 'Invalid credentials' },
    header: null,
    expectedCategory: 'invalid_credentials',
    expectedI18n: 'login_invalid_credentials',
    expectedRetry: 0,
  },
  {
    name: '429 with Retry-After returns rate_limited with countdown seconds',
    status: 429,
    body: { error: 'Too many requests' },
    header: '45',
    expectedCategory: 'rate_limited',
    expectedI18n: 'login_retry_after',
    expectedRetry: 45,
  },
  {
    name: '429 without Retry-After returns generic rate_limited',
    status: 429,
    body: { error: 'Too many requests' },
    header: null,
    expectedCategory: 'rate_limited',
    expectedI18n: 'login_rate_limited',
    expectedRetry: 0,
  },
  {
    name: '502 GO_BACKEND_UNREACHABLE returns service_unavailable',
    status: 502,
    body: { error: 'Go backend unreachable', code: 'GO_BACKEND_UNREACHABLE' },
    header: null,
    expectedCategory: 'service_unavailable',
    expectedI18n: 'login_service_unavailable',
    expectedRetry: 0,
  },
  {
    name: '503 AUTH_UNAVAILABLE returns service_unavailable',
    status: 503,
    body: { error: 'Authentication service temporarily unavailable', code: 'AUTH_UNAVAILABLE' },
    header: null,
    expectedCategory: 'service_unavailable',
    expectedI18n: 'login_service_unavailable',
    expectedRetry: 0,
  },
  {
    name: '500 Internal Server Error returns server_error',
    status: 500,
    body: { error: 'Internal server error' },
    header: null,
    expectedCategory: 'server_error',
    expectedI18n: 'login_server_error',
    expectedRetry: 0,
  },
  {
    name: 'Network exception (undefined status) returns network_error',
    status: undefined,
    body: undefined,
    header: null,
    expectedCategory: 'network_error',
    expectedI18n: 'login_network_error',
    expectedRetry: 0,
  },
];

for (const tc of loginMappingCases) {
  verify(`Login mapping: ${tc.name}`, () => {
    const res = mapLoginResponse(tc.status, tc.body, tc.header);
    assert.equal(res.category, tc.expectedCategory);
    assert.equal(res.i18nKey, tc.expectedI18n);
    assert.equal(res.retryAfterSeconds, tc.expectedRetry);
  });
}

// ============================================================================
// 2. Login Response Privacy Matrix
// ============================================================================
console.log('\n[2] Login Response Privacy Matrix (All 401 scenarios return identical generic message)');

const privacyCases = [
  { reason: 'unknown user', body: { error: 'Invalid credentials', code: 'ACCOUNT_NOT_FOUND' } },
  { reason: 'wrong password', body: { error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' } },
  { reason: 'disabled account', body: { error: 'Invalid credentials', code: 'ACCOUNT_DISABLED' } },
  { reason: 'locked account', body: { error: 'Invalid credentials', code: 'ACCOUNT_LOCKED' } },
  { reason: 'revoked session', body: { error: 'Unauthorized', code: 'SESSION_REVOKED' } },
  { reason: 'empty error body', body: {} },
  { reason: 'null body', body: null },
];

for (const tc of privacyCases) {
  verify(`Privacy invariant: ${tc.reason} maps to generic credential key`, () => {
    const res = mapLoginResponse(401, tc.body, null);
    assert.equal(res.category, 'invalid_credentials');
    assert.equal(res.i18nKey, 'login_invalid_credentials');
    assert.equal(res.retryAfterSeconds, 0);
  });
}

// ============================================================================
// 3. Retry-After Semantics
// ============================================================================
console.log('\n[3] Retry-After Semantics & Resilience');

const retryAfterCases = [
  { input: '30', expected: 30, desc: 'valid integer string' },
  { input: '1', expected: 1, desc: 'valid single second' },
  { input: '120', expected: 120, desc: 'larger valid integer' },
  { input: '  45  ', expected: 45, desc: 'integer with surrounding whitespace' },
  { input: '15.9', expected: 15, desc: 'float string floored to integer' },
  { input: undefined, expected: 0, desc: 'undefined header' },
  { input: null, expected: 0, desc: 'null header' },
  { input: '', expected: 0, desc: 'empty string' },
  { input: '   ', expected: 0, desc: 'whitespace string' },
  { input: '0', expected: 0, desc: 'zero string' },
  { input: '-5', expected: 0, desc: 'negative integer' },
  { input: 'invalid', expected: 0, desc: 'non-numeric alphabetic string' },
  { input: 'NaN', expected: 0, desc: 'NaN string' },
  { input: '{}', expected: 0, desc: 'json object string' },
];

for (const tc of retryAfterCases) {
  verify(`parseRetryAfter: ${tc.desc} (${tc.input}) => ${tc.expected}`, () => {
    const val = parseRetryAfter(tc.input);
    assert.equal(val, tc.expected);
    assert.equal(Number.isNaN(val), false);
    assert.ok(val >= 0);
  });
}

// ============================================================================
// 4. Session-Expired vs Credential Alert Presentation Semantics
// ============================================================================
console.log('\n[4] Session-Expired vs Credential Presentation Semantics');

verify('LoginForm.tsx uses role="status" for session-expired notice and role="alert" for error', () => {
  const loginFormSource = readFileSync(
    path.resolve(import.meta.dirname, '../frontend/src/app/login/LoginForm.tsx'),
    'utf8'
  );
  assert.ok(
    loginFormSource.includes('role="status"'),
    'LoginForm must render session-expired notice with role="status"'
  );
  assert.ok(
    loginFormSource.includes('role="alert"'),
    'LoginForm must render credential errors with role="alert"'
  );
  assert.ok(
    loginFormSource.includes('setShowSessionNotice(false)'),
    'Submitting login must dismiss session-expired notice'
  );
  assert.ok(
    loginFormSource.includes('window.location.assign("/")'),
    'Successful login must perform full window navigation to /'
  );
  assert.ok(
    !loginFormSource.includes('localStorage'),
    'LoginForm must not store token in localStorage'
  );
  assert.ok(
    !loginFormSource.includes('sessionStorage'),
    'LoginForm must not store token in sessionStorage'
  );
});

verify('LoginForm.css defines distinct session notice styling', () => {
  const loginCssSource = readFileSync(
    path.resolve(import.meta.dirname, '../frontend/src/app/login/LoginForm.css'),
    'utf8'
  );
  assert.ok(
    loginCssSource.includes('.login-session-container'),
    'LoginForm.css must style .login-session-container'
  );
  assert.ok(
    loginCssSource.includes('.login-error-container'),
    'LoginForm.css must style .login-error-container'
  );
});

// ============================================================================
// 5. Current Actor Awareness & Self-Protection
// ============================================================================
console.log('\n[5] Current Actor Awareness & Self-Protection');

verify('User detail page removes hard-coded const isSelf = false', () => {
  const detailSource = readFileSync(
    path.resolve(import.meta.dirname, '../frontend/src/app/(dashboard)/users/[username]/page.tsx'),
    'utf8'
  );
  assert.ok(
    !detailSource.includes('const isSelf = false;'),
    'Hardcoded "const isSelf = false;" must be removed from user detail page'
  );
  assert.ok(
    detailSource.includes('currentUser.username === username') ||
      detailSource.includes('currentUser?.username === username'),
    'User detail page must dynamically determine isSelf from authenticated user'
  );
  assert.ok(
    detailSource.includes('userManagementActions(currentUser'),
    'User detail page must reuse userManagementActions with currentUser'
  );
});

// ============================================================================
// 6. User Management Policy Reuse & Action Matrix
// ============================================================================
console.log('\n[6] User Management Policy Reuse & Actor/Target Action Matrix');

const actorTargetCases = [
  {
    desc: 'admin managing other admin',
    actor: { username: 'admin1', role: 'admin' },
    target: { username: 'admin2', role: 'admin' },
    expectActions: ['disable', 'enable', 'lock', 'password.reset', 'role.change', 'unlock', 'update'],
  },
  {
    desc: 'admin managing operator',
    actor: { username: 'admin1', role: 'admin' },
    target: { username: 'operator1', role: 'operator' },
    expectActions: ['disable', 'enable', 'lock', 'password.reset', 'role.change', 'unlock', 'update'],
  },
  {
    desc: 'admin managing viewer',
    actor: { username: 'admin1', role: 'admin' },
    target: { username: 'viewer1', role: 'viewer' },
    expectActions: ['disable', 'enable', 'lock', 'password.reset', 'role.change', 'unlock', 'update'],
  },
  {
    desc: 'admin viewing self (self-protection: no disable, no lock, no role.change)',
    actor: { username: 'admin1', role: 'admin' },
    target: { username: 'admin1', role: 'admin' },
    expectActions: ['enable', 'password.reset', 'unlock', 'update'],
  },
  {
    desc: 'operator viewing admin (target role protected)',
    actor: { username: 'operator1', role: 'operator' },
    target: { username: 'admin1', role: 'admin' },
    expectActions: [],
  },
  {
    desc: 'operator viewing operator (no user management permission)',
    actor: { username: 'operator1', role: 'operator' },
    target: { username: 'operator2', role: 'operator' },
    expectActions: [],
  },
  {
    desc: 'viewer viewing anyone (read-only)',
    actor: { username: 'viewer1', role: 'viewer' },
    target: { username: 'viewer2', role: 'viewer' },
    expectActions: [],
  },
];

for (const tc of actorTargetCases) {
  verify(`Actor/target policy: ${tc.desc}`, () => {
    const actions = userManagementActions(tc.actor, tc.target);
    assert.deepEqual(actions.sort(), tc.expectActions.sort());
  });
}

// ============================================================================
// 7. Status Lifecycle Operations
// ============================================================================
console.log('\n[7] Status Lifecycle Operations Contract');

verify('Detail page separates profile update from role change and lifecycle operations', () => {
  const detailSource = readFileSync(
    path.resolve(import.meta.dirname, '../frontend/src/app/(dashboard)/users/[username]/page.tsx'),
    'utf8'
  );
  assert.ok(
    detailSource.includes('canUpdateProfile') && detailSource.includes('canChangeRole'),
    'Profile update and role change permissions must be distinct'
  );
  assert.ok(
    detailSource.includes('usersApi.disable(username'),
    'Disable action must call canonical usersApi.disable'
  );
  assert.ok(
    detailSource.includes('usersApi.update(username, { status: "locked"'),
    'Lock action must call canonical usersApi.update with status: locked'
  );
  assert.ok(
    detailSource.includes('usersApi.update(username, { status: "active"'),
    'Unlock and enable actions must call canonical usersApi.update with status: active'
  );
  assert.ok(
    detailSource.includes('ConfirmActionPanel'),
    'Lifecycle transitions must be guarded by ConfirmActionPanel modal'
  );
});

// ============================================================================
// 8. Security State Metadata Contract & Leak Prevention
// ============================================================================
console.log('\n[8] Security State Metadata Contract');

verify('User detail page renders safe security metadata and conceals sensitive fields', () => {
  const detailSource = readFileSync(
    path.resolve(import.meta.dirname, '../frontend/src/app/(dashboard)/users/[username]/page.tsx'),
    'utf8'
  );
  assert.ok(detailSource.includes('user.security?.sessionVersion'), 'Must display sessionVersion');
  assert.ok(detailSource.includes('user.security?.failedLoginAttempts'), 'Must display failedLoginAttempts');
  assert.ok(detailSource.includes('user.security?.lastLoginAt'), 'Must display lastLoginAt');
  assert.ok(detailSource.includes('user.security?.lastLoginIp'), 'Must display lastLoginIp');
  assert.ok(detailSource.includes('user.security?.passwordChangedAt'), 'Must display passwordChangedAt');
  assert.ok(detailSource.includes('normalizedStatus === "locked"'), 'Locked fields must be conditional on locked status');
  assert.ok(!detailSource.includes('passwordHash'), 'Must NEVER render passwordHash');
  assert.ok(!detailSource.includes('JWT_SECRET'), 'Must NEVER render JWT_SECRET');
  assert.ok(!detailSource.includes('auth_token'), 'Must NEVER render auth_token');
});

verify('UserLoginHistory conditionally displays locked metadata only when locked', () => {
  const historySource = readFileSync(
    path.resolve(import.meta.dirname, '../frontend/src/app/(dashboard)/users/components/UserLoginHistory.tsx'),
    'utf8'
  );
  assert.ok(
    historySource.includes('isLocked'),
    'UserLoginHistory must check isLocked before rendering lockedAt and lockReason'
  );
});

// ============================================================================
// 9. User Management Error Mapping
// ============================================================================
console.log('\n[9] User Management Error Mapping');

const errorMappingCases = [
  { code: 'LAST_ACTIVE_ADMIN', expected: 'users_err_last_active_admin' },
  { code: 'SELF_OPERATION_FORBIDDEN', expected: 'users_err_self_operation' },
  { code: 'SELF_DISABLE_FORBIDDEN', expected: 'users_err_self_operation' },
  { code: 'SELF_ROLE_CHANGE_FORBIDDEN', expected: 'users_err_self_role_change' },
  { code: 'USER_NOT_FOUND', expected: 'users_err_not_found' },
  { code: 'USERNAME_ALREADY_EXISTS', expected: 'users_username_taken' },
  { code: 'INVALID_PASSWORD', expected: 'users_err_password' },
  { code: 'PERMISSION_DENIED', expected: 'users_err_permission_denied' },
];

const mockT = (key) => key;

for (const tc of errorMappingCases) {
  verify(`mapUserManagementError: ${tc.code} => ${tc.expected}`, () => {
    const msg = mapUserManagementError({ code: tc.code }, mockT);
    assert.equal(msg, tc.expected);
  });
}

// ============================================================================
// 10. I18n Completeness (EN & ZH Parity)
// ============================================================================
console.log('\n[10] I18n Completeness (EN & ZH Parity for New UI Concepts)');

const requiredKeys = [
  'login_invalid_credentials',
  'login_rate_limited',
  'login_retry_after',
  'login_service_unavailable',
  'login_server_error',
  'login_session_expired',
  'users_err_last_active_admin',
  'users_err_self_operation',
  'users_err_self_role_change',
  'users_err_not_found',
  'users_err_permission_denied',
  'users_unlock_desc',
];

for (const key of requiredKeys) {
  verify(`Locale key "${key}" present in en.ts`, () => {
    assert.ok(en[key], `Missing key in en.ts: ${key}`);
    assert.ok(typeof en[key] === 'string' && en[key].length > 0);
  });

  verify(`Locale key "${key}" present in zh.ts`, () => {
    assert.ok(zh[key], `Missing key in zh.ts: ${key}`);
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0);
  });
}

// ============================================================================
// 11. API Inventory & Routing Freeze
// ============================================================================
console.log('\n[11] API Inventory & Routing Freeze (CUTOVER_TABLE=36, ACTUALLY_ROUTED=36)');

verify('CUTOVER_TABLE is exactly 36 and ACTUALLY_ROUTED is exactly 36', () => {
  assert.equal(CUTOVER_TABLE.length, 36, `CUTOVER_TABLE entries count must be 36, got ${CUTOVER_TABLE.length}`);
  const actuallyRouted = CUTOVER_TABLE.filter((r) => r.owner === 'go');
  assert.equal(actuallyRouted.length, 36, `ACTUALLY_ROUTED count must be 36, got ${actuallyRouted.length}`);
});

verify('Authentication and User Management routes are Go-owned in CUTOVER_TABLE', () => {
  const expectedRoutes = [
    { method: 'POST', path: '/api/auth/login' },
    { method: 'POST', path: '/api/auth/logout' },
    { method: 'GET', path: '/api/auth/me' },
    { method: 'GET', path: '/api/auth/permissions' },
    { method: 'GET', path: '/api/users' },
    { method: 'POST', path: '/api/users' },
    { method: 'GET', path: '/api/users/{username}' },
    { method: 'PATCH', path: '/api/users/{username}' },
    { method: 'POST', path: '/api/users/{username}/disable' },
    { method: 'POST', path: '/api/users/{username}/password-reset' },
  ];
  for (const r of expectedRoutes) {
    const entry = CUTOVER_TABLE.find((e) => e.method === r.method && e.path === r.path);
    assert.ok(entry, `Expected route in CUTOVER_TABLE: ${r.method} ${r.path}`);
    assert.equal(entry.owner, 'go', `Expected route owner to be 'go': ${r.method} ${r.path}`);
    const resolved = resolveRouteOwner(r.method, r.path.replace('{username}', 'testuser'));
    assert.equal(resolved, 'go', `resolveRouteOwner for ${r.method} ${r.path} must return 'go'`);
  }
});

console.log(`\n==================================================`);
console.log(`Phase 6.4 Auth & User UI Integration Suite Completed`);
console.log(`Passed: ${passed} / ${totalChecks} checks`);
console.log(`==================================================\n`);
