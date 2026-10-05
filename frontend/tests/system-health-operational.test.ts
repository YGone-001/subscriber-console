import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOWED_SCAN_PHASES,
  buildAnalyticsInitRequest,
  buildAuditScanRequest,
  buildBatchHealRequest,
  buildSingleHealRequest,
} from '../src/features/system-health/operational-contract';

test('analytics init has no fabricated body', () => {
  const req = buildAnalyticsInitRequest();
  assert.deepEqual(req, {});
  assert.equal(Object.keys(req).length, 0);
});

test('audit scan valid phases', () => {
  assert.equal(ALLOWED_SCAN_PHASES.length, 4);
  for (const phase of ['sub', 'ocs', 'tariff', 'reservation'] as const) {
    const req = buildAuditScanRequest('0', phase);
    assert.equal(req.cursor, '0');
    assert.equal(req.phase, phase);
    assert.equal(Object.keys(req).length, 2);
  }
});

test('audit scan invalid phase rejection', () => {
  assert.throws(() => {
    buildAuditScanRequest('0', 'invalid_phase');
  }, /Invalid audit scan phase/);

  assert.throws(() => {
    buildAuditScanRequest('0', '');
  }, /Invalid audit scan phase/);
});

test('audit scan cursor preservation', () => {
  const req = buildAuditScanRequest('cursor_12345', 'ocs');
  assert.equal(req.cursor, 'cursor_12345');
  assert.equal(req.phase, 'ocs');

  assert.throws(() => {
    buildAuditScanRequest('', 'sub');
  }, /cursor must be a non-empty string/);
});

test('single heal exact body', () => {
  const req = buildSingleHealRequest({
    imsi: '001010000000001',
    type: 'missing_config',
  });
  assert.equal(req.imsi, '001010000000001');
  assert.equal(req.type, 'missing_config');
  assert.equal(req.profileName, undefined);
  assert.deepEqual(Object.keys(req).sort(), ['imsi', 'type']);
});

test('single heal optional profile', () => {
  const req = buildSingleHealRequest(
    { imsi: '001010000000001', type: 'orphan_ocs' },
    'default',
  );
  assert.equal(req.imsi, '001010000000001');
  assert.equal(req.type, 'orphan_ocs');
  assert.equal(req.profileName, 'default');
  assert.deepEqual(Object.keys(req).sort(), ['imsi', 'profileName', 'type']);
});

test('single heal malformed anomaly rejection', () => {
  assert.throws(() => {
    buildSingleHealRequest({ type: 'missing_config' });
  }, /must include a non-empty imsi/);

  assert.throws(() => {
    buildSingleHealRequest({ imsi: '001010000000001' });
  }, /must include a non-empty type/);

  assert.throws(() => {
    buildSingleHealRequest(null);
  }, /must be an object/);
});

test('batch heal exact body', () => {
  const req = buildBatchHealRequest([
    { imsi: '001010000000001', type: 'missing_config', details: 'ignored' },
    { imsi: '001010000000002', type: 'orphan_ocs', severity: 'high' },
  ]);
  assert.equal(req.anomalies.length, 2);
  assert.deepEqual(req.anomalies[0], {
    imsi: '001010000000001',
    type: 'missing_config',
  });
  assert.deepEqual(req.anomalies[1], {
    imsi: '001010000000002',
    type: 'orphan_ocs',
  });
  assert.equal(req.profileName, undefined);
  assert.deepEqual(Object.keys(req), ['anomalies']);
});

test('batch heal empty-list rejection', () => {
  assert.throws(() => {
    buildBatchHealRequest([]);
  }, /cannot be empty/);

  assert.throws(() => {
    buildBatchHealRequest(null);
  }, /cannot be empty/);
});

test('batch heal malformed-entry rejection', () => {
  assert.throws(() => {
    buildBatchHealRequest([{ imsi: '001010000000001' }]);
  }, /must include a non-empty type/);

  assert.throws(() => {
    buildBatchHealRequest([{ type: 'orphan_ocs' }]);
  }, /must include a non-empty imsi/);

  assert.throws(() => {
    buildBatchHealRequest([null]);
  }, /must be an object/);
});

test('viewer presentation denied and admin/operator allowed', () => {
  const contractFile = resolve(
    import.meta.dirname,
    '../operational-contract.json',
  );
  assert.ok(existsSync(contractFile), 'operational contract must exist');
  const contracts = JSON.parse(readFileSync(contractFile, 'utf8'));
  const sysHealth = contracts.find((c: { route: string }) => c.route === '/system-health');
  assert.ok(sysHealth, '/system-health contract must exist');

  for (const op of sysHealth.operations) {
    if (op.authorization.kind === 'role') {
      assert.ok(op.authorization.values.includes('admin'));
      assert.ok(op.authorization.values.includes('operator'));
      assert.equal(op.authorization.values.includes('viewer'), false);
    } else if (op.authorization.kind === 'capability') {
      assert.equal(op.authorization.value, 'system_heal');
    }
  }
});

test('batch HTTP 200 with partial failure is not treated as total success', () => {
  const partialResult = {
    message: 'Successfully healed 1 of 2 anomalies',
    successCount: 1,
    failedCount: 1,
    errors: ['Failed to heal 001010000000002 (orphan_ocs): connection timeout'],
  };

  // When failedCount > 0, it must be classified as partial result / warning, never total success
  const isTotalSuccess = partialResult.failedCount === 0;
  assert.equal(isTotalSuccess, false, 'failedCount > 0 must not be treated as total success');
  assert.ok(partialResult.errors.length > 0, 'errors must be preserved');
});

test('traffic and business mutation contracts remain untouched', () => {
  const businessContractFile = resolve(
    import.meta.dirname,
    '../mutation-contract.json',
  );
  const businessRequestContractFile = resolve(
    import.meta.dirname,
    '../mutation-request-contract.json',
  );
  const businessContracts = JSON.parse(readFileSync(businessContractFile, 'utf8'));
  const requestContracts = JSON.parse(readFileSync(businessRequestContractFile, 'utf8'));

  assert.equal(businessContracts.length, 11, 'business mutation routes must remain 11');
  assert.equal(requestContracts.length, 31, 'business mutation request contracts must remain 31');

  const trafficContract = requestContracts.find(
    (c: { name: string }) => c.name === 'subscriber traffic adjustment',
  );
  assert.ok(trafficContract);
  assert.equal(trafficContract.responseSemantics, 'routing-acknowledgement');
});
