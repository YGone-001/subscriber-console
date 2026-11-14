/*
 * NF Health list contract: in-page views, URL filters and the request shape.
 *
 * The page shows one representation at a time. A duty operator opens it to see
 * what needs attention, so the default view is the compact card wall and the
 * default order is the server-defined risk order. The table stays available for
 * audit columns; it is a different view, never a second section below the
 * cards.
 *
 * Everything here is pure so the URL contract can be asserted without a DOM.
 */
import type { NfHealthInterfaceQueryParams, NfHealthTargetQueryParams } from './nf-health-types';

export const HEALTH_VIEWS = ['cards', 'table', 'interfaces'] as const;
export type HealthView = (typeof HEALTH_VIEWS)[number];
export const DEFAULT_HEALTH_VIEW: HealthView = 'cards';

export const HEALTH_SORTS = ['risk', 'updated'] as const;
export type HealthSort = (typeof HEALTH_SORTS)[number];
export const DEFAULT_HEALTH_SORT: HealthSort = 'risk';

/* Canonical overall states published by the backend projection. */
export const HEALTH_OVERALL_STATES = [
  'healthy',
  'degraded',
  'unhealthy',
  'stale',
  'unknown',
  'not_configured',
] as const;

/* Layer coverage filter: requiring a layer means "this layer was measured". */
export const HEALTH_LAYER_FILTERS = ['l1', 'l2', 'l3'] as const;

/* Measurement freshness states published by the backend. Freshness is the age
 * of the accepted measurement against the target's own policy window; it is
 * independent of the collection outcome. */
export const HEALTH_FRESHNESS_STATES = [
  'fresh',
  'stale',
  'unknown',
  'not_monitored',
] as const;

/* Latest collection attempt outcome. A failed attempt never advances the
 * accepted measurement, so a target can be fresh and failed at the same time. */
export const HEALTH_COLLECTION_OUTCOMES = ['failed', 'succeeded'] as const;

export const HEALTH_URL_KEYS = [
  'q',
  'enabled',
  'domain',
  'state',
  'layers',
  'freshness',
  'collection',
  'sort',
] as const;

export type HealthFilterSource = Record<string, string | undefined>;

export type HealthFilters = {
  q: string;
  enabled: string;
  domain: string;
  overall: string;
  layer: string;
  /** Comma-separated freshness states; empty means no freshness narrowing. */
  freshness: string;
  /** Latest collection attempt outcome; empty means no outcome narrowing. */
  collection: string;
  sort: HealthSort;
};

function pick<T extends readonly string[]>(options: T, value: string | undefined): T[number] | '' {
  const trimmed = (value ?? '').trim();
  return (options as readonly string[]).includes(trimmed) ? (trimmed as T[number]) : '';
}

/**
 * Reads a comma-separated filter value, keeping only canonical tokens and
 * preserving request order. An unknown token is dropped rather than forwarded,
 * so a hand-edited URL degrades to the unfiltered queue instead of a 400.
 */
function pickList<T extends readonly string[]>(options: T, value: string | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase();
    if (!token || seen.has(token)) continue;
    if (!(options as readonly string[]).includes(token)) continue;
    seen.add(token);
    kept.push(token);
  }
  return kept.join(',');
}

/**
 * Reads the URL into the filter model.
 *
 * Two compatibility rules matter:
 *   - `state=enabled|disabled` is the pre-view collection filter, so an old
 *     link keeps filtering by collection state instead of requesting an
 *     invalid overall state;
 *   - an unrecognised value is dropped rather than forwarded, so a hand-edited
 *     URL degrades to the unfiltered queue instead of a 400.
 */
export function readHealthFilters(source: HealthFilterSource): HealthFilters {
  let enabled = pick(['true', 'false'], source.enabled);
  let overall = pick(HEALTH_OVERALL_STATES, source.state);
  const legacy = pick(['enabled', 'disabled'], source.state);
  if (!enabled && legacy) {
    enabled = legacy === 'enabled' ? 'true' : 'false';
    overall = '';
  }
  const sort = pick(HEALTH_SORTS, source.sort) || DEFAULT_HEALTH_SORT;
  return {
    q: (source.q ?? '').trim(),
    enabled,
    domain: (source.domain ?? '').trim(),
    overall,
    layer: pick(HEALTH_LAYER_FILTERS, source.layers),
    freshness: pickList(HEALTH_FRESHNESS_STATES, source.freshness),
    collection: pick(HEALTH_COLLECTION_OUTCOMES, source.collection),
    sort: sort as HealthSort,
  };
}

/** Resolves the visible view, defaulting to the duty-queue cards. */
export function healthView(value: string | undefined): HealthView {
  return (pick(HEALTH_VIEWS, value) || DEFAULT_HEALTH_VIEW) as HealthView;
}

/**
 * Builds the bounded target query.
 *
 * Only canonical values reach the request: the backend rejects unknown states
 * and layers, and a stale link must not turn the queue into an error page.
 */
export function healthTargetQuery(
  filters: HealthFilters,
  cursor: string | undefined,
  limit: number,
): NfHealthTargetQueryParams {
  return {
    q: filters.q || undefined,
    enabled: filters.enabled || undefined,
    domain: filters.domain || undefined,
    state: filters.overall || undefined,
    layers: filters.layer || undefined,
    freshness: filters.freshness || undefined,
    collection: filters.collection || undefined,
    sort: filters.sort,
    cursor,
    limit,
  };
}

/**
 * Builds the interface matrix query.
 *
 * The matrix answers the same filters as the list, but its columns come from
 * the server vocabulary and its page from the matrix projection.
 */
export function healthInterfaceQuery(
  filters: HealthFilters,
  cursor: string | undefined,
  limit: number,
): NfHealthInterfaceQueryParams {
  return {
    q: filters.q || undefined,
    domain: filters.domain || undefined,
    freshness: filters.freshness || undefined,
    collection: filters.collection || undefined,
    sort: filters.sort,
    cursor,
    limit,
  };
}

/** True when at least one narrowing filter is active. */
export function hasHealthFilters(filters: HealthFilters): boolean {
  return Boolean(
    filters.q
    || filters.enabled
    || filters.domain
    || filters.overall
    || filters.layer
    || filters.freshness
    || filters.collection,
  );
}
