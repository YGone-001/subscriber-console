/**
 * Cross-runtime fixtures for batch update v2.
 * Node produces, Go consumes.
 * Canonical fieldNames: access_restriction_data, ambr.downlink, ambr.uplink
 * Per-target before/after flattened: access_restriction_data, ambr.downlink.value, etc.
 */

import { createHash } from 'node:crypto';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

// ─── Fixture 1: accessRestrictionData only ───
const ACCESS_RESTRICTION_PATCH = { accessRestrictionData: 0 };

const ACCESS_RESTRICTION_TARGETS = [
  {
    imsi: '460001234567890',
    before: { access_restriction_data: 32 },
    after: { access_restriction_data: 0 },
  },
];

// ─── Fixture 2: AMBR downlink only ───
const AMBR_DOWNLINK_PATCH = { ambr: { downlink: { value: 100, unit: 1 } } };

const AMBR_DOWNLINK_TARGETS = [
  {
    imsi: '460001234567891',
    before: { 'ambr.downlink.value': 1, 'ambr.downlink.unit': 3 },
    after: { 'ambr.downlink.value': 100, 'ambr.downlink.unit': 1 },
  },
];

// ─── Fixture 3: AMBR uplink only ───
const AMBR_UPLINK_PATCH = { ambr: { uplink: { value: 50, unit: 2 } } };

const AMBR_UPLINK_TARGETS = [
  {
    imsi: '460001234567892',
    before: { 'ambr.uplink.value': 1, 'ambr.uplink.unit': 3 },
    after: { 'ambr.uplink.value': 50, 'ambr.uplink.unit': 2 },
  },
];

// ─── Fixture 4: Both AMBR directions ───
const AMBR_BOTH_PATCH = { ambr: { downlink: { value: 200, unit: 1 }, uplink: { value: 100, unit: 1 } } };

const AMBR_BOTH_TARGETS = [
  {
    imsi: '460001234567893',
    before: { 'ambr.downlink.value': 1, 'ambr.downlink.unit': 3, 'ambr.uplink.value': 1, 'ambr.uplink.unit': 3 },
    after: { 'ambr.downlink.value': 200, 'ambr.downlink.unit': 1, 'ambr.uplink.value': 100, 'ambr.uplink.unit': 1 },
  },
];

// ─── Fixture 5: accessRestrictionData + AMBR ───
const COMBINED_PATCH = { accessRestrictionData: 16, ambr: { downlink: { value: 500, unit: 1 } } };

const COMBINED_TARGETS = [
  {
    imsi: '460001234567894',
    before: { access_restriction_data: 32, 'ambr.downlink.value': 1, 'ambr.downlink.unit': 3 },
    after: { access_restriction_data: 16, 'ambr.downlink.value': 500, 'ambr.downlink.unit': 1 },
  },
];

// ─── Fixture 6: Multiple IMSIs ───
const MULTI_IMSI_PATCH = { accessRestrictionData: 0 };

const MULTI_IMSI_TARGETS = [
  {
    imsi: '460001234567890',
    before: { access_restriction_data: 32 },
    after: { access_restriction_data: 0 },
  },
  {
    imsi: '460001234567891',
    before: { access_restriction_data: 64 },
    after: { access_restriction_data: 0 },
  },
  {
    imsi: '460001234567892',
    before: { access_restriction_data: 128 },
    after: { access_restriction_data: 0 },
  },
];

// ─── Helper functions ───

function changedFieldNames(patch: Record<string, unknown>): string[] {
  const fields: string[] = [];
  if ('accessRestrictionData' in patch) fields.push('access_restriction_data');
  const ambr = patch.ambr as Record<string, unknown> | undefined;
  if (ambr?.downlink) fields.push('ambr.downlink');
  if (ambr?.uplink) fields.push('ambr.uplink');
  return fields.sort();
}

function computeFingerprint(targets: { imsi: string; preconditionHash: string; after: Record<string, number> }[], patch: Record<string, unknown>, fieldNames: string[]): string {
  return fingerprint({
    operation: 'SUBSCRIBER_BATCH_UPDATE',
    targets: targets.map((t) => ({ imsi: t.imsi, preconditionHash: t.preconditionHash, after: t.after })),
    patch,
    fieldNames,
  });
}

function buildFixture(targets: { imsi: string; before: Record<string, number>; after: Record<string, number> }[], patch: Record<string, unknown>) {
  const fieldNames = changedFieldNames(patch);
  const targetsWithHash = targets.map((t) => ({
    ...t,
    preconditionHash: fingerprint(t.before),
  }));
  const fingerprintValue = computeFingerprint(targetsWithHash, patch, fieldNames);
  const snapshotBytes = Buffer.byteLength(stableJson({ targets: targetsWithHash, patch, fieldNames, operationFingerprint: fingerprintValue }), 'utf8');
  return {
    targets: targetsWithHash,
    patch,
    fieldNames,
    targetCount: targetsWithHash.length,
    snapshotBytes,
    operationFingerprint: fingerprintValue,
  };
}

// ─── Exported fixtures ───

export const ACCESS_RESTRICTION_FIXTURE = buildFixture(ACCESS_RESTRICTION_TARGETS, ACCESS_RESTRICTION_PATCH);
export const AMBR_DOWNLINK_FIXTURE = buildFixture(AMBR_DOWNLINK_TARGETS, AMBR_DOWNLINK_PATCH);
export const AMBR_UPLINK_FIXTURE = buildFixture(AMBR_UPLINK_TARGETS, AMBR_UPLINK_PATCH);
export const AMBR_BOTH_FIXTURE = buildFixture(AMBR_BOTH_TARGETS, AMBR_BOTH_PATCH);
export const COMBINED_FIXTURE = buildFixture(COMBINED_TARGETS, COMBINED_PATCH);
export const MULTI_IMSI_FIXTURE = buildFixture(MULTI_IMSI_TARGETS, MULTI_IMSI_PATCH);

// ─── All fixtures for JSON export ───

export const ALL_FIXTURES = {
  accessRestriction: ACCESS_RESTRICTION_FIXTURE,
  ambrDownlink: AMBR_DOWNLINK_FIXTURE,
  ambrUplink: AMBR_UPLINK_FIXTURE,
  ambrBoth: AMBR_BOTH_FIXTURE,
  combined: COMBINED_FIXTURE,
  multiImsi: MULTI_IMSI_FIXTURE,
};

// ─── Verification ───

export function verifyCanonicalSerialization() {
  // Key-order independence
  const a = { b: 1, a: 2 };
  const b = { a: 2, b: 1 };
  if (stableJson(a) !== stableJson(b)) {
    throw new Error('Canonical serialization is not key-order independent');
  }
}
