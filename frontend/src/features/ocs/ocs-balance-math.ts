/*
 * Deterministic balance adjustment arithmetic and validation.
 *
 * Replaces permissive floating-point parsing with exact decimal conversions
 * using BigInt to prevent silent precision loss, rounding of fractional units,
 * and unsafe integer mutations.
 */
import type { OcsBalanceViewModel } from './ocs-view-models';

export type BalanceBucketType = 'data' | 'voice' | 'sms';
export type BalanceOperationType = 'credit' | 'debit';
export type DataUnitType = 'GB' | 'MB' | 'Bytes';
export type VoiceUnitType = 'Minutes' | 'Seconds';
export type BalanceUnitType = DataUnitType | VoiceUnitType | 'SMS';

export interface AmountParseSuccess {
  ok: true;
  canonicalAmount: number;
  canonicalUnit: string;
}

export interface AmountParseFailure {
  ok: false;
  errorKey: string;
}

export type AmountParseResult = AmountParseSuccess | AmountParseFailure;

export interface ProjectAdjustmentParams {
  balance: OcsBalanceViewModel | null | undefined;
  bucket: BalanceBucketType;
  operation: BalanceOperationType;
  canonicalAmount: number;
}

export interface BalanceAdjustmentProjection {
  imsi: string;
  bucket: BalanceBucketType;
  operation: BalanceOperationType;
  canonicalAmount: number;
  signedDelta: number;
  beforeTotal: number;
  beforeAvailable: number;
  beforeUsed: number;
  beforeReserved: number | null;
  expectedTotal: number;
  expectedAvailable: number;
  unchangedUsed: number;
  unchangedReserved: number | null;
  version: number;
  invariantsOk: boolean;
}

export interface ProjectionSuccess {
  ok: true;
  projection: BalanceAdjustmentProjection;
}

export interface ProjectionFailure {
  ok: false;
  errorKey: string;
}

export type ProjectionResult = ProjectionSuccess | ProjectionFailure;

const POSITIVE_DECIMAL_REGEX = /^[0-9]+(\.[0-9]+)?$/;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parses a raw user-entered amount string into an exact canonical positive integer.
 *
 * Rules:
 *  - 1 GB = 1,073,741,824 Bytes
 *  - 1 MB = 1,048,576 Bytes
 *  - 1 Minute = 60 Seconds
 *  - Fractional canonical units (Bytes, Seconds, SMS messages) are strictly rejected.
 *  - Non-finite, exponential, negative, zero, and out-of-safe-integer amounts are rejected.
 */
export function parseCanonicalAdjustmentAmount(
  rawInput: string,
  bucket: BalanceBucketType,
  unit: string,
): AmountParseResult {
  const trimmed = rawInput.trim();
  if (!trimmed || !POSITIVE_DECIMAL_REGEX.test(trimmed)) {
    return { ok: false, errorKey: 'ocs_balance_amount_invalid' };
  }

  const parts = trimmed.split('.');
  const intStr = parts[0] || '0';
  let fracStr = parts[1] || '';

  // Strip trailing zeros from fractional part (e.g. "50" -> "5")
  while (fracStr.endsWith('0')) {
    fracStr = fracStr.slice(0, -1);
  }

  const isIntegerOnly = fracStr.length === 0;

  let multiplier = 1n;
  let canonicalUnit = '';

  if (bucket === 'sms') {
    if (!isIntegerOnly) {
      return { ok: false, errorKey: 'ocs_balance_fractional_unit' };
    }
    multiplier = 1n;
    canonicalUnit = 'SMS';
  } else if (bucket === 'data') {
    canonicalUnit = 'Bytes';
    if (unit === 'Bytes') {
      if (!isIntegerOnly) {
        return { ok: false, errorKey: 'ocs_balance_fractional_unit' };
      }
      multiplier = 1n;
    } else if (unit === 'MB') {
      multiplier = 1048576n; // 1024 * 1024
    } else if (unit === 'GB') {
      multiplier = 1073741824n; // 1024 * 1024 * 1024
    } else {
      return { ok: false, errorKey: 'ocs_balance_amount_invalid' };
    }
  } else if (bucket === 'voice') {
    canonicalUnit = 'Seconds';
    if (unit === 'Seconds') {
      if (!isIntegerOnly) {
        return { ok: false, errorKey: 'ocs_balance_fractional_unit' };
      }
      multiplier = 1n;
    } else if (unit === 'Minutes') {
      multiplier = 60n;
    } else {
      return { ok: false, errorKey: 'ocs_balance_amount_invalid' };
    }
  } else {
    return { ok: false, errorKey: 'ocs_balance_amount_invalid' };
  }

  let totalBigInt = 0n;

  try {
    const intVal = BigInt(intStr);
    totalBigInt = intVal * multiplier;

    if (fracStr.length > 0) {
      const fracVal = BigInt(fracStr);
      const scale = 10n ** BigInt(fracStr.length);
      const scaledFrac = fracVal * multiplier;

      // If the scaled fraction does not divide evenly by scale, it results in a fractional canonical unit!
      if (scaledFrac % scale !== 0n) {
        return { ok: false, errorKey: 'ocs_balance_fractional_unit' };
      }
      totalBigInt += scaledFrac / scale;
    }
  } catch {
    return { ok: false, errorKey: 'ocs_balance_amount_invalid' };
  }

  if (totalBigInt <= 0n) {
    return { ok: false, errorKey: 'ocs_balance_amount_invalid' };
  }

  if (totalBigInt > MAX_SAFE_BIGINT) {
    return { ok: false, errorKey: 'ocs_balance_overflow' };
  }

  return {
    ok: true,
    canonicalAmount: Number(totalBigInt),
    canonicalUnit,
  };
}

/**
 * Projects before, delta, and after values from an authoritative balance view model.
 *
 * Enforces:
 *  - Missing field detection (never substitutes 0 for unknown).
 *  - Tri-state invariant validation (rejects broken or missing invariants).
 *  - Debit capacity constraint (debit cannot exceed available or create negative balance).
 *  - Safe integer overflow boundaries.
 */
export function projectBalanceAdjustment({
  balance,
  bucket,
  operation,
  canonicalAmount,
}: ProjectAdjustmentParams): ProjectionResult {
  if (!balance) {
    return { ok: false, errorKey: 'ocs_balance_not_found' };
  }

  const imsi = balance.imsi?.trim();
  if (!imsi) {
    return { ok: false, errorKey: 'ocs_balance_not_found' };
  }

  const version = balance.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { ok: false, errorKey: 'ocs_balance_version_missing' };
  }

  // Check invariants: if reported invariants are false or null/missing, block mutation
  if (balance.invariants.all === false || balance.invariants[bucket] === false) {
    return { ok: false, errorKey: 'ocs_balance_invariants_broken' };
  }
  if (balance.invariants.all === null || balance.invariants[bucket] === null) {
    return { ok: false, errorKey: 'ocs_balance_fields_missing' };
  }

  const bucketData = balance[bucket];
  if (!bucketData) {
    return { ok: false, errorKey: 'ocs_balance_fields_missing' };
  }

  const beforeTotal = bucketData.total;
  const beforeAvailable = bucketData.available;
  const beforeUsed = bucketData.used;
  const beforeReserved = bucket === 'sms' ? null : bucketData.reserved;

  // Never substitute 0 for missing/unknown fields
  if (
    beforeTotal === null ||
    beforeAvailable === null ||
    beforeUsed === null ||
    (bucket !== 'sms' && beforeReserved === null)
  ) {
    return { ok: false, errorKey: 'ocs_balance_fields_missing' };
  }

  if (
    !Number.isFinite(beforeTotal) ||
    !Number.isFinite(beforeAvailable) ||
    !Number.isFinite(beforeUsed) ||
    (beforeReserved !== null && !Number.isFinite(beforeReserved))
  ) {
    return { ok: false, errorKey: 'ocs_balance_fields_missing' };
  }

  if (
    typeof canonicalAmount !== 'number' ||
    !Number.isInteger(canonicalAmount) ||
    canonicalAmount <= 0 ||
    canonicalAmount > Number.MAX_SAFE_INTEGER
  ) {
    return { ok: false, errorKey: 'ocs_balance_amount_invalid' };
  }

  const signedDelta = operation === 'credit' ? canonicalAmount : -canonicalAmount;
  let expectedTotal = 0;
  let expectedAvailable = 0;

  if (operation === 'credit') {
    expectedTotal = beforeTotal + canonicalAmount;
    expectedAvailable = beforeAvailable + canonicalAmount;
    if (
      expectedTotal > Number.MAX_SAFE_INTEGER ||
      expectedAvailable > Number.MAX_SAFE_INTEGER
    ) {
      return { ok: false, errorKey: 'ocs_balance_overflow' };
    }
  } else if (operation === 'debit') {
    if (canonicalAmount > beforeAvailable) {
      return { ok: false, errorKey: 'ocs_balance_insufficient' };
    }
    expectedTotal = beforeTotal - canonicalAmount;
    expectedAvailable = beforeAvailable - canonicalAmount;

    if (expectedTotal < 0 || expectedAvailable < 0) {
      return { ok: false, errorKey: 'ocs_balance_insufficient' };
    }

    const minRequiredTotal = beforeUsed + (beforeReserved ?? 0);
    if (expectedTotal < minRequiredTotal) {
      return { ok: false, errorKey: 'ocs_balance_insufficient' };
    }
  } else {
    return { ok: false, errorKey: 'ocs_balance_amount_invalid' };
  }

  return {
    ok: true,
    projection: {
      imsi,
      bucket,
      operation,
      canonicalAmount,
      signedDelta,
      beforeTotal,
      beforeAvailable,
      beforeUsed,
      beforeReserved,
      expectedTotal,
      expectedAvailable,
      unchangedUsed: beforeUsed,
      unchangedReserved: beforeReserved,
      version,
      invariantsOk: true,
    },
  };
}
