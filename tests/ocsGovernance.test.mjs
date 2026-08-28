import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { loadModule } from './helpers/loadModule.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('OCS registry classifies every administrative operation and keeps charging runtime internal', () => {
  const { OCS_OPERATIONS, evaluateOcsOperation, governedOcsApprovalActions, assertOcsGovernedOperationCoverage } = loadModule('src/server/ocsGovernanceRegistry.ts', {});
  const adjustment = evaluateOcsOperation(OCS_OPERATIONS.BALANCE_ADJUST);
  assert.equal(adjustment.governanceMode, 'APPROVAL_GOVERNED');
  assert.equal(adjustment.executionClass, 'administrative');
  assert.equal(adjustment.requiresApproval, true);
  assert.equal(evaluateOcsOperation(OCS_OPERATIONS.BALANCE_RESET).governanceMode, 'DISABLED');
  for (const operation of [OCS_OPERATIONS.RUNTIME_RESERVE, OCS_OPERATIONS.RUNTIME_CONSUME, OCS_OPERATIONS.RUNTIME_RELEASE, OCS_OPERATIONS.RUNTIME_USAGE]) {
    const definition = evaluateOcsOperation(operation);
    assert.equal(definition.governanceMode, 'RUNTIME_INTERNAL');
    assert.equal(definition.requiresApproval, false);
    assert.equal(definition.humanExecutable, false);
  }
  assert.deepEqual([...governedOcsApprovalActions], ['TRAFFIC_ADJUSTMENT']);
  assert.doesNotThrow(() => assertOcsGovernedOperationCoverage(['TRAFFIC_ADJUSTMENT']));
  assert.throws(() => assertOcsGovernedOperationCoverage([]), /OCS_GOVERNED_OPERATION_EXECUTOR_MISSING:TRAFFIC_ADJUSTMENT/);
  for (const operation of Object.values(OCS_OPERATIONS)) {
    const definition = evaluateOcsOperation(operation);
    assert.ok(['APPROVAL_GOVERNED', 'DIRECT_GOVERNED', 'RUNTIME_INTERNAL', 'DISABLED'].includes(definition.governanceMode));
    if (definition.governanceMode === 'DISABLED') {
      assert.equal(definition.executionMode, 'none');
      assert.equal(definition.humanExecutable, false);
      assert.match(definition.disabledCode, /_NOT_SUPPORTED$/);
    }
  }
});

test('balance intent accepts only a reasoned credit/debit and rejects direct state fields', () => {
  const { validateOcsBalanceIntent } = loadModule('src/server/ocsBalanceGovernance.ts', {
    'node:crypto': { randomUUID: () => 'adjustment-1' },
    mongodb: { Long: { isLong: () => false } },
    '@/lib/mongo': { getAppCollection: async () => ({}), getOpen5gsCollection: async () => ({}), mongoCollections: {} },
  });
  const valid = validateOcsBalanceIntent({ bucket: 'data', operation: 'credit', amount: 1024, reason: 'approved correction' });
  assert.equal(valid.bucket, 'data');
  assert.equal(valid.operation, 'credit');
  assert.equal(valid.amount, 1024);
  assert.equal(valid.reason, 'approved correction');
  assert.throws(() => validateOcsBalanceIntent({ bucket: 'data', operation: 'debit', amount: 100, reason: 'x', data_used: 0 }), /INVALID_OCS_BALANCE_ADJUSTMENT/);
  assert.throws(() => validateOcsBalanceIntent({ bucket: 'data', operation: 'debit', amount: 0, reason: 'x' }), /INVALID_OCS_BALANCE_AMOUNT/);
  assert.throws(() => validateOcsBalanceIntent({ bucket: 'data', operation: 'credit', amount: Number.MAX_SAFE_INTEGER + 1, reason: 'x' }), /OCS_BALANCE_VALUE_OUT_OF_RANGE/);
  assert.throws(() => validateOcsBalanceIntent({ bucket: 'sms', operation: 'credit', amount: 1, reason: 'x' }), /INVALID_OCS_BALANCE_BUCKET/);
});

test('high-risk OCS HTTP writes submit approvals and contain no direct repository mutators', () => {
  const routes = [
    'src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts',
    'src/app/api/tariff-plans/route.ts', 'src/app/api/tariff-plans/[planId]/route.ts',
    'src/app/api/tariff-plans/[planId]/rules/route.ts', 'src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts',
    'src/app/api/tariff-plans/[planId]/migrate/route.ts', 'src/app/api/tariff-plans/import/route.ts', 'src/app/api/tariff-plans/[planId]/clone/route.ts',
    'src/app/api/ratings/route.ts', 'src/app/api/ratings/[id]/route.ts',
  ];
  for (const path of routes) {
    const source = read(path);
    assert.match(source, /createApprovalRequest/, path);
    assert.doesNotMatch(source, /capabilityDecision|isSuperAdmin/, path);
  }
  assert.doesNotMatch(read('src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts'), /data_used|data_reserved|set_total|set_available|reset/);
});

test('disabled OCS administration routes reject before creating an approval', () => {
  const routes = [
    'src/app/api/tariff-plans/route.ts', 'src/app/api/tariff-plans/[planId]/route.ts',
    'src/app/api/tariff-plans/[planId]/rules/route.ts', 'src/app/api/tariff-plans/[planId]/rules/[ruleId]/route.ts',
    'src/app/api/tariff-plans/[planId]/migrate/route.ts', 'src/app/api/tariff-plans/import/route.ts',
    'src/app/api/tariff-plans/[planId]/clone/route.ts', 'src/app/api/ratings/route.ts',
    'src/app/api/ratings/[id]/route.ts', 'src/app/api/subscribers/policy/route.ts',
  ];
  for (const path of routes) {
    const source = read(path);
    const guard = source.indexOf('if (!definition.executable)');
    const approval = source.indexOf('const approval = await createApprovalRequest');
    assert.ok(guard >= 0 && approval >= 0 && guard < approval, path);
  }
});

test('secret-bearing subscriber provisioning remains server-side and absent from approval payloads', () => {
  const repository = read('src/server/repositories/subscriberRepository.ts');
  const batchRoute = read('src/app/api/subscribers/batch/route.ts');
  assert.match(repository, /buildDefaultOpen5gsSubscriber/);
  assert.match(repository, /batchDocForImsi/);
  assert.doesNotMatch(batchRoute, /\bauth\s*:/);
  assert.doesNotMatch(batchRoute, /\b(?:opc|op|k)\s*:/i);
});

test('approval and audit JSON snapshots redact nested subscriber authentication material', () => {
  const { sanitizeAuditPayload, REDACTED } = loadModule('src/lib/audit/sanitize.ts', {});
  const approval = { payload: { imsi: '460020000000001', auth: { k: 'secret-k', opc: 'secret-opc', amf: '8000', sqn: 9 }, nested: [{ security: { op: 'secret-op' } }] } };
  const audit = sanitizeAuditPayload(approval);
  const serialized = JSON.stringify(audit).toLowerCase();
  assert.ok(serialized.includes(REDACTED.toLowerCase()));
  for (const secret of ['secret-k', 'secret-opc', 'secret-op']) assert.doesNotMatch(serialized, new RegExp(secret, 'i'));
});

test('runtime charging has no public administrative route or ordinary-role permission', () => {
  const routeRoot = new URL('../src/app/api/ocs', import.meta.url);
  for (const relative of readdirSync(routeRoot, { recursive: true }).filter((entry) => String(entry).endsWith('route.ts'))) {
    const source = readFileSync(new URL(String(relative).replaceAll('\\', '/'), `${routeRoot.href}/`), 'utf8');
    assert.doesNotMatch(source, /export async function (?:POST|PUT|PATCH|DELETE)/);
    assert.doesNotMatch(source, /createApprovalRequest|ocs\.runtime\.execute/);
  }
  const { hasPermission } = loadModule('src/lib/permissions.ts', {});
  for (const role of ['ops_admin', 'operator', 'auditor', 'viewer']) {
    assert.equal(hasPermission({ role, status: 'active' }, 'ocs.runtime.execute'), false, role);
  }
});
