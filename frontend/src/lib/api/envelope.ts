/*
 * Response envelope coercion.
 *
 * The Go service answers with a small set of envelope shapes (`{plan}`,
 * `{ok, balance}`, `{ok, records}`, `{items, stats}`, `{profiles, summary}`,
 * `{subscribers, total, summary}`). Ported presentational components were
 * written against the historical client, which returned the payload already
 * unwrapped, so every ported component would otherwise need its own unwrapping
 * and its own defensive coercion.
 *
 * This module centralises that, with one rule that matters: an ABSENT field, a
 * NULL field, and a real ZERO/EMPTY value are three different things, and the
 * coercers keep them apart.
 *
 *   undefined  the key was not present in the payload
 *   null       the key was present but the value is unusable
 *   0 / '' / []  a real value that must be rendered as-is
 */
export type UnknownRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A record, or an empty record when the value is not one. */
export function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

/** A record, or null when the value is not one. */
export function asRecordOrNull(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

/** A string, or null. An empty string is a real value and is preserved. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A non-empty trimmed string, or null. */
export function asText(value: unknown): string | null {
  const text = asString(value);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** A finite number, or null. Zero is preserved. */
export function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A boolean, or null. `false` is preserved. */
export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** An array, or null. An empty array is a real value and is preserved. */
export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * A 24-hex identifier as a plain string.
 *
 * Accepts a raw string or an extended-JSON `{$oid}` wrapper, so a driver that
 * leaks an object form can never reach a renderer as "[object Object]".
 */
export function asIdString(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (isRecord(value)) {
    const oid = value.$oid;
    if (typeof oid === 'string' && oid !== '') return oid;
  }
  return null;
}

/** An ISO timestamp string, or null when it is absent or unparseable. */
export function asTimestamp(value: unknown): string | null {
  const text = asText(value);
  if (text === null) return null;
  return Number.isNaN(new Date(text).getTime()) ? null : text;
}

/**
 * Read one field with a tri-state result.
 *
 *   undefined  the key was absent
 *   null       the key was present but the value failed `coerce`
 *   T          the coerced value
 */
export function pick<T>(record: UnknownRecord, key: string, coerce: (value: unknown) => T | null): T | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const raw = record[key];
  if (raw === null) return null;
  return coerce(raw);
}

/** Read one field, collapsing "absent" and "unusable" into null. */
export function field<T>(record: UnknownRecord, key: string, coerce: (value: unknown) => T | null): T | null {
  return pick(record, key, coerce) ?? null;
}

/** True when the payload is an explicit failure envelope (`{ok: false}`). */
export function isFailureEnvelope(payload: unknown): boolean {
  return isRecord(payload) && payload.ok === false;
}

/**
 * Unwrap a single-record envelope.
 *
 * Returns the first present key whose value is a record. When the payload is a
 * bare record with none of the keys it is returned unchanged, so both `{plan}`
 * and a plain plan object work. An `{ok: false}` payload always yields null.
 */
export function unwrapRecord(payload: unknown, ...keys: string[]): UnknownRecord | null {
  if (isFailureEnvelope(payload)) return null;
  const record = asRecordOrNull(payload);
  if (!record) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (isRecord(candidate)) return candidate;
  }
  if (keys.some((key) => Object.prototype.hasOwnProperty.call(record, key))) return null;
  return record;
}

/**
 * Unwrap a list envelope.
 *
 * Returns the first present key whose value is an array, or the payload itself
 * when it is already an array. An empty array is returned as an empty array,
 * never as null: "no rows" and "unreadable payload" are different states.
 */
export function unwrapList(payload: unknown, ...keys: string[]): unknown[] | null {
  if (isFailureEnvelope(payload)) return null;
  const direct = asArray(payload);
  if (direct) return direct;
  const record = asRecordOrNull(payload);
  if (!record) return null;
  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

/** Unwrap a nested record such as `summary` or `stats`. */
export function unwrapSummary(payload: unknown, key: string): UnknownRecord | null {
  return asRecordOrNull(asRecord(payload)[key]);
}

/**
 * Display text for a scalar, preserving zero and empty string.
 *
 * `null`, `undefined` and objects fall back to the placeholder; numbers and
 * strings render as themselves.
 */
export function displayText(value: unknown, fallback = '-'): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value === '' ? fallback : value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

/** Percentage of a total, clamped to 0-100. Null when the total is unusable. */
export function percentOf(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.min(100, Math.max(0, (used / total) * 100));
}
