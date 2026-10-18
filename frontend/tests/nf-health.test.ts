import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCreateTargetRequest,
  buildMetricTrendSeries,
  buildUpdateTargetRequest,
  createEmptyTargetForm,
  splitMetricsEndpoint,
} from '../src/features/nf-health/nf-health-builders';
import {
  validateCandidateId,
  validateResourceId,
  validateTargetForm,
} from '../src/features/nf-health/nf-health-validation';
import type { HealthSample } from '../src/features/nf-health/nf-health-types';

const RESOURCE_ID = '1a2b3c40-0005-4a05-8c05-00000000f005';
const CANDIDATE_ID = '9b2d3c40-0011-4b11-9d11-000000000011';

test('nf health target form: Inventory resource is required for new targets', () => {
  const form = {
    ...createEmptyTargetForm(120),
    serviceKind: 'none' as const,
    resourceId: '',
  };
  assert.equal(validateResourceId(form.resourceId), 'nf_health_validation_resource_required');
  assert.equal(
    validateTargetForm(form, null),
    'nf_health_validation_resource_required',
    'the resource identity gates the form',
  );

  const complete = {
    ...form,
    resourceId: RESOURCE_ID,
    name: 'P-CSCF ims-01',
    metricsDestination: '127.0.0.5:9090',
  };
  assert.equal(validateTargetForm(complete, null), null);
});

test('nf health target form: the Discovery candidate is optional', () => {
  assert.equal(validateCandidateId(''), null, 'an absent candidate is valid');
  assert.equal(validateCandidateId(CANDIDATE_ID), null);
  const form = {
    ...createEmptyTargetForm(120),
    serviceKind: 'none' as const,
    resourceId: RESOURCE_ID,
    name: 'MME epc-01',
    metricsDestination: '127.0.0.5:9090',
  };
  assert.equal(validateTargetForm(form, null), null, 'Inventory-only targets need no candidate');
});

test('nf health target form: process_only omits the metrics endpoint and requires an inspection source', () => {
  const processOnly = {
    ...createEmptyTargetForm(120),
    resourceId: RESOURCE_ID,
    name: 'P-CSCF local process',
    collectorProfile: 'process_only' as const,
    serviceUnit: 'pcscfd',
    serviceKind: 'process' as const,
  };
  assert.equal(validateTargetForm(processOnly, null), null);

  const payload = buildCreateTargetRequest(processOnly);
  assert.equal(payload.resourceId, RESOURCE_ID);
  assert.equal(payload.collectorProfile, 'process_only');
  assert.equal(payload.metricsEndpoint, undefined, 'process_only never configures an HTTP metrics endpoint');
  assert.equal(payload.candidateId, undefined, 'an absent candidate stays absent');

  const withoutInspection = { ...processOnly, serviceKind: 'none' as const };
  assert.equal(
    validateTargetForm(withoutInspection, null),
    'nf_health_validation_process_only_inspection_required',
  );
});

test('nf health target form: http_metrics still requires an allowlisted destination', () => {
  const httpMetrics = {
    ...createEmptyTargetForm(120),
    serviceKind: 'none' as const,
    resourceId: RESOURCE_ID,
    name: 'AMF metrics',
  };
  assert.equal(validateTargetForm(httpMetrics, null), 'nf_health_validation_destination_required');
  const payload = buildCreateTargetRequest({
    ...httpMetrics,
    candidateId: CANDIDATE_ID,
    metricsDestination: '127.0.0.5:9090',
    metricsPath: '/metrics',
  });
  assert.equal(payload.metricsEndpoint, 'http://127.0.0.5:9090/metrics');
  assert.equal(payload.candidateId, CANDIDATE_ID);
});

test('nf health target form: edit requests never rebind identity', () => {
  const update = buildUpdateTargetRequest(4, {
    ...createEmptyTargetForm(120),
    resourceId: RESOURCE_ID,
    candidateId: CANDIDATE_ID,
    name: 'renamed target',
    metricsDestination: '127.0.0.5:9090',
  });
  assert.equal(update.expectedRevision, 4);
  assert.ok(!('resourceId' in update.target), 'update must not rebind the Inventory resource');
  assert.ok(!('candidateId' in update.target), 'update must not rebind the Discovery candidate');
  assert.equal(update.target.name, 'renamed target');
});

test('nf health target form: metrics endpoint splitting stays compatible', () => {
  assert.deepEqual(splitMetricsEndpoint('http://127.0.0.5:9090/metrics'), {
    destination: '127.0.0.5:9090',
    path: '/metrics',
  });
  assert.deepEqual(splitMetricsEndpoint(undefined), { destination: '', path: '/metrics' });
});

test('nf health trend series: samples are sorted, windowed and never interpolated', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  const unmeasuredLayer = () => ({
    state: 'not_configured' as const,
    evidenceKind: 'none' as const,
    measured: false,
  });
  const sample = (
    collectedAt: string,
    metrics: Array<{ key: string; value: number; unit?: string }>,
  ): HealthSample => ({
    sampleId: `sample-${collectedAt}`,
    schemaVersion: 1,
    targetId: 'target-1',
    runId: `run-${collectedAt}`,
    collectedAt,
    layers: { process: unmeasuredLayer(), interface: unmeasuredLayer(), service: unmeasuredLayer() },
    metrics: metrics.map((metric) => ({
      key: metric.key,
      value: metric.value,
      unit: metric.unit ?? 'bytes',
      type: 'gauge' as const,
      source: 'nf_metrics_exporter',
      collectedAt,
    })),
  });

  const series = buildMetricTrendSeries(
    [
      // Deliberately out of chronological order and with one sample that
      // falls before the window and must be dropped entirely.
      sample('2026-10-18T11:59:00.000Z', [{ key: 'process_resident_memory_bytes', value: 3 }]),
      sample('2026-10-18T11:30:00.000Z', [{ key: 'process_resident_memory_bytes', value: 1 }]),
      sample('2026-10-18T11:45:00.000Z', [
        { key: 'process_resident_memory_bytes', value: 2 },
        { key: 'up', value: 1 },
      ]),
    ],
    now - 20 * 60 * 1000,
  );

  const memory = series.find((entry) => entry.key === 'process_resident_memory_bytes');
  assert.ok(memory, 'the memory family is charted');
  assert.deepEqual(
    memory.points.map((point) => point.value),
    [2, 3],
    'points are sorted ascending and the pre-window sample is dropped',
  );
  assert.equal(memory.unit, 'bytes');

  const up = series.find((entry) => entry.key === 'up');
  assert.ok(up, 'a second family forms its own series');
  assert.deepEqual(up.points.map((point) => point.value), [1]);

  // A family that only exists before the window disappears instead of
  // being backfilled with zeros.
  const droppedOnly = buildMetricTrendSeries(
    [sample('2026-10-18T11:30:00.000Z', [{ key: 'process_cpu_seconds_total', value: 9 }])],
    now - 20 * 60 * 1000,
  );
  assert.equal(
    droppedOnly.find((entry) => entry.key === 'process_cpu_seconds_total'),
    undefined,
    'families with no in-window points are not fabricated',
  );

  assert.deepEqual(buildMetricTrendSeries([], now), [], 'no samples yield no series');
});
