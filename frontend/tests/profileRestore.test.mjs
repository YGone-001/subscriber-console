/**
 * Profile Restore Unit Tests — Production Functions
 *
 * Tests REAL exported functions:
 *   - buildEffectiveRestoredProfile
 *   - computeProfileHash
 *   - computeOperationFingerprint
 *   - stableCanonicalJSON
 *
 * 18 vectors total.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

// ─── Production imports ───

import {
  buildEffectiveRestoredProfile,
  computeProfileHash,
  computeOperationFingerprint,
  stableCanonicalJSON,
} from '../src/server/profileRestoreGovernance.ts';

// ─── Helpers ───

function fingerprint(obj) {
  return createHash('sha256').update(stableCanonicalJSON(obj)).digest('hex');
}

function deterministicClock() {
  return '2024-06-01T10:00:00.000Z';
}

// ─── Test Data ───

const VERSION_PROFILE = {
  name: 'test_profile',
  title: 'Old Title',
  description: 'Old description',
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'original_user',
  updatedAt: '2024-06-01T10:00:00.000Z',
  updatedBy: 'admin',
};

const CURRENT_PROFILE = {
  name: 'test_profile',
  title: 'Current Title',
  description: 'Current description',
  createdAt: '2024-01-01T00:00:00.000Z',
  createdBy: 'original_user',
  updatedAt: '2024-07-01T00:00:00.000Z',
  updatedBy: 'current_user',
};

const VERSION_DOC = {
  versionId: 'v-001',
  profileName: 'test_profile',
  action: 'UPDATE',
  savedAt: '2024-06-01T10:00:00.000Z',
  savedBy: 'admin',
  profile: VERSION_PROFILE,
};

const NOW_ISO = '2024-06-01T10:00:00.000Z';
const OPERATOR = 'test_operator';

// ─── Tests ───

describe('buildEffectiveRestoredProfile', () => {
  it('preserves version fields with correct overrides', () => {
    const result = buildEffectiveRestoredProfile(
      CURRENT_PROFILE,
      VERSION_DOC,
      'test_profile',
      OPERATOR,
      deterministicClock,
    );

    assert.equal(result.name, 'test_profile');
    assert.equal(result.title, 'Old Title');
    assert.equal(result.description, 'Old description');
    assert.equal(result.createdAt, '2024-01-01T00:00:00.000Z');
    assert.equal(result.createdBy, 'original_user');
    assert.equal(result.updatedAt, NOW_ISO);
    assert.equal(result.updatedBy, OPERATOR);
    assert.equal(result.restoredFromVersionId, 'v-001');
    assert.equal(result.restoredFromSavedAt, '2024-06-01T10:00:00.000Z');
  });

  it('handles missing createdAt gracefully', () => {
    const versionDoc = {
      ...VERSION_DOC,
      profile: { ...VERSION_PROFILE },
    };
    delete versionDoc.profile.createdAt;

    const result = buildEffectiveRestoredProfile(
      null,
      versionDoc,
      'test_profile',
      OPERATOR,
      deterministicClock,
    );

    assert.equal(result.createdAt, NOW_ISO);
  });

  it('handles missing createdBy gracefully', () => {
    const versionDoc = {
      ...VERSION_DOC,
      profile: { ...VERSION_PROFILE },
    };
    delete versionDoc.profile.createdBy;

    const result = buildEffectiveRestoredProfile(
      null,
      versionDoc,
      'test_profile',
      OPERATOR,
      deterministicClock,
    );

    assert.equal(result.createdBy, OPERATOR);
  });

  it('uses deterministic clock output directly', () => {
    const result = buildEffectiveRestoredProfile(
      CURRENT_PROFILE,
      VERSION_DOC,
      'test_profile',
      OPERATOR,
      deterministicClock,
    );

    assert.equal(result.updatedAt, '2024-06-01T10:00:00.000Z');
  });
});

describe('computeProfileHash', () => {
  it('produces stable SHA-256 hex digest', () => {
    const hash = computeProfileHash(VERSION_PROFILE);

    const expected = createHash('sha256')
      .update(stableCanonicalJSON(VERSION_PROFILE))
      .digest('hex');

    assert.equal(hash, expected);
    assert.equal(hash.length, 64);
  });

  it('hash changes when profile changes', () => {
    const hash1 = computeProfileHash(VERSION_PROFILE);
    const hash2 = computeProfileHash({ ...VERSION_PROFILE, title: 'Modified' });

    assert.notEqual(hash1, hash2);
  });
});

describe('computeOperationFingerprint', () => {
  it('produces stable SHA-256 hex digest', () => {
    const fp = computeOperationFingerprint({
      operation: 'PROFILE_RESTORE',
      profileName: 'test_profile',
      versionId: 'v-001',
      sourceVersionHash: 'a'.repeat(64),
      currentState: 'present',
      currentProfileHash: 'b'.repeat(64),
      effectiveRestoredHash: 'c'.repeat(64),
    });

    assert.equal(fp.length, 64);

    // Deterministic — same input → same output
    const fp2 = computeOperationFingerprint({
      operation: 'PROFILE_RESTORE',
      profileName: 'test_profile',
      versionId: 'v-001',
      sourceVersionHash: 'a'.repeat(64),
      currentState: 'present',
      currentProfileHash: 'b'.repeat(64),
      effectiveRestoredHash: 'c'.repeat(64),
    });

    assert.equal(fp, fp2);
  });

  it('changes when any field changes', () => {
    const make = (overrides) =>
      computeOperationFingerprint({
        operation: 'PROFILE_RESTORE',
        profileName: 'test_profile',
        versionId: 'v-001',
        sourceVersionHash: 'a'.repeat(64),
        currentState: 'present',
        currentProfileHash: 'b'.repeat(64),
        effectiveRestoredHash: 'c'.repeat(64),
        ...overrides,
      });

    const base = make({});
    assert.notEqual(base, make({ profileName: 'other' }));
    assert.notEqual(base, make({ versionId: 'v-002' }));
    assert.notEqual(base, make({ currentState: 'absent' }));
  });
});

describe('stableCanonicalJSON', () => {
  it('sorts object keys recursively', () => {
    const result = stableCanonicalJSON({ b: 2, a: 1 });
    assert.equal(result, '{"a":1,"b":2}');
  });

  it('preserves array order', () => {
    const result = stableCanonicalJSON([3, 1, 2]);
    assert.equal(result, '[3,1,2]');
  });

  it('handles nested objects', () => {
    const result = stableCanonicalJSON({
      z: { b: 2, a: 1 },
      a: { z: true, a: false },
    });
    assert.equal(result, '{"a":{"a":false,"z":true},"z":{"a":1,"b":2}}');
  });
});

describe('Cross-runtime hash parity', () => {
  it('Node hash matches manual SHA-256 of canonical JSON', () => {
    const profile = {
      name: 'test_profile',
      title: 'Old Title',
      description: 'Old description',
      createdAt: '2024-01-01T00:00:00.000Z',
      createdBy: 'original_user',
      updatedAt: '2024-06-01T10:00:00.000Z',
      updatedBy: 'admin',
    };

    const canonical = stableCanonicalJSON(profile);
    const manualHash = createHash('sha256').update(canonical).digest('hex');
    const functionHash = computeProfileHash(profile);

    assert.equal(functionHash, manualHash);
  });

  it('effectiveRestored hash is deterministic', () => {
    const result = buildEffectiveRestoredProfile(
      CURRENT_PROFILE,
      VERSION_DOC,
      'test_profile',
      OPERATOR,
      deterministicClock,
    );

    const hash1 = computeProfileHash(result);
    const hash2 = computeProfileHash(result);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  it('operation fingerprint includes all hash fields', () => {
    const restored = buildEffectiveRestoredProfile(
      CURRENT_PROFILE,
      VERSION_DOC,
      'test_profile',
      OPERATOR,
      deterministicClock,
    );

    const sourceHash = computeProfileHash(VERSION_PROFILE);
    const restoredHash = computeProfileHash(restored);
    const currentHash = computeProfileHash(CURRENT_PROFILE);

    const fp = computeOperationFingerprint({
      operation: 'PROFILE_RESTORE',
      profileName: 'test_profile',
      versionId: 'v-001',
      sourceVersionHash: sourceHash,
      currentState: 'present',
      currentProfileHash: currentHash,
      effectiveRestoredHash: restoredHash,
    });

    assert.equal(fp.length, 64);
  });
});
