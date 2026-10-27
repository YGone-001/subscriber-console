/*
 * Presentation helpers shared by the template list and the version diff.
 * Values are formatted, never invented: an absent value is reported with the
 * caller's not-configured label instead of a plausible default.
 */

export const AMBR_UNIT_LABELS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];

/* Rating rule vocabulary shared by the template view and editors. */
export function ratingTypeLabel(t: (key: string) => string, value?: string): string {
  if (value === 'data_volume') return t('rating_service_data');
  if (value === 'voice_time') return t('rating_service_voice');
  if (value === 'sms_event' || value === 'event') return t('rating_service_sms');
  if (value === 'free') return t('rating_service_ims');
  return value || '-';
}

export function ratingUnitLabel(t: (key: string) => string, value?: string): string {
  if (value === 'bytes' || value === 'octets') return t('rating_unit_bytes');
  if (value === 'seconds') return t('rating_unit_seconds');
  if (value === 'events') return t('rating_unit_events');
  return value || '-';
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* A decoded AMBR side may carry no unit, and bps is a legal unit at index 0.
 * Resolving the absent case to any index would both display and persist an
 * invented unit, so an absent or out-of-range unit reports '' and the caller
 * shows it as unset. */
export function ambrSelectUnit(unit: unknown): number | '' {
  const index = toFiniteNumber(unit);
  if (index === null || !Number.isInteger(index) || index < 0 || index >= AMBR_UNIT_LABELS.length) {
    return '';
  }
  return index;
}

/* The unit's display form, with no invented default: an absent or unresolvable
 * unit reads as no unit at all rather than as Kbps. */
export function ambrUnitLabel(unit: unknown): string {
  const index = ambrSelectUnit(unit);
  return index === '' ? '' : AMBR_UNIT_LABELS[index] ?? '';
}

export type AmbrSideView = { text: string; unit: string };

export function ambrSideView(side: unknown, notConfigured: string): AmbrSideView {
  const record = typeof side === 'object' && side !== null ? side as Record<string, unknown> : null;
  const value = record === null ? null : toFiniteNumber(record.value);
  if (value === null) return { text: notConfigured, unit: '' };
  return { text: String(value), unit: ambrUnitLabel(record?.unit) };
}

export function mbrSideText(side: unknown, notSet: string): string {
  const record = typeof side === 'object' && side !== null ? side as Record<string, unknown> : null;
  if (record === null || record.value === undefined || record.value === null) return notSet;
  const value = toFiniteNumber(record.value);
  if (value === null) return notSet;
  return `${value} ${ambrUnitLabel(record.unit)}`.trim();
}

export type TemplateImpact = { kind: 'unknown' } | { kind: 'known'; count: number };

/*
 * An attribution read that failed is not "zero linked users". A confirmation in
 * front of a write has to say it cannot tell, instead of reporting a count that
 * never came from anywhere.
 */
export function resolveTemplateImpact(
  count: number | null | undefined,
  statsAvailable: boolean,
): TemplateImpact {
  if (!statsAvailable || typeof count !== 'number' || !Number.isFinite(count)) {
    return { kind: 'unknown' };
  }
  return { kind: 'known', count };
}

export function formatAmbrSide(side: unknown, fallback: string): string {
  if (typeof side !== 'object' || side === null) return fallback;
  const record = side as Record<string, unknown>;
  const value = toFiniteNumber(record.value);
  if (value === null) return fallback;
  const unitIndex = toFiniteNumber(record.unit);
  const unit = unitIndex === null ? '' : AMBR_UNIT_LABELS[unitIndex] ?? '';
  return `${value} ${unit}`.trim();
}

export function formatAmbrPair(
  ambr: unknown,
  fallback: string,
  labels: { downlink: string; uplink: string },
): string {
  const sides = ambrPairOrFallback(ambr, fallback);
  if (!sides) return fallback;
  const [downlink, uplink] = sides;
  return `${labels.downlink} ${downlink} / ${labels.uplink} ${uplink}`;
}

/* The list column already sits under a UE-AMBR heading, so the direction words
 * cost width without adding information. */
export function formatAmbrPairCompact(ambr: unknown, fallback: string): string {
  const sides = ambrPairOrFallback(ambr, fallback);
  return sides ? `${sides[0]} / ${sides[1]}` : fallback;
}

function ambrPairOrFallback(ambr: unknown, fallback: string): [string, string] | null {
  if (typeof ambr !== 'object' || ambr === null) return null;
  const record = ambr as Record<string, unknown>;
  const downlink = formatAmbrSide(record.downlink, fallback);
  const uplink = formatAmbrSide(record.uplink, fallback);
  if (downlink === fallback && uplink === fallback) return null;
  return [downlink, uplink];
}
