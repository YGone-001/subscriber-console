import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';
import * as auditQueryModule from '../src/lib/auditQuery.ts';
import * as auditSanitize from '../src/lib/audit/sanitize.ts';
import { MongoServerError } from 'mongodb';

const auditQuery = loadModule('src/lib/auditQuery.ts', {});
const recordHelpers = loadModule('src/lib/audit/record.ts', { './sanitize': auditSanitize });
const plain = (value) => JSON.parse(JSON.stringify(value));

test('audit query defaults to the shared server pagination contract and supports legacy aliases', () => {
  assert.deepEqual(plain(auditQuery.parseAuditQuery(new URLSearchParams())), { page: 1, pageSize: 20 });
  const parsed = plain(auditQuery.parseAuditQuery(new URLSearchParams('page=3&pageSize=50&operator=admin&target=SYS_USER%3Aalice')));
  assert.equal(parsed.page, 3);
  assert.equal(parsed.pageSize, 50);
  assert.equal(parsed.actor, 'admin');
  assert.equal(parsed.resourceId, 'SYS_USER:alice');
  assert.equal(plain(auditQuery.parseAuditQuery(new URLSearchParams('limit=100'))).pageSize, 100);
});

test('audit query rejects invalid pages, oversized page sizes, enums, dates, ranges and text', () => {
  for (const query of [
    'page=-2', 'page=0', 'pageSize=10', 'pageSize=100000', 'limit=500',
    'result=foobar', 'risk=xxx', 'module=unknown-module', 'level=critical',
    'from=not-a-date', 'from=2026-08-28&to=2026-08-27', `actor=${'a'.repeat(129)}`,
  ]) assert.throws(() => auditQuery.parseAuditQuery(new URLSearchParams(query)), /page|limit|unsupported|valid ISO|earlier|exceeds/);
});

test('audit query builds legacy-compatible actor, target, correlation and source filters', () => {
  const query = auditQuery.parseAuditQuery(new URLSearchParams([
    ['actor', 'admin'], ['resourceType', 'user'], ['resourceId', 'phase3_test'],
    ['requestId', 'req-1'], ['correlationId', 'corr-1'], ['approvalId', 'approval-1'],
    ['sourceIp', '10.10.0.***'], ['action', 'user.role.change'], ['module', 'users'],
    ['result', 'success'], ['risk', 'high'], ['level', 'warning'],
    ['from', '2026-08-20'], ['to', '2026-08-27'],
  ]));
  const serialized = JSON.stringify(auditQuery.buildAuditFilter(query));
  for (const field of [
    'actor', 'actorContext.username', 'actorContext.displayName', 'actorContext.userId',
    'targetId', 'resource.id', 'resource.name', 'request.requestId', 'correlationId',
    'request.correlationId', 'approvalId', 'operatorIp', 'source.ip', 'timestamp',
  ]) assert.match(serialized, new RegExp(field.replace('.', '\\.')));
});

test('audit q searches identifier fields only and escapes client regex input', () => {
  const filter = auditQuery.buildAuditFilter(auditQuery.parseAuditQuery(new URLSearchParams('q=admin.*%28test%29')));
  const serialized = JSON.stringify(filter);
  for (const field of ['id', 'eventId', 'action', 'actor', 'targetId', 'resource.id', 'request.requestId', 'request.correlationId', 'correlationId', 'approvalId']) {
    assert.match(serialized, new RegExp(field.replace('.', '\\.')));
  }
  for (const forbidden of ['oldData', 'newData', 'metadata', 'error']) assert.doesNotMatch(serialized, new RegExp(forbidden));
  assert.equal(auditQuery.escapeAuditRegex('admin.*(test)'), 'admin\\.\\*\\(test\\)');
});

test('audit repository returns first and last server pages with whole-filter summary and a lightweight projection', async () => {
  const pipelines = [];
  const sample = {
    id: 'evt-1', eventId: 'EVT-evt-1', timestamp: '2026-08-27T01:00:00.000Z',
    level: 'warning', action: 'user.role.change', targetId: 'phase3_test', actor: 'admin',
    operatorIp: '10.0.0.***', oldData: { role: 'viewer' }, newData: { role: 'auditor' },
    metadata: { reason: 'test' }, result: 'success', riskLevel: 'high', module: 'users',
  };
  const repository = loadModule('src/server/repositories/auditRepository.ts', {
    mongodb: { MongoServerError },
    '@/lib/mongo': { mongoCollections: { auditLogs: 'app_audit_logs' }, getAppCollection: async () => ({
      aggregate: (pipeline) => ({ toArray: async () => {
        pipelines.push(pipeline);
        return [{ logs: [sample], summary: [{ matched: 41, failed: 3, denied: 2, highRisk: 4 }] }];
      } }),
    }) },
    '@/lib/audit/record': recordHelpers,
    '@/lib/auditQuery': auditQueryModule,
    '@/lib/tariffPlanOperations': { buildTariffPlanAuditFilter: () => ({}) },
  });
  const first = await repository.listAuditLogs({ page: 1, pageSize: 20 });
  const last = await repository.listAuditLogs({ page: 3, pageSize: 20 });
  assert.deepEqual(plain(first.pagination), { page: 1, pageSize: 20, total: 41, totalPages: 3 });
  assert.deepEqual(plain(last.pagination), { page: 3, pageSize: 20, total: 41, totalPages: 3 });
  assert.deepEqual(plain(first.summary), { matched: 41, failed: 3, denied: 2, highRisk: 4 });
  assert.equal(first.logs[0].oldData, undefined);
  assert.equal(first.logs[0].metadata, undefined);
  assert.equal(pipelines[0][1].$facet.logs[1].$skip, 0);
  assert.equal(pipelines[1][1].$facet.logs[1].$skip, 40);
  assert.equal(pipelines[0][1].$facet.logs.at(-1).$project.oldData, undefined);
});

test('audit detail route validates canonical ids, returns sanitized legacy/new events and enforces permission', async () => {
  const legacy = {
    id: 'legacy-1', timestamp: '2026-08-20T00:00:00.000Z', level: 'info', action: 'UPDATE',
    targetId: 'SYS_USER:alice', actor: 'admin', operatorIp: '10.0.0.***', correlationId: 'corr-1',
    oldData: { password: 'unsafe' }, newData: { role: 'viewer' },
  };
  const response = { NextResponse: { json: (body, init) => Response.json(body, init) } };
  const makeRoute = (allowed, log = legacy) => loadModule('src/app/api/audit/[id]/route.ts', {
    'next/server': response,
    '@/lib/authz': {
      requireCapability: () => allowed ? { ok: true, auth: { user: 'admin' } } : { ok: false, response: Response.json({}, { status: 403 }) },
      requirePermission: () => allowed ? { ok: true, auth: { user: 'admin' } } : { ok: false, response: Response.json({}, { status: 403 }) },
    },
    '@/lib/auditQuery': auditQueryModule,
    '@/lib/rateLimit': { enforceRateLimit: async () => ({ ok: true }) },
    '@/server/repositories/auditRepository': { getAuditLog: async () => log ? recordHelpers.sanitizeAuditRecord(log) : null },
  });
  const request = new Request('https://ops.test/api/audit/legacy-1');
  const denied = await makeRoute(false).GET(request, { params: Promise.resolve({ id: 'legacy-1' }) });
  assert.equal(denied.status, 403);
  const invalid = await makeRoute(true).GET(request, { params: Promise.resolve({ id: '../bad' }) });
  assert.equal(invalid.status, 400);
  const missing = await makeRoute(true, null).GET(request, { params: Promise.resolve({ id: 'missing' }) });
  assert.equal(missing.status, 404);
  const found = await makeRoute(true).GET(request, { params: Promise.resolve({ id: 'legacy-1' }) });
  assert.equal(found.status, 200);
  assert.doesNotMatch(await found.text(), /unsafe/);
});
