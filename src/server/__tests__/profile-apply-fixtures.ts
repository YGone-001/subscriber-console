/**
 * Cross-runtime fixtures for Subscriber Profile Apply.
 * Node and Go must produce identical hashes for:
 * - Subscriber precondition hash
 * - Profile precondition hash
 * - Operation fingerprint
 */

import { createHash } from 'node:crypto';

type SafeSnapshot = {
  imsi: string;
  msisdn: string[];
  accessRestrictionData: number;
  networkAccessMode: number;
  ambr: unknown;
  slices: unknown;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

// ─── Fixture Data ───

/**
 * Subscriber document with all precondition hash fields.
 * Matches the fields in computeSubscriberPreconditionHash:
 * - imsi, msisdn, security, ambr, slice, access_restriction_data,
 *   network_access_mode, webui_meta.profile_name
 */
export const SUBSCRIBER_FIXTURE = {
  imsi: '460001234567890',
  msisdn: ['13800138000', '13900139000'],
  security: {
    opc: 'aabbccddee00112233445566778899ff',
    amf: '8000',
    k: '00112233445566778899aabbccddeeff',
    sqn: '000000001234',
  },
  ambr: {
    downlink: { value: 50, unit: 3 },
    uplink: { value: 25, unit: 3 },
  },
  slice: [
    {
      sst: 1,
      sd: '000001',
      session: [
        {
          name: 'internet',
          type: 3,
          ambr: { downlink: { value: 50, unit: 3 }, uplink: { value: 25, unit: 3 } },
          qos: { index: 9, arp: { priorityLevel: 8, preemptionCapability: 1, preemptionVulnerability: 1 } },
          pccRuleList: [],
        },
      ],
    },
  ],
  access_restriction_data: 4,
  network_access_mode: 0,
  webui_meta: { profile_name: 'basic-4g' },
};

/**
 * Profile document with all precondition hash fields.
 * Matches the fields in computeProfilePreconditionHash:
 * - auth, ambr, sliceList, access_restriction_data
 */
export const PROFILE_FIXTURE = {
  name: 'premium-5g',
  auth: {
    opc: 'aabbccddee00112233445566778899ff',
    amf: '8000',
    k: '00112233445566778899aabbccddeeff',
  },
  ambr: {
    downlink: { value: 100, unit: 3 },
    uplink: { value: 50, unit: 3 },
  },
  sliceList: [
    {
      sst: 1,
      sd: '000001',
      session_list: [
        {
          name: 'internet',
          type: 3,
          ambr: { downlink: { value: 100, unit: 3 }, uplink: { value: 50, unit: 3 } },
          qos: { index: 9, arp: { priorityLevel: 8, preemptionCapability: 1, preemptionVulnerability: 1 } },
          pccRuleList: [],
        },
      ],
    },
  ],
  access_restriction_data: 32,
};

/**
 * Second subscriber with different profile_name to test hash difference.
 */
export const SUBSCRIBER_WITH_DIFFERENT_PROFILE = {
  ...SUBSCRIBER_FIXTURE,
  webui_meta: { profile_name: 'standard-5g' },
};

/**
 * Compute subscriber precondition hash (must match Go computeSubscriberPreconditionHash).
 * Fields: imsi, msisdn, security, ambr, slice, access_restriction_data,
 *         network_access_mode, webui_meta.profile_name
 */
export function computeSubscriberHash(subscriber: Record<string, unknown>): string {
  const state = {
    imsi: subscriber.imsi,
    msisdn: subscriber.msisdn || [],
    security: subscriber.security || {},
    ambr: subscriber.ambr,
    slice: subscriber.slice,
    access_restriction_data: subscriber.access_restriction_data,
    network_access_mode: subscriber.network_access_mode,
    webui_meta: { profile_name: (subscriber as Record<string, unknown>).webui_meta?.profile_name || '' },
  };
  return fingerprint(state);
}

/**
 * Compute profile precondition hash (must match Go computeProfilePreconditionHash).
 * Fields: auth, ambr, sliceList, access_restriction_data
 */
export function computeProfileHash(profile: Record<string, unknown>): string {
  const state = {
    auth: profile.auth,
    ambr: profile.ambr,
    sliceList: profile.sliceList,
    access_restriction_data: profile.access_restriction_data,
  };
  return fingerprint(state);
}

/**
 * Compute profile apply fingerprint (must match Go computeProfileApplyFingerprint).
 * Fields: operation, imsi, profileName, subscriberPreconditionHash,
 *         profilePreconditionHash, afterPreview
 */
export function computeFingerprint(
  imsi: string,
  profileName: string,
  subHash: string,
  profHash: string,
  afterPreview: SafeSnapshot
): string {
  const state = {
    operation: 'SUBSCRIBER_PROFILE_APPLY',
    imsi,
    profileName,
    subscriberPreconditionHash: subHash,
    profilePreconditionHash: profHash,
    afterPreview,
  };
  return fingerprint(state);
}

// ─── After Preview SafeSnapshot ───
// This represents the subscriber state after profile apply.
// Profile applies: auth, ambr, sliceList (→ slice), access_restriction_data
const AFTER_PREVIEW: SafeSnapshot = {
  imsi: SUBSCRIBER_FIXTURE.imsi as string,
  msisdn: SUBSCRIBER_FIXTURE.msisdn as string[],
  accessRestrictionData: PROFILE_FIXTURE.access_restriction_data as number,
  networkAccessMode: SUBSCRIBER_FIXTURE.network_access_mode as number,
  ambr: PROFILE_FIXTURE.ambr,
  slices: (PROFILE_FIXTURE.sliceList as unknown[]).map((slice: unknown) => {
    const s = slice as Record<string, unknown>;
    return {
      sst: s.sst,
      sd: s.sd,
      session: (s.session_list as unknown[]).map((sess: unknown) => {
        const se = sess as Record<string, unknown>;
        return {
          name: se.name,
          type: se.type,
          ambr: se.ambr,
          qos: se.qos,
          pccRuleList: se.pccRuleList || [],
        };
      }),
    };
  }),
};

// ─── Pre-computed Expected Hashes ───
// These values must match Go test expectations exactly.

export const EXPECTED = {
  // Subscriber precondition hash for SUBSCRIBER_FIXTURE
  subscriberHash: computeSubscriberHash(SUBSCRIBER_FIXTURE),

  // Subscriber precondition hash with different profile_name
  subscriberHashDifferentProfile: computeSubscriberHash(SUBSCRIBER_WITH_DIFFERENT_PROFILE),

  // Profile precondition hash for PROFILE_FIXTURE
  profileHash: computeProfileHash(PROFILE_FIXTURE),

  // Operation fingerprint (includes afterPreview)
  fingerprint: computeFingerprint(
    SUBSCRIBER_FIXTURE.imsi as string,
    PROFILE_FIXTURE.name as string,
    computeSubscriberHash(SUBSCRIBER_FIXTURE),
    computeProfileHash(PROFILE_FIXTURE),
    AFTER_PREVIEW
  ),
};

export { AFTER_PREVIEW };

/**
 * Verify canonical serialization is key-order independent.
 */
export function verifyCanonicalSerialization(): void {
  const a = { b: 1, a: { d: 3, c: 2 } };
  const b = { a: { c: 2, d: 3 }, b: 1 };
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  if (fa !== fb) {
    throw new Error(`Key-order independence failed: ${fa} !== ${fb}`);
  }
}
