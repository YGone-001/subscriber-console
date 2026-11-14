/*
 * Operations summary projection tests.
 *
 * UX-0 contract: page KPIs must come from the full-collection summary
 * section with an explicit scope/completeness label. A page-scoped count
 * must never be presented as a platform total, and an unavailable section
 * must project to explicit null KPIs so the UI renders an unavailable
 * label instead of a zero.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alertsKpisFromSummary,
  discoveryKpisFromSummary,
  healthKpisFromSummary,
  isSectionComplete,
  type AlertsSummarySection,
  type DiscoverySummarySection,
  type HealthSummarySection,
} from '../src/features/operations/operations-summary';

const discoverySection = (
  overrides: Partial<DiscoverySummarySection> = {},
): DiscoverySummarySection => ({
  completeness: 'complete',
  scope: 'full_collection',
  sources: 3,
  candidates: { seen: 10, missing: 2, stale: 1, linked: 7, unlinked: 5 },
  ...overrides,
});

const healthSection = (
  overrides: Partial<HealthSummarySection> = {},
): HealthSummarySection => ({
  completeness: 'complete',
  scope: 'full_collection',
  targets: {
    configured: 12,
    enabled: 10,
    failed: 2,
    freshnessByState: { fresh: 7, stale: 2, unknown: 3 },
    overallByState: {},
    layersByState: {},
  },
  ...overrides,
});

const alertsSection = (
  overrides: Partial<AlertsSummarySection> = {},
): AlertsSummarySection => ({
  completeness: 'complete',
  scope: 'full_collection',
  alerts: {
    totalRules: 4,
    enabledRules: 3,
    alertsByState: { active: 5, acknowledged: 2, assigned: 3, recovering: 1, resolved: 9 },
    openBySeverity: { critical: 1, warning: 4, info: 2 },
  },
  ...overrides,
});

test('discovery KPIs project from a complete section', () => {
  const kpis = discoveryKpisFromSummary(discoverySection());
  assert.deepEqual(kpis, { sources: 3, seen: 10, missing: 2, stale: 1, linked: 7 });
});

test('discovery KPIs stay null when the section is missing', () => {
  const kpis = discoveryKpisFromSummary(undefined);
  assert.deepEqual(kpis, { sources: null, seen: null, missing: null, stale: null, linked: null });
});

test('discovery KPIs stay null when the section is unavailable', () => {
  const kpis = discoveryKpisFromSummary(
    discoverySection({ completeness: 'unavailable', error: 'SECTION_UNAVAILABLE' }),
  );
  assert.deepEqual(kpis, { sources: null, seen: null, missing: null, stale: null, linked: null });
});

test('discovery KPIs keep explicit null for absent counts in a complete section', () => {
  const kpis = discoveryKpisFromSummary(discoverySection({ sources: undefined, candidates: undefined }));
  assert.deepEqual(kpis, { sources: null, seen: null, missing: null, stale: null, linked: null });
});

test('health KPIs project freshness and failure from the full population', () => {
  const kpis = healthKpisFromSummary(healthSection());
  // The freshness states are mutually exclusive, so each bucket is read from
  // the server distribution rather than derived by subtraction. "failed" is an
  // independent dimension: a failed attempt never advances the measurement, so
  // a target can be fresh and failed at the same time.
  assert.deepEqual(kpis, {
    configured: 12,
    fresh: 7,
    stale: 2,
    unknown: 3,
    notMonitored: 0,
    failed: 2,
  });
});

test('health KPIs stay null when the section is unavailable', () => {
  const kpis = healthKpisFromSummary(healthSection({ completeness: 'unavailable' }));
  assert.deepEqual(kpis, {
    configured: null,
    fresh: null,
    stale: null,
    unknown: null,
    notMonitored: null,
    failed: null,
  });
});

test('health KPIs stay null when the section carries no target counts', () => {
  const kpis = healthKpisFromSummary(healthSection({ targets: undefined }));
  assert.deepEqual(kpis, {
    configured: null,
    fresh: null,
    stale: null,
    unknown: null,
    notMonitored: null,
    failed: null,
  });
});

test('health freshness buckets never borrow from the failed dimension', () => {
  // A target whose last attempt failed keeps its previous measurement, so it
  // can be fresh and failed at once. The stale/unknown counts must therefore
  // come from the freshness distribution and not from a subtraction.
  const kpis = healthKpisFromSummary(
    healthSection({
      targets: {
        configured: 5,
        enabled: 5,
        failed: 4,
        freshnessByState: { fresh: 4, stale: 1 },
        overallByState: {},
        layersByState: {},
      },
    }),
  );
  assert.equal(kpis.stale, 1);
  assert.equal(kpis.unknown, 0);
  assert.equal(kpis.fresh, 4);
  assert.equal(kpis.failed, 4);
});

test('alerts KPIs project queue totals from the full population', () => {
  const kpis = alertsKpisFromSummary(alertsSection());
  assert.deepEqual(kpis, { rules: 4, active: 5, acknowledged: 2, assigned: 3, recovering: 1, criticalOpen: 1 });
});

test('alerts KPIs stay null when the section is unavailable', () => {
  const kpis = alertsKpisFromSummary(alertsSection({ completeness: 'unavailable' }));
  assert.deepEqual(kpis, { rules: null, active: null, acknowledged: null, assigned: null, recovering: null, criticalOpen: null });
});

test('alerts KPIs stay null when the section carries no alert counts', () => {
  const kpis = alertsKpisFromSummary(alertsSection({ alerts: undefined }));
  assert.deepEqual(kpis, { rules: null, active: null, acknowledged: null, assigned: null, recovering: null, criticalOpen: null });
});

test('isSectionComplete accepts only the complete marker', () => {
  assert.equal(isSectionComplete('complete'), true);
  assert.equal(isSectionComplete('unavailable'), false);
  assert.equal(isSectionComplete(undefined), false);
});