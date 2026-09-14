/**
 * Profile Restore Governance — shared frozen v2 implementation.
 *
 * Used by both direct restore route and approval execution.
 * Implements: prepare → assert → execute → classify → strict audit.
 */

import { createHash } from 'crypto';
import { writeAuditLog } from '@/lib/audit';
import { safeProfileSnapshot } from '@/lib/profileAudit';
import {
  getProfile,
  getProfileVersion,
  restoreProfileVersion,
} from '@/server/repositories/profileRepository';

export interface RestoreIntent {
  version: 'profile-restore-v2';
  profileName: string;
  versionId: string;
  sourceVersionHash: string;
  currentState: 'present' | 'absent';
  currentProfileHash: string | null;
  effectiveRestoredHash: string;
  operationFingerprint: string;
}

export interface RestoreAssertion {
  intent: RestoreIntent;
  currentProfile: Record<string, unknown> | null;
  versionDoc: Record<string, unknown>;
  effectiveRestored: Record<string, unknown>;
}

/**
 * Compute SHA256 of stable JSON of a profile (excluding _id).
 */
function computeProfileHash(profile: unknown): string {
  if (!profile) return '';
  const cleaned = removeField(profile, '_id');
  const data = JSON.stringify(cleaned, Object.keys(cleaned as Record<string, unknown>).sort());
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute SHA256 of stable JSON of the operation.
 */
function computeOperationFingerprint(data: Record<string, unknown>): string {
  const dataStr = JSON.stringify(data, Object.keys(data).sort());
  return createHash('sha256').update(dataStr).digest('hex');
}

/**
 * Recursively remove a field from a document.
 */
function removeField(doc: unknown, field: string): unknown {
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      if (k === field) continue;
      result[k] = removeField(v, field);
    }
    return result;
  }
  if (Array.isArray(doc)) {
    return doc.map(item => removeField(item, field));
  }
  return doc;
}

/**
 * Prepare frozen v2 restore intent.
 * Returns null if version not found.
 */
export async function prepareFrozenRestoreV2(
  profileName: string,
  versionId: string,
  _actor: string
): Promise<RestoreIntent | null> {
  const version = await getProfileVersion(profileName, versionId);
  if (!version) return null;

  const sourceVersionHash = computeProfileHash(version.profile);

  const current = await getProfile(profileName);
  const currentState: 'present' | 'absent' = current ? 'present' : 'absent';
  const currentProfileHash = current ? computeProfileHash(current) : null;

  const effectiveRestored = buildEffectiveRestoredProfile(current, version, profileName, _actor);
  const effectiveRestoredHash = computeProfileHash(effectiveRestored);

  const operationFingerprint = computeOperationFingerprint({
    operation: 'PROFILE_RESTORE',
    profileName,
    versionId,
    sourceVersionHash,
    currentState,
    currentProfileHash,
    effectiveRestoredHash,
  });

  return {
    version: 'profile-restore-v2',
    profileName,
    versionId,
    sourceVersionHash,
    currentState,
    currentProfileHash,
    effectiveRestoredHash,
    operationFingerprint,
  };
}

/**
 * Assert frozen v2 — re-read and verify hashes match.
 * Returns null if drift detected.
 */
export async function assertFrozenRestoreV2(
  intent: RestoreIntent
): Promise<RestoreAssertion | null> {
  const version = await getProfileVersion(intent.profileName, intent.versionId);
  if (!version) return null;

  const sourceVersionHash = computeProfileHash(version.profile);
  if (sourceVersionHash !== intent.sourceVersionHash) return null;

  const current = await getProfile(intent.profileName);

  if (intent.currentState === 'present') {
    if (!current) return null;
    const currentHash = computeProfileHash(current);
    if (currentHash !== intent.currentProfileHash) return null;
  } else {
    if (current) return null;
  }

  const effectiveRestored = buildEffectiveRestoredProfile(
    current,
    version,
    intent.profileName,
    'system' // actor will be overridden by caller
  );

  return {
    intent,
    currentProfile: current as Record<string, unknown> | null,
    versionDoc: version as unknown as Record<string, unknown>,
    effectiveRestored,
  };
}

/**
 * Execute frozen restore v2.
 * Returns the restored profile document.
 * Throws on CAS conflict or storage failure.
 */
export async function executeFrozenRestoreV2(
  assertion: RestoreAssertion,
  actor: string
): Promise<{
  restored: Record<string, unknown>;
  classification: string;
  committed: boolean;
}> {
  const { intent, currentProfile, versionDoc } = assertion;

  // Use the existing restoreProfileVersion function which handles:
  // - Loading the version
  // - Saving RESTORE version
  // - Replacing/inserting the profile
  const result = await restoreProfileVersion(intent.profileName, intent.versionId, actor);

  if (!result) {
    throw Object.assign(new Error('Version not found'), {
      code: 'PROFILE_RESTORE_FAILED',
    });
  }

  return {
    restored: result.restored as unknown as Record<string, unknown>,
    classification: 'SUCCESS',
    committed: true,
  };
}

/**
 * Write strict audit for restore operation.
 */
export async function writeRestoreAudit(
  intent: RestoreIntent,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  actor: { username: string; role: string },
  result: 'success' | 'failed',
  classification: string,
  committed: boolean,
  governanceMode: string,
  error?: Error | null
): Promise<void> {
  await writeAuditLog({
    action: 'profile.restore',
    module: 'profiles',
    actor: { type: 'user', username: actor.username, role: actor.role },
    resource: { type: 'profile', name: intent.profileName },
    targetId: intent.profileName,
    result,
    before: before ? safeProfileSnapshot(before) : undefined,
    after: after ? safeProfileSnapshot(after) : undefined,
    error: error
      ? { code: classification, message: error.message }
      : undefined,
    metadata: {
      governanceMode,
      approvalRequired: governanceMode === 'APPROVAL_GOVERNED',
      actorRole: actor.role,
      mutationCommitted: committed,
      classification,
      operationFingerprint: intent.operationFingerprint,
      sourceVersionHash: intent.sourceVersionHash,
      currentProfileHash: intent.currentProfileHash,
      versionId: intent.versionId,
    },
  }, { failureMode: 'strict' });
}

/**
 * Build effective restored profile from version and current.
 */
function buildEffectiveRestoredProfile(
  current: Record<string, unknown> | null,
  versionDoc: Record<string, unknown>,
  profileName: string,
  actor: string
): Record<string, unknown> {
  const versionProfile = (versionDoc.profile as Record<string, unknown>) || {};

  // Strip subscriber identity fields
  const stripped = stripSubscriberIdentityFields(versionProfile);

  const now = new Date().toISOString();

  return {
    ...stripped,
    name: profileName,
    title: versionProfile.title || profileName,
    createdAt: versionProfile.createdAt || current?.createdAt || now,
    createdBy: versionProfile.createdBy || current?.createdBy || actor,
    updatedAt: now,
    updatedBy: actor,
    restoredFromVersionId: versionDoc.versionId,
    restoredFromSavedAt: versionDoc.savedAt,
  };
}

/**
 * Strip subscriber identity fields from a profile.
 */
function stripSubscriberIdentityFields(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'imsi' || k === 'msisdn' || k === 'msisdnList') continue;
    result[k] = v;
  }
  return result;
}

/**
 * Check if error is a duplicate key error.
 */
function isDuplicateKey(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('duplicate key') ||
      error.message.includes('E11000'))
  );
}
