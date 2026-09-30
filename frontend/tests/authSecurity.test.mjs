import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isPasswordStrong, PASSWORD_POLICY_MESSAGE } from '../src/lib/security.ts';

test('isPasswordStrong validates Unicode code points, byte length, and username containment', () => {
  assert.equal(isPasswordStrong('1234567'), false);
  assert.equal(isPasswordStrong(''), false);
  assert.equal(isPasswordStrong('12345678'), true);
  assert.equal(isPasswordStrong('ComplexP@ssw0rd!', 'alice'), true);
  assert.equal(isPasswordStrong({ length: 20 }), false);
  assert.equal(isPasswordStrong(' '.repeat(20)), false);
  assert.equal(isPasswordStrong('x'.repeat(73)), false);
  assert.equal(isPasswordStrong('ALICE-Secret!2026', 'alice'), false);
  assert.equal(typeof PASSWORD_POLICY_MESSAGE, 'string');

  // Unicode code-point counting (supplementary characters)
  assert.equal(isPasswordStrong('😀😀😀😀'), false, '4 emojis should fail (4 code points)');
  assert.equal(isPasswordStrong('😀😀😀😀😀😀😀'), false, '7 emojis should fail (7 code points)');
  assert.equal(isPasswordStrong('😀😀😀😀😀😀😀😀'), true, '8 emojis should pass (8 code points, 32 UTF-8 bytes)');
  assert.equal(isPasswordStrong('测试密码安全验证'), true, '8 BMP characters should pass (8 code points, 24 UTF-8 bytes)');
  assert.equal(isPasswordStrong('  Abcd1234  '), true, 'whitespace around 8 characters should pass');
  assert.equal(isPasswordStrong('          '), false, 'whitespace-only should fail');

  // Verify against shared parity vectors fixture
  const fixturePath = new URL('../../scripts/fixtures/password-parity-vectors.json', import.meta.url);
  if (fs.existsSync(fixturePath)) {
    const vectors = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    for (const v of vectors) {
      const actual = isPasswordStrong(v.password, v.username);
      assert.equal(actual, v.expected, `Node decision for "${v.case}" must be ${v.expected}`);
    }
  }
});

test('the UI navigation guard delegates API authentication to Go and holds no local auth runtime', () => {
  const source = fs.readFileSync(new URL('../src/proxy.ts', import.meta.url), 'utf8');
  // Scan executable code only: the module documents the runtime it must NOT contain.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');

  // No JWT verification runtime in the frontend production path.
  assert.doesNotMatch(code, /jose/);
  assert.doesNotMatch(code, /jwtVerify/);
  assert.doesNotMatch(code, /HS256/);
  assert.doesNotMatch(code, /getJwtSecretKey/);

  // No Mongo / session-store runtime in the frontend production path.
  assert.doesNotMatch(code, /mongodb/i);
  assert.doesNotMatch(code, /findOne/);

  // No API reverse proxy, no cutover routing, no trusted identity header injection.
  assert.doesNotMatch(code, /resolveRouteOwner/);
  assert.doesNotMatch(code, /CUTOVER_TABLE/);
  assert.doesNotMatch(code, /forwardToGo/);
  assert.doesNotMatch(code, /x-user/i);

  // Delegation target and fail-closed semantics.
  assert.match(source, /\/api\/auth\/me/);
  assert.match(source, /AUTH_SERVICE_UNAVAILABLE/);
  assert.match(source, /AUTH_UNAVAILABLE/);

  // /api must never enter the guard: the edge and Go own it.
  assert.ok(source.includes("matcher: ['/((?!api|"), 'the guard matcher must exclude /api');
});
