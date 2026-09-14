/**
 * Subscriber Profile Apply Governance — Phase 4.3-C
 *
 * Pure/testable functions for the SUBSCRIBER_PROFILE_APPLY governed operation.
 * Applies Profile auth/AMBR/slices/access_restriction to a Subscriber.
 *
 * Security rules:
 * - SQN is NEVER overwritten (subscriber runtime state)
 * - OP/OPc normalization: profile opc → opc only; profile op → op only
 * - Approval/audit payloads NEVER contain raw K/OP/OPc/AMF/SQN
 * - OCS collections are NEVER touched
 */
import { createHash } from 'node:crypto';
import { subscriberSafeSnapshot, stable, hash, type SafeSnapshot } from '@/lib/subscriberContract';
import { findSubscriberDocument } from '@/server/repositories/subscriberRepository';
import { getProfile, type ProfileDocument } from '@/server/repositories/profileRepository';
import type { XcloudSubscriberDocument } from '@/types/xcloud';
import type { XcloudSecurity } from '@/types/xcloud';

// ─── Types ───

export interface FrozenSubscriberProfileApplyV1 {
  version: 'subscriber-profile-apply-v1';
  imsi: string;
  profileName: string;
  subscriberPreconditionHash: string;
  profilePreconditionHash: string;
  before: SafeSnapshot;
  afterPreview: SafeSnapshot;
  operationFingerprint: string;
}

export interface ProfileApplyAssertion {
  intent: FrozenSubscriberProfileApplyV1;
  currentSubscriber: XcloudSubscriberDocument;
  currentProfile: ProfileDocument;
  effectiveSubscriber: XcloudSubscriberDocument;
}

export interface ProfileApplyResult {
  restored: XcloudSubscriberDocument;
  classification: string;
  committed: boolean;
  securityChanged: boolean;
}

export class SubscriberProfileApplyError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
    public readonly committed = false,
    public readonly details?: unknown,
  ) {
    super(code);
  }
}

// ─── Pure Functions ───

/**
 * Canonical stable JSON for profile execution fields.
 * Used for profilePreconditionHash computation.
 */
export function profileExecutionFieldsCanonical(profile: ProfileDocument): string {
  const fields: Record<string, unknown> = {};
  if (profile.auth !== undefined) fields.auth = profile.auth;
  if (profile.ambr !== undefined) fields.ambr = profile.ambr;
  if (profile.sliceList !== undefined) fields.sliceList = profile.sliceList;
  if (profile.access_restriction_data !== undefined) fields.access_restriction_data = profile.access_restriction_data;
  return stable(fields);
}

/**
 * Compute profilePreconditionHash from execution-relevant profile fields.
 */
export function computeProfilePreconditionHash(profile: ProfileDocument): string {
  return sha256(profileExecutionFieldsCanonical(profile));
}

/**
 * Compute subscriberPreconditionHash from full execution-relevant subscriber state.
 * Raw auth values are used as INPUT only — never stored in approval/audit metadata.
 */
export function computeSubscriberPreconditionHash(subscriber: XcloudSubscriberDocument): string {
  const state = {
    imsi: subscriber.imsi,
    msisdn: subscriber.msisdn || [],
    security: subscriber.security || {},
    ambr: subscriber.ambr,
    slice: subscriber.slice,
    access_restriction_data: subscriber.access_restriction_data,
    network_access_mode: subscriber.network_access_mode,
    webui_meta: subscriber.webui_meta || {},
  };
  return sha256(stable(state));
}

/**
 * Build effective subscriber after Profile Apply.
 * Pure function — no database writes.
 *
 * Rules:
 * - Preserve identity (imsi, msisdn, imeisv)
 * - Preserve SQN exactly
 * - Apply Profile auth (k, op/opc normalization, amf)
 * - Apply Profile ambr
 * - Apply Profile sliceList
 * - Apply Profile access_restriction_data (when present)
 * - Set webui_meta.profile_name
 * - Set webui_meta.updated_at
 * - NO OCS mutation
 */
export function buildSubscriberAfterProfileApply(
  current: XcloudSubscriberDocument,
  profile: ProfileDocument,
  profileName: string,
  clock: () => string = () => new Date().toISOString(),
): XcloudSubscriberDocument {
  // Deep copy current subscriber
  const next = deepCopySubscriber(current);

  // Apply Profile auth fields
  if (profile.auth) {
    const profileAuth = profile.auth;
    const currentSecurity = { ...(next.security || {}) };

    // K
    if (profileAuth.k !== undefined && profileAuth.k !== null) {
      currentSecurity.k = String(profileAuth.k);
    }

    // OP/OPc normalization: profile auth mode is authoritative
    if (profileAuth.opc !== undefined && profileAuth.opc !== null) {
      currentSecurity.opc = String(profileAuth.opc);
      currentSecurity.op = null;
    } else if (profileAuth.op !== undefined && profileAuth.op !== null) {
      currentSecurity.op = String(profileAuth.op);
      currentSecurity.opc = null;
    }

    // AMF
    if (profileAuth.amf !== undefined && profileAuth.amf !== null) {
      currentSecurity.amf = String(profileAuth.amf);
    }

    // SQN is NEVER overwritten — preserve existing
    // currentSecurity.sqn remains unchanged

    next.security = currentSecurity;
  }

  // Apply Profile AMBR
  if (profile.ambr !== undefined && profile.ambr !== null) {
    next.ambr = profile.ambr as XcloudSubscriberDocument['ambr'];
  }

  // Apply Profile slices
  if (profile.sliceList !== undefined && profile.sliceList !== null) {
    next.slice = profile.sliceList as XcloudSubscriberDocument['slice'];
  }

  // Apply Profile access_restriction_data (when present)
  if (profile.access_restriction_data !== undefined && profile.access_restriction_data !== null) {
    next.access_restriction_data = profile.access_restriction_data;
  }

  // Set Profile binding metadata
  if (!next.webui_meta) {
    next.webui_meta = {};
  }
  next.webui_meta.profile_name = profileName;
  next.webui_meta.updated_at = new Date(clock());

  return next;
}

/**
 * Compute operation fingerprint.
 * Must match Node and Go exactly.
 */
export function computeProfileApplyFingerprint(
  imsi: string,
  profileName: string,
  subscriberPreconditionHash: string,
  profilePreconditionHash: string,
  afterPreview: SafeSnapshot,
): string {
  return sha256(stable({
    operation: 'SUBSCRIBER_PROFILE_APPLY',
    imsi,
    profileName,
    subscriberPreconditionHash,
    profilePreconditionHash,
    afterPreview,
  }));
}

/**
 * Check if Profile Apply would have no effect.
 * Returns true if subscriber already matches Profile execution fields AND binding.
 */
export function isProfileApplyNoEffect(
  current: XcloudSubscriberDocument,
  profile: ProfileDocument,
  profileName: string,
): boolean {
  // Check binding
  if (current.webui_meta?.profile_name !== profileName) return false;

  // Check auth fields
  if (profile.auth) {
    const sec = current.security || {};
    const pa = profile.auth;
    if (pa.k !== undefined && pa.k !== null && String(pa.k) !== String(sec.k ?? '')) return false;
    if (pa.opc !== undefined && pa.opc !== null) {
      if (String(pa.opc) !== String(sec.opc ?? '')) return false;
      if (sec.op !== null && sec.op !== undefined) return false;
    } else if (pa.op !== undefined && pa.op !== null) {
      if (String(pa.op) !== String(sec.op ?? '')) return false;
      if (sec.opc !== null && sec.opc !== undefined) return false;
    }
    if (pa.amf !== undefined && pa.amf !== null && String(pa.amf) !== String(sec.amf ?? '')) return false;
  }

  // Check ambr
  if (profile.ambr !== undefined && profile.ambr !== null) {
    if (stable(profile.ambr) !== stable(current.ambr)) return false;
  }

  // Check slices
  if (profile.sliceList !== undefined && profile.sliceList !== null) {
    if (stable(profile.sliceList) !== stable(current.slice)) return false;
  }

  // Check access_restriction_data
  if (profile.access_restriction_data !== undefined && profile.access_restriction_data !== null) {
    if (profile.access_restriction_data !== current.access_restriction_data) return false;
  }

  return true;
}

/**
 * Detect if security material changed.
 */
export function securityMaterialChanged(
  before: XcloudSubscriberDocument,
  after: XcloudSubscriberDocument,
): boolean {
  const bs = before.security || {};
  const as = after.security || {};
  return (
    String(bs.k ?? '') !== String(as.k ?? '') ||
    String(bs.op ?? '') !== String(as.op ?? '') ||
    String(bs.opc ?? '') !== String(as.opc ?? '') ||
    String(bs.amf ?? '') !== String(as.amf ?? '')
  );
}

// ─── Prepare / Assert / Execute ───

/**
 * Prepare frozen v1 intent. No database mutation.
 */
export async function prepareFrozenSubscriberProfileApply(
  imsi: string,
  profileName: string,
  clock: () => string = () => new Date().toISOString(),
): Promise<FrozenSubscriberProfileApplyV1> {
  if (!imsi || !/^\d{15}$/.test(imsi)) {
    throw new SubscriberProfileApplyError('INVALID_IMSI', 400);
  }
  if (!profileName || !profileName.trim()) {
    throw new SubscriberProfileApplyError('INVALID_PROFILE_NAME', 400);
  }

  const subscriber = await findSubscriberDocument(imsi);
  if (!subscriber) {
    throw new SubscriberProfileApplyError('SUBSCRIBER_NOT_FOUND', 404);
  }

  const profile = await getProfile(profileName);
  if (!profile) {
    throw new SubscriberProfileApplyError('PROFILE_NOT_FOUND', 404);
  }

  const subscriberPreconditionHash = computeSubscriberPreconditionHash(subscriber);
  const profilePreconditionHash = computeProfilePreconditionHash(profile);
  const effective = buildSubscriberAfterProfileApply(subscriber, profile, profileName, clock);
  const before = subscriberSafeSnapshot(subscriber);
  const afterPreview = subscriberSafeSnapshot(effective);

  // No-effect detection
  if (!securityMaterialChanged(subscriber, effective) &&
      stable(before) === stable(afterPreview) &&
      subscriber.webui_meta?.profile_name === profileName) {
    throw new SubscriberProfileApplyError('SUBSCRIBER_PROFILE_APPLY_NO_EFFECT', 409);
  }

  const operationFingerprint = computeProfileApplyFingerprint(
    imsi, profileName, subscriberPreconditionHash, profilePreconditionHash, afterPreview,
  );

  return {
    version: 'subscriber-profile-apply-v1',
    imsi,
    profileName,
    subscriberPreconditionHash,
    profilePreconditionHash,
    before,
    afterPreview,
    operationFingerprint,
  };
}

/**
 * Assert frozen intent against current state.
 * Returns null if drift detected.
 */
export async function assertFrozenSubscriberProfileApply(
  intent: FrozenSubscriberProfileApplyV1,
): Promise<ProfileApplyAssertion | null> {
  const subscriber = await findSubscriberDocument(intent.imsi);
  if (!subscriber) return null;

  const profile = await getProfile(intent.profileName);
  if (!profile) return null;

  // Verify subscriber precondition
  const currentSubHash = computeSubscriberPreconditionHash(subscriber);
  if (currentSubHash !== intent.subscriberPreconditionHash) return null;

  // Verify profile precondition
  const currentProfHash = computeProfilePreconditionHash(profile);
  if (currentProfHash !== intent.profilePreconditionHash) return null;

  const effective = buildSubscriberAfterProfileApply(subscriber, profile, intent.profileName);

  return {
    intent,
    currentSubscriber: subscriber,
    currentProfile: profile,
    effectiveSubscriber: effective,
  };
}

/**
 * Execute frozen profile apply with full-document CAS.
 * No upsert. Returns the updated subscriber.
 *
 * replaceCAS: (expected, replacement) => Promise<boolean>
 */
export async function executeFrozenSubscriberProfileApply(
  assertion: ProfileApplyAssertion,
  actor: string,
  replaceCAS: (expected: XcloudSubscriberDocument, replacement: XcloudSubscriberDocument) => Promise<boolean>,
): Promise<ProfileApplyResult> {
  const { intent, currentSubscriber, effectiveSubscriber } = assertion;

  // Update webui_meta with actor
  if (!effectiveSubscriber.webui_meta) {
    effectiveSubscriber.webui_meta = {};
  }
  effectiveSubscriber.webui_meta.updated_at = new Date();

  const replaced = await replaceCAS(currentSubscriber, effectiveSubscriber);
  if (!replaced) {
    throw new SubscriberProfileApplyError('SUBSCRIBER_PROFILE_APPLY_PRECONDITION_CHANGED', 409);
  }

  const secChanged = securityMaterialChanged(currentSubscriber, effectiveSubscriber);

  return {
    restored: effectiveSubscriber,
    classification: 'SUCCESS',
    committed: true,
    securityChanged: secChanged,
  };
}

// ─── Helpers ───

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepCopySubscriber(doc: XcloudSubscriberDocument): XcloudSubscriberDocument {
  return JSON.parse(JSON.stringify(doc));
}

// Re-export for testability
export { stable, hash, subscriberSafeSnapshot } from '@/lib/subscriberContract';
export type { SafeSnapshot } from '@/lib/subscriberContract';
