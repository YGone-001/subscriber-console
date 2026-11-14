/*
 * Health KPI cards as filter entries.
 *
 * Every KPI card narrows the queue to exactly the population it counts, so an
 * operator never has to translate a number into a hand-built filter.
 *
 * The mapping is a pure function of the KPI key: it keeps the URL contract in
 * one place and lets the mapping be asserted without a DOM.
 */

/** The filter patch a KPI card applies when it is clicked. */
export type HealthKpiFilter = {
  /** Comma-separated freshness states, or null to clear the freshness filter. */
  freshness: string | null;
  /** Latest collection attempt outcome, or null to clear the collection filter. */
  collection: string | null;
};

export type HealthKpiKey =
  | 'configured'
  | 'fresh'
  | 'stale'
  | 'unknown'
  | 'notMonitored'
  | 'failed';

/**
 * Maps a KPI card onto the filter it applies.
 *
 * The freshness cards and the collection card are different dimensions: a
 * failed attempt never advances the accepted measurement, so a target can be
 * fresh and failed at the same time. Clicking one dimension therefore clears
 * the other, instead of stacking two narrowing filters that could hide a
 * target.
 */
export function healthKpiFilter(key: HealthKpiKey): HealthKpiFilter {
  switch (key) {
    case 'fresh':
      return { freshness: 'fresh', collection: null };
    case 'stale':
      return { freshness: 'stale', collection: null };
    case 'unknown':
      return { freshness: 'unknown', collection: null };
    case 'notMonitored':
      return { freshness: 'not_monitored', collection: null };
    case 'failed':
      return { freshness: null, collection: 'failed' };
    case 'configured':
    default:
      return { freshness: null, collection: null };
  }
}
