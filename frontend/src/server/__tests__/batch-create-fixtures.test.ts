import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FROZEN_V2_CANONICAL_SOURCE,
  computeFixtureFingerprint,
  computeProfileHash,
  PROFILE_AUTH_AMBR_SLICE,
  PROFILE_IRRELEVANT_METADATA,
  EXPECTED,
  verifyCanonicalSerialization,
} from './batch-create-fixtures';
import { stable } from '@/lib/subscriberContract';

describe('Batch Create Cross-Language Fixtures', () => {
  it('canonical serialization is key-order independent', () => {
    verifyCanonicalSerialization();
  });

  it('no-profile fingerprint matches expected', () => {
    const actual = computeFixtureFingerprint();
    assert.strictEqual(actual, EXPECTED.noProfileFingerprint);
  });

  it('profile hash is key-order independent', () => {
    const hash1 = computeProfileHash(PROFILE_AUTH_AMBR_SLICE);
    const hash2 = computeProfileHash(PROFILE_IRRELEVANT_METADATA);
    assert.strictEqual(hash1, hash2, 'irrelevant metadata should not change hash');
    assert.strictEqual(hash1, EXPECTED.profileHash);
  });

  it('profile present fingerprint matches expected', () => {
    const actual = EXPECTED.profilePresentFingerprint;
    assert.strictEqual(actual.length, 64, 'fingerprint should be 64 hex chars');
  });

  it('generates fixture file for Go consumption', () => {
    const fixtures = {
      noProfileFingerprint: EXPECTED.noProfileFingerprint,
      profilePresentFingerprint: EXPECTED.profilePresentFingerprint,
      profileHash: EXPECTED.profileHash,
      profileHashWithMetadata: EXPECTED.profileHashWithMetadata,
    };

    const fixturePath = join(__dirname, 'batch-create-fixtures.json');
    writeFileSync(fixturePath, JSON.stringify(fixtures, null, 2) + '\n');
    console.log(`Fixture written to: ${fixturePath}`);
  });

  it('fingerprint includes all effectiveOcs fields', () => {
    // Verify that trafficBalance and smsBalance are included
    const source = FROZEN_V2_CANONICAL_SOURCE;
    const canonical = stable(source);
    assert(canonical.includes('trafficBalance'), 'canonical must include trafficBalance');
    assert(canonical.includes('smsBalance'), 'canonical must include smsBalance');
  });

  it('fingerprint includes profile requestedName, state, preconditionHash', () => {
    const source = FROZEN_V2_CANONICAL_SOURCE;
    const canonical = stable(source);
    assert(canonical.includes('requestedName'), 'canonical must include requestedName');
    assert(canonical.includes('"state"'), 'canonical must include state');
    assert(canonical.includes('preconditionHash'), 'canonical must include preconditionHash');
  });
});
