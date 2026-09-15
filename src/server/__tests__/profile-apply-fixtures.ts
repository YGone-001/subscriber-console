/**
 * Cross-runtime fixtures for Subscriber Profile Apply.
 * Node and Go must produce identical hashes for:
 * - Subscriber precondition hash
 * - Profile precondition hash
 * - Operation fingerprint
 *
 * This file imports canonical helpers from production code.
 * Do NOT duplicate hash/fingerprint/stable logic here.
 */

import { stable, hash, type SafeSnapshot } from '@/lib/subscriberContract';
import {
  computeSubscriberPreconditionHash,
  computeProfilePreconditionHash,
  computeProfileApplyFingerprint,
} from '@/server/subscriberProfileApplyGovernance';
import type { XcloudSubscriberDocument } from '@/types/xcloud';
import type { ProfileDocument } from '@/server/repositories/profileRepository';

// ─── Fixture Data ───

/**
 * Subscriber document with all precondition hash fields.
 * Typed as XcloudSubscriberDocument for direct use with production helpers.
 */
export const SUBSCRIBER_FIXTURE: XcloudSubscriberDocument = {
  schema_version: 1,
  imsi: '460001234567890',
  msisdn: ['13800138000', '13900139000'],
  imeisv: '',
  security: {
    opc: 'aabbccddee00112233445566778899ff',
    amf: '8000',
    k: '00112233445566778899aabbccddeeff',
    sqn: 1234,
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
          qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
          pcc_rule: [],
        },
      ],
    },
  ],
  access_restriction_data: 4,
  subscriber_status: 0,
  network_access_mode: 0,
  subscribed_rau_tau_timer: 0,
  webui_meta: { profile_name: 'basic-4g' },
};

/**
 * Profile document with all precondition hash fields.
 * Typed as ProfileDocument for direct use with production helpers.
 */
export const PROFILE_FIXTURE: ProfileDocument = {
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
          qos: { index: 9, arp: { priority_level: 8, pre_emption_capability: 1, pre_emption_vulnerability: 1 } },
          pcc_rule: [],
        },
      ],
    },
  ],
  access_restriction_data: 32,
} as unknown as ProfileDocument;

/**
 * Second subscriber with different profile_name to test hash difference.
 */
export const SUBSCRIBER_WITH_DIFFERENT_PROFILE: XcloudSubscriberDocument = {
  ...SUBSCRIBER_FIXTURE,
  webui_meta: { profile_name: 'standard-5g' },
};

// ─── After Preview SafeSnapshot ───
// This represents the subscriber state after profile apply.
// Profile applies: auth, ambr, sliceList (→ slice), access_restriction_data
const AFTER_PREVIEW: SafeSnapshot = {
  imsi: SUBSCRIBER_FIXTURE.imsi,
  msisdn: SUBSCRIBER_FIXTURE.msisdn,
  accessRestrictionData: PROFILE_FIXTURE.access_restriction_data as number,
  networkAccessMode: SUBSCRIBER_FIXTURE.network_access_mode,
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
          pcc_rule: (se as Record<string, unknown>).pcc_rule || [],
        };
      }),
    };
  }),
};

// ─── Pre-computed Expected Hashes ───
// These values must match Go test expectations exactly.
// Computed using PRODUCTION canonical helpers, not test-side copies.

export const EXPECTED = {
  subscriberHash: computeSubscriberPreconditionHash(SUBSCRIBER_FIXTURE),
  subscriberHashDifferentProfile: computeSubscriberPreconditionHash(SUBSCRIBER_WITH_DIFFERENT_PROFILE),
  profileHash: computeProfilePreconditionHash(PROFILE_FIXTURE),
  fingerprint: computeProfileApplyFingerprint(
    SUBSCRIBER_FIXTURE.imsi,
    PROFILE_FIXTURE.name as string,
    computeSubscriberPreconditionHash(SUBSCRIBER_FIXTURE),
    computeProfilePreconditionHash(PROFILE_FIXTURE),
    AFTER_PREVIEW
  ),
};

export { AFTER_PREVIEW };

/**
 * Verify canonical serialization is key-order independent.
 * Uses production stable() from subscriberContract.
 */
export function verifyCanonicalSerialization(): void {
  const a = { b: 1, a: { d: 3, c: 2 } };
  const b = { a: { c: 2, d: 3 }, b: 1 };
  const fa = hash(a);
  const fb = hash(b);
  if (fa !== fb) {
    throw new Error(`Key-order independence failed: ${fa} !== ${fb}`);
  }
}
