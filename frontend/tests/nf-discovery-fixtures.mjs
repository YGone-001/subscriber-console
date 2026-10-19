/*
 * Deterministic browser-acceptance fixtures for the NF Discovery UI.
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
import { RUNTIME_OBSERVATIONS, serveRuntimeFixture } from './runtime-fixtures.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

export const SOURCE_IDS = {
  lab: '8a1c2b30-0001-4a01-8c01-000000000001',
  edge: '8a1c2b30-0002-4a02-8c02-000000000002',
};

export const CANDIDATE_IDS = {
  amf: '9b2d3c40-0011-4b11-9d11-000000000011',
  udm: '9b2d3c40-0012-4b12-9d12-000000000012',
  pcf: '9b2d3c40-0013-4b13-9d13-000000000013',
  missingNrf: '9b2d3c40-0014-4b14-9d14-000000000014',
};

export const RESOURCE_IDS = {
  amf: '6f1c1a10-0001-4a01-8b01-000000000001',
  smf: '6f1c1a10-0002-4a02-8b02-000000000002',
};

const TS = {
  t1: '2026-10-01T08:00:00Z',
  t2: '2026-10-02T09:15:00Z',
  t3: '2026-10-03T10:30:00Z',
  t4: '2026-10-04T11:45:00Z',
  t5: '2026-10-05T12:00:00Z',
};

export const SOURCES = [
  {
    sourceId: SOURCE_IDS.lab,
    schemaVersion: 1,
    name: 'lab-registry',
    adapterType: 'nrf',
    baseUrl: 'http://127.0.0.10:7777',
    enabled: true,
    transportMode: 'h2c',
    revision: 3,
    createdAt: TS.t1,
    createdBy: 'operator1',
    updatedAt: TS.t4,
    updatedBy: 'operator1',
    lastSuccessAt: TS.t4,
    lastScanAt: TS.t4,
  },
  {
    sourceId: SOURCE_IDS.edge,
    schemaVersion: 1,
    name: 'edge-registry',
    adapterType: 'nrf',
    baseUrl: 'http://127.0.0.11:7777',
    enabled: false,
    transportMode: 'h2c',
    revision: 1,
    createdAt: TS.t2,
    createdBy: 'operator1',
    updatedAt: TS.t2,
    updatedBy: 'operator1',
    lastError: 'destination not allowlisted',
  },
];

export const RUNS = [
  {
    runId: 'aa3e4f50-0021-4c21-9e21-000000000021',
    schemaVersion: 1,
    sourceId: SOURCE_IDS.lab,
    startedAt: TS.t4,
    completedAt: TS.t4,
    status: 'success',
    discoveredCount: 3,
    createdCount: 0,
    updatedCount: 3,
    unchangedCount: 0,
    missingCount: 1,
    initiatedBy: 'operator1',
  },
  {
    runId: 'aa3e4f50-0022-4c22-9e22-000000000022',
    schemaVersion: 1,
    sourceId: SOURCE_IDS.lab,
    startedAt: TS.t3,
    completedAt: TS.t3,
    status: 'partial',
    discoveredCount: 2,
    createdCount: 2,
    updatedCount: 0,
    unchangedCount: 0,
    missingCount: 0,
    errorCode: 'DISCOVERY_RESPONSE_LIMIT_EXCEEDED',
    errorSummary: 'scan truncated; absence not inferred',
    initiatedBy: 'operator1',
  },
  {
    runId: 'aa3e4f50-0023-4c23-9e23-000000000023',
    schemaVersion: 1,
    sourceId: SOURCE_IDS.edge,
    startedAt: TS.t2,
    completedAt: TS.t2,
    status: 'failed',
    discoveredCount: 0,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    missingCount: 0,
    errorCode: 'DISCOVERY_TARGET_NOT_ALLOWED',
    errorSummary: 'destination is not allowlisted',
    initiatedBy: 'operator1',
  },
];

export const CANDIDATES = [
  {
    candidateId: CANDIDATE_IDS.amf,
    schemaVersion: 1,
    sourceId: SOURCE_IDS.lab,
    adapterType: 'nrf',
    externalNfInstanceId: '3301e63a-c3b7-41f1-a512-9f6322e6f4c2',
    nfType: 'AMF',
    nfStatus: 'REGISTERED',
    fqdn: 'amf.core.example',
    ipv4Addresses: ['127.0.0.5'],
    observedEndpoints: [
      { serviceName: 'namf-comm', scheme: 'http', addressType: 'ipv4', address: '127.0.0.5', port: 7777 },
    ],
    observedServices: [
      {
        serviceName: 'namf-comm',
        status: 'REGISTERED',
        apiVersions: ['v1'],
        endpoints: [{ serviceName: 'namf-comm', scheme: 'http', addressType: 'ipv4', address: '127.0.0.5', port: 7777 }],
      },
    ],
    heartBeatTimer: 10,
    plmnList: [{ mcc: '001', mnc: '01' }],
    sNssaiList: [{ sst: 1 }],
    firstSeenAt: TS.t1,
    lastSeenAt: TS.t4,
    observationState: 'seen',
    linkedResourceId: RESOURCE_IDS.amf,
    revision: 4,
    monitoringAssociation: { state: 'monitored', targetId: '7c3e1d50-0031-4d31-9f31-000000000031' },
  },
  {
    candidateId: CANDIDATE_IDS.udm,
    schemaVersion: 1,
    sourceId: SOURCE_IDS.lab,
    adapterType: 'nrf',
    externalNfInstanceId: '2fdd9616-c3b7-41f1-9e90-c1bf0278f435',
    nfType: 'UDM',
    nfStatus: 'REGISTERED',
    ipv4Addresses: ['127.0.0.12'],
    observedEndpoints: [],
    observedServices: [
      { serviceName: 'nudm-ueau', status: 'REGISTERED', apiVersions: ['v2'], endpoints: [] },
    ],
    firstSeenAt: TS.t1,
    lastSeenAt: TS.t4,
    observationState: 'seen',
    linkedResourceId: null,
    revision: 2,
  },
  {
    candidateId: CANDIDATE_IDS.pcf,
    schemaVersion: 1,
    sourceId: SOURCE_IDS.lab,
    adapterType: 'nrf',
    externalNfInstanceId: '44a2f74b-c3b7-41f1-b233-aa1122334455',
    nfType: 'PCF',
    nfStatus: 'REGISTERED',
    ipv4Addresses: ['127.0.0.13'],
    observedEndpoints: [],
    observedServices: [
      { serviceName: 'npcf-am-policy', status: 'REGISTERED', apiVersions: ['v1'], endpoints: [] },
    ],
    firstSeenAt: TS.t2,
    lastSeenAt: TS.t4,
    observationState: 'seen',
    linkedResourceId: null,
    revision: 1,
  },
  {
    candidateId: CANDIDATE_IDS.missingNrf,
    schemaVersion: 1,
    sourceId: SOURCE_IDS.lab,
    adapterType: 'nrf',
    externalNfInstanceId: '55b3a85c-c3b7-41f1-c344-bb2233445566',
    nfType: 'NRF',
    nfStatus: 'REGISTERED',
    observedEndpoints: [],
    observedServices: [],
    firstSeenAt: TS.t1,
    lastSeenAt: TS.t3,
    observationState: 'missing',
    linkedResourceId: null,
    revision: 3,
  },
];

/*
 * Inventory identity authority for the comparison pages.
 *
 * "role" carries the canonical architecture role token, not a generic "nf"
 * bucket: the reference architecture binds its skeleton by role, so a
 * deployment can only be projected when the token matches exactly.
 */
const INVENTORY_RESOURCES = [
  {
    resourceId: RESOURCE_IDS.amf,
    schemaVersion: 1,
    kind: 'network_function',
    name: 'amf-01',
    nameNormalized: 'amf-01',
    displayName: 'AMF-01',
    domain: '5gc',
    role: 'amf',
    lifecycleState: 'active',
    source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
    revision: 1,
    createdAt: TS.t1,
    createdBy: 'fixture',
    updatedAt: TS.t1,
    updatedBy: 'fixture',
  },
  {
    resourceId: RESOURCE_IDS.smf,
    schemaVersion: 1,
    kind: 'network_function',
    name: 'smf-01',
    nameNormalized: 'smf-01',
    displayName: 'SMF-01',
    domain: '5gc',
    role: 'smf',
    lifecycleState: 'active',
    source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
    revision: 1,
    createdAt: TS.t1,
    createdBy: 'fixture',
    updatedAt: TS.t1,
    updatedBy: 'fixture',
  },
];

export const TARGET_IDS = {
  amf: '7c3e1d50-0031-4d31-9f31-000000000031',
};

/*
 * GET /api/operations/resources projection.
 *
 * The server owns the authoritative Inventory -> NF Health association join.
 * The fixture mirrors both accepted association outcomes so the rendering
 * states stay distinguishable:
 *   amf-01 -> confirmed (a target exists and the latest evidence is fresh)
 *   smf-01 -> absent    (the bounded lookup succeeded and returned no target)
 * "absent" is the only state the UI may render as "not monitored". The fixture
 * never produces "unresolved" because its lookup always succeeds.
 */
export const OPERATIONS_RESOURCES = [
  {
    resourceId: RESOURCE_IDS.amf,
    name: 'amf-01',
    displayName: 'AMF-01',
    domain: '5gc',
    kind: 'network_function',
    role: 'amf',
    lifecycleState: 'active',
    isNetworkFunction: true,
    association: 'confirmed',
    monitoring: {
      targetId: TARGET_IDS.amf,
      enabled: true,
      nfType: 'AMF',
      overallState: 'healthy',
      statusComplete: true,
      coverage: { l1Measured: true, l2Measured: true, l3Measured: false, l3Available: false },
      freshness: { state: 'fresh', ageSeconds: 24, policySeconds: 300 },
      latestSampleAt: TS.t4,
      lastRunStatus: 'success',
      lastRunAt: TS.t4,
      resourceMetrics: [
        {
          key: 'resource_memory_resident_bytes',
          value: 402653184,
          unit: 'bytes',
          type: 'gauge',
          source: 'proc',
          collectedAt: TS.t4,
          category: 'resource',
        },
      ],
    },
    runtimeBinding: { state: 'bound', unit: 'xcloud-amfd.service' },
  },
  {
    resourceId: RESOURCE_IDS.smf,
    name: 'smf-01',
    displayName: 'SMF-01',
    domain: '5gc',
    kind: 'network_function',
    role: 'smf',
    lifecycleState: 'active',
    isNetworkFunction: true,
    association: 'absent',
    runtimeBinding: { state: 'unbound' },
  },
];

/*
 * Page-scoped monitoring predicates. Every value is evaluated against the
 * loaded page only, which is why a filtered response declares filterScope.
 */
const MONITORING_FILTERS = {
  monitored: (entry) => entry.association === 'confirmed',
  unmonitored: (entry) => entry.association === 'absent',
  unresolved: (entry) => entry.association === 'unresolved',
  degraded: (entry) =>
    entry.association === 'confirmed' &&
    (entry.monitoring?.overallState === 'degraded' || entry.monitoring?.overallState === 'unhealthy'),
  stale: (entry) =>
    entry.association === 'confirmed' &&
    (entry.monitoring?.overallState === 'stale' || entry.monitoring?.freshness?.state === 'stale'),
  unknown: (entry) =>
    entry.association === 'confirmed' &&
    ['', 'unknown', 'not_configured'].includes(entry.monitoring?.overallState ?? ''),
};

/*
 * Mirrors the accepted projection query semantics: identity filters are applied
 * by the Inventory read, the monitoring predicate is page-scoped, and the
 * cursor envelope is always present.
 */
export function projectOperationsResources(url) {
  const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const domain = url.searchParams.get('domain') ?? '';
  const kind = url.searchParams.get('kind') ?? '';
  const monitoring = url.searchParams.get('monitoring') ?? '';
  const roles = (url.searchParams.get('roles') ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  let items = OPERATIONS_RESOURCES;
  if (roles.length) items = items.filter((entry) => roles.includes(entry.role));
  if (domain) items = items.filter((entry) => entry.domain === domain);
  if (kind) items = items.filter((entry) => entry.kind === kind);
  if (q) {
    items = items.filter((entry) =>
      entry.name.toLowerCase().includes(q) ||
      (entry.displayName ?? '').toLowerCase().includes(q) ||
      entry.resourceId.toLowerCase().includes(q));
  }

  const page = { limit, hasMore: false, nextCursor: null };
  if (monitoring) {
    const predicate = MONITORING_FILTERS[monitoring];
    items = predicate ? items.filter(predicate) : items;
    page.filterScope = 'page';
    page.filteredCount = items.length;
  }

  return {
    generatedAt: TS.t5,
    completeness: { inventory: 'complete', monitoring: 'complete', telemetry: 'complete', overall: 'complete' },
    page,
    resources: items.slice(0, limit),
  };
}

const SUMMARY_SECTIONS = ['inventory', 'discovery', 'health', 'alerts', 'topology'];

/*
 * Section-aware operations summary. Requested sections are the only ones
 * computed and returned, matching the production contract.
 */
function buildOperationsSummary(url) {
  const requested = (url.searchParams.get('sections') ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const sections = requested.length
    ? SUMMARY_SECTIONS.filter((name) => requested.includes(name))
    : SUMMARY_SECTIONS;
  const body = { generatedAt: TS.t5, sections };

  if (sections.includes('inventory')) {
    body.inventory = {
      completeness: 'complete',
      scope: 'full_collection',
      counts: {
        total: OPERATIONS_RESOURCES.length,
        byKind: { network_function: OPERATIONS_RESOURCES.length },
        byLifecycleState: { active: OPERATIONS_RESOURCES.length },
        byDomain: { '5gc': OPERATIONS_RESOURCES.length },
      },
    };
  }

  if (sections.includes('health')) {
    const monitored = OPERATIONS_RESOURCES.filter((entry) => entry.association === 'confirmed');
    body.health = {
      completeness: 'complete',
      scope: 'full_collection',
      targets: {
        configured: monitored.length,
        enabled: monitored.length,
        failed: 0,
        freshnessByState: { fresh: monitored.length },
        overallByState: { healthy: monitored.length },
        layersByState: {},
      },
    };
  }

  if (sections.includes('discovery')) {
    const stateCount = (state) => CANDIDATES.filter((item) => item.observationState === state).length;
    body.discovery = {
      completeness: 'complete',
      scope: 'full_collection',
      sources: SOURCES.length,
      candidates: {
        seen: stateCount('seen'),
        missing: stateCount('missing'),
        stale: stateCount('stale'),
        linked: CANDIDATES.filter((item) => item.linkedResourceId).length,
        unlinked: CANDIDATES.filter((item) => !item.linkedResourceId).length,
      },
    };
  }

  return body;
}

const TOPOLOGY_EDGES = [
  {
    edgeId: '7e2d2b20-0011-4b11-9c11-000000000011',
    schemaVersion: 1,
    relationshipType: 'registers_with',
    fromResourceId: RESOURCE_IDS.smf,
    toResourceId: RESOURCE_IDS.amf,
    description: 'Fixture relationship for visual comparison.',
    labels: { scenario: 'discovery-acceptance' },
    attributes: { declaredBy: 'fixture' },
    lifecycleState: 'active',
    source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
    revision: 1,
    createdAt: TS.t1,
    createdBy: 'operator1',
    updatedAt: TS.t4,
    updatedBy: 'operator1',
  },
];

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

/*
 * Deliberate fault injection.
 *
 * The resilience acceptance suite needs every auxiliary read to fail in
 * isolation. Failures are opt-in per server instance so the screenshot matrix
 * keeps running against the healthy fixture.
 */
const FAILURE_ROUTES = {
  summary: (method, pathname) => pathname === '/api/operations/summary',
  sources: (method, pathname) => pathname === '/api/discovery/sources' && method === 'GET',
  candidates: (method, pathname) =>
    pathname === '/api/discovery/candidates' ||
    (/^\/api\/discovery\/candidates\/[^/]+$/.test(pathname) && method === 'GET'),
  runs: (method, pathname) => pathname === '/api/discovery/runs',
  runtime: (method, pathname) => pathname === '/api/runtime/observations',
  'runtime-stream': (method, pathname) => pathname === '/api/runtime/stream',
};

/*
 * Rewrites the monitoring association projection for linked candidates.
 *
 * "unresolved" is the state an authoritative association lookup produces when
 * it does not succeed. It must never render as "not monitored".
 */
function projectCandidate(item, monitoringVariant) {
  if (monitoringVariant !== 'unresolved' || !item.linkedResourceId) return item;
  return { ...item, monitoringAssociation: { state: 'unresolved' } };
}

export async function startFixtureServer({
  distDir,
  sessionKey = 'operator',
  /* Endpoint families this instance fails, e.g. ['summary', 'candidates']. */
  fail = [],
  /* Monitoring association variant: 'normal' | 'unresolved'. */
  monitoringVariant = 'normal',
}) {
  const unexpected = [];
  const requestLog = [];
  const openStreams = new Set();
  const failures = new Set(fail);

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      requestLog.push(`${req.method} ${pathname}`);
      return handleApi(req, res, url, { sessionKey, unexpected, openStreams, failures, monitoringVariant });
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

function handleApi(req, res, url, context) {
  const pathname = url.pathname;
  const session = SESSIONS[context.sessionKey] ?? SESSIONS.operator;

  /* Injected faults answer exactly like a failing service would, so the UI
   * exercises its real error boundary instead of a test-only branch. */
  for (const token of context.failures ?? []) {
    const matches = FAILURE_ROUTES[token];
    if (matches && matches(req.method, pathname)) {
      return sendJson(res, 503, { error: 'fixture injected failure', code: 'FIXTURE_INJECTED_FAILURE' });
    }
  }

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

  if (pathname === '/api/runtime/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 600000\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify({
      timestamp: RUNTIME_OBSERVATIONS.snapshot.generatedAt,
      ...RUNTIME_OBSERVATIONS,
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
    '/api/inventory/meta': {
      schemaVersion: 1,
      kinds: ['network_function_instance'],
      domains: ['5gc', 'ims'],
      lifecycleStates: ['active', 'retired'],
      managementProtocols: ['sbi'],
      addressTypes: ['ipv4', 'fqdn'],
    },
    '/api/topology/meta': {
      schemaVersion: 1,
      relationshipTypes: ['contains', 'runs_on', 'depends_on', 'connects_to', 'routes_to', 'registers_with', 'serves', 'uses', 'exposes'],
      lifecycleStates: ['active', 'retired'],
    },
  };
  if (Object.prototype.hasOwnProperty.call(BENIGN_EMPTY, pathname)) {
    return sendJson(res, 200, BENIGN_EMPTY[pathname]);
  }

  /* ----------------------------------------------------------- inventory -- */
  if (pathname === '/api/inventory/resources') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    return sendJson(res, 200, { resources: INVENTORY_RESOURCES.slice(0, limit), page: page(limit) });
  }
  const inventoryMatch = /^\/api\/inventory\/resources\/([^/]+)$/.exec(pathname);
  if (inventoryMatch) {
    const resource = INVENTORY_RESOURCES.find((item) => item.resourceId === inventoryMatch[1]);
    if (!resource) return sendJson(res, 404, { error: 'not found', code: 'INVENTORY_RESOURCE_NOT_FOUND' });
    return sendJson(res, 200, resource);
  }

  /* ------------------------------------------------------------ topology -- */
  if (pathname === '/api/topology/edges' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    return sendJson(res, 200, { edges: TOPOLOGY_EDGES.slice(0, limit), page: page(limit) });
  }

  /* -------------------------------------------------- operations summary -- */
  if (pathname === '/api/operations/summary' && req.method === 'GET') {
    return sendJson(res, 200, buildOperationsSummary(url));
  }

  /* ------------------------------------------------ operations resources -- */
  if (pathname === '/api/operations/resources' && req.method === 'GET') {
    return sendJson(res, 200, projectOperationsResources(url));
  }

  /* ----------------------------------------------------------- discovery -- */

  if (pathname === '/api/discovery/meta') {
    return sendJson(res, 200, {
      schemaVersion: 1,
      adapterTypes: ['nrf'],
      transportModes: ['h2c', 'h2_tls'],
      runStatuses: ['running', 'success', 'partial', 'failed'],
      observationStates: ['seen', 'missing', 'stale'],
      minScanIntervalSeconds: 60,
      requestTimeoutSeconds: 10,
      totalScanDeadlineSeconds: 60,
      maxNfProfiles: 256,
    });
  }

  if (pathname === '/api/discovery/sources' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    return sendJson(res, 200, { sources: SOURCES.slice(0, limit), page: page(limit) });
  }
  if (pathname === '/api/discovery/sources' && req.method === 'POST') {
    return readBody(req, (payload) => sendJson(res, 201, {
      sourceId: '8a1c2b30-0099-4a99-8c99-000000000099',
      schemaVersion: 1,
      name: payload?.name ?? 'new-source',
      adapterType: payload?.adapterType ?? 'nrf',
      baseUrl: payload?.baseUrl ?? 'http://127.0.0.10:7777',
      enabled: payload?.enabled ?? true,
      transportMode: payload?.transportMode ?? 'h2c',
      revision: 1,
      createdAt: TS.t5,
      createdBy: session.username,
      updatedAt: TS.t5,
      updatedBy: session.username,
    }));
  }

  const scanMatch = /^\/api\/discovery\/sources\/([^/]+)\/scan$/.exec(pathname);
  if (scanMatch && req.method === 'POST') {
    return readBody(req, () => sendJson(res, 200, {
      run: {
        runId: 'aa3e4f50-0099-4c99-9e99-000000000099',
        schemaVersion: 1,
        sourceId: scanMatch[1],
        startedAt: TS.t5,
        completedAt: TS.t5,
        status: 'success',
        discoveredCount: 3,
        createdCount: 0,
        updatedCount: 3,
        unchangedCount: 0,
        missingCount: 1,
        initiatedBy: session.username,
      },
    }));
  }

  const sourceMatch = /^\/api\/discovery\/sources\/([^/]+)$/.exec(pathname);
  if (sourceMatch && req.method === 'GET') {
    const source = SOURCES.find((item) => item.sourceId === sourceMatch[1]);
    if (!source) return sendJson(res, 404, { error: 'not found', code: 'DISCOVERY_SOURCE_NOT_FOUND' });
    return sendJson(res, 200, source);
  }
  if (sourceMatch && req.method === 'PUT') {
    return readBody(req, (payload) => {
      const source = SOURCES.find((item) => item.sourceId === sourceMatch[1]) ?? SOURCES[0];
      return sendJson(res, 200, {
        ...source,
        name: payload?.source?.name ?? source.name,
        baseUrl: payload?.source?.baseUrl ?? source.baseUrl,
        transportMode: payload?.source?.transportMode ?? source.transportMode,
        enabled: payload?.source?.enabled ?? source.enabled,
        revision: source.revision + 1,
        updatedAt: TS.t5,
        updatedBy: session.username,
      });
    });
  }

  if (pathname === '/api/discovery/runs') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    const sourceId = url.searchParams.get('sourceId') ?? '';
    const items = (sourceId ? RUNS.filter((run) => run.sourceId === sourceId) : RUNS).slice(0, limit);
    return sendJson(res, 200, { runs: items, page: page(limit) });
  }

  if (pathname === '/api/discovery/candidates') {
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    const sourceId = url.searchParams.get('sourceId') ?? '';
    const nfType = url.searchParams.get('nfType') ?? '';
    const observationState = url.searchParams.get('observationState') ?? '';
    let items = CANDIDATES;
    if (sourceId) items = items.filter((item) => item.sourceId === sourceId);
    if (nfType) items = items.filter((item) => item.nfType === nfType);
    if (observationState) items = items.filter((item) => item.observationState === observationState);
    const projected = items
      .slice(0, limit)
      .map((item) => projectCandidate(item, context.monitoringVariant));
    return sendJson(res, 200, { candidates: projected, page: page(limit) });
  }

  const candidateLink = /^\/api\/discovery\/candidates\/([^/]+)\/link$/.exec(pathname);
  if (candidateLink && req.method === 'POST') {
    return readBody(req, (payload) => {
      const candidate = CANDIDATES.find((item) => item.candidateId === candidateLink[1]) ?? CANDIDATES[0];
      return sendJson(res, 200, projectCandidate({
        ...candidate,
        linkedResourceId: payload?.resourceId ?? RESOURCE_IDS.amf,
        revision: candidate.revision + 1,
      }, context.monitoringVariant));
    });
  }
  const candidateUnlink = /^\/api\/discovery\/candidates\/([^/]+)\/unlink$/.exec(pathname);
  if (candidateUnlink && req.method === 'POST') {
    return readBody(req, () => {
      const candidate = CANDIDATES.find((item) => item.candidateId === candidateUnlink[1]) ?? CANDIDATES[0];
      return sendJson(res, 200, { ...candidate, linkedResourceId: null, revision: candidate.revision + 1 });
    });
  }
  const candidateMatch = /^\/api\/discovery\/candidates\/([^/]+)$/.exec(pathname);
  if (candidateMatch && req.method === 'GET') {
    const candidate = CANDIDATES.find((item) => item.candidateId === candidateMatch[1]);
    if (!candidate) return sendJson(res, 404, { error: 'not found', code: 'DISCOVERY_CANDIDATE_NOT_FOUND' });
    return sendJson(res, 200, projectCandidate(candidate, context.monitoringVariant));
  }

  // The runtime discovery panel is mounted on the dashboard, the Inventory
  // route and the Topology route. Its reads are part of the accepted request
  // set; anything else still fails the run.
  if (serveRuntimeFixture(pathname, sendJson, res)) return;

  context.unexpected.push(`${req.method} ${pathname}`);
  return sendJson(res, 404, { error: 'unexpected fixture request', code: 'FIXTURE_UNEXPECTED' });
}
