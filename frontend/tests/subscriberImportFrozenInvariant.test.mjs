// tests/subscriberImportFrozenInvariant.test.mjs
// Prepare→Assert production invariant and frozen tamper tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash as realCreateHash } from 'node:crypto';
import { loadModule } from './helpers/loadModule.mjs';

// Production-like contract functions for deterministic hashing
function productionStable(value) {
  if (Array.isArray(value)) return `[${value.map(productionStable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${productionStable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function productionHash(value) {
  return realCreateHash('sha256').update(productionStable(value)).digest('hex');
}
function productionSafeSnapshot(doc) {
  if (!doc) return {};
  const { k, op, opc, amf, sqn, security, ...safe } = doc;
  return safe;
}

// Mock only the DB layer — production logic for contract functions
const mockDependencies = {
  '@/lib/subscriberContract': {
    stable: productionStable,
    hash: productionHash,
    subscriberSafeSnapshot: productionSafeSnapshot,
  },
  '@/types/xcloud': {},
  '@/lib/xcloudSubscriber': {
    buildXcloudSubscriberFromLegacy: (imsi, payload, existing) => ({ ...existing, ...payload }),
  },
  '@/server/repositories/subscriberRepository': {
    findSubscriberDocument: async (imsi) => {
      // present: 454000000000001; absent: everything else
      if (imsi === '454000000000001') {
        return { imsi, access_restriction_data: 32, security: {}, ocsTraffic: {} };
      }
      return null;
    },
    insertSubscriberImportCreateOnly: async () => {},
    provisionImportedSubscriberOcs: async () => {},
    deleteSubscriber: async () => true,
    conditionalDeleteSubscriber: async () => true,
    deleteSubscriberOcsProvisioning: async () => {},
    updateSubscriberFromLegacy: async () => ({}),
    findSubscriberLegacyState: async () => null,
  },
  '@/lib/xcloudSubscriber': {
    buildXcloudSubscriberFromLegacy: (imsi, payload, existing) => ({ ...existing, ...payload }),
  },
};

const govModule = loadModule(
  'src/server/subscriberSingleGovernance.ts',
  mockDependencies
);

const CANONICAL_FIELD_NAMES = [
  'access_restriction_data',
  'plan_id',
  'sms_balance',
  'sms_total',
  'traffic_balance',
  'traffic_total',
];

// ---------------------------------------------------------------------------
// Section 3: Prepare→Assert Production Invariant
// ---------------------------------------------------------------------------

test('Prepare→Assert: IMSI only', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  assert.equal(frozen.summary.fieldNames.length, 6);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  // Must not throw
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
});

test('Prepare→Assert: IMSI + traffic_balance only', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', traffic_balance: 5000000000 },
  ]);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
  // traffic_total defaults to traffic_balance
  assert.equal(frozen.records[0].traffic_total, 5000000000);
  assert.equal(frozen.records[0].traffic_balance, 5000000000);
});

test('Prepare→Assert: IMSI + sms_balance only', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', sms_balance: 50 },
  ]);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
  // sms_total defaults to sms_balance
  assert.equal(frozen.records[0].sms_total, 50);
  assert.equal(frozen.records[0].sms_balance, 50);
});

test('Prepare→Assert: IMSI + ARD only', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', access_restriction_data: 128 },
  ]);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
  assert.equal(frozen.records[0].access_restriction_data, 128);
});

test('Prepare→Assert: IMSI + plan_id only', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', plan_id: 'custom_plan' },
  ]);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
  assert.equal(frozen.records[0].plan_id, 'custom_plan');
});

test('Prepare→Assert: all supported fields', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    {
      imsi: '454000000000002',
      access_restriction_data: 64,
      traffic_total: 20000000000,
      traffic_balance: 10000000000,
      sms_total: 200,
      sms_balance: 100,
      plan_id: 'premium_plan',
    },
  ]);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
});

test('Prepare→Assert: mixed rows with different raw optional-column presence', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000003' },
    { imsi: '454000000000004', traffic_balance: 5000000000 },
    { imsi: '454000000000005', sms_balance: 25, plan_id: 'custom' },
    { imsi: '454000000000006', access_restriction_data: 0, traffic_total: 1000, sms_total: 10 },
  ]);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  assert.equal(frozen.targetCount, 4);
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
});

// ---------------------------------------------------------------------------
// Section 9: Frozen Tamper Tests
// ---------------------------------------------------------------------------

test('tamper: invalid IMSI in records', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.records[0].imsi = 'invalid';
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: recordIntentHash modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.targets[0].recordIntentHash = 'tampered';
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: target state modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.targets[0].state = 'present';
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: target order modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000003' },
    { imsi: '454000000000004' },
  ]);
  frozen.targets.reverse();
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: record order modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000003' },
    { imsi: '454000000000004' },
  ]);
  frozen.records.reverse();
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: summary.rowCount modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.summary.rowCount = 999;
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: summary.createCount modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.summary.createCount = 999;
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: summary.skipCount modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.summary.skipCount = 999;
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: summary.fieldNames missing', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.summary.fieldNames = [];
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: summary.fieldNames extra', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.summary.fieldNames = [...CANONICAL_FIELD_NAMES, 'extra'];
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: summary.fieldNames wrong order', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.summary.fieldNames = [...CANONICAL_FIELD_NAMES].reverse();
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: fileHash modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.summary.fileHash = 'tampered';
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: operationFingerprint modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.operationFingerprint = 'tampered';
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

test('tamper: snapshotBytes modified', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  frozen.snapshotBytes = 0;
  assert.throws(() => govModule.assertFrozenSubscriberImportV2(frozen), /INVALID_SUBSCRIBER_IMPORT_PAYLOAD/);
});

// ---------------------------------------------------------------------------
// Section 8: Snapshot cap — real Prepare
// ---------------------------------------------------------------------------

test('snapshot cap: normal below-cap Prepare→Assert succeeds', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
  ]);
  assert.ok(frozen.snapshotBytes <= 512 * 1024);
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
});

// ---------------------------------------------------------------------------
// Section 5: Cross-runtime fixture data (record-order invariant, key-order invariant, OCS defaults)
// ---------------------------------------------------------------------------

test('fixture: row-order reversed → same normalized ordering, fileHash, fingerprint', async () => {
  const a = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000003' },
    { imsi: '454000000000002' },
  ]);
  const b = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
    { imsi: '454000000000003' },
  ]);
  assert.equal(a.summary.fileHash, b.summary.fileHash);
  assert.equal(a.operationFingerprint, b.operationFingerprint);
  assert.equal(JSON.stringify(a.records), JSON.stringify(b.records));
  assert.equal(JSON.stringify(a.targets), JSON.stringify(b.targets));
});

test('fixture: traffic_balance supplied, traffic_total omitted → total == balance', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', traffic_balance: 5000000000 },
  ]);
  assert.equal(frozen.records[0].traffic_total, 5000000000);
  assert.equal(frozen.records[0].traffic_balance, 5000000000);
});

test('fixture: sms_balance supplied, sms_total omitted → total == balance', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', sms_balance: 50 },
  ]);
  assert.equal(frozen.records[0].sms_total, 50);
  assert.equal(frozen.records[0].sms_balance, 50);
});

test('fixture: plan_id changed → recordIntentHash changes, fingerprint changes', async () => {
  const a = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', plan_id: 'plan_a' },
  ]);
  const b = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', plan_id: 'plan_b' },
  ]);
  assert.notEqual(a.targets[0].recordIntentHash, b.targets[0].recordIntentHash);
  assert.notEqual(a.operationFingerprint, b.operationFingerprint);
});

test('fixture: ARD changed → recordIntentHash changes, fingerprint changes', async () => {
  const a = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', access_restriction_data: 32 },
  ]);
  const b = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002', access_restriction_data: 64 },
  ]);
  assert.notEqual(a.targets[0].recordIntentHash, b.targets[0].recordIntentHash);
  assert.notEqual(a.operationFingerprint, b.operationFingerprint);
});

test('fixture: two absent rows', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000002' },
    { imsi: '454000000000003' },
  ]);
  assert.equal(frozen.summary.createCount, 2);
  assert.equal(frozen.summary.skipCount, 0);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
});

test('fixture: present + absent', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000001' }, // present (mock returns doc)
    { imsi: '454000000000002' }, // absent
  ]);
  assert.equal(frozen.summary.createCount, 1);
  assert.equal(frozen.summary.skipCount, 1);
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
});

test('fixture: all present', async () => {
  // Only 454000000000001 is present in mock — use two copies of it via single row
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000001' },
  ]);
  assert.equal(frozen.summary.createCount, 0);
  assert.equal(frozen.summary.skipCount, 1);
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
});

test('fixture: all-present multi-row (only known present IMSI)', async () => {
  // Mock only knows 454000000000001 as present, so single-row all-present is the max
  const frozen = await govModule.prepareFrozenSubscriberImport([
    { imsi: '454000000000001' },
  ]);
  assert.equal(JSON.stringify(frozen.summary.fieldNames), JSON.stringify(CANONICAL_FIELD_NAMES));
  assert.doesNotThrow(() => govModule.assertFrozenSubscriberImportV2(frozen));
});

// Canonical values for cross-runtime comparison
test('fixture: canonical all-fields values for cross-runtime comparison', async () => {
  const frozen = await govModule.prepareFrozenSubscriberImport([
    {
      imsi: '454000000000002',
      access_restriction_data: 32,
      traffic_total: 10737418240,
      traffic_balance: 10737418240,
      sms_total: 100,
      sms_balance: 100,
      plan_id: 'plan_default_10gb',
    },
  ]);

  // Print canonical values for Go fixture consumption
  console.log('CROSS_RUNTIME_FIXTURE_ALL_FIELDS=' + JSON.stringify({
    normalized: frozen.records,
    targets: frozen.targets,
    recordIntentHash: frozen.targets[0].recordIntentHash,
    fieldNames: frozen.summary.fieldNames,
    fileHash: frozen.summary.fileHash,
    strategy: frozen.strategy,
    operationFingerprint: frozen.operationFingerprint,
    snapshotBytes: frozen.snapshotBytes,
  }));
  assert.ok(frozen.snapshotBytes > 0);
});
