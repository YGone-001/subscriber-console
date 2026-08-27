import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/loadModule.mjs';
import * as csv from '../src/lib/csv.ts';
import * as permissions from '../src/lib/permissions.ts';

const auditExport = loadModule('src/lib/auditExport.ts', { '@/lib/csv': csv }, { process: { env: {} } });

const sampleLog = (overrides = {}) => ({
  id: 'event-1', eventId: 'EVT-event-1', timestamp: '2026-08-27T01:00:00.000Z',
  level: 'warning', action: 'user.role.change', targetId: 'phase3_audit_test', actor: 'admin',
  operatorIp: '10.0.0.***', oldData: { role: 'viewer' }, newData: { role: 'auditor' },
  actorContext: { type: 'user', username: 'admin', role: 'super_admin' },
  module: 'users', resource: { type: 'user', id: 'phase3_audit_test' }, riskLevel: 'high',
  result: 'success', source: { ip: '10.0.0.***' }, request: { requestId: 'req-1', correlationId: 'corr-1' },
  ...overrides,
});

test('audit CSV escapes commas, quotes and newlines and neutralizes spreadsheet formulas', () => {
  const logs = [sampleLog({ reason: '=HYPERLINK("https://bad")\ncomma,value', actorContext: { type: 'user', username: '+SUM(1,1)', role: 'auditor' } })];
  const document = auditExport.serializeAuditCsv(logs);
  const rows = csv.parseCsv(document, { trimFields: false });
  assert.equal(rows.length, 2);
  assert.equal(rows[1][6], "'+SUM(1,1)");
  assert.equal(rows[1][14], "'=HYPERLINK(\"https://bad\")\ncomma,value");
  for (const value of ['=1+1', '+cmd', '-10', '@name', '  =SUM(A1:A2)']) assert.match(auditExport.safeAuditCsvCell(value), /^'/);
});

test('audit JSON and CSV preserve legacy empty fields without inventing new context', () => {
  const legacy = sampleLog({ eventId: undefined, actorContext: undefined, module: undefined, resource: undefined, result: undefined, riskLevel: undefined, request: undefined, source: undefined });
  const csvRows = csv.parseCsv(auditExport.serializeAuditCsv([legacy]));
  assert.equal(csvRows[1][1], 'event-1');
  assert.equal(csvRows[1][2], '');
  assert.equal(csvRows[1][3], '');
  const json = JSON.parse(auditExport.serializeAuditJson([legacy], { page: 1, pageSize: 20, actor: 'admin' }, '2026-08-27T00:00:00.000Z'));
  assert.equal(json.filters.actor, 'admin');
  assert.equal(json.logs[0].module, undefined);
});

test('audit export policy is configurable, bounded and role permissions keep viewer denied', () => {
  assert.equal(auditExport.auditExportMaxRows(undefined), 50000);
  assert.equal(auditExport.auditExportMaxRows('2500'), 2500);
  assert.throws(() => auditExport.auditExportMaxRows('0'));
  assert.throws(() => auditExport.auditExportMaxRows('many'));
  assert.equal(permissions.hasPermission({ role: 'auditor' }, 'audit.export'), true);
  assert.equal(permissions.hasPermission({ role: 'viewer' }, 'audit.export'), false);
  assert.equal(permissions.hasPermission({ role: 'operator' }, 'audit.read'), true);
  assert.equal(permissions.hasPermission({ role: 'operator' }, 'audit.export'), false);
});

test('audit export route records strict success/failure evidence and does not duplicate denied evidence', async () => {
  class TooLarge extends Error { constructor(matched, limit) { super('too large'); this.matched = matched; this.limit = limit; } }
  class WriteError extends Error {}
  class TestNextResponse extends Response { static json(body, init) { return Response.json(body, init); } }
  const writes = [];
  const guardCalls = [];
  let exportMode = 'success';
  const route = loadModule('src/app/api/audit/export/route.ts', {
    'next/server': { NextResponse: TestNextResponse },
    '@/lib/audit': { AuditWriteError: WriteError, writeAuditLog: async (record, options) => { writes.push({ record, options }); return true; } },
    '@/lib/audit/record': { auditRequestContext: () => ({ source: { ip: '10.0.0.***' }, request: { requestId: 'req-export', correlationId: 'corr-export' } }) },
    '@/lib/auditExport': {
      auditExportMaxRows: () => 50000,
      auditFilterSummary: (query) => ({ actor: query.actor || '' }),
      serializeAuditCsv: () => 'csv-body',
      serializeAuditJson: () => 'json-body',
    },
    '@/lib/auditQuery': {
      AuditQueryError: class AuditQueryError extends Error {},
      parseAuditQuery: (params) => ({ page: 1, pageSize: 20, actor: params.get('actor') || undefined }),
    },
    '@/lib/authz': {
      requireCapability: (request) => { guardCalls.push('capability'); const role = request.headers.get('x-user-role'); return role === 'auditor' ? { ok: true, auth: { user: 'audit_user', role, sessionVersion: 0 } } : { ok: false, response: Response.json({}, { status: 403 }) }; },
      requirePermission: () => { guardCalls.push('permission'); return { ok: true, auth: { user: 'audit_user', role: 'auditor', sessionVersion: 0 } }; },
    },
    '@/lib/rateLimit': { enforceRateLimit: async () => ({ ok: true }) },
    '@/server/repositories/auditRepository': {
      AuditExportTooLargeError: TooLarge,
      exportAuditLogs: async () => { if (exportMode === 'large') throw new TooLarge(50001, 50000); return { logs: [sampleLog()], matched: 1 }; },
    },
  });

  const denied = await route.GET(new Request('https://ops.test/api/audit/export?format=csv', { headers: { 'x-user-role': 'viewer' } }));
  assert.equal(denied.status, 403);
  assert.deepEqual(guardCalls, ['capability']);
  assert.equal(writes.length, 0);

  const success = await route.GET(new Request('https://ops.test/api/audit/export?format=csv&actor=admin', { headers: { 'x-user-role': 'auditor' } }));
  assert.equal(success.status, 200);
  assert.equal(writes[0].record.action, 'audit.export');
  assert.equal(writes[0].record.result, 'success');
  assert.equal(writes[0].record.metadata.exportedCount, 1);
  assert.equal(writes[0].options.failureMode, 'strict');

  exportMode = 'large';
  const large = await route.GET(new Request('https://ops.test/api/audit/export?format=json', { headers: { 'x-user-role': 'auditor' } }));
  assert.equal(large.status, 422);
  assert.equal(writes.at(-1).record.result, 'failed');
  assert.equal(writes.at(-1).record.error.code, 'AUDIT_EXPORT_TOO_LARGE');
  assert.doesNotMatch(JSON.stringify(writes), /password|authorization|cookie|jwt|opc|secret/i);
});
