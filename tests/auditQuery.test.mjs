import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';

const auditQuery = loadModule('src/lib/auditQuery.ts', {});
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
