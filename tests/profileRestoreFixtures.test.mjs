/**
 * Profile Restore Cross-Runtime Fixtures
 *
 * These fixtures must produce identical fingerprints in both Node and Go.
 * Run this test and the Go TestRestoreFingerprintParity to verify parity.
 */

import { createHash } from 'crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function stableJson(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v).sort();
    const entries = keys.map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`);
    return `{${entries.join(',')}}`;
  }
  if (Array.isArray(v)) {
    return `[${v.map(item => stableJson(item)).join(',')}]`;
  }
  return JSON.stringify(v);
}

function fingerprint(v) {
  return createHash('sha256').update(stableJson(v)).digest('hex');
}

// ─── Restore Version Doc ───

const RestoreVersionDoc = {
  versionId: 'v-001',
  profileName: 'fixture_restore',
  action: 'UPDATE',
  savedAt: '2024-06-01T10:00:00.000Z',
  savedBy: 'admin',
  title: 'Old Title',
  sliceCount: 1,
  profile: {
    name: 'fixture_restore',
    title: 'Old Title',
    description: 'Old description',
    auth: {
      k: '00000000000000000000000000000001',
      opc: '00000000000000000000000000000002',
      amf: '8000',
    },
    ambr: {
      downlink: { unit: 2, value: 10 },
      uplink: { unit: 2, value: 10 },
    },
    sliceList: [
      {
        default_indicator: true,
        sd: '000001',
        sst: 1,
        session_list: [],
      },
    ],
    createdAt: '2024-01-01T00:00:00.000Z',
    createdBy: 'original_user',
    updatedAt: '2024-06-01T10:00:00.000Z',
    updatedBy: 'admin',
  },
};

// ─── Current Profile ───

const RestoreCurrentProfile = {
  name: 'fixture_restore',
  title: 'Current Title',
  description: 'Current description',
  auth: {
    k: '00000000000000000000000000000003',
    opc: '00000000000000000000000000000004',
    amf: '8000',
  },
  ambr: {
    downlink: { unit: 2, value: 20 },
    uplink: { unit: 2, value: 20 },
  },
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'original_user',
  updatedAt: '2024-07-01T10:00:00.000Z',
  updatedBy: 'current_user',
};

// ─── Tests ───

describe('Profile Restore Cross-Runtime Fixtures', () => {
  it('should compute sourceVersionHash', () => {
    const hash = fingerprint(RestoreVersionDoc.profile);
    console.log(`sourceVersionHash: ${hash}`);
    assert.ok(hash, 'sourceVersionHash should be non-empty');
  });

  it('should compute currentProfileHash', () => {
    const hash = fingerprint(RestoreCurrentProfile);
    console.log(`currentProfileHash: ${hash}`);
    assert.ok(hash, 'currentProfileHash should be non-empty');
  });

  it('should compute effectiveRestoredHash', () => {
    const restored = {
      name: 'fixture_restore',
      title: 'Old Title',
      description: 'Old description',
      auth: {
        k: '00000000000000000000000000000001',
        opc: '00000000000000000000000000000002',
        amf: '8000',
      },
      ambr: {
        downlink: { unit: 2, value: 10 },
        uplink: { unit: 2, value: 10 },
      },
      sliceList: [
        {
          default_indicator: true,
          sd: '000001',
          sst: 1,
          session_list: [],
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      createdBy: 'original_user',
      updatedAt: '2024-06-01T10:00:00.000Z',
      updatedBy: 'admin',
      restoredFromVersionId: 'v-001',
      restoredFromSavedAt: '2024-06-01T10:00:00.000Z',
    };

    const hash = fingerprint(restored);
    console.log(`effectiveRestoredHash: ${hash}`);
    assert.ok(hash, 'effectiveRestoredHash should be non-empty');
  });

  it('should compute operationFingerprint', () => {
    const sourceVersionHash = fingerprint(RestoreVersionDoc.profile);
    const currentProfileHash = fingerprint(RestoreCurrentProfile);

    const restored = {
      name: 'fixture_restore',
      title: 'Old Title',
      description: 'Old description',
      auth: {
        k: '00000000000000000000000000000001',
        opc: '00000000000000000000000000000002',
        amf: '8000',
      },
      ambr: {
        downlink: { unit: 2, value: 10 },
        uplink: { unit: 2, value: 10 },
      },
      sliceList: [
        {
          default_indicator: true,
          sd: '000001',
          sst: 1,
          session_list: [],
        },
      ],
      createdAt: '2024-01-01T00:00:00.000Z',
      createdBy: 'original_user',
      updatedAt: '2024-06-01T10:00:00.000Z',
      updatedBy: 'admin',
      restoredFromVersionId: 'v-001',
      restoredFromSavedAt: '2024-06-01T10:00:00.000Z',
    };

    const effectiveRestoredHash = fingerprint(restored);

    const opData = {
      operation: 'PROFILE_RESTORE',
      profileName: 'fixture_restore',
      versionId: 'v-001',
      sourceVersionHash,
      currentState: 'present',
      currentProfileHash,
      effectiveRestoredHash,
    };

    const opFp = fingerprint(opData);
    console.log(`operationFingerprint: ${opFp}`);
    assert.ok(opFp, 'operationFingerprint should be non-empty');
  });
});
