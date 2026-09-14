/**
 * Profile Restore Cross-Runtime Fixtures
 *
 * These fixtures must produce identical fingerprints in both Node and Go.
 * Run this test and the Go TestRestoreFingerprintParity to verify parity.
 */

import { createHash } from 'crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildEffectiveRestoredProfile } from '../src/server/profileRestoreGovernance.ts';

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

// Deterministic clock for cross-runtime parity
const deterministicClock = () => '2024-06-01T10:00:00.000Z';

// ─── Tests ───

describe('Profile Restore Cross-Runtime Fixtures', () => {
  it('should compute sourceVersionHash', () => {
    const hash = fingerprint(RestoreVersionDoc.profile);
    assert.equal(hash, '3f33fcbbdf86b5b6e7385bfdd2e410e94f6da04cf126dd1163234c9c76a0bf60');
  });

  it('should compute currentProfileHash', () => {
    const hash = fingerprint(RestoreCurrentProfile);
    assert.equal(hash, '270d5f1afbe0d64e7ec3ed6df3f7cf6d56eb9867111987cc7be878751de2ba01');
  });

  it('should compute effectiveRestoredHash using buildEffectiveRestoredProfile', () => {
    const restored = buildEffectiveRestoredProfile(
      RestoreCurrentProfile,
      RestoreVersionDoc,
      'fixture_restore',
      'admin',
      deterministicClock
    );

    const hash = fingerprint(restored);
    assert.equal(hash, '04d4d79798be9f7adb5242423a63cf4dbb8324a05beeea193e62dec9b87ba2cb');
  });

  it('should compute operationFingerprint', () => {
    const sourceVersionHash = fingerprint(RestoreVersionDoc.profile);
    const currentProfileHash = fingerprint(RestoreCurrentProfile);

    const restored = buildEffectiveRestoredProfile(
      RestoreCurrentProfile,
      RestoreVersionDoc,
      'fixture_restore',
      'admin',
      deterministicClock
    );

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
    assert.equal(opFp, 'b02a280c12c5f5e4f89f6199d62aa45f5406d7cd32104075cde61aafac1fd970');
  });
});
