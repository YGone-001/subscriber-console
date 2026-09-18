/**
 * Cross-runtime fixtures for bulk delete v2.
 * Node produces, Go consumes.
 * Canonical SafeSnapshot fields: imsi, msisdn, accessRestrictionData, networkAccessMode, ambr, slices
 * PreconditionHash: SHA256(stableJSON(SafeSnapshot))
 * OperationFingerprint: SHA256(stableJSON({operation:"SUBSCRIBER_BULK_DELETE", targets:[{imsi,preconditionHash}], strategy:"delete-only"}))
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

// ─── Fixture 1: Single target ───
const SINGLE_TARGET_BEFORE = {
  imsi: '460001234567890',
  msisdn: ['1234567890'],
  accessRestrictionData: 47,
  networkAccessMode: 2,
  ambr: { downlink: { value: 100, unit: 'Mbps' }, uplink: { value: 50, unit: 'Mbps' } },
  slices: [{ sst: '1', sd: '000001' }],
};

const SINGLE_TARGET_PRECONDITION_HASH = fingerprint(SINGLE_TARGET_BEFORE);

const SINGLE_TARGET = {
  imsi: '460001234567890',
  before: SINGLE_TARGET_BEFORE,
  preconditionHash: SINGLE_TARGET_PRECONDITION_HASH,
};

const SINGLE_FROZEN = {
  version: 'subscriber-bulk-delete-v2',
  targets: [SINGLE_TARGET],
  targetCount: 1,
  snapshotBytes: stableJson({ targets: [SINGLE_TARGET], strategy: 'delete-only', operationFingerprint: '' }).length,
  strategy: 'delete-only',
  operationFingerprint: fingerprint({
    operation: 'SUBSCRIBER_BULK_DELETE',
    targets: [{ imsi: SINGLE_TARGET.imsi, preconditionHash: SINGLE_TARGET.preconditionHash }],
    strategy: 'delete-only',
  }),
};

// Fix snapshotBytes with actual fingerprint
SINGLE_FROZEN.snapshotBytes = stableJson({ targets: [SINGLE_TARGET], strategy: 'delete-only', operationFingerprint: SINGLE_FROZEN.operationFingerprint }).length;

// ─── Fixture 2: Multiple targets ───
const MULTI_TARGET_1_BEFORE = {
  imsi: '460001234567890',
  msisdn: ['1234567890'],
  accessRestrictionData: 47,
  networkAccessMode: 2,
};

const MULTI_TARGET_2_BEFORE = {
  imsi: '460001234567891',
  msisdn: ['0987654321'],
  accessRestrictionData: 0,
  networkAccessMode: 0,
};

const MULTI_TARGET_1 = {
  imsi: '460001234567890',
  before: MULTI_TARGET_1_BEFORE,
  preconditionHash: fingerprint(MULTI_TARGET_1_BEFORE),
};

const MULTI_TARGET_2 = {
  imsi: '460001234567891',
  before: MULTI_TARGET_2_BEFORE,
  preconditionHash: fingerprint(MULTI_TARGET_2_BEFORE),
};

const MULTI_FROZEN = {
  version: 'subscriber-bulk-delete-v2',
  targets: [MULTI_TARGET_1, MULTI_TARGET_2],
  targetCount: 2,
  snapshotBytes: 0,
  strategy: 'delete-only',
  operationFingerprint: fingerprint({
    operation: 'SUBSCRIBER_BULK_DELETE',
    targets: [
      { imsi: MULTI_TARGET_1.imsi, preconditionHash: MULTI_TARGET_1.preconditionHash },
      { imsi: MULTI_TARGET_2.imsi, preconditionHash: MULTI_TARGET_2.preconditionHash },
    ],
    strategy: 'delete-only',
  }),
};

MULTI_FROZEN.snapshotBytes = stableJson({ targets: [MULTI_TARGET_1, MULTI_TARGET_2], strategy: 'delete-only', operationFingerprint: MULTI_FROZEN.operationFingerprint }).length;

// ─── Fixture 3: With AMBR and slices ───
const FULL_TARGET_BEFORE = {
  imsi: '460001234567892',
  msisdn: ['1111111111'],
  accessRestrictionData: 32,
  networkAccessMode: 1,
  ambr: { downlink: { value: 200, unit: 'Mbps' }, uplink: { value: 100, unit: 'Mbps' } },
  slices: [
    { sst: '1', sd: '000001' },
    { sst: '2', sd: '000002', differentiator: '000001' },
  ],
};

const FULL_TARGET = {
  imsi: '460001234567892',
  before: FULL_TARGET_BEFORE,
  preconditionHash: fingerprint(FULL_TARGET_BEFORE),
};

const FULL_FROZEN = {
  version: 'subscriber-bulk-delete-v2',
  targets: [FULL_TARGET],
  targetCount: 1,
  snapshotBytes: 0,
  strategy: 'delete-only',
  operationFingerprint: fingerprint({
    operation: 'SUBSCRIBER_BULK_DELETE',
    targets: [{ imsi: FULL_TARGET.imsi, preconditionHash: FULL_TARGET.preconditionHash }],
    strategy: 'delete-only',
  }),
};

FULL_FROZEN.snapshotBytes = stableJson({ targets: [FULL_TARGET], strategy: 'delete-only', operationFingerprint: FULL_FROZEN.operationFingerprint }).length;

// ─── Exports ───
export {
  SINGLE_FROZEN,
  SINGLE_TARGET,
  SINGLE_TARGET_BEFORE,
  MULTI_FROZEN,
  MULTI_TARGET_1,
  MULTI_TARGET_2,
  MULTI_TARGET_1_BEFORE,
  MULTI_TARGET_2_BEFORE,
  FULL_FROZEN,
  FULL_TARGET,
  FULL_TARGET_BEFORE,
  fingerprint,
  stableJson,
};
