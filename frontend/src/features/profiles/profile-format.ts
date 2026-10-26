/*
 * Presentation helpers shared by the template list and the version diff.
 * Values are formatted, never invented: an absent value is reported with the
 * caller's not-configured label instead of a plausible default.
 */

export const AMBR_UNIT_LABELS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
