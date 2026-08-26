import test from 'node:test';
import assert from 'node:assert/strict';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE, getJwtSecretKey } from '../src/lib/security.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';

const jiti = createJiti(import.meta.url, { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } });
const { validateAccountSnapshot } = await jiti.import('../src/lib/accountSession.ts');

test('current-account validation supports legacy sessions and rejects revoked or invalid identities', () => {
  const account = { username: 'admin', role: 'root', status: 'active' };
  const claims = { username: 'admin', role: 'root' };
  assert.equal(validateAccountSnapshot(claims, account).sessionVersion, 0);
  assert.equal(validateAccountSnapshot({ ...claims, sv: 0 }, { ...account, security: { sessionVersion: 0 } }).normalizedRole, 'super_admin');
  assert.equal(validateAccountSnapshot({ ...claims, role: 'super_admin' }, account).role, 'root');
  for (const sv of [undefined, 0]) assert.throws(() => validateAccountSnapshot({ ...claims, sv }, { ...account, security: { sessionVersion: 1 } }), /SESSION_REVOKED/);
  for (const [patch, code] of [[{ status: 'disabled' }, 'ACCOUNT_DISABLED'], [{ status: 'locked' }, 'ACCOUNT_LOCKED'], [{ locked: true }, 'ACCOUNT_LOCKED'], [{ role: 'viewer' }, 'SESSION_REVOKED']]) {
    assert.throws(() => validateAccountSnapshot(claims, { ...account, ...patch }), new RegExp(code));
  }
  assert.throws(() => validateAccountSnapshot(claims, null), /ACCOUNT_NOT_FOUND/);
  for (const patch of [{ role: 'unknown' }, { username: {} }, { sv: -1 }, { sv: '0' }, { sv: null }]) assert.throws(() => validateAccountSnapshot({ ...claims, ...patch }, account), /AUTH_INVALID_TOKEN/);
});

test('Proxy overwrites identity headers only after verified JWT and current database account validation', () => {
  const source = fs.readFileSync('src/proxy.ts', 'utf8');
  assert.ok(source.indexOf('await jwtVerify') < source.indexOf('await validateCurrentAccount'));
  assert.ok(source.indexOf('await validateCurrentAccount') < source.indexOf("requestHeaders.set('x-user'"));
  assert.match(source, /algorithms: \['HS256'\]/);
  assert.doesNotMatch(source, /payload\.role as string/);
});

test('isPasswordStrong rejects passwords shorter than 8 characters', () => {
  assert.equal(isPasswordStrong('1234567'), false);
  assert.equal(isPasswordStrong(''), false);
  assert.equal(isPasswordStrong('12345678'), true);
  assert.equal(isPasswordStrong('ComplexP@ssw0rd!'), true);
  assert.equal(typeof PASSWORD_POLICY_MESSAGE, 'string');
});

test('getJwtSecretKey validates secret length and rejects unsafe placeholders', () => {
  const origSecret = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = 'short_secret';
    assert.throws(() => getJwtSecretKey(), /must be at least 32 bytes/);

    process.env.JWT_SECRET = 'secret';
    assert.throws(() => getJwtSecretKey(), /unsafe placeholder/);

    process.env.JWT_SECRET = '01234567890123456789012345678901';
    const key = getJwtSecretKey();
    assert.equal(key.byteLength, 32);
  } finally {
    process.env.JWT_SECRET = origSecret;
  }
});

test('login route source code does not contain auto-admin runtime provisioning', () => {
  const loginRoutePath = path.resolve(process.cwd(), 'src/app/api/auth/login/route.ts');
  const content = fs.readFileSync(loginRoutePath, 'utf8');

  assert.equal(
    content.includes('INITIAL_ADMIN_PASSWORD'),
    false,
    'Login route must not read INITIAL_ADMIN_PASSWORD or auto-create admin at runtime'
  );
  assert.equal(
    content.includes('createUser'),
    false,
    'Login route must not call createUser'
  );
});

test('user update route enforces password strength policy', () => {
  const userUpdateRoutePath = path.resolve(process.cwd(), 'src/app/api/auth/users/[username]/route.ts');
  const content = fs.readFileSync(userUpdateRoutePath, 'utf8');

  assert.equal(
    content.includes('isPasswordStrong'),
    true,
    'User update route must enforce isPasswordStrong on password change'
  );
});
