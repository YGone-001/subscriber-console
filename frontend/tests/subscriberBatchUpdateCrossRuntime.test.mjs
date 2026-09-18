import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Import production fixture and hash functions
const {
  ACCESS_RESTRICTION_FIXTURE,
  AMBR_DOWNLINK_FIXTURE,
  AMBR_UPLINK_FIXTURE,
  AMBR_BOTH_FIXTURE,
  COMBINED_FIXTURE,
  MULTI_IMSI_FIXTURE,
  verifyCanonicalSerialization,
} = await import('../src/server/__tests__/batch-update-fixtures.ts');

// Load committed JSON fixtures
const fixtureJson = JSON.parse(
  readFileSync(new URL('../src/server/__tests__/batch-update-fixtures.json', import.meta.url), 'utf8')
);

// ─── Fingerprint Parity ───
test('fingerprint: accessRestriction fixture matches committed JSON', () => {
  assert.equal(ACCESS_RESTRICTION_FIXTURE.operationFingerprint, fixtureJson.accessRestriction.operationFingerprint);
});

test('fingerprint: ambrDownlink fixture matches committed JSON', () => {
  assert.equal(AMBR_DOWNLINK_FIXTURE.operationFingerprint, fixtureJson.ambrDownlink.operationFingerprint);
});

test('fingerprint: ambrUplink fixture matches committed JSON', () => {
  assert.equal(AMBR_UPLINK_FIXTURE.operationFingerprint, fixtureJson.ambrUplink.operationFingerprint);
});

test('fingerprint: ambrBoth fixture matches committed JSON', () => {
  assert.equal(AMBR_BOTH_FIXTURE.operationFingerprint, fixtureJson.ambrBoth.operationFingerprint);
});

test('fingerprint: combined fixture matches committed JSON', () => {
  assert.equal(COMBINED_FIXTURE.operationFingerprint, fixtureJson.combined.operationFingerprint);
});

test('fingerprint: multiImsi fixture matches committed JSON', () => {
  assert.equal(MULTI_IMSI_FIXTURE.operationFingerprint, fixtureJson.multiImsi.operationFingerprint);
});

// ─── Snapshot Bytes Parity ───
test('snapshotBytes: accessRestriction fixture matches committed JSON', () => {
  assert.equal(ACCESS_RESTRICTION_FIXTURE.snapshotBytes, fixtureJson.accessRestriction.snapshotBytes);
});

test('snapshotBytes: ambrDownlink fixture matches committed JSON', () => {
  assert.equal(AMBR_DOWNLINK_FIXTURE.snapshotBytes, fixtureJson.ambrDownlink.snapshotBytes);
});

test('snapshotBytes: ambrUplink fixture matches committed JSON', () => {
  assert.equal(AMBR_UPLINK_FIXTURE.snapshotBytes, fixtureJson.ambrUplink.snapshotBytes);
});

test('snapshotBytes: ambrBoth fixture matches committed JSON', () => {
  assert.equal(AMBR_BOTH_FIXTURE.snapshotBytes, fixtureJson.ambrBoth.snapshotBytes);
});

test('snapshotBytes: combined fixture matches committed JSON', () => {
  assert.equal(COMBINED_FIXTURE.snapshotBytes, fixtureJson.combined.snapshotBytes);
});

test('snapshotBytes: multiImsi fixture matches committed JSON', () => {
  assert.equal(MULTI_IMSI_FIXTURE.snapshotBytes, fixtureJson.multiImsi.snapshotBytes);
});

// ─── fieldNames Parity ───
test('fieldNames: accessRestriction fixture has correct fieldNames', () => {
  assert.deepEqual(ACCESS_RESTRICTION_FIXTURE.fieldNames, ['access_restriction_data']);
});

test('fieldNames: ambrDownlink fixture has correct fieldNames', () => {
  assert.deepEqual(AMBR_DOWNLINK_FIXTURE.fieldNames, ['ambr.downlink']);
});

test('fieldNames: ambrUplink fixture has correct fieldNames', () => {
  assert.deepEqual(AMBR_UPLINK_FIXTURE.fieldNames, ['ambr.uplink']);
});

test('fieldNames: ambrBoth fixture has correct fieldNames', () => {
  assert.deepEqual(AMBR_BOTH_FIXTURE.fieldNames, ['ambr.downlink', 'ambr.uplink']);
});

test('fieldNames: combined fixture has correct fieldNames', () => {
  assert.deepEqual(COMBINED_FIXTURE.fieldNames, ['access_restriction_data', 'ambr.downlink']);
});

test('fieldNames: multiImsi fixture has correct fieldNames', () => {
  assert.deepEqual(MULTI_IMSI_FIXTURE.fieldNames, ['access_restriction_data']);
});

// ─── Key-Order Independence ───
test('canonical serialization is key-order independent', () => {
  verifyCanonicalSerialization();
});

// ─── Fixture File Integrity ───
test('committed fixture JSON has all required keys', () => {
  assert.ok(fixtureJson.accessRestriction, 'accessRestriction present');
  assert.ok(fixtureJson.ambrDownlink, 'ambrDownlink present');
  assert.ok(fixtureJson.ambrUplink, 'ambrUplink present');
  assert.ok(fixtureJson.ambrBoth, 'ambrBoth present');
  assert.ok(fixtureJson.combined, 'combined present');
  assert.ok(fixtureJson.multiImsi, 'multiImsi present');
});

test('fixture fingerprints are valid hex SHA-256', () => {
  const sha256Hex = /^[a-f0-9]{64}$/;
  assert.match(fixtureJson.accessRestriction.operationFingerprint, sha256Hex);
  assert.match(fixtureJson.ambrDownlink.operationFingerprint, sha256Hex);
  assert.match(fixtureJson.ambrUplink.operationFingerprint, sha256Hex);
  assert.match(fixtureJson.ambrBoth.operationFingerprint, sha256Hex);
  assert.match(fixtureJson.combined.operationFingerprint, sha256Hex);
  assert.match(fixtureJson.multiImsi.operationFingerprint, sha256Hex);
});

test('fixture preconditionHashes are valid hex SHA-256', () => {
  const sha256Hex = /^[a-f0-9]{64}$/;
  for (const fixture of Object.values(fixtureJson)) {
    for (const target of fixture.targets) {
      assert.match(target.preconditionHash, sha256Hex);
    }
  }
});
