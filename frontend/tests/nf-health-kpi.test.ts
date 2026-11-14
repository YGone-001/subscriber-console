/*
 * Health KPI cards as filter entries.
 *
 * The KPI strip must let an operator move from a number to the exact
 * population it counts. The mapping is therefore a pure function, asserted
 * here without a DOM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { healthKpiFilter } from '../src/features/nf-health/nf-health-kpi';

test('each freshness KPI card selects exactly its own freshness state', () => {
  assert.deepEqual(healthKpiFilter('fresh'), { freshness: 'fresh', collection: null });
  assert.deepEqual(healthKpiFilter('stale'), { freshness: 'stale', collection: null });
  assert.deepEqual(healthKpiFilter('unknown'), { freshness: 'unknown', collection: null });
  assert.deepEqual(healthKpiFilter('notMonitored'), {
    freshness: 'not_monitored',
    collection: null,
  });
});

test('the failed KPI card selects the collection outcome, not a freshness state', () => {
  assert.deepEqual(healthKpiFilter('failed'), { freshness: null, collection: 'failed' });
});

test('the configured KPI card clears both narrowing dimensions', () => {
  assert.deepEqual(healthKpiFilter('configured'), { freshness: null, collection: null });
});

test('a freshness card clears the collection dimension and vice versa', () => {
  // Freshness and collection outcome are independent dimensions: a failed
  // attempt never advances the accepted measurement, so a target can be fresh
  // and failed at the same time. Stacking them would hide targets.
  const fresh = healthKpiFilter('fresh');
  assert.equal(fresh.collection, null, 'a freshness card must not keep a collection filter');

  const failed = healthKpiFilter('failed');
  assert.equal(failed.freshness, null, 'the failed card must not keep a freshness filter');
});
