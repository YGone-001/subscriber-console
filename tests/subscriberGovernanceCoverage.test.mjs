import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('every subscriber mutation endpoint is classified by the canonical governance boundary', () => {
  const routes = {
    'POST /api/subscribers': ['src/app/api/subscribers/route.ts', 'DIRECT_GOVERNED', 'SUBSCRIBER_OPERATIONS.CREATE'],
    'PUT /api/subscribers/:imsi': ['src/app/api/subscribers/[imsi]/route.ts', 'APPROVAL_GOVERNED', 'SUBSCRIBER_OPERATIONS.UPDATE'],
    'DELETE /api/subscribers/:imsi': ['src/app/api/subscribers/[imsi]/route.ts', 'APPROVAL_GOVERNED', 'SUBSCRIBER_OPERATIONS.DELETE'],
    'POST /api/subscribers/batch': ['src/app/api/subscribers/batch/route.ts', 'APPROVAL_GOVERNED', 'SUBSCRIBER_OPERATIONS.BATCH_CREATE'],
    'POST /api/subscribers/batch-update': ['src/app/api/subscribers/batch-update/route.ts', 'APPROVAL_GOVERNED', 'evaluateSubscriberOperationPolicy'],
    'POST /api/subscribers/bulk-delete': ['src/app/api/subscribers/bulk-delete/route.ts', 'APPROVAL_GOVERNED', 'SUBSCRIBER_OPERATIONS.BULK_DELETE'],
    'POST /api/subscribers/import': ['src/app/api/subscribers/import/route.ts', 'APPROVAL_GOVERNED', 'SUBSCRIBER_OPERATIONS.IMPORT'],
    'POST /api/subscribers/policy': ['src/app/api/subscribers/policy/route.ts', 'APPROVAL_GOVERNED', "action: 'POLICY_CHANGE'"],
    'POST /api/subscribers/:imsi/traffic-adjustments': ['src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts', 'APPROVAL_GOVERNED', "action: 'TRAFFIC_ADJUSTMENT'"],
  };
  for (const [route, [path, _status, marker]] of Object.entries(routes)) {
    assert.match(read(path), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), route);
  }
});

test('high-risk subscriber routes contain no super-admin direct-write bypasses', () => {
  for (const path of [
    'src/app/api/subscribers/[imsi]/route.ts',
    'src/app/api/subscribers/batch/route.ts',
    'src/app/api/subscribers/bulk-delete/route.ts',
    'src/app/api/subscribers/import/route.ts',
    'src/app/api/subscribers/policy/route.ts',
    'src/app/api/subscribers/[imsi]/traffic-adjustments/route.ts',
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /isSuperAdmin|capabilityDecision/);
  }
});

test('approval and audit snapshots never transport subscriber authentication material', () => {
  const governance = read('src/server/subscriberSingleGovernance.ts');
  const importer = read('src/app/api/subscribers/import/route.ts');
  assert.match(governance, /Never include security, K, OP\/OPc, AMF or SQN/);
  assert.match(governance, /SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED/);
  assert.match(importer, /SENSITIVE_SUBSCRIBER_CHANGE_NOT_SUPPORTED/);
  assert.match(importer, /SUBSCRIBER_IMPORT_OVERWRITE_NOT_SUPPORTED/);
});
