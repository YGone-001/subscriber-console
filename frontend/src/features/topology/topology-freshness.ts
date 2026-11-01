/*
 * Source-time freshness for topology reads.
 *
 * Every topology surface is read on demand, so a canvas can be showing a
 * snapshot from minutes ago while the page looks live. The projection therefore
 * states its own source time and whether that time is still inside the policy,
 * and it never calls an unknown time "fresh": an unparseable or absent source
 * time is its own state.
 *
 * The policy is deliberately short and explicit. It describes staleness of the
 * evidence, not a health or availability claim about the resources inside it.
 */

export const TOPOLOGY_FRESHNESS_POLICY_SECONDS = 300;

export type TopologyFreshness = 'fresh' | 'stale' | 'unknown';

/** Milliseconds since the epoch for a server supplied ISO timestamp, or null. */
export function parseSourceTime(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function sourceAgeSeconds(
  value: string | undefined | null,
  nowMs: number = Date.now(),
): number | null {
  const parsed = parseSourceTime(value);
  if (parsed === null) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

export function freshnessState(
  ageSeconds: number | null,
  policySeconds: number = TOPOLOGY_FRESHNESS_POLICY_SECONDS,
): TopologyFreshness {
  if (ageSeconds === null) return 'unknown';
  return ageSeconds <= policySeconds ? 'fresh' : 'stale';
}

export function freshnessLabelKey(state: TopologyFreshness): string {
  return `topology_fresh_${state}`;
}

/** The source time exactly as the server reported it, so no local clock is implied. */
export function sourceTimeLabel(value: string | undefined | null): string {
  return parseSourceTime(value) === null ? '' : String(value);
}