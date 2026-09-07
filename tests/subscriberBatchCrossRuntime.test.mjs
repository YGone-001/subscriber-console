import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Import production fixture and hash functions
const {
  PROFILE_AUTH_AMBR_SLICE,
  PROFILE_IRRELEVANT_METADATA,
  EXPECTED,
  computeFixtureFingerprint,
  computeProfileHash,
  verifyCanonicalSerialization,
} = await import('../src/server/__tests__/batch-create-fixtures.ts');

// Load committed JSON fixtures
const fixtureJson = JSON.parse(
  readFileSync(new URL('../src/server/__tests__/batch-create-fixtures.json', import.meta.url), 'utf8')
);

// ─── Fingerprint Parity ───
test('fingerprint: committed JSON matches live computation', () => {
  assert.equal(fixtureJson.noProfileFingerprint, EXPECTED.noProfileFingerprint);
  assert.equal(fixtureJson.profilePresentFingerprint, EXPECTED.profilePresentFingerprint);
});

test('fingerprint: noProfileFingerprint matches direct computation', () => {
  assert.equal(computeFixtureFingerprint(), fixtureJson.noProfileFingerprint);
});

// ─── Profile Hash Parity ───
test('profile hash: committed JSON matches live computation', () => {
  assert.equal(fixtureJson.profileHash, EXPECTED.profileHash);
  assert.equal(fixtureJson.profileHashWithMetadata, EXPECTED.profileHashWithMetadata);
});

test('profile hash: metadata-irrelevant fields do not change hash', () => {
  const hashAuth = computeProfileHash(PROFILE_AUTH_AMBR_SLICE);
  const hashFull = computeProfileHash(PROFILE_IRRELEVANT_METADATA);
  assert.equal(hashAuth, hashFull);
  assert.equal(hashAuth, fixtureJson.profileHash);
});

// ─── Key-Order Independence ───
test('canonical serialization is key-order independent', () => {
  // Should not throw
  verifyCanonicalSerialization();
});

// ─── Fixture File Integrity ───
test('committed fixture JSON has all required keys', () => {
  assert.ok(fixtureJson.noProfileFingerprint, 'noProfileFingerprint present');
  assert.ok(fixtureJson.profilePresentFingerprint, 'profilePresentFingerprint present');
  assert.ok(fixtureJson.profileHash, 'profileHash present');
  assert.ok(fixtureJson.profileHashWithMetadata, 'profileHashWithMetadata present');
});

test('fixture fingerprints are valid hex SHA-256', () => {
  const sha256Hex = /^[a-f0-9]{64}$/;
  assert.match(fixtureJson.noProfileFingerprint, sha256Hex);
  assert.match(fixtureJson.profilePresentFingerprint, sha256Hex);
  assert.match(fixtureJson.profileHash, sha256Hex);
  assert.match(fixtureJson.profileHashWithMetadata, sha256Hex);
});
