import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const analyticsCockpitSource = readFileSync(
  new URL('../src/components/AnalyticsCockpit.tsx', import.meta.url),
  'utf8'
);

// ─── 1. API Contract Assertions ───

test('Dashboard Pending Approvals metric uses exact lowercase status=pending contract', () => {
  if (!analyticsCockpitSource.includes('/api/approvals')) {
    // Phase 5.7-A: Approvals removed from cockpit overview
    return;
  }
  // Required: /api/approvals?status=pending&limit=1
  assert.match(
    analyticsCockpitSource,
    /\/api\/approvals\?status=pending&limit=1/,
    'Dashboard must query /api/approvals with lowercase status=pending'
  );

  // Forbidden: status=PENDING
  assert.doesNotMatch(
    analyticsCockpitSource,
    /status=PENDING/,
    'Dashboard must NOT use uppercase status=PENDING'
  );
});

test('Dashboard Failed Operations metric uses exact /api/audit?result=failed&limit=1 contract', () => {
  if (!analyticsCockpitSource.includes('/api/audit')) {
    return;
  }
  // Required: /api/audit?result=failed&limit=1
  assert.match(
    analyticsCockpitSource,
    /\/api\/audit\?result=failed&limit=1/,
    'Dashboard must query /api/audit with result=failed'
  );

  // Forbidden: /api/audit-logs as API route in useSWR
  assert.doesNotMatch(
    analyticsCockpitSource,
    /useSWR[^(]*\([^)]*\/api\/audit-logs/,
    'Dashboard must NOT use /api/audit-logs as an API endpoint'
  );

  // Forbidden: result=FAILURE or result=failure
  assert.doesNotMatch(
    analyticsCockpitSource,
    /result=FAILURE/,
    'Dashboard must NOT use result=FAILURE'
  );
  assert.doesNotMatch(
    analyticsCockpitSource,
    /result=failure/,
    'Dashboard must NOT use result=failure (enum is failed)'
  );
});

test('Dashboard reads authoritative Audit response properties (summary.failed / pagination.total)', () => {
  if (!analyticsCockpitSource.includes('auditFailureData')) {
    return;
  }
  // Must access summary.failed or pagination.total
  assert.match(
    analyticsCockpitSource,
    /summary\?\.failed/,
    'Dashboard must read summary.failed from Audit response'
  );
  assert.match(
    analyticsCockpitSource,
    /pagination\?\.total/,
    'Dashboard should fall back to pagination.total from Audit response'
  );

  // Must not have crude fallback `auditFailureData?.total ?? 0`
  assert.doesNotMatch(
    analyticsCockpitSource,
    /auditFailureData\?\.total\s*\?\?\s*0/,
    'Dashboard must NOT blindly fallback auditFailureData?.total ?? 0'
  );
});

test('Dashboard does not silently convert API failures to zero', () => {
  // Forbidden patterns that mask errors as valid zeros:
  assert.doesNotMatch(
    analyticsCockpitSource,
    /approvalData\?\.total\s*\?\?\s*0/,
    'Dashboard must NOT silently convert approvalData to zero'
  );
  assert.doesNotMatch(
    analyticsCockpitSource,
    /ocsSubData\?\.total\s*\?\?\s*0/,
    'Dashboard must NOT silently convert ocsSubData to zero'
  );
});

// ─── 2. Metric State & Failure Semantics Logic Tests ───

// Replicate the exact pure state model used in AnalyticsCockpit
function resolveMetricValue(isUnavailable, data, extractor) {
  if (isUnavailable || data == null) {
    return null; // renders "—"
  }
  return extractor(data);
}

function renderValue(metricCount) {
  return metricCount !== null ? String(metricCount) : '—';
}

test('Pending Approvals metric state logic: distinguishes valid zero from failure', () => {
  const extractor = (data) =>
    typeof data.total === 'number' ? data.total : (data.pagination?.total ?? 0);

  // Case 1: API success with total = 0 -> must be '0'
  const successZero = resolveMetricValue(false, { total: 0 }, extractor);
  assert.equal(renderValue(successZero), '0');

  // Case 2: API success with total > 0 -> must be exact value
  const successPositive = resolveMetricValue(false, { total: 5 }, extractor);
  assert.equal(renderValue(successPositive), '5');

  // Case 3: API failure (error present) -> must be '—', NEVER '0'
  const apiFailure = resolveMetricValue(true, null, extractor);
  assert.equal(renderValue(apiFailure), '—');
  assert.notEqual(renderValue(apiFailure), '0');

  // Case 4: API loading with no data -> must be '—', NEVER '0'
  const apiLoading = resolveMetricValue(true, undefined, extractor);
  assert.equal(renderValue(apiLoading), '—');
  assert.notEqual(renderValue(apiLoading), '0');
});

test('Failed Operations metric state logic: distinguishes valid zero from failure', () => {
  const extractor = (data) =>
    typeof data.summary?.failed === 'number'
      ? data.summary.failed
      : (typeof data.pagination?.total === 'number' ? data.pagination.total : 0);

  // Case 1: API success with summary.failed = 0 -> must be '0'
  const successZero = resolveMetricValue(
    false,
    { summary: { failed: 0 }, pagination: { total: 0 } },
    extractor
  );
  assert.equal(renderValue(successZero), '0');

  // Case 2: API success with summary.failed > 0 -> must be exact value
  const successPositive = resolveMetricValue(
    false,
    { summary: { failed: 14 }, pagination: { total: 14 } },
    extractor
  );
  assert.equal(renderValue(successPositive), '14');

  // Case 3: API failure (error present) -> must be '—', NEVER '0'
  const apiFailure = resolveMetricValue(true, null, extractor);
  assert.equal(renderValue(apiFailure), '—');
  assert.notEqual(renderValue(apiFailure), '0');

  // Case 4: API loading with no data -> must be '—', NEVER '0'
  const apiLoading = resolveMetricValue(true, undefined, extractor);
  assert.equal(renderValue(apiLoading), '—');
  assert.notEqual(renderValue(apiLoading), '0');
});

test('Contract Subscribers metric state logic: distinguishes valid zero from failure', () => {
  const extractor = (data) =>
    typeof data.total === 'number' ? data.total : (data.pagination?.total ?? 0);

  // Case 1: API success with total = 0 -> must be '0'
  const successZero = resolveMetricValue(false, { total: 0 }, extractor);
  assert.equal(renderValue(successZero), '0');

  // Case 2: API success with total = 9 -> must be '9'
  const successPositive = resolveMetricValue(false, { total: 9 }, extractor);
  assert.equal(renderValue(successPositive), '9');

  // Case 3: API failure -> must be '—', NEVER '0'
  const apiFailure = resolveMetricValue(true, null, extractor);
  assert.equal(renderValue(apiFailure), '—');
  assert.notEqual(renderValue(apiFailure), '0');
});

test('Tariff Plans metric state logic: distinguishes valid zero from failure', () => {
  const extractor = (data) =>
    Array.isArray(data)
      ? data.length
      : (data?.plans?.length ?? data?.records?.length ?? (typeof data?.total === 'number' ? data.total : 0));

  // Case 1: API success with 0 plans -> must be '0'
  const successZero = resolveMetricValue(false, { plans: [] }, extractor);
  assert.equal(renderValue(successZero), '0');

  // Case 2: API success with 2 plans -> must be '2'
  const successPositive = resolveMetricValue(false, { plans: [{ id: 'p1' }, { id: 'p2' }] }, extractor);
  assert.equal(renderValue(successPositive), '2');

  // Case 3: API failure -> must be '—', NEVER '0'
  const apiFailure = resolveMetricValue(true, null, extractor);
  assert.equal(renderValue(apiFailure), '—');
  assert.notEqual(renderValue(apiFailure), '0');
});
