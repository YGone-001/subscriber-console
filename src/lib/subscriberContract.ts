/**
 * Pure subscriber contract functions.
 *
 * These are the single source of truth for:
 * - SafeSnapshot shape
 * - Canonical stable serialization
 * - Operation fingerprint hashing
 *
 * Imported by BOTH runtime code and fixture producers.
 * Do NOT duplicate these implementations elsewhere.
 */
import { createHash } from 'node:crypto';
import type { XcloudSubscriberDocument } from '@/types/xcloud';

export type SafeSnapshot = {
  imsi: string;
  msisdn: string[];
  accessRestrictionData: number;
  networkAccessMode: number;
  ambr: unknown;
  slices: unknown;
};

/**
 * Canonical stable JSON serialization.
 * Recursively sorts object keys, preserves array order.
 * Matches the wire format used for fingerprint computation.
 */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * SHA256 hash of the stable JSON representation.
 */
export function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

/**
 * Deep-clone a value, converting ObjectId instances to hex strings.
 * This ensures stable() produces deterministic output regardless of
 * whether ObjectId is a class instance or a plain string.
 */
function normalizeForSnapshot(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(normalizeForSnapshot);
  if (typeof value === 'object') {
    // Check for ObjectId (has toHexString method)
    const obj = value as Record<string, unknown>;
    if (typeof obj.toHexString === 'function') return (obj.toHexString as () => string)();
    // Plain object — recurse
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      result[key] = normalizeForSnapshot(obj[key]);
    }
    return result;
  }
  return value;
}

/**
 * Extract a SafeSnapshot from a subscriber document.
 * NEVER includes security, K, OP/OPc, AMF or SQN.
 * ObjectId values are converted to hex strings for deterministic serialization.
 */
export function subscriberSafeSnapshot(doc: XcloudSubscriberDocument): SafeSnapshot {
  return {
    imsi: doc.imsi,
    msisdn: [...(doc.msisdn || [])],
    accessRestrictionData: Number(doc.access_restriction_data ?? 0),
    networkAccessMode: Number(doc.network_access_mode ?? 0),
    ambr: normalizeForSnapshot(doc.ambr),
    slices: normalizeForSnapshot(doc.slice),
  };
}

/**
 * Compute operation fingerprint.
 * Matches Node hash({ operation, imsi, before, after }) exactly.
 */
export function operationFingerprint(
  operation: string,
  imsi: string,
  before: SafeSnapshot,
  after?: SafeSnapshot | null,
): string {
  const obj: Record<string, unknown> = { operation, imsi, before };
  if (after) obj.after = after;
  return hash(obj);
}
