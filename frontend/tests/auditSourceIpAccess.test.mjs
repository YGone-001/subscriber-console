import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MongoServerError } from 'mongodb';
import { loadModule } from './helpers/loadModule.mjs';
import * as auditQuery from '../src/lib/auditQuery.ts';
import * as auditSanitize from '../src/lib/audit/sanitize.ts';
import * as permissions from '../src/lib/permissions.ts';

const record = loadModule('src/lib/audit/record.ts', { './sanitize': auditSanitize });
const plain = (value) => JSON.parse(JSON.stringify(value));

const rawLog = {
  id: 'source-ip-1', eventId: 'EVT-source-ip-1', timestamp: '2026-08-27T00:00:00.000Z',
  level: 'info', action: 'auth.login', targetId: 'admin', actor: 'admin',
  operatorIp: '203.0.113.42', source: { ip: '203.0.113.42', userAgent: 'test' },
  oldData: null, newData: null, result: 'success', module: 'security',
};

test('audit request context stores only validated full addresses and masks IPv4/IPv6 on read', () => {
  const context = record.auditRequestContext(new Request('https://ops.test/api/audit', {
    headers: { 'x-forwarded-for': '203.0.113.42, 10.0.0.1' },
  }));
  assert.equal(context.source.ip, '203.0.113.42');
  assert.equal(record.normalizeAuditSourceIp('999.1.1.1'), 'unknown');
  assert.equal(record.normalizeAuditSourceIp('203.0.113.42:8443'), '203.0.113.42');
  assert.equal(record.normalizeAuditSourceIp('[2001:db8::7]:443'), '2001:db8::7');
  assert.equal(record.maskAuditSourceIp('203.0.113.42'), '203.0.113.***');
  assert.equal(record.maskAuditSourceIp('2001:db8::7'), '2001:db8:0:0:****:****:****:****');
  assert.equal(record.maskAuditSourceIp('10.0.0.***'), '10.0.0.***');
  assert.equal(record.applyAuditSourceIpAccess(rawLog).source.ip, '203.0.113.***');
  assert.equal(record.applyAuditSourceIpAccess(rawLog, true).source.ip, '203.0.113.42');
});

test('audit repository masks by default and reveals only after an explicit access decision', async () => {
  const collection = {
    aggregate: () => ({ toArray: async () => [{ logs: [rawLog], summary: [{ matched: 1, failed: 0, denied: 0, highRisk: 0 }] }] }),
    findOne: async () => rawLog,
    countDocuments: async () => 1,
    find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [rawLog] }) }) }),
  };
  const repository = loadModule('src/server/repositories/auditRepository.ts', {
    mongodb: { MongoServerError },
    '@/lib/mongo': { mongoCollections: { auditLogs: 'app_audit_logs' }, getAppCollection: async () => collection },
    '@/lib/audit/record': record,
    '@/lib/auditQuery': auditQuery,
    '@/lib/tariffPlanOperations': { buildTariffPlanAuditFilter: () => ({}) },
  });

  const maskedList = await repository.listAuditLogs({ page: 1, pageSize: 20 });
  const fullList = await repository.listAuditLogs({ page: 1, pageSize: 20 }, { revealSourceIp: true });
  assert.equal(maskedList.logs[0].source.ip, '203.0.113.***');
  assert.equal(fullList.logs[0].source.ip, '203.0.113.42');
  assert.equal((await repository.getAuditLog('source-ip-1')).operatorIp, '203.0.113.***');
  assert.equal((await repository.getAuditLog('source-ip-1', { revealSourceIp: true })).operatorIp, '203.0.113.42');
  assert.equal((await repository.exportAuditLogs({ page: 1, pageSize: 20 }, 100)).logs[0].source.ip, '203.0.113.***');
  assert.equal((await repository.exportAuditLogs({ page: 1, pageSize: 20 }, 100, { revealSourceIp: true })).logs[0].source.ip, '203.0.113.42');
  assert.equal((await repository.listAuditLogsForApproval('approval-1'))[0].source.ip, '203.0.113.***');
  assert.equal((await repository.listAuditLogsForTariffPlan('plan-1'))[0].source.ip, '203.0.113.***');
});

test('source IP filtering is denied without the full-IP permission and enabled for auditors', async () => {
  class TestNextResponse extends Response { static json(body, init) { return Response.json(body, init); } }
  const calls = [];
  const makeRoute = (role) => loadModule('src/app/api/audit/route.ts', {
    'next/server': { NextResponse: TestNextResponse },
    '@/lib/authz': {
      requireCapability: () => ({ ok: true, auth: { user: 'tester', role } }),
      requirePermission: (request, permission) => {
        calls.push(permission);
        return permissions.hasPermission({ role }, permission)
          ? { ok: true, auth: { user: 'tester', role } }
          : { ok: false, response: Response.json({ code: 'PERMISSION_DENIED' }, { status: 403 }) };
      },
    },
    '@/lib/rateLimit': { enforceRateLimit: async () => ({ ok: true }) },
    '@/server/repositories/auditRepository': { listAuditLogs: async (query, options) => {
      calls.push({ query: plain(query), options: plain(options) });
      return { logs: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 1 } };
    } },
    '@/lib/auditQuery': auditQuery,
    '@/lib/permissions': permissions,
  });

  const denied = await makeRoute('operator').GET(new Request('https://ops.test/api/audit?sourceIp=203.0.113.42'));
  assert.equal(denied.status, 403);
  assert.deepEqual(calls.slice(0, 2), ['audit.read', 'audit.source-ip.read-full']);
  calls.length = 0;
  const allowed = await makeRoute('auditor').GET(new Request('https://ops.test/api/audit?sourceIp=203.0.113.42'));
  assert.equal(allowed.status, 200);
  assert.equal(calls[0], 'audit.read');
  assert.deepEqual(calls[1].options, { revealSourceIp: true });
});

test('audit export keeps operations-admin IPs masked and gives auditors full-IP evidence', async () => {
  class TestNextResponse extends Response { static json(body, init) { return Response.json(body, init); } }
  class AuditWriteError extends Error {}
  class AuditExportTooLargeError extends Error {}
  const optionsSeen = [];
  const makeRoute = (role) => loadModule('src/app/api/audit/export/route.ts', {
    'next/server': { NextResponse: TestNextResponse },
    '@/lib/audit': { AuditWriteError, writeAuditLog: async () => true },
    '@/lib/audit/record': { auditRequestContext: () => ({}) },
    '@/lib/auditExport': {
      auditExportMaxRows: () => 100,
      auditFilterSummary: () => ({}),
      serializeAuditCsv: () => 'csv',
      serializeAuditJson: () => 'json',
    },
    '@/lib/auditQuery': {
      AuditQueryError: class AuditQueryError extends Error {},
      parseAuditQuery: (params) => ({ page: 1, pageSize: 20, sourceIp: params.get('sourceIp') || undefined }),
    },
    '@/lib/authz': {
      requireCapability: () => ({ ok: true, auth: { user: 'tester', role } }),
      requirePermission: (request, permission) => permissions.hasPermission({ role }, permission)
        ? { ok: true, auth: { user: 'tester', role } }
        : { ok: false, response: Response.json({ code: 'PERMISSION_DENIED' }, { status: 403 }) },
    },
    '@/lib/permissions': permissions,
    '@/lib/rateLimit': { enforceRateLimit: async () => ({ ok: true }) },
    '@/server/repositories/auditRepository': {
      AuditExportTooLargeError,
      exportAuditLogs: async (query, limit, options) => {
        optionsSeen.push(plain(options));
        return { logs: [], matched: 0 };
      },
    },
  });

  assert.equal((await makeRoute('ops_admin').GET(new Request('https://ops.test/api/audit/export?format=json'))).status, 200);
  assert.deepEqual(optionsSeen.at(-1), { revealSourceIp: false });
  assert.equal((await makeRoute('auditor').GET(new Request('https://ops.test/api/audit/export?format=json'))).status, 200);
  assert.deepEqual(optionsSeen.at(-1), { revealSourceIp: true });
  const beforeDenied = optionsSeen.length;
  assert.equal((await makeRoute('ops_admin').GET(new Request('https://ops.test/api/audit/export?format=json&sourceIp=203.0.113.42'))).status, 403);
  assert.equal(optionsSeen.length, beforeDenied);
});

test('audit and approval response paths pass an explicit source-IP access decision', () => {
  const files = [
    'src/app/api/audit/route.ts',
    'src/app/api/audit/[id]/route.ts',
    'src/app/api/audit/export/route.ts',
    'src/app/api/approvals/[id]/audit/route.ts',
    'src/app/api/approvals/export/route.ts',
  ];
  for (const file of files) {
    const source = String(requireSource(file));
    assert.match(source, /audit\.source-ip\.read-full/);
    assert.match(source, /revealSourceIp/);
  }
});

function requireSource(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
