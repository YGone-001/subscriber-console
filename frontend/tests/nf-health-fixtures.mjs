/*
 * Deterministic browser-acceptance fixtures for the NF Health UI.
 *
 * TEST-ONLY. Nothing in this module is imported by production runtime code.
 * It serves the built SPA from `frontend/dist` and answers the `/api/*` reads the
 * target pages perform, so a real Chromium browser renders the real application
 * against deterministic data.
 *
 * The payloads follow the accepted wire contracts. They demonstrate frontend
 * rendering against fixtures, not a live core-network deployment.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

export const CANDIDATE_IDS = {
  amf: '9b2d3c40-0011-4b11-9d11-000000000011',
  smf: '9b2d3c40-0012-4b12-9d12-000000000012',
  upf: '9b2d3c40-0013-4b13-9d13-000000000013',
};

export const TARGET_IDS = {
  amf: '7c1d2e30-0001-4a01-8c01-000000000001',
  smf: '7c1d2e30-0002-4a02-8c02-000000000002',
  upf: '7c1d2e30-0003-4a03-8c03-000000000003',
};

const TS = {
  t1: '2026-10-09T06:00:00Z',
  t2: '2026-10-09T07:00:00Z',
  t3: '2026-10-09T08:00:00Z',
  t4: '2026-10-09T09:00:00Z',
  t5: '2026-10-09T10:00:00Z',
  t6: '2026-10-09T11:00:00Z',
  t7: '2026-10-09T12:00:00Z',
};

const DISCOVERY_CANDIDATES = [
  {
    candidateId: CANDIDATE_IDS.amf,
    schemaVersion: 1,
    sourceId: '8a1c2b30-0001-4a01-8c01-000000000001',
    adapterType: 'nrf',
    nfType: 'AMF',
    nfStatus: 'REGISTERED',
    ipv4Addresses: ['127.0.0.5'],
    observationState: 'seen',
    firstSeenAt: TS.t1,
    lastSeenAt: TS.t6,
    revision: 4,
  },
  {
    candidateId: CANDIDATE_IDS.smf,
    schemaVersion: 1,
    sourceId: '8a1c2b30-0001-4a01-8c01-000000000001',
    adapterType: 'nrf',
    nfType: 'SMF',
    nfStatus: 'REGISTERED',
    ipv4Addresses: ['127.0.0.4'],
    observationState: 'seen',
    firstSeenAt: TS.t1,
    lastSeenAt: TS.t6,
    revision: 2,
  },
  {
    candidateId: CANDIDATE_IDS.upf,
    schemaVersion: 1,
    sourceId: '8a1c2b30-0001-4a01-8c01-000000000001',
    adapterType: 'nrf',
    nfType: 'UPF',
    nfStatus: 'REGISTERED',
    ipv4Addresses: ['127.0.0.7'],
    observationState: 'seen',
    firstSeenAt: TS.t1,
    lastSeenAt: TS.t6,
    revision: 1,
  },
];

const LAYER_HEALTHY = (kind, extra = {}) => ({
  state: 'healthy',
  evidenceKind: kind,
  measured: true,
  ...extra,
});

const METRICS_AMF = [
  {
    key: 'amf_session_active',
    value: 12,
    unit: 'sessions',
    type: 'gauge',
    source: 'http_metrics',
    collectedAt: TS.t6,
    interpretation: 'current active sessions reported by the exporter',
    labels: {},
  },
  {
    key: 'ran_ue_active',
    value: 34,
    unit: 'ues',
    type: 'gauge',
    source: 'http_metrics',
    collectedAt: TS.t6,
    interpretation: 'current connected UEs reported by the exporter',
    labels: {},
  },
  {
    key: 'process_cpu_seconds_total',
    value: 128.5,
    unit: 'seconds',
    type: 'counter',
    source: 'http_metrics',
    collectedAt: TS.t6,
    interpretation: 'cumulative CPU seconds; never presented as a rate',
    labels: {},
  },
];

const METRICS_SMF = [
  {
    key: 'pfcp_sessions_active',
    value: 8,
    unit: 'sessions',
    type: 'gauge',
    source: 'http_metrics',
    collectedAt: TS.t6,
    interpretation: 'active PFCP sessions reported by the exporter',
    labels: {},
  },
  {
    key: 'pfcp_peers_active',
    value: 1,
    unit: 'peers',
    type: 'gauge',
    source: 'http_metrics',
    collectedAt: TS.t6,
    interpretation: 'active PFCP peers reported by the exporter',
    labels: {},
  },
];

function layerProcess(outcome, state, pid) {
  return LAYER_HEALTHY('systemd', {
    state,
    processOutcome: outcome,
    mainPid: pid,
  });
}

function layerInterface(status, ms, state = 'healthy') {
  return LAYER_HEALTHY('http_metrics', {
    state,
    httpStatus: status,
    responseMs: ms,
  });
}

function layerService(state, reason, measured = true) {
  return {
    state,
    evidenceKind: measured ? 'metric_registry' : 'none',
    reason,
    measured,
  };
}

export const TARGETS = [
  {
    targetId: TARGET_IDS.amf,
    schemaVersion: 1,
    candidateId: CANDIDATE_IDS.amf,
    name: 'AMF core-01 metrics',
    collectorProfile: 'http_metrics',
    metricsEndpoint: 'http://127.0.0.5:9090/metrics',
    serviceUnit: 'amfd',
    serviceKind: 'process',
    collectionMode: 'scheduled',
    intervalSeconds: 120,
    enabled: true,
    revision: 4,
    createdAt: TS.t1,
    createdBy: 'operator1',
    updatedAt: TS.t5,
    updatedBy: 'operator1',
    lastAttemptAt: TS.t6,
    lastSuccessAt: TS.t6,
    lastMeasuredAt: TS.t6,
    coverage: { l1Measured: true, l2Measured: true, l3Measured: true, l3Available: true },
  },
  {
    targetId: TARGET_IDS.smf,
    schemaVersion: 1,
    candidateId: CANDIDATE_IDS.smf,
    name: 'SMF core-01 metrics',
    collectorProfile: 'http_metrics',
    metricsEndpoint: 'http://127.0.0.4:9090/metrics',
    serviceUnit: 'smfd',
    serviceKind: 'process',
    collectionMode: 'manual',
    intervalSeconds: 120,
    enabled: true,
    revision: 2,
    createdAt: TS.t2,
    createdBy: 'operator1',
    updatedAt: TS.t4,
    updatedBy: 'operator1',
    lastAttemptAt: TS.t5,
    lastSuccessAt: TS.t5,
    lastMeasuredAt: TS.t5,
    coverage: { l1Measured: true, l2Measured: true, l3Measured: true, l3Available: true },
  },
  {
    targetId: TARGET_IDS.upf,
    schemaVersion: 1,
    candidateId: CANDIDATE_IDS.upf,
    name: 'UPF core-01 metrics',
    collectorProfile: 'http_metrics',
    metricsEndpoint: 'http://127.0.0.7:9090/metrics',
    serviceUnit: 'upfd',
    serviceKind: 'process',
    collectionMode: 'manual',
    intervalSeconds: 300,
    enabled: false,
    revision: 6,
    createdAt: TS.t1,
    createdBy: 'operator1',
    updatedAt: TS.t3,
    updatedBy: 'operator1',
    lastAttemptAt: TS.t3,
    lastSuccessAt: TS.t2,
    lastMeasuredAt: TS.t2,
    lastError: 'connection refused',
    coverage: { l1Measured: true, l2Measured: false, l3Measured: false, l3Available: false },
  },
];

export const RUNS = [
  {
    runId: 'aa3e4f50-0031-4c31-9e31-000000000031',
    schemaVersion: 1,
    targetId: TARGET_IDS.amf,
    candidateId: CANDIDATE_IDS.amf,
    startedAt: TS.t6,
    completedAt: TS.t6,
    status: 'success',
    sampleId: 'bb4f5a60-0041-4d41-9f41-000000000041',
    layersMeasured: 3,
    initiatedBy: 'scheduler',
  },
  {
    runId: 'aa3e4f50-0032-4c32-9e32-000000000032',
    schemaVersion: 1,
    targetId: TARGET_IDS.smf,
    candidateId: CANDIDATE_IDS.smf,
    startedAt: TS.t5,
    completedAt: TS.t5,
    status: 'success',
    sampleId: 'bb4f5a60-0042-4d42-9f42-000000000042',
    layersMeasured: 3,
    initiatedBy: 'operator1',
  },
  {
    runId: 'aa3e4f50-0033-4c33-9e33-000000000033',
    schemaVersion: 1,
    targetId: TARGET_IDS.upf,
    candidateId: CANDIDATE_IDS.upf,
    startedAt: TS.t3,
    completedAt: TS.t3,
    status: 'failed',
    sampleId: null,
    layersMeasured: 1,
    errorCode: 'NF_HEALTH_COLLECTION_TIMEOUT',
    errorSummary: 'metrics endpoint timed out; last good sample preserved',
    initiatedBy: 'operator1',
  },
  {
    runId: 'aa3e4f50-0034-4c34-9e34-000000000034',
    schemaVersion: 1,
    targetId: TARGET_IDS.amf,
    candidateId: CANDIDATE_IDS.amf,
    startedAt: TS.t4,
    completedAt: TS.t4,
    status: 'partial',
    sampleId: 'bb4f5a60-0044-4d44-9f44-000000000044',
    layersMeasured: 2,
    errorCode: 'NF_HEALTH_METRICS_INVALID',
    errorSummary: 'metrics body contained no supported families',
    initiatedBy: 'scheduler',
  },
];

export const SAMPLES = [
  {
    sampleId: 'bb4f5a60-0041-4d41-9f41-000000000041',
    schemaVersion: 1,
    targetId: TARGET_IDS.amf,
    runId: 'aa3e4f50-0031-4c31-9e31-000000000031',
    candidateId: CANDIDATE_IDS.amf,
    collectedAt: TS.t6,
    expiresAt: '2026-10-16T06:00:00Z',
    layers: {
      process: layerProcess('active', 'healthy', 2411),
      interface: layerInterface(200, 18),
      service: layerService('healthy', undefined),
    },
    metrics: METRICS_AMF,
  },
  {
    sampleId: 'bb4f5a60-0042-4d42-9f42-000000000042',
    schemaVersion: 1,
    targetId: TARGET_IDS.smf,
    runId: 'aa3e4f50-0032-4c32-9e32-000000000032',
    candidateId: CANDIDATE_IDS.smf,
    collectedAt: TS.t5,
    expiresAt: '2026-10-16T05:00:00Z',
    layers: {
      process: layerProcess('active', 'healthy', 2522),
      interface: layerInterface(200, 24),
      service: layerService('healthy', undefined),
    },
    metrics: METRICS_SMF,
  },
  {
    sampleId: 'bb4f5a60-0043-4d43-9f43-000000000043',
    schemaVersion: 1,
    targetId: TARGET_IDS.upf,
    runId: 'aa3e4f50-0033-4c33-9e33-000000000033',
    candidateId: CANDIDATE_IDS.upf,
    collectedAt: TS.t2,
    expiresAt: '2026-10-16T02:00:00Z',
    layers: {
      process: layerProcess('running', 'healthy', 2633),
      interface: {
        state: 'unknown',
        evidenceKind: 'none',
        reason: 'connection_refused',
        measured: false,
      },
      service: layerService('not_configured', 'metric_not_exported', false),
    },
    metrics: [],
  },
  {
    sampleId: 'bb4f5a60-0044-4d44-9f44-000000000044',
    schemaVersion: 1,
    targetId: TARGET_IDS.amf,
    runId: 'aa3e4f50-0034-4c34-9e34-000000000034',
    candidateId: CANDIDATE_IDS.amf,
    collectedAt: TS.t4,
    expiresAt: '2026-10-16T04:00:00Z',
    layers: {
      process: layerProcess('active', 'healthy', 2411),
      interface: layerInterface(200, 22, 'degraded'),
      service: layerService('not_configured', 'no_supported_service_kpi', false),
    },
    metrics: [],
  },
];

/* Trend series used by the detail metric charts. Values are exporter readings. */
export const TREND_SERIES = {
  [TARGET_IDS.amf]: {
    'amf_session_active': [
      { t: TS.t3, v: 9 },
      { t: TS.t4, v: 10 },
      { t: TS.t5, v: 11 },
      { t: TS.t6, v: 12 },
    ],
    'ran_ue_active': [
      { t: TS.t3, v: 28 },
      { t: TS.t4, v: 30 },
      { t: TS.t5, v: 32 },
      { t: TS.t6, v: 34 },
    ],
    'process_cpu_seconds_total': [
      { t: TS.t3, v: 100.1 },
      { t: TS.t4, v: 110.4 },
      { t: TS.t5, v: 120.0 },
      { t: TS.t6, v: 128.5 },
    ],
  },
  [TARGET_IDS.smf]: {
    'pfcp_sessions_active': [
      { t: TS.t3, v: 6 },
      { t: TS.t4, v: 7 },
      { t: TS.t5, v: 8 },
    ],
    'pfcp_peers_active': [
      { t: TS.t3, v: 1 },
      { t: TS.t4, v: 1 },
      { t: TS.t5, v: 1 },
    ],
  },
  [TARGET_IDS.upf]: {
    'bearers_active': [
      { t: TS.t1, v: 4 },
      { t: TS.t2, v: 5 },
    ],
  },
};

export const SESSIONS = {
  operator: {
    username: 'operator1',
    role: 'operator',
    normalizedRole: 'operator',
    status: 'active',
    permissions: ['core.read', 'core.configure'],
  },
  viewer: {
    username: 'viewer1',
    role: 'viewer',
    normalizedRole: 'viewer',
    status: 'active',
    permissions: ['core.read'],
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, respond) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let payload = null;
    try {
      payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    } catch {
      payload = null;
    }
    respond(payload);
  });
}

function page(limit) {
  return { limit, nextCursor: null, hasMore: false };
}

function summarize(target) {
  return { ...target };
}

function latestSampleFor(targetId) {
  return SAMPLES.find((sample) => sample.targetId === targetId) ?? null;
}

function lastRunFor(targetId) {
  return RUNS.find((run) => run.targetId === targetId) ?? null;
}

function overallStateFor(sample) {
  if (!sample) return 'unknown';
  const states = [sample.layers.process.state, sample.layers.interface.state, sample.layers.service.state];
  if (states.includes('unhealthy')) return 'unhealthy';
  if (states.includes('degraded')) return 'degraded';
  if (states.every((state) => state === 'healthy')) return 'healthy';
  return 'unknown';
}

function handleNfHealth(req, res, url, context) {
  const pathname = url.pathname;
  const session = SESSIONS[context.sessionKey] ?? SESSIONS.operator;

  if (pathname === '/api/nf-health/meta') {
    return sendJson(res, 200, {
      schemaVersion: 1,
      collectorProfiles: ['http_metrics'],
      collectionModes: ['manual', 'scheduled'],
      runStatuses: ['success', 'partial', 'failed'],
      layerStates: ['healthy', 'degraded', 'unhealthy', 'unknown', 'not_configured', 'stale'],
      evidenceKinds: ['systemd', 'process', 'http_metrics', 'metric_registry', 'none'],
      processOutcomes: ['active', 'inactive', 'failed', 'unit_not_found', 'permission_denied', 'not_configured', 'running', 'not_running'],
      interfaceOutcomes: ['valid_response', 'connection_refused', 'timeout', 'invalid_response', 'http_4xx', 'http_5xx', 'collection_error', 'not_configured'],
      serviceKinds: ['process', 'systemd'],
      minIntervalSeconds: 60,
      maxIntervalSeconds: 3600,
      defaultIntervalSeconds: 120,
      requestTimeoutSeconds: 5,
      totalDeadlineSeconds: 15,
      maxGlobalConcurrent: 2,
      retentionDays: 7,
      maxRetentionDays: 30,
      supportedMetrics: [
        { name: 'amf_session_active', nfTypes: ['AMF'], type: 'gauge', unit: 'sessions', description: 'Active AMF sessions reported by the exporter', safeLabels: [], interpretation: 'current active sessions; never inferred from NRF registration' },
        { name: 'ran_ue_active', nfTypes: ['AMF', 'RAN'], type: 'gauge', unit: 'ues', description: 'Active RAN UEs reported by the exporter', safeLabels: [], interpretation: 'current connected UEs reported by the exporter' },
        { name: 'pfcp_sessions_active', nfTypes: ['SMF'], type: 'gauge', unit: 'sessions', description: 'Active PFCP sessions reported by the exporter', safeLabels: [], interpretation: 'exporter-reported PFCP session count; not an association oracle' },
        { name: 'pfcp_peers_active', nfTypes: ['SMF'], type: 'gauge', unit: 'peers', description: 'Active PFCP peers reported by the exporter', safeLabels: [], interpretation: 'exporter-reported peer count' },
        { name: 'bearers_active', nfTypes: ['UPF'], type: 'gauge', unit: 'bearers', description: 'Active bearers reported by the exporter', safeLabels: [], interpretation: 'exporter-reported bearer count' },
        { name: 'process_cpu_seconds_total', nfTypes: [], type: 'counter', unit: 'seconds', description: 'Cumulative process CPU seconds', safeLabels: [], interpretation: 'cumulative counter; never presented as a rate' },
      ],
      allowedDestinations: ['127.0.0.5:9090', '127.0.0.4:9090', '127.0.0.7:9090'],
      allowedServiceUnits: ['amfd', 'smfd', 'upfd'],
    });
  }

  if (pathname === '/api/nf-health/targets' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const enabled = url.searchParams.get('enabled');
    let items = TARGETS.map(summarize);
    if (q) items = items.filter((item) => item.name.toLowerCase().includes(q));
    if (enabled === 'true') items = items.filter((item) => item.enabled);
    if (enabled === 'false') items = items.filter((item) => !item.enabled);
    return sendJson(res, 200, { targets: items.slice(0, limit), page: page(limit) });
  }

  if (pathname === '/api/nf-health/targets' && req.method === 'POST') {
    return readBody(req, (payload) => sendJson(res, 201, {
      targetId: '7c1d2e30-0099-4a99-8c99-000000000099',
      schemaVersion: 1,
      candidateId: payload?.candidateId ?? CANDIDATE_IDS.amf,
      name: payload?.name ?? 'new target',
      collectorProfile: payload?.collectorProfile ?? 'http_metrics',
      metricsEndpoint: payload?.metricsEndpoint ?? '',
      serviceUnit: payload?.serviceUnit ?? '',
      serviceKind: payload?.serviceKind ?? 'process',
      collectionMode: payload?.collectionMode ?? 'manual',
      intervalSeconds: payload?.intervalSeconds ?? 120,
      enabled: payload?.enabled ?? true,
      revision: 1,
      createdAt: TS.t7,
      createdBy: session.username,
      updatedAt: TS.t7,
      updatedBy: session.username,
      coverage: { l1Measured: false, l2Measured: false, l3Measured: false, l3Available: false },
    }));
  }

  const collectMatch = /^\/api\/nf-health\/targets\/([^/]+)\/collect$/.exec(pathname);
  if (collectMatch && req.method === 'POST') {
    return readBody(req, () => sendJson(res, 200, {
      run: {
        runId: 'aa3e4f50-0099-4c99-9e99-000000000099',
        schemaVersion: 1,
        targetId: collectMatch[1],
        candidateId: CANDIDATE_IDS.amf,
        startedAt: TS.t7,
        completedAt: TS.t7,
        status: 'success',
        sampleId: 'bb4f5a60-0099-4d99-9f99-000000000099',
        layersMeasured: 3,
        initiatedBy: session.username,
      },
      sample: {
        sampleId: 'bb4f5a60-0099-4d99-9f99-000000000099',
        schemaVersion: 1,
        targetId: collectMatch[1],
        runId: 'aa3e4f50-0099-4c99-9e99-000000000099',
        candidateId: CANDIDATE_IDS.amf,
        collectedAt: TS.t7,
        expiresAt: '2026-10-16T07:00:00Z',
        layers: {
          process: layerProcess('active', 'healthy', 2411),
          interface: layerInterface(200, 16),
          service: layerService('healthy', undefined),
        },
        metrics: METRICS_AMF,
      },
    }));
  }

  const targetMatch = /^\/api\/nf-health\/targets\/([^/]+)$/.exec(pathname);
  if (targetMatch && req.method === 'GET') {
    const target = TARGETS.find((item) => item.targetId === targetMatch[1]);
    if (!target) return sendJson(res, 404, { error: 'not found', code: 'NF_HEALTH_TARGET_NOT_FOUND' });
    const latest = latestSampleFor(target.targetId);
    return sendJson(res, 200, {
      target: summarize(target),
      latestSample: latest,
      lastRun: lastRunFor(target.targetId),
      overallState: overallStateFor(latest),
    });
  }
  if (targetMatch && req.method === 'PUT') {
    return readBody(req, (payload) => {
      const target = TARGETS.find((item) => item.targetId === targetMatch[1]) ?? TARGETS[0];
      const mutable = payload?.target ?? {};
      return sendJson(res, 200, {
        targetId: target.targetId,
        schemaVersion: 1,
        candidateId: target.candidateId,
        name: mutable.name ?? target.name,
        collectorProfile: target.collectorProfile,
        metricsEndpoint: mutable.metricsEndpoint ?? target.metricsEndpoint,
        serviceUnit: mutable.serviceUnit ?? target.serviceUnit,
        serviceKind: mutable.serviceKind ?? target.serviceKind,
        collectionMode: mutable.collectionMode ?? target.collectionMode,
        intervalSeconds: mutable.intervalSeconds ?? target.intervalSeconds,
        enabled: mutable.enabled ?? target.enabled,
        revision: target.revision + 1,
        createdAt: target.createdAt,
        createdBy: target.createdBy,
        updatedAt: TS.t7,
        updatedBy: session.username,
        coverage: target.coverage,
      });
    });
  }

  const historyMatch = /^\/api\/nf-health\/targets\/([^/]+)\/history$/.exec(pathname);
  if (historyMatch && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    const items = SAMPLES.filter((sample) => sample.targetId === historyMatch[1]).slice(0, limit);
    return sendJson(res, 200, { samples: items, page: page(limit) });
  }

  if (pathname === '/api/nf-health/samples') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    const targetId = url.searchParams.get('targetId') ?? '';
    let items = SAMPLES;
    if (targetId) items = items.filter((sample) => sample.targetId === targetId);
    return sendJson(res, 200, { samples: items.slice(0, limit), page: page(limit) });
  }

  if (pathname === '/api/nf-health/runs') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    const targetId = url.searchParams.get('targetId') ?? '';
    const status = url.searchParams.get('status') ?? '';
    let items = RUNS;
    if (targetId) items = items.filter((run) => run.targetId === targetId);
    if (status) items = items.filter((run) => run.status === status);
    return sendJson(res, 200, { runs: items.slice(0, limit), page: page(limit) });
  }

  const runMatch = /^\/api\/nf-health\/runs\/([^/]+)$/.exec(pathname);
  if (runMatch && req.method === 'GET') {
    const run = RUNS.find((item) => item.runId === runMatch[1]);
    if (!run) return sendJson(res, 404, { error: 'not found', code: 'NF_HEALTH_SAMPLE_NOT_FOUND' });
    return sendJson(res, 200, run);
  }

  return sendJson(res, 404, { error: 'not found', code: 'NOT_FOUND' });
}

function handleApi(req, res, url, context) {
  const pathname = url.pathname;
  const session = SESSIONS[context.sessionKey] ?? SESSIONS.operator;

  if (pathname === '/api/auth/me') return sendJson(res, 200, session);
  if (pathname === '/api/auth/permissions') return sendJson(res, 200, { permissions: session.permissions });

  if (pathname === '/api/notifications/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 600000\n\n');
    res.write(`event: init\ndata: ${JSON.stringify({
      alerts: { activeCount: 0, activeCriticalCount: 0, activeWarningCount: 0, recent: [] },
    })}\n\n`);
    context.openStreams.add(res);
    req.on('close', () => context.openStreams.delete(res));
    return undefined;
  }

  const BENIGN_EMPTY = {
    '/api/alerts': { alerts: [] },
    '/api/profiles': { profiles: [] },
    '/api/analytics/metrics': { metrics: {} },
    '/api/analytics/sparkline': { points: [] },
    '/api/system/health': { status: 'ok', subsystems: {} },
    '/api/system/audit/status': { lastSaveTime: 1_760_000_000_000 },
    '/api/system/mongo/health': { status: 'ok' },
    '/api/search': { results: [] },
    '/api/discovery/candidates': {
      candidates: DISCOVERY_CANDIDATES,
      page: page(20),
    },
    '/api/discovery/meta': {
      schemaVersion: 1,
      adapterTypes: ['nrf'],
      transportModes: ['h2c', 'h2_tls'],
      runStatuses: ['running', 'success', 'partial', 'failed'],
      observationStates: ['seen', 'missing', 'stale'],
      minScanIntervalSeconds: 60,
      requestTimeoutSeconds: 10,
      totalScanDeadlineSeconds: 60,
      maxNfProfiles: 256,
    },
    '/api/discovery/sources': {
      sources: [],
      page: page(20),
    },
    '/api/inventory/meta': {
      schemaVersion: 1,
      kinds: ['network_function_instance'],
      domains: ['5gc', 'ims'],
      lifecycleStates: ['active', 'retired'],
      managementProtocols: ['sbi'],
      addressTypes: ['ipv4', 'fqdn'],
    },
    '/api/inventory/resources': {
      resources: [],
      page: page(20),
    },
    '/api/topology/meta': {
      schemaVersion: 1,
      relationshipTypes: ['contains', 'runs_on', 'depends_on', 'connects_to', 'routes_to', 'registers_with', 'serves', 'uses', 'exposes'],
      lifecycleStates: ['active', 'retired'],
    },
    '/api/topology/edges': {
      edges: [],
      page: page(20),
    },
  };
  if (Object.prototype.hasOwnProperty.call(BENIGN_EMPTY, pathname)) {
    return sendJson(res, 200, BENIGN_EMPTY[pathname]);
  }

  const candidateMatch = pathname.match(/^\/api\/discovery\/candidates\/([^/]+)$/);
  if (candidateMatch) {
    const candidate = DISCOVERY_CANDIDATES.find((item) => item.candidateId === candidateMatch[1]);
    if (candidate) return sendJson(res, 200, candidate);
    return sendJson(res, 404, { error: 'not found', code: 'NOT_FOUND' });
  }

  if (pathname.startsWith('/api/nf-health/')) {
    return handleNfHealth(req, res, url, context);
  }

  context.unexpected.push(`${req.method} ${pathname}`);
  return sendJson(res, 404, { error: 'not found', code: 'NOT_FOUND' });
}

export async function startFixtureServer({ distDir, sessionKey = 'operator' }) {
  const unexpected = [];
  const requestLog = [];
  const openStreams = new Set();

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      requestLog.push(`${req.method} ${pathname}`);
      return handleApi(req, res, url, { sessionKey, unexpected, openStreams });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    const candidate = join(distDir, relative);
    if (relative && candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const body = readFileSync(candidate);
      res.writeHead(200, {
        'Content-Type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    const indexFile = join(distDir, 'index.html');
    const body = readFileSync(indexFile);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
    res.end(body);
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    unexpected,
    requestLog,
    async close() {
      for (const stream of openStreams) {
        try { stream.destroy(); } catch { /* already closed */ }
      }
      openStreams.clear();
      await new Promise((done) => server.close(done));
    },
  };
}
