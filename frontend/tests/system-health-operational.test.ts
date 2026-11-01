import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOWED_SCAN_PHASES,
  buildAuditScanRequest,
} from '../src/features/system-health/operational-contract';

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

test('the console offers only the read-only audit scan', () => {
  const contractFile = resolve(
    import.meta.dirname,
    '../operational-contract.json',
  );
  assert.ok(existsSync(contractFile), 'operational contract must exist');
  const contracts = JSON.parse(readFileSync(contractFile, 'utf8'));
  const sysHealth = contracts.find((c: { route: string }) => c.route === '/system-health');
  assert.ok(sysHealth, '/system-health contract must exist');
  assert.equal(sysHealth.operations.length, 1, 'auto-heal and analytics-init are retired from the console');
  assert.equal(sysHealth.operations[0].request, 'POST /api/system/audit/scan');
  assert.deepEqual(sysHealth.operations[0].authorization.values, ['admin', 'operator']);
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

  assert.equal(businessContracts.length, 13, 'business mutation routes must remain 13');
  assert.equal(requestContracts.length, 33, 'business mutation request contracts must remain 33');

  const trafficContract = requestContracts.find(
    (c: { name: string }) => c.name === 'subscriber traffic adjustment',
  );
  assert.ok(trafficContract);
  assert.equal(trafficContract.responseSemantics, 'routing-acknowledgement');
});
