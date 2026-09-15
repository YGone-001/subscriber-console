import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Import production fixture and hash functions
const {
  SUBSCRIBER_FIXTURE,
  PROFILE_FIXTURE,
  SUBSCRIBER_WITH_DIFFERENT_PROFILE,
  EXPECTED,
  AFTER_PREVIEW,
  computeSubscriberHash,
  computeProfileHash,
  computeFingerprint,
  verifyCanonicalSerialization,
} = await import('../src/server/__tests__/profile-apply-fixtures.ts');

// Load committed JSON fixtures
const fixtureJson = JSON.parse(
  readFileSync(new URL('../src/server/__tests__/profile-apply-fixtures.json', import.meta.url), 'utf8')
);

// ─── Subscriber Precondition Hash ───
test('subscriber hash: committed JSON matches live computation', () => {
  assert.equal(EXPECTED.subscriberHash, fixtureJson.subscriberHash);
});

test('subscriber hash: live computation matches fixture data', () => {
  assert.equal(computeSubscriberHash(SUBSCRIBER_FIXTURE), fixtureJson.subscriberHash);
});

test('subscriber hash: different profile_name produces different hash', () => {
  assert.notEqual(computeSubscriberHash(SUBSCRIBER_WITH_DIFFERENT_PROFILE), fixtureJson.subscriberHash);
  assert.equal(computeSubscriberHash(SUBSCRIBER_WITH_DIFFERENT_PROFILE), fixtureJson.subscriberHashDifferentProfile);
});

// ─── Profile Precondition Hash ───
test('profile hash: committed JSON matches live computation', () => {
  assert.equal(EXPECTED.profileHash, fixtureJson.profileHash);
});

test('profile hash: live computation matches fixture data', () => {
  assert.equal(computeProfileHash(PROFILE_FIXTURE), fixtureJson.profileHash);
});

// ─── Operation Fingerprint ───
test('fingerprint: committed JSON matches live computation', () => {
  assert.equal(EXPECTED.fingerprint, fixtureJson.fingerprint);
});

test('fingerprint: live computation matches fixture data', () => {
  assert.equal(
    computeFingerprint(
      SUBSCRIBER_FIXTURE.imsi,
      PROFILE_FIXTURE.name,
      computeSubscriberHash(SUBSCRIBER_FIXTURE),
      computeProfileHash(PROFILE_FIXTURE),
      AFTER_PREVIEW
    ),
    fixtureJson.fingerprint
  );
});

// ─── Key-Order Independence ───
test('canonical serialization is key-order independent', () => {
  // Should not throw
  verifyCanonicalSerialization();
});

// ─── Fixture File Integrity ───
test('committed fixture JSON has all required keys', () => {
  assert.ok(fixtureJson.subscriberHash, 'subscriberHash present');
  assert.ok(fixtureJson.subscriberHashDifferentProfile, 'subscriberHashDifferentProfile present');
  assert.ok(fixtureJson.profileHash, 'profileHash present');
  assert.ok(fixtureJson.fingerprint, 'fingerprint present');
  assert.ok(fixtureJson.fixtures, 'fixtures present');
  assert.ok(fixtureJson.fixtures.subscriber, 'fixtures.subscriber present');
  assert.ok(fixtureJson.fixtures.profile, 'fixtures.profile present');
});

test('fixture hashes are valid hex SHA-256', () => {
  const sha256Hex = /^[a-f0-9]{64}$/;
  assert.match(fixtureJson.subscriberHash, sha256Hex);
  assert.match(fixtureJson.subscriberHashDifferentProfile, sha256Hex);
  assert.match(fixtureJson.profileHash, sha256Hex);
  assert.match(fixtureJson.fingerprint, sha256Hex);
});

// ─── Sentinel Leak Detection ───
test('sentinel: subscriber hash fields do not include forbidden fields', () => {
  // The subscriber hash must NOT include: enabled, subscriber_status, operator_specific_data
  // These fields were previously incorrectly included in Go implementation.
  const subscriberWithSentinel = {
    ...SUBSCRIBER_FIXTURE,
    enabled: false,  // Should NOT affect hash
    subscriber_status: 1,  // Should NOT affect hash
    operator_specific_data: 'sentinel-value',  // Should NOT affect hash
  };

  const hashOriginal = computeSubscriberHash(SUBSCRIBER_FIXTURE);
  const hashWithSentinel = computeSubscriberHash(subscriberWithSentinel);

  assert.equal(hashOriginal, hashWithSentinel, 'sentinel fields must not affect subscriber hash');
});

test('sentinel: profile hash fields do not include forbidden fields', () => {
  // The profile hash must NOT include: name, mcc, mnc, enabled, etc.
  const profileWithSentinel = {
    ...PROFILE_FIXTURE,
    name: 'different-name',  // Should NOT affect hash
    mcc: '999',  // Should NOT affect hash
    mnc: '99',  // Should NOT affect hash
    enabled: false,  // Should NOT affect hash
  };

  const hashOriginal = computeProfileHash(PROFILE_FIXTURE);
  const hashWithSentinel = computeProfileHash(profileWithSentinel);

  assert.equal(hashOriginal, hashWithSentinel, 'sentinel fields must not affect profile hash');
});

// ─── Hash Determinism ───
test('hashes are deterministic across multiple calls', () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(computeSubscriberHash(SUBSCRIBER_FIXTURE), fixtureJson.subscriberHash);
    assert.equal(computeProfileHash(PROFILE_FIXTURE), fixtureJson.profileHash);
  }
});
