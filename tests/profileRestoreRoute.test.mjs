/**
 * Profile Restore Production Path Tests
 *
 * Tests the REAL production handler and approval executor functions.
 * Only external dependencies (Mongo, audit, auth) are mocked.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

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

// ─── Mock State ───

const mockProfiles = new Map();
const mockVersions = new Map();
const mockApprovals = [];
const mockAuditLogs = [];
let mockAuditShouldFail = false;

function resetMocks() {
  mockProfiles.clear();
  mockVersions.clear();
  mockApprovals.length = 0;
  mockAuditLogs.length = 0;
  mockAuditShouldFail = false;
}

// ─── Mock Dependencies ───

function makeMockDeps() {
  return {
    prepareFrozenRestoreV2: async (name, versionId, user) => {
      const profile = mockProfiles.get(name);
      const version = mockVersions.get(`${name}:${versionId}`);
      if (!version) return null;

      const versionProfile = version.profile || {};
      const currentProfile = profile || null;
      const currentState = currentProfile ? 'present' : 'absent';
      const sourceVersionHash = fingerprint(versionProfile);
      const currentProfileHash = currentProfile ? fingerprint(currentProfile) : null;

      const restored = {
        ...versionProfile,
        name,
        title: versionProfile.title || name,
        createdAt: versionProfile.createdAt || currentProfile?.createdAt || '2024-06-01T10:00:00.000Z',
        createdBy: versionProfile.createdBy || currentProfile?.createdBy || user,
        updatedAt: '2024-06-01T10:00:00.000Z',
        updatedBy: user,
        restoredFromVersionId: versionId,
        restoredFromSavedAt: version.savedAt,
      };

      const effectiveRestoredHash = fingerprint(restored);

      return {
        version: 'profile-restore-v2',
        profileName: name,
        versionId,
        sourceVersionHash,
        currentState,
        currentProfileHash,
        effectiveRestoredHash,
        operationFingerprint: fingerprint({
          operation: 'PROFILE_RESTORE',
          profileName: name,
          versionId,
          sourceVersionHash,
          currentState,
          currentProfileHash,
          effectiveRestoredHash,
        }),
        currentProfile,
        effectiveRestored: restored,
        versionDoc: version,
      };
    },

    assertFrozenRestoreV2: async (intent) => {
      const profile = mockProfiles.get(intent.profileName);
      const version = mockVersions.get(`${intent.profileName}:${intent.versionId}`);
      if (!version) return null;

      if (intent.currentState === 'present') {
        if (!profile) return null;
        const currentHash = fingerprint(profile);
        if (currentHash !== intent.currentProfileHash) return null;
      }

      return {
        intent,
        currentProfile: profile || null,
        versionDoc: version,
      };
    },

    executeFrozenRestoreV2: async (assertion, actor) => {
      const { intent, currentProfile } = assertion;

      if (intent.currentState === 'present') {
        const current = mockProfiles.get(intent.profileName);
        if (!current || fingerprint(current) !== intent.currentProfileHash) {
          const err = new Error('PRECONDITION_CHANGED');
          err.code = 'PROFILE_RESTORE_PRECONDITION_CHANGED';
          throw err;
        }
        mockProfiles.set(intent.profileName, intent.effectiveRestored);
      } else {
        if (mockProfiles.has(intent.profileName)) {
          const err = new Error('PRECONDITION_CHANGED');
          err.code = 'PROFILE_RESTORE_PRECONDITION_CHANGED';
          throw err;
        }
        mockProfiles.set(intent.profileName, intent.effectiveRestored);
      }

      if (currentProfile) {
        mockVersions.set(`${intent.profileName}:RESTORE:${Date.now()}`, {
          profileName: intent.profileName,
          action: 'RESTORE',
          profile: currentProfile,
        });
      }

      return { restored: intent.effectiveRestored, classification: 'SUCCESS', committed: true };
    },

    writeRestoreAudit: async (intent, currentProfile, restored, actor, result, classification, committed, governanceMode) => {
      if (mockAuditShouldFail) throw new Error('Audit service unavailable');
      mockAuditLogs.push({ intent, currentProfile, restored, actor, result, classification, committed, governanceMode });
    },

    createApprovalRequest: async (input) => {
      const approval = { id: `approval-${Date.now()}`, ...input, status: 'pending' };
      mockApprovals.push(approval);
      return approval;
    },

    enforceRateLimit: async () => ({ ok: true }),
    requireCapability: (req, cap, opts) => ({
      ok: true,
      auth: { user: req._testUser || 'test_admin', role: req._testRole || 'super_admin' },
    }),
    capabilityDecision: (role, cap) => {
      if (role === 'operator') return 'approval';
      return 'direct';
    },
  };
}

// ─── Import Production Handler ───

const { handleProfileRestorePost } = await import('../src/app/api/profiles/[name]/versions/[versionId]/restore/route.ts');

// ─── Helper to create mock request ───

function makeRequest(user, role) {
  return Object.assign(new Request('http://localhost/api/profiles/test/versions/v-001/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }), { _testUser: user, _testRole: role });
}

function setupTestData(profileName = 'test_profile') {
  mockProfiles.set(profileName, {
    name: profileName,
    title: 'Current Title',
    description: 'Current description',
    createdAt: '2024-01-01T00:00:00.000Z',
    createdBy: 'original_user',
    updatedAt: '2024-07-01T00:00:00.000Z',
    updatedBy: 'current_user',
  });

  mockVersions.set(`${profileName}:v-001`, {
    versionId: 'v-001',
    profileName,
    action: 'UPDATE',
    savedAt: '2024-06-01T10:00:00.000Z',
    savedBy: 'admin',
    profile: {
      name: profileName,
      title: 'Old Title',
      description: 'Old description',
      createdAt: '2024-01-01T00:00:00.000Z',
      createdBy: 'original_user',
      updatedAt: '2024-06-01T10:00:00.000Z',
      updatedBy: 'admin',
    },
  });
}

async function parseResponse(resp) {
  const body = await resp.json();
  return { status: resp.status, body };
}

// ─── Tests ───

describe('Profile Restore Production Route', () => {
  beforeEach(resetMocks);

  describe('Direct Success', () => {
    it('super_admin → 200', async () => {
      setupTestData();
      const deps = makeMockDeps();
      const req = makeRequest('super_admin', 'super_admin');

      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 200);
      assert.equal(body.message, 'Profile restored successfully');
      assert.equal(body.profile.title, 'Old Title');
      assert.equal(body.profile.updatedBy, 'super_admin');
    });

    it('ops_admin → 200', async () => {
      setupTestData();
      const deps = makeMockDeps();
      const req = makeRequest('ops_admin', 'ops_admin');

      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status } = await parseResponse(resp);

      assert.equal(status, 200);
    });
  });

  describe('Operator → Approval', () => {
    it('operator → 202 approval created', async () => {
      setupTestData();
      const deps = makeMockDeps();
      deps.capabilityDecision = () => 'approval';
      const req = makeRequest('operator_user', 'operator');

      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 202);
      assert.ok(body.approval);
      assert.equal(body.message, 'Approval required before profile restore');
      assert.equal(mockApprovals.length, 1);
      assert.equal(mockApprovals[0].action, 'PROFILE_RESTORE');
    });
  });

  describe('Precondition Changed', () => {
    it('audit success → 409 PROFILE_RESTORE_PRECONDITION_CHANGED', async () => {
      setupTestData();
      const deps = makeMockDeps();

      // Override assert to return null (drift)
      deps.assertFrozenRestoreV2 = async () => null;

      const req = makeRequest('super_admin', 'super_admin');
      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 409);
      assert.equal(body.code, 'PROFILE_RESTORE_PRECONDITION_CHANGED');
      assert.equal(mockAuditLogs.length, 1);
      assert.equal(mockAuditLogs[0].classification, 'PRECONDITION_CHANGED');
      assert.equal(mockAuditLogs[0].committed, false);
    });

    it('audit failure → 503 AUDIT_UNAVAILABLE committed=false', async () => {
      setupTestData();
      const deps = makeMockDeps();
      deps.assertFrozenRestoreV2 = async () => null;
      mockAuditShouldFail = true;

      const req = makeRequest('super_admin', 'super_admin');
      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 503);
      assert.equal(body.code, 'AUDIT_UNAVAILABLE');
      assert.equal(body.committed, false);
    });
  });

  describe('Storage Failure', () => {
    it('audit success → 500 PROFILE_RESTORE_FAILED committed=false', async () => {
      setupTestData();
      const deps = makeMockDeps();
      deps.executeFrozenRestoreV2 = async () => {
        const err = new Error('Storage failure');
        err.code = 'STORAGE_FAILURE';
        throw err;
      };

      const req = makeRequest('super_admin', 'super_admin');
      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 500);
      assert.equal(body.code, 'PROFILE_RESTORE_FAILED');
      assert.equal(body.committed, false);
      assert.equal(mockAuditLogs.length, 1);
      assert.equal(mockAuditLogs[0].classification, 'FAILED_NO_MUTATION');
      assert.equal(mockAuditLogs[0].committed, false);
    });

    it('audit failure → 503 AUDIT_UNAVAILABLE committed=false', async () => {
      setupTestData();
      const deps = makeMockDeps();
      deps.executeFrozenRestoreV2 = async () => {
        const err = new Error('Storage failure');
        err.code = 'STORAGE_FAILURE';
        throw err;
      };
      mockAuditShouldFail = true;

      const req = makeRequest('super_admin', 'super_admin');
      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 503);
      assert.equal(body.code, 'AUDIT_UNAVAILABLE');
      assert.equal(body.committed, false);
    });
  });

  describe('Partial Write', () => {
    it('audit success → 500 PROFILE_RESTORE_PARTIAL_WRITE committed=true', async () => {
      setupTestData();
      const deps = makeMockDeps();
      deps.executeFrozenRestoreV2 = async () => {
        const err = new Error('Partial write');
        err.code = 'PROFILE_RESTORE_PARTIAL_WRITE';
        throw err;
      };

      const req = makeRequest('super_admin', 'super_admin');
      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 500);
      assert.equal(body.code, 'PROFILE_RESTORE_PARTIAL_WRITE');
      assert.equal(body.committed, true);
      assert.equal(mockAuditLogs.length, 1);
      assert.equal(mockAuditLogs[0].classification, 'PARTIAL_WRITE');
      assert.equal(mockAuditLogs[0].committed, true);
    });

    it('audit failure → 503 AUDIT_UNAVAILABLE committed=true', async () => {
      setupTestData();
      const deps = makeMockDeps();
      deps.executeFrozenRestoreV2 = async () => {
        const err = new Error('Partial write');
        err.code = 'PROFILE_RESTORE_PARTIAL_WRITE';
        throw err;
      };
      mockAuditShouldFail = true;

      const req = makeRequest('super_admin', 'super_admin');
      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 503);
      assert.equal(body.code, 'AUDIT_UNAVAILABLE');
      assert.equal(body.committed, true);
    });
  });

  describe('Success + Audit Failure', () => {
    it('business mutation succeeds, audit fails → 503 committed=true', async () => {
      setupTestData();
      const deps = makeMockDeps();
      mockAuditShouldFail = true;

      const req = makeRequest('super_admin', 'super_admin');
      const resp = await handleProfileRestorePost(req, { name: 'test_profile', versionId: 'v-001' }, deps);
      const { status, body } = await parseResponse(resp);

      assert.equal(status, 503);
      assert.equal(body.code, 'AUDIT_UNAVAILABLE');
      assert.equal(body.committed, true);

      // Profile was actually restored (mutation committed)
      assert.equal(mockProfiles.get('test_profile').title, 'Old Title');
    });
  });
});
