/**
 * Profile Restore — shared frozen v2 implementation.
 *
 * Implements: prepare → assert → execute → classify → non-gating audit.
 *
 * DO NOT call legacy restoreProfileVersion() for profile-restore-v2.
 */

import { createHash } from 'crypto';
import { writeAuditLog } from '@/lib/audit';
import { safeProfileSnapshot } from '@/lib/profileAudit';
import {
  getProfile,
  getProfileVersion,
  replaceProfileCAS,
  insertProfileCreateOnly,
  saveProfileVersion,
  stripSubscriberIdentityFields,
} from '@/server/repositories/profileRepository';
import type { ProfileDocument } from '@/server/repositories/profileRepository';

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
  currentProfile: ProfileDocument | null;
  versionDoc: Record<string, unknown>;
  effectiveRestored: ProfileDocument;
}

/**
 * Recursive canonical JSON serializer.
 * Keys are sorted recursively at every level.
 * Arrays preserve order.
 * All nested values are preserved.
 */
export function stableCanonicalJSON(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(item => stableCanonicalJSON(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const entries = keys.map(k => `${JSON.stringify(k)}:${stableCanonicalJSON(obj[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compute SHA256 of stable canonical JSON of a profile (excluding _id).
 */
export function computeProfileHash(profile: unknown): string {
  if (!profile) return '';
  const cleaned = removeField(profile, '_id');
  return createHash('sha256').update(stableCanonicalJSON(cleaned)).digest('hex');
}

/**
 * Compute SHA256 of stable canonical JSON of the operation.
 */
export function computeOperationFingerprint(data: Record<string, unknown>): string {
  return createHash('sha256').update(stableCanonicalJSON(data)).digest('hex');
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
    currentProfile: current,
    versionDoc: version as unknown as Record<string, unknown>,
    effectiveRestored,
  };
}

/**
 * Execute frozen restore v2.
 * Uses proper CAS/InsertOne primitives — NOT legacy restoreProfileVersion.
 *
 * Returns the restored profile document.
 * Throws on CAS conflict or storage failure.
 */
export async function executeFrozenRestoreV2(
  assertion: RestoreAssertion,
  actor: string
): Promise<{
  restored: ProfileDocument;
  classification: string;
  committed: boolean;
}> {
  const { intent, currentProfile, versionDoc } = assertion;

  // Build effective restored with correct actor
  const effectiveRestored = buildEffectiveRestoredProfile(
    currentProfile,
    versionDoc,
    intent.profileName,
    actor
  );

  if (intent.currentState === 'present') {
    // CAS replace for existing profile
    const matched = await replaceProfileCAS(
      intent.profileName,
      currentProfile!,
      effectiveRestored
    );
    if (!matched) {
      throw Object.assign(new Error('PROFILE_RESTORE_PRECONDITION_CHANGED'), {
        code: 'PROFILE_RESTORE_PRECONDITION_CHANGED',
      });
    }
  } else {
    // Insert for missing profile (no upsert)
    const inserted = await insertProfileCreateOnly(effectiveRestored);
    if (!inserted) {
      // Concurrent creator won
      throw Object.assign(new Error('PROFILE_RESTORE_PRECONDITION_CHANGED'), {
        code: 'PROFILE_RESTORE_PRECONDITION_CHANGED',
      });
    }
  }

  // Save RESTORE version AFTER mutation (only if current profile existed)
  if (currentProfile) {
    try {
      await saveProfileVersion(intent.profileName, currentProfile, actor, 'RESTORE');
    } catch {
      // Partial write - profile was restored but version save failed
      throw Object.assign(new Error('Profile restored but version save failed'), {
        code: 'PROFILE_RESTORE_PARTIAL_WRITE',
      });
    }
  }

  return {
    restored: effectiveRestored,
    classification: 'SUCCESS',
    committed: true,
  };
}

/**
 * Write non-gating audit for restore operation.
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
      actorRole: actor.role,
      mutationCommitted: committed,
      classification,
      operationFingerprint: intent.operationFingerprint,
      sourceVersionHash: intent.sourceVersionHash,
      currentProfileHash: intent.currentProfileHash,
      versionId: intent.versionId,
    },
  });
}

/**
 * Build effective restored profile from version and current.
 * Uses deterministic clock for test parity when provided.
 */
export function buildEffectiveRestoredProfile(
  current: Record<string, unknown> | null,
  versionDoc: Record<string, unknown>,
  profileName: string,
  actor: string,
  clock?: () => string
): ProfileDocument {
  const versionProfile = (versionDoc.profile as Record<string, unknown>) || {};

  // Strip subscriber identity fields
  const stripped = stripSubscriberIdentityFields(versionProfile);

  const now = clock ? clock() : new Date().toISOString();

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
  } as ProfileDocument;
}
