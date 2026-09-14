/**
 * Profile Restore Governance Unit Tests
 *
 * Tests pure functions from profileRestoreGovernance.ts.
 * For integration tests (MongoDB), use the Go handler tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import {
  buildEffectiveRestoredProfile,
  computeProfileHash,
  computeOperationFingerprint,
  stableCanonicalJSON,
} from '../src/server/profileRestoreGovernance.ts';

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

const deterministicClock = () => '2024-06-01T10:00:00.000Z';

describe('Profile Restore Governance', () => {
  describe('buildEffectiveRestoredProfile', () => {
    it('should restore from version with current profile present', () => {
      const current = {
        name: 'test_profile',
        title: 'Current Title',
        description: 'Current description',
        auth: { k: 'current_k', opc: 'current_opc', amf: '8000' },
        createdAt: '2024-01-01T00:00:00.000Z',
        createdBy: 'original_user',
        updatedAt: '2024-07-01T00:00:00.000Z',
        updatedBy: 'current_user',
      };

      const versionDoc = {
        versionId: 'v-001',
        profileName: 'test_profile',
        action: 'UPDATE',
        savedAt: '2024-06-01T10:00:00.000Z',
        savedBy: 'admin',
        profile: {
          name: 'test_profile',
          title: 'Old Title',
          description: 'Old description',
          auth: { k: 'old_k', opc: 'old_opc', amf: '8000' },
          createdAt: '2024-01-01T00:00:00.000Z',
          createdBy: 'original_user',
          updatedAt: '2024-06-01T10:00:00.000Z',
          updatedBy: 'admin',
        },
      };

      const restored = buildEffectiveRestoredProfile(current, versionDoc, 'test_profile', 'admin', deterministicClock);

      // Server-controlled fields
      assert.equal(restored.name, 'test_profile');
      assert.equal(restored.title, 'Old Title');
      assert.equal(restored.updatedBy, 'admin');
      assert.equal(restored.updatedAt, '2024-06-01T10:00:00.000Z');
      assert.equal(restored.restoredFromVersionId, 'v-001');
      assert.equal(restored.restoredFromSavedAt, '2024-06-01T10:00:00.000Z');

      // Version data preserved
      assert.equal(restored.description, 'Old description');
      assert.equal(restored.createdBy, 'original_user');
      assert.equal(restored.createdAt, '2024-01-01T00:00:00.000Z');
    });

    it('should restore when current profile is null (absent)', () => {
      const versionDoc = {
        versionId: 'v-001',
        profileName: 'new_profile',
        action: 'CREATE',
        savedAt: '2024-06-01T10:00:00.000Z',
        savedBy: 'admin',
        profile: {
          name: 'new_profile',
          title: 'New Profile',
          createdAt: '2024-06-01T10:00:00.000Z',
          createdBy: 'admin',
          updatedAt: '2024-06-01T10:00:00.000Z',
          updatedBy: 'admin',
        },
      };

      const restored = buildEffectiveRestoredProfile(null, versionDoc, 'new_profile', 'admin', deterministicClock);

      assert.equal(restored.name, 'new_profile');
      assert.equal(restored.title, 'New Profile');
      assert.equal(restored.createdAt, '2024-06-01T10:00:00.000Z');
      assert.equal(restored.createdBy, 'admin');
      assert.equal(restored.updatedAt, '2024-06-01T10:00:00.000Z');
      assert.equal(restored.updatedBy, 'admin');
    });

    it('should strip subscriber identity fields', () => {
      const current = { name: 'test' };
      const versionDoc = {
        versionId: 'v-001',
        profile: {
          name: 'test',
          title: 'Test',
          imsi: '123456789012345',
          msisdn: '1234567890',
          msisdnList: ['1234567890'],
          description: 'test profile',
        },
      };

      const restored = buildEffectiveRestoredProfile(current, versionDoc, 'test', 'admin', deterministicClock);

      assert.equal(restored.imsi, undefined);
      assert.equal(restored.msisdn, undefined);
      assert.equal(restored.msisdnList, undefined);
      assert.equal(restored.description, 'test profile');
    });

    it('should use profileName as title fallback', () => {
      const versionDoc = {
        versionId: 'v-001',
        profile: {
          name: 'test',
          // no title
        },
      };

      const restored = buildEffectiveRestoredProfile(null, versionDoc, 'test', 'admin', deterministicClock);
      assert.equal(restored.title, 'test');
    });
  });

  describe('computeProfileHash', () => {
    it('should compute deterministic hash', () => {
      const profile = {
        name: 'test',
        title: 'Test',
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const hash1 = computeProfileHash(profile);
      const hash2 = computeProfileHash(profile);

      assert.ok(hash1);
      assert.equal(hash1, hash2);
    });

    it('should return empty string for null', () => {
      assert.equal(computeProfileHash(null), '');
    });

    it('should exclude _id field', () => {
      const profile1 = { name: 'test', _id: 'abc123' };
      const profile2 = { name: 'test' };

      assert.equal(computeProfileHash(profile1), computeProfileHash(profile2));
    });
  });

  describe('computeOperationFingerprint', () => {
    it('should compute deterministic fingerprint', () => {
      const data = {
        operation: 'PROFILE_RESTORE',
        profileName: 'test',
        versionId: 'v-001',
        sourceVersionHash: 'hash1',
        currentState: 'present',
        currentProfileHash: 'hash2',
        effectiveRestoredHash: 'hash3',
      };

      const fp1 = computeOperationFingerprint(data);
      const fp2 = computeOperationFingerprint(data);

      assert.ok(fp1);
      assert.equal(fp1, fp2);
    });

    it('should change with different inputs', () => {
      const fp1 = computeOperationFingerprint({
        operation: 'PROFILE_RESTORE',
        profileName: 'test1',
        versionId: 'v-001',
        sourceVersionHash: 'hash1',
        currentState: 'present',
        currentProfileHash: 'hash2',
        effectiveRestoredHash: 'hash3',
      });

      const fp2 = computeOperationFingerprint({
        operation: 'PROFILE_RESTORE',
        profileName: 'test2',
        versionId: 'v-001',
        sourceVersionHash: 'hash1',
        currentState: 'present',
        currentProfileHash: 'hash2',
        effectiveRestoredHash: 'hash3',
      });

      assert.notEqual(fp1, fp2);
    });
  });

  describe('stableCanonicalJSON', () => {
    it('should produce deterministic output for objects', () => {
      const obj = { b: 2, a: 1, c: 3 };
      assert.equal(stableCanonicalJSON(obj), '{"a":1,"b":2,"c":3}');
    });

    it('should handle nested objects', () => {
      const obj = { z: { b: 2, a: 1 }, a: 1 };
      assert.equal(stableCanonicalJSON(obj), '{"a":1,"z":{"a":1,"b":2}}');
    });

    it('should handle arrays', () => {
      const arr = [3, 1, 2];
      assert.equal(stableCanonicalJSON(arr), '[3,1,2]');
    });

    it('should handle null', () => {
      assert.equal(stableCanonicalJSON(null), 'null');
    });

    it('should handle strings', () => {
      assert.equal(stableCanonicalJSON('hello'), '"hello"');
    });

    it('should handle numbers', () => {
      assert.equal(stableCanonicalJSON(42), '42');
    });

    it('should handle booleans', () => {
      assert.equal(stableCanonicalJSON(true), 'true');
    });
  });

  describe('Cross-runtime hash parity', () => {
    it('should match Go fingerprints for sourceVersionHash', () => {
      const versionProfile = {
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
      };

      const hash = fingerprint(versionProfile);
      assert.equal(hash, '3f33fcbbdf86b5b6e7385bfdd2e410e94f6da04cf126dd1163234c9c76a0bf60');
    });

    it('should match Go fingerprints for currentProfileHash', () => {
      const current = {
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

      const hash = fingerprint(current);
      assert.equal(hash, '270d5f1afbe0d64e7ec3ed6df3f7cf6d56eb9867111987cc7be878751de2ba01');
    });
  });
});
