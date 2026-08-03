import test from 'node:test';
import assert from 'node:assert/strict';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE, getJwtSecretKey } from '../src/lib/security.ts';
import fs from 'node:fs';
import path from 'node:path';

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
