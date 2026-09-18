/**
 * Cross-Language Frozen v2 Fixtures
 *
 * Node production generates authoritative fixtures.
 * Go reads expected values only.
 *
 * These fixtures verify that Node and Go use identical:
 * - Canonical stable serialization
 * - SHA-256 fingerprint computation
 * - Profile precondition hash computation
 */

import { stable, hash } from '@/lib/subscriberContract';
import { profileExecutionHash } from '@/server/repositories/subscriberRepository';

// ─── Frozen v2 Contract Fixture ──────────────────────────────────────────────

export const FROZEN_V2_CANONICAL_SOURCE = {
  operation: 'SUBSCRIBER_BATCH_CREATE',
  targets: ['001010000000001', '001010000000002', '001010000000003'],
  effectiveOcs: {
    planId: 'plan_default_5gb',
    trafficTotal: 5368709120,
    trafficBalance: 5368709120,
    smsTotal: 100,
    smsBalance: 100,
  },
  profile: {
    requestedName: '',
    state: 'absent' as const,
    preconditionHash: '',
  },
  strategy: 'create-only',
};

export function computeFixtureFingerprint(): string {
  return hash(FROZEN_V2_CANONICAL_SOURCE);
}

// ─── Profile Hash Fixtures ───────────────────────────────────────────────────

export const PROFILE_AUTH_AMBR_SLICE = {
  auth: { k: '00000000000000000000000000000000', opc: '00000000000000000000000000000000', sqn: 1, amf: '8000' },
  ambr: { downlink: { value: 1, unit: 3 }, uplink: { value: 1, unit: 3 } },
  sliceList: [{ sst: 1, sd: '000001' }],
  ocsDefaults: { trafficTotal: 5368709120, smsTotal: 100 },
};

export const PROFILE_IRRELEVANT_METADATA = {
  _id: 'some-mongo-id',
  createdAt: new Date(),
  updatedAt: new Date(),
  displayName: 'Test Profile',
  ...PROFILE_AUTH_AMBR_SLICE,
};

export function computeProfileHash(profileData: Record<string, unknown>): string {
  return profileExecutionHash(profileData as Parameters<typeof profileExecutionHash>[0]);
}

// ─── Expected Values ─────────────────────────────────────────────────────────

export const EXPECTED = {
  // No-profile batch (5 GiB default, 100 SMS)
  noProfileFingerprint: computeFixtureFingerprint(),

  // Profile present fingerprint (with PROFILE_AUTH_AMBR_SLICE)
  profilePresentFingerprint: (() => {
    const profileHash = computeProfileHash(PROFILE_AUTH_AMBR_SLICE);
    const source = {
      ...FROZEN_V2_CANONICAL_SOURCE,
      profile: {
        requestedName: 'test_profile',
        state: 'present' as const,
        preconditionHash: profileHash,
      },
    };
    return hash(source);
  })(),

  // Profile hash for PROFILE_AUTH_AMBR_SLICE
  profileHash: computeProfileHash(PROFILE_AUTH_AMBR_SLICE),

  // Profile hash for PROFILE_IRRELEVANT_METADATA (should be same as above)
  profileHashWithMetadata: computeProfileHash(PROFILE_IRRELEVANT_METADATA),
} as const;

// ─── Canonical Serialization Test ────────────────────────────────────────────

export function verifyCanonicalSerialization(): void {
  // Key order changes → same hash
  const reordered = {
    strategy: 'create-only',
    operation: 'SUBSCRIBER_BATCH_CREATE',
    targets: ['001010000000001', '001010000000002', '001010000000003'],
    effectiveOcs: {
      smsBalance: 100,
      trafficTotal: 5368709120,
      planId: 'plan_default_5gb',
      trafficBalance: 5368709120,
      smsTotal: 100,
    },
    profile: {
      preconditionHash: '',
      state: 'absent',
      requestedName: '',
    },
  };

  const original = stable(FROZEN_V2_CANONICAL_SOURCE);
  const reorderedStable = stable(reordered);

  if (original !== reorderedStable) {
    throw new Error('Canonical serialization is not key-order independent');
  }
}
