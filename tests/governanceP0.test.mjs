import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createJiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { MongoServerError } from 'mongodb';
import { sanitizeAuditPayload, sanitizeAuditText, REDACTED } from '../src/lib/audit/sanitize.ts';
import { requiresApproval, isRiskLevel, normalizeApprovalStatus } from '../src/lib/governance/risk.ts';
import { formatGovernanceTime } from '../src/lib/governance/display.ts';
import * as permissions from '../src/lib/permissions.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const jiti = createJiti(import.meta.url, { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } });
const recordHelpers = await jiti.import('../src/lib/audit/record.ts');

// Execute the production service/guard/repository with only external I/O replaced.
// No database connection, authentication bypass in the app, or test-only API is needed.
function loadModule(path, dependencies, globals = {}) {
  const testModule = { exports: {} };
  const compiled = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module: testModule, exports: testModule.exports,
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency: ${name}`);
      return dependencies[name];
    },
    URL, Date, crypto, setTimeout, console,
    ...globals,
  }, { filename: path });
  return testModule.exports;
}

const event = (result = 'success') => ({
  actor: { type: 'user', username: 'operator01', role: 'operator' },
  module: 'subscribers', action: 'subscriber.update', resource: { type: 'subscriber', id: '460020000000003' },
  result, riskLevel: 'high', before: { ambr: 100, password: 'old-secret' }, after: { ambr: 500, password: 'new-secret' },
});

test('audit evidence retains Next after scheduling and compatible trace fields', () => {
  const auditSource = read('src/lib/audit.ts');
  const recordSource = read('src/lib/audit/record.ts');
  const typeSource = read('src/types/audit.ts');

  assert.match(auditSource, /import \{ after \} from 'next\/server'/);
  assert.match(auditSource, /after\(async \(\) =>/);
  assert.match(auditSource, /x-user/);
  assert.match(recordSource, /x-request-id/);
  assert.match(auditSource, /attempt <= 3/);
  assert.doesNotMatch(auditSource, /setTimeout\(async \(\) =>/);
  assert.match(typeSource, /actor\?: string/);
  assert.match(typeSource, /correlationId\?: string/);
  assert.match(typeSource, /approvalId\?: string/);
});

test('risk and legacy status adapters never confuse approval with execution', () => {
  assert.equal(isRiskLevel('critical'), true);
  assert.equal(isRiskLevel('CRITICAL'), false);
  assert.equal(requiresApproval('high'), true);
  assert.equal(requiresApproval('critical'), true);
  assert.equal(requiresApproval('low'), false);
  assert.equal(normalizeApprovalStatus('executed'), 'completed');
  assert.equal(normalizeApprovalStatus('approved'), 'approved');
  assert.equal(normalizeApprovalStatus('invented'), null);
  assert.equal(formatGovernanceTime('2026-08-26T06:32:18.291Z'), '2026-08-26 14:32:18');
  assert.equal(formatGovernanceTime('invalid'), '—');
});

test('sanitizer recursively redacts secrets, credential variants and telecom authentication material', () => {
  const input = {
    PASSWORD: 'one', Password_Hash: 'two', headers: { AUTHORIZATION: 'Bearer three', Cookie: 'four' },
    nested: [{ apiKey: 'five', refreshToken: 'six', diameterSecret: 'seven', dbPassword: 'eight' }],
    security: { k: 'nine', opc: 'ten', privateKey: 'eleven' },
    'auth.password': 'twelve', user: 'alice', ambr: { downlink: 500 },
    passwordChangedAt: '2026-08-26T06:32:18Z',
    embedded: '{"token":"thirteen","ambr":500}',
  };
  const output = sanitizeAuditPayload(input);
  assert.equal(output.PASSWORD, REDACTED);
  assert.equal(output.Password_Hash, REDACTED);
  assert.equal(output.headers.AUTHORIZATION, REDACTED);
  assert.equal(output.nested[0].diameterSecret, REDACTED);
  assert.equal(output.security.k, REDACTED);
  assert.equal(output['auth.password'], REDACTED);
  assert.equal(JSON.parse(output.embedded).token, REDACTED);
  assert.equal(output.passwordChangedAt, input.passwordChangedAt);
  assert.deepEqual(output.ambr, { downlink: 500 });
  assert.equal(input.PASSWORD, 'one');
  for (const secret of ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen']) {
    assert.equal(JSON.stringify(output).includes(`"${secret}"`), false);
  }
});

test('sanitizer bounds hostile metadata, avoids getters and handles circular and non-JSON values', () => {
  let getterCalls = 0;
  const input = { count: 4n, date: new Date('2026-08-26T00:00:00Z'), bytes: new Uint8Array([1, 2]) };
  input.self = input;
  Object.defineProperty(input, 'getter', { enumerable: true, get() { getterCalls++; throw new Error('secret'); } });
  const safe = sanitizeAuditPayload(input);
  assert.equal(getterCalls, 0);
  assert.equal(safe.self, '[CIRCULAR]');
  assert.equal(safe.count, '4');
  assert.equal(safe.bytes, '[BINARY OMITTED]');
  assert.equal(safe.date, '2026-08-26T00:00:00.000Z');
  assert.ok(JSON.stringify(sanitizeAuditPayload(Array.from({ length: 1000 }, () => 'x'.repeat(10000)))).length < 68000);
  assert.doesNotThrow(() => sanitizeAuditPayload(new Proxy({}, { ownKeys() { throw new Error('secret'); } })));
  assert.equal(sanitizeAuditText('Bearer abc.def.ghi'), REDACTED);
  assert.equal(sanitizeAuditText(null), '');
  assert.doesNotThrow(() => recordHelpers.sanitizeAuditRecord({ id: 'historic', timestamp: '', level: 'info', action: 'UPDATE', targetId: 'x', actor: null, operatorIp: null, reason: null }));
  assert.equal(sanitizeAuditText('eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.signature'), REDACTED);
  assert.equal(sanitizeAuditText('mongodb://admin:db-secret@localhost/test'), `mongodb://${REDACTED}@localhost/test`);
  assert.equal(sanitizeAuditText('password="do not log me"'), `password=${REDACTED}`);
  assert.equal(sanitizeAuditText('failure: {"password":"inline-secret"}').includes('inline-secret'), false);
  assert.equal(sanitizeAuditPayload('{"password":"long-json-secret","body":"' + 'a'.repeat(5000) + '"}'), '[TRUNCATED]');
  const repeatedSecrets = Array.from({ length: 200 }, () => Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`${'a'.repeat(180)}${i}Password`, 'secret'])));
  assert.ok(JSON.stringify(sanitizeAuditPayload(repeatedSecrets)).length < 75000);
  assert.equal(sanitizeAuditText('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'), REDACTED);
});

test('structured audit records preserve results, before/after and legacy compatibility without credentials', () => {
  for (const result of ['success', 'failed', 'denied']) {
    const log = recordHelpers.createAuditRecord({ ...event(result), error: { code: 'WRITE_CONFLICT', message: 'Bearer abc' } });
    assert.equal(log.result, result);
    assert.equal(log.actor, 'operator01');
    assert.equal(log.actorContext.role, 'operator');
    assert.equal(log.oldData.ambr, 100);
    assert.equal(log.newData.ambr, 500);
    assert.equal(log.oldData.password, REDACTED);
    assert.equal(log.error.message, REDACTED);
    assert.match(log.eventId, /^EVT-/);
    assert.ok(Number.isFinite(Date.parse(log.timestamp)));
  }
  const context = recordHelpers.auditRequestContext(new Request('https://ops.test/api/subscribers?token=never-log', {
    method: 'PATCH', headers: { 'x-request-id': 'req-123', 'x-correlation-id': 'corr-456',
      'x-forwarded-for': '10.20.30.40, 192.168.1.1', Authorization: 'Bearer never-log' },
  }));
  assert.equal(context.request.path, '/api/subscribers');
  assert.equal(context.source.ip, '10.20.30.40');
  assert.equal(context.request.requestId, 'req-123');
  assert.equal(JSON.stringify(context).includes('never-log'), false);
  const truncated = recordHelpers.createAuditRecord({ ...event(), before: Array.from({ length: 100 }, () => 'a'.repeat(4000)) });
  assert.notEqual(truncated.newData, null, 'Truncated after data must not look like an actual deletion');
});

test('audit writes retry a stable event and expose strict versus best-effort failures', async () => {
  const attempts = [];
  const errors = [];
  let failing = true;
  const service = loadModule('src/lib/audit.ts', {
    'next/server': { after() {} }, './analytics': { updateAnalytics: async () => {} },
    '@/server/repositories/auditRepository': { appendAuditLog: async (record) => {
      attempts.push(record);
      if (failing) throw new Error('mongodb://admin:secret@db');
    } }, './audit/record': recordHelpers,
  }, { setTimeout: (callback) => callback(), console: { error: (...args) => errors.push(args) } });
  assert.equal(await service.writeAuditLog(event()), false);
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((record) => record.id)).size, 1);
  await assert.rejects(service.writeAuditLog(event(), { failureMode: 'strict' }), { name: 'AuditWriteError' });
  assert.equal(JSON.stringify(errors).includes('secret'), false);
  failing = false;
  assert.equal(await service.writeAuditLog(event()), true);
});

test('legacy audit adapter snapshots inputs before after(), scrubs secrets and isolates analytics failures', async () => {
  const tasks = [];
  const records = [];
  const service = loadModule('src/lib/audit.ts', {
    'next/server': { after: (task) => tasks.push(task) },
    './analytics': { updateAnalytics: async () => { throw new Error('analytics failed'); } },
    '@/server/repositories/auditRepository': { appendAuditLog: async (record) => { records.push(record); } },
    './audit/record': recordHelpers,
  }, { console: { error() {} } });
  const after = { role: 'operator', token: 'secret' };
  service.logAudit('UPDATE', 'SYS_USER:alice', { role: 'viewer' }, after,
    new Request('https://ops.test/api/auth/users/alice', { headers: { 'x-user': 'root01', 'x-user-role': 'root' } }));
  after.role = 'root';
  assert.equal(records.length, 0);
  await tasks[0]();
  assert.equal(records[0].newData.role, 'operator');
  assert.equal(records[0].newData.token, REDACTED);
  assert.equal(records[0].actor, 'root01');
  assert.equal(records[0].module, 'users');
});

test('requirePermission enforces server identity and denied capabilities produce security evidence', () => {
  const events = [];
  const guards = loadModule('src/lib/authz.ts', {
    'next/server': { NextResponse: { json: (body, init) => ({ body, status: init.status }) } },
    '@/lib/permissions': permissions, '@/lib/audit': { scheduleAuditLog: (entry) => events.push(entry) },
    '@/lib/audit/record': recordHelpers,
  });
  const request = (role) => new Request('https://ops.test/api/users', { method: 'POST',
    headers: { 'x-user': 'alice', 'x-user-role': role }, body: '{"actor":"root","role":"root"}' });
  assert.equal(guards.requirePermission(new Request('https://ops.test/api/users'), 'users.create').response.status, 401);
  assert.equal(guards.requirePermission(request('viewer'), 'users.create').response.status, 403);
  assert.equal(guards.requirePermission(request('root'), 'users.create').ok, true);
  assert.equal(guards.requirePermission(request('unknown'), 'audit.read').response.status, 401);
  assert.equal(guards.requireCapability(request('operator'), 'approval_review').response.status, 403);
  assert.equal(events.length, 2);
  assert.ok(events.every((entry) => entry.actor.username === 'alice' && entry.result === 'denied'));
});

test('audit repository is append-only, scrubs at the storage boundary and makes retries idempotent', async () => {
  const stored = new Map();
  const repository = loadModule('src/server/repositories/auditRepository.ts', {
    mongodb: { MongoServerError },
    '@/lib/mongo': { mongoCollections: { auditLogs: 'app_audit_logs' }, getAppCollection: async () => ({
      insertOne: async (record) => {
        if (stored.has(record._id)) throw new MongoServerError({ message: 'duplicate', code: 11000, keyPattern: { _id: 1 }, keyValue: { _id: record._id } });
        stored.set(record._id, record);
      },
    }) },
    '@/lib/audit/record': recordHelpers,
    '@/lib/auditQuery': { buildAuditFilter: () => ({}) },
    '@/lib/tariffPlanOperations': { buildTariffPlanAuditFilter: () => ({}) },
  });
  const record = recordHelpers.createAuditRecord(event());
  record.newData = { token: 'unsafe direct repository caller' };
  await repository.appendAuditLog(record);
  await repository.appendAuditLog(record);
  assert.equal(stored.size, 1);
  assert.equal(stored.get(record.id).newData.token, REDACTED);
  assert.doesNotMatch(read('src/server/repositories/auditRepository.ts'), /deleteOne|deleteMany|updateOne|updateMany|replaceOne/);
});

test('audit viewing, bulk export, change review, and execution use separate permissions and endpoints', () => {
  const viewRoute = read('src/app/api/audit/route.ts');
  const auditExportRoute = read('src/app/api/audit/export/route.ts');
  const exportRoute = read('src/app/api/approvals/export/route.ts');
  const reviewRoute = read('src/app/api/approvals/[id]/route.ts');

  assert.match(viewRoute, /requireCapability\(request, 'audit_view'\)/);
  assert.match(auditExportRoute, /requireCapability\(request, 'audit_export'/);
  assert.match(auditExportRoute, /requirePermission\(request, 'audit\.export'\)/);
  assert.match(exportRoute, /requireCapability\(request, 'audit_export'/);
  const approveRoute = read('src/app/api/approvals/[id]/approve/route.ts');
  const executePath = read('src/server/approvalWorkflow.ts');
  assert.match(reviewRoute, /INVALID_DECISION/);
  assert.match(approveRoute, /requirePermission\(request, 'approvals\.approve'\)/);
  assert.doesNotMatch(approveRoute, /executeApproval/);
  assert.match(executePath, /approvals\.execute/);
});
