/*
 * OCS presentation formatting.
 *
 * Two rules drive everything in this module:
 *
 *   1. A missing value is not a zero. `null` renders as the em dash and never as
 *      `0 B` / `0s`, because an operator reading a balance table must be able to
 *      tell "no measurement" apart from "measured zero".
 *   2. Numbers that the API documents as byte counts or second counts are shown
 *      with a unit. Raw `104857600` next to a column header is a reading hazard.
 */
import { formatBytes, formatSeconds } from '../../lib/unitParser';

/** Rendered in place of any value the API did not supply. */
export const OCS_EMPTY = '\u2014';

/** Byte count, or the em dash when the field is absent. */
export function formatOcsBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return OCS_EMPTY;
  return formatBytes(value);
}

/**
 * Second count as a compact duration (`1d`, `90m`, `45s`), or the em dash.
 *
 * The unit suffixes stay ASCII on purpose: they are the same in both locales and
 * match the duration notation the subscriber surfaces already use.
 */
export function formatOcsSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return OCS_EMPTY;
  return formatSeconds(value);
}

/** Integer or decimal count, or the em dash. */
export function formatOcsNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return OCS_EMPTY;
  return Number(value).toLocaleString();
}

/**
 * A rating-rule quota in the unit the rule declares.
 *
 * Rule quotas are not all byte counts: a voice rule counts seconds and an SMS
 * rule counts events. Formatting every quota as bytes printed "60 B" for a
 * 60-second allowance, which is a wrong measurement rather than a cosmetic
 * choice. Unknown units keep the numeric value and the declared unit verbatim.
 */
export function formatOcsRuleQuota(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return OCS_EMPTY;
  const normalized = (unit ?? '').trim().toLowerCase();
  if (normalized === 'seconds' || normalized === 'second' || normalized === 's') return `${value}s`;
  if (normalized === 'events' || normalized === 'event') return String(value);
  if (normalized === '' || normalized === 'octets' || normalized === 'bytes' || normalized === 'byte') {
    return formatOcsBytes(value);
  }
  return `${value} ${unit}`;
}

/** ISO timestamp rendered in the operator's locale, or the em dash. */
export function formatOcsTime(value: string | null | undefined): string {
  if (!value) return OCS_EMPTY;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

/** Date-only rendering for dense table cells, or the em dash. */
export function formatOcsDate(value: string | null | undefined): string {
  if (!value) return OCS_EMPTY;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString();
}

/**
 * Keep an IMSI query to digits.
 *
 * The read endpoints pass this value into a database regular expression, so any
 * metacharacter either changes the meaning of the search or fails the request
 * outright. Restricting the input to digits at the field is the narrowest fix:
 * it cannot break a legitimate lookup and it removes the injection surface.
 */
export function sanitizeImsiInput(value: string): string {
  return value.replace(/\D+/g, '').slice(0, 18);
}

/** True when the raw search box content had to be rewritten to digits only. */
export function imsiInputWasSanitized(raw: string): boolean {
  return sanitizeImsiInput(raw) !== raw;
}

/**
 * Page count for a fixed-size page, computed from the total rather than trusted
 * from the payload.
 *
 * The contract list endpoint answers `floor(total/limit) + 1`, which advertises
 * an extra trailing page whenever the total is an exact multiple of the limit.
 * The UI derives its own count so the pager can never point at an empty page.
 */
export function pageCountFor(total: number | null | undefined, limit: number): number {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Number(total)) : 0;
  const safeLimit = limit > 0 ? limit : 20;
  return Math.max(1, Math.ceil(safeTotal / safeLimit));
}

/** Formats an unknown error into a short diagnostic string for a state panel. */
export function describeReadError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return '';
}
