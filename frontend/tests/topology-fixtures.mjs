/*
 * Deterministic browser-acceptance fixtures for the Topology UI.
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
import { extname, join, normalize, resolve } from 'node:path';

/* ------------------------------------------------------------ identifiers -- */

export const RESOURCE_IDS = {
  amf: '6f1c1a10-0001-4a01-8b01-000000000001',
  smf: '6f1c1a10-0002-4a02-8b02-000000000002',
  upf: '6f1c1a10-0003-4a03-8b03-000000000003',
  pcf: '6f1c1a10-0004-4a04-8b04-000000000004',
  nrf: '6f1c1a10-0005-4a05-8b05-000000000005',
  epc: '6f1c1a10-0006-4a06-8b06-000000000006',
};

export const EDGE_IDS = {
  depends: '7e2d2b20-0011-4b11-9c11-000000000011',
  connects: '7e2d2b20-0012-4b12-9c12-000000000012',
  uses: '7e2d2b20-0013-4b13-9c13-000000000013',
  registers: '7e2d2b20-0014-4b14-9c14-000000000014',
  exposes: '7e2d2b20-0015-4b15-9c15-000000000015',
};

/* Fixed timestamps keep ordering and rendering deterministic. */
const TS = {
  t1: '2026-10-01T08:00:00Z',
  t2: '2026-10-02T09:15:00Z',
  t3: '2026-10-03T10:30:00Z',
  t4: '2026-10-04T11:45:00Z',
  t5: '2026-10-05T12:00:00Z',
};

const SOURCE = { kind: 'manual', system: 'xcloud', authority: 'authoritative' };

/* -------------------------------------------------------------- resources -- */

function inventoryResource(id, name, domain, kind, lifecycleState) {
  return {
    resourceId: id,
    schemaVersion: 1,
    kind,
    name,
    displayName: name.toUpperCase(),
    description: 'Fixture resource used for deterministic browser acceptance.',
    domain,
    role: kind === 'network_function' ? 'nf' : 'element',
    lifecycleState,
    source: SOURCE,
    revision: 1,
    createdAt: TS.t1,
    createdBy: 'fixture',
    updatedAt: TS.t1,
    updatedBy: 'fixture',
  };
}

export const RESOURCES = [
  inventoryResource(RESOURCE_IDS.amf, 'amf-01', '5gc', 'network_function', 'active'),
  inventoryResource(RESOURCE_IDS.smf, 'smf-01', '5gc', 'network_function', 'active'),
  inventoryResource(RESOURCE_IDS.upf, 'upf-01', '5gc', 'network_function', 'active'),
  inventoryResource(RESOURCE_IDS.pcf, 'pcf-01', '5gc', 'network_function', 'active'),
  inventoryResource(RESOURCE_IDS.nrf, 'nrf-01', '5gc', 'network_function', 'active'),
  inventoryResource(RESOURCE_IDS.epc, 'mme-legacy-01', 'epc', 'network_element', 'retired'),
];

/* ------------------------------------------------------------------ edges -- */

function topologyEdge(edgeId, relationshipType, fromResourceId, toResourceId, lifecycleState, revision, description, updatedAt) {
  return {
    edgeId,
    schemaVersion: 1,
    relationshipType,
    fromResourceId,
    toResourceId,
    description,
    labels: { scenario: 'stage2-acceptance' },
    attributes: { declaredBy: 'fixture' },
    lifecycleState,
    source: SOURCE,
    revision,
    createdAt: TS.t1,
    createdBy: 'operator1',
    updatedAt,
    updatedBy: 'operator1',
  };
}

export const EDGES = [
  /* SMF-01 neighbourhood: one inbound, two outbound. */
  topologyEdge(EDGE_IDS.depends, 'depends_on', RESOURCE_IDS.smf, RESOURCE_IDS.pcf, 'active', 1, 'SMF depends on PCF', TS.t5),
  topologyEdge(EDGE_IDS.connects, 'connects_to', RESOURCE_IDS.amf, RESOURCE_IDS.smf, 'active', 1, 'AMF connects to SMF', TS.t4),
  topologyEdge(EDGE_IDS.uses, 'uses', RESOURCE_IDS.smf, RESOURCE_IDS.upf, 'active', 2, 'SMF uses UPF', TS.t3),
  topologyEdge(EDGE_IDS.registers, 'registers_with', RESOURCE_IDS.nrf, RESOURCE_IDS.amf, 'active', 1, 'NRF registers AMF', TS.t2),
  /* Retired relationship: still readable, never shown as active. */
  topologyEdge(EDGE_IDS.exposes, 'exposes', RESOURCE_IDS.pcf, RESOURCE_IDS.nrf, 'retired', 3, 'PCF exposes NRF (retired)', TS.t1),
];

export const RELATIONSHIP_TYPES = [
  'contains', 'runs_on', 'depends_on', 'connects_to', 'routes_to',
  'registers_with', 'serves', 'uses', 'exposes',
];

export const INVENTORY_KINDS = [
  'region', 'site', 'cluster', 'host', 'virtual_machine', 'container', 'pod',
  'network_element', 'network_function', 'network_function_instance', 'interface',
  'ip_address', 'service_endpoint', 'plmn', 'dnn', 'network_slice', 'service',
  'configuration', 'software_version', 'deployment',
];

export const INVENTORY_DOMAINS = [
  'platform', 'ran', 'epc', 'ims', '5gc', 'charging', 'transport', 'cloud', 'shared', 'other',
];

export const INVENTORY_LIFECYCLE_STATES = ['planned', 'active', 'maintenance', 'retired'];

/* -------------------------------------------------------------- sessions -- */

export const SESSIONS = {
  operator: {
    username: 'operator1',
    role: 'operator',
    normalizedRole: 'operator',
    status: 'active',
    permissions: ['core.read', 'core.configure'],
  },
  admin: {
    username: 'admin1',
    role: 'admin',
    normalizedRole: 'admin',
    status: 'active',
    permissions: ['core.read', 'core.configure', 'users.read', 'users.write', 'system_heal'],
  },
  viewer: {
    username: 'viewer1',
    role: 'viewer',
    normalizedRole: 'viewer',
    status: 'active',
    permissions: ['core.read'],
  },
};

/* ------------------------------------------------------------ projections -- */

function project(resourceId) {
  const resource = RESOURCES.find((item) => item.resourceId === resourceId);
  if (!resource) return null;
  return {
    resourceId: resource.resourceId,
    kind: resource.kind,
    name: resource.name,
    displayName: resource.displayName,
    domain: resource.domain,
    role: resource.role,
    lifecycleState: resource.lifecycleState,
  };
}

function neighboursOf(rootResourceId, direction, lifecycleState, relationshipType) {
  const matches = EDGES.filter((edge) => {
    if (lifecycleState && edge.lifecycleState !== lifecycleState) return false;
    if (relationshipType && edge.relationshipType !== relationshipType) return false;
    if (direction === 'inbound') return edge.toResourceId === rootResourceId;
    if (direction === 'outbound') return edge.fromResourceId === rootResourceId;
    return edge.fromResourceId === rootResourceId || edge.toResourceId === rootResourceId;
  });
  return matches.map((edge) => {
    const outbound = edge.fromResourceId === rootResourceId;
    const neighbourId = outbound ? edge.toResourceId : edge.fromResourceId;
    return {
      edge,
      direction: outbound ? 'outbound' : 'inbound',
      neighborResource: project(neighbourId) ?? { resourceId: neighbourId, kind: '', name: '', domain: '', lifecycleState: 'unknown' },
    };
  });
}

/* ----------------------------------------------------------- health shape -- */

function healthPayload() {
  return {
    status: 'healthy',
    score: 98,
    checkedAt: TS.t5,
    subsystems: {
      database: {
        status: 'healthy',
        latencyMs: 3,
        xcloudDb: 'xcloud',
        appDb: 'xcloud_ops',
        ready: true,
        totalCollections: 12,
        existingCollections: 12,
        missingCollectionsCount: 0,
        missingIndexesCount: 0,
        report: {
          ok: true,
          database: 'xcloud_ops',
          databases: { xcloud: 'xcloud', app: 'xcloud_ops' },
          checkedAt: TS.t5,
          latencyMs: 3,
          collections: [],
          missingCollections: [],
          missingIndexes: [],
        },
      },
      ocsEngine: {
        status: 'healthy',
        totalSubscribers: 128,
        totalAllocatedOctets: 1374389534720,
        totalUsedOctets: 274877906944,
        totalReservedOctets: 1073741824,
        totalAvailableOctets: 1098445493760,
        utilizationRate: 0.2,
        invariantsOk: true,
        brokenInvariantsCount: 0,
        activeSessions: 7,
        closingSessions: 0,
        activeReservations: 3,
        orphanedReservations: 0,
        activeTariffPlans: 2,
      },
      hssCore: {
        status: 'healthy',
        totalSubscribers: 128,
        validCredentialsCount: 128,
        missingCredentialsCount: 0,
        validSlicesCount: 128,
        missingSlicesCount: 0,
        activeProfilesCount: 3,
        danglingProfilesCount: 0,
      },
      security: {
        status: 'healthy',
        rootUserConfigured: true,
        activeUsersCount: 3,
        unacknowledgedAlertsCount: 0,
        criticalAlertsCount: 0,
        warningAlertsCount: 0,
        recentAuditLogsCount: 42,
      },
    },
    summary: {
      totalAnomaliesDetected: 0,
      actionableItemsCount: 0,
      recommendations: ['No anomalies detected across monitored subsystems.'],
    },
  };
}

/* ------------------------------------------------------------ HTTP server -- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
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

/**
 * Start the fixture server.
 *
 * @param {object} options
 * @param {string} options.distDir built SPA directory
 * @param {string} options.sessionKey key of SESSIONS to authenticate as
 * @returns {Promise<{origin: string, unexpected: string[], close: () => Promise<void>, requestLog: string[]}>}
 */
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

    /* SPA fallback so deep links such as /topology/<id> resolve. */
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

  if (pathname === '/api/alerts') return sendJson(res, 200, { alerts: [] });
  if (pathname === '/api/profiles') return sendJson(res, 200, { profiles: [] });
  if (pathname === '/api/system/health') return sendJson(res, 200, healthPayload());
  if (pathname === '/api/system/audit/status') return sendJson(res, 200, { lastSaveTime: 1_760_000_000_000 });
  if (pathname === '/api/system/mongo/health') return sendJson(res, 200, healthPayload().subsystems.database.report);

  /* Known read surfaces the shell or comparison pages may touch. They answer with
   * an empty, contract-shaped payload so the browser sees a real response rather
   * than an error state. Anything outside this allowlist is reported as an
   * unexpected request and fails the acceptance run. */
  const BENIGN_EMPTY = {
    '/api/analytics/metrics': { metrics: {} },
    '/api/analytics/sparkline': { points: [] },
    '/api/ocs/subscribers': { subscribers: [] },
    '/api/ocs/balances': { balances: [] },
    '/api/ocs/sessions': { sessions: [] },
    '/api/ocs/usage': { records: [] },
    '/api/ocs/reservations': { reservations: [] },
    '/api/ratings': { ratings: [] },
    '/api/tariff-plans': { plans: [] },
    '/api/search': { results: [] },
    '/api/users': { users: [] },
    '/api/auth/users': { users: [] },
  };
  if (Object.prototype.hasOwnProperty.call(BENIGN_EMPTY, pathname)) {
    return sendJson(res, 200, BENIGN_EMPTY[pathname]);
  }

  /* ------------------------------------------------------------ inventory -- */
  if (pathname === '/api/inventory/meta') {
    return sendJson(res, 200, {
      schemaVersion: 1,
      kinds: INVENTORY_KINDS,
      domains: INVENTORY_DOMAINS,
      lifecycleStates: INVENTORY_LIFECYCLE_STATES,
      managementProtocols: ['http', 'https', 'ssh', 'snmp', 'netconf', 'restconf', 'gnmi', 'sbi', 'sip', 'diameter', 'pfcp', 'gtp', 'ngap', 'other'],
      addressTypes: ['ipv4', 'ipv6', 'fqdn'],
    });
  }
  if (pathname === '/api/inventory/resources') {
    const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const kind = url.searchParams.get('kind') ?? '';
    const domain = url.searchParams.get('domain') ?? '';
    const lifecycleState = url.searchParams.get('lifecycleState') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    let items = RESOURCES.filter((resource) => {
      if (kind && resource.kind !== kind) return false;
      if (domain && resource.domain !== domain) return false;
      if (lifecycleState && resource.lifecycleState !== lifecycleState) return false;
      if (query && !resource.resourceId.startsWith(query) && !resource.name.toLowerCase().startsWith(query)) return false;
      return true;
    });
    items = items.slice(0, limit);
    return sendJson(res, 200, { resources: items, page: { limit, nextCursor: null, hasMore: false } });
  }
  const inventoryMatch = /^\/api\/inventory\/resources\/([^/]+)$/.exec(pathname);
  if (inventoryMatch) {
    const resource = RESOURCES.find((item) => item.resourceId === inventoryMatch[1]);
    if (!resource) return sendJson(res, 404, { error: 'not found', code: 'INVENTORY_RESOURCE_NOT_FOUND' });
    return sendJson(res, 200, resource);
  }

  /* ------------------------------------------------------------- topology -- */
  if (pathname === '/api/topology/meta') {
    return sendJson(res, 200, {
      schemaVersion: 1,
      relationshipTypes: RELATIONSHIP_TYPES,
      lifecycleStates: ['active', 'retired'],
    });
  }
  if (pathname === '/api/topology/edges' && req.method === 'GET') {
    const lifecycleState = url.searchParams.get('lifecycleState') ?? 'active';
    const relationshipType = url.searchParams.get('relationshipType') ?? '';
    const fromResourceId = url.searchParams.get('fromResourceId') ?? '';
    const toResourceId = url.searchParams.get('toResourceId') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 20) || 20;
    const items = EDGES.filter((edge) => {
      if (lifecycleState && edge.lifecycleState !== lifecycleState) return false;
      if (relationshipType && edge.relationshipType !== relationshipType) return false;
      if (fromResourceId && edge.fromResourceId !== fromResourceId) return false;
      if (toResourceId && edge.toResourceId !== toResourceId) return false;
      return true;
    }).slice(0, limit);
    return sendJson(res, 200, { edges: items, page: { limit, nextCursor: null, hasMore: false } });
  }
  if (pathname === '/api/topology/edges' && req.method === 'POST') {
    return readBody(req, (payload) => {
      const now = TS.t5;
      return sendJson(res, 201, {
        edgeId: '7e2d2b20-0099-4b99-9c99-000000000099',
        schemaVersion: 1,
        relationshipType: payload?.relationshipType ?? 'depends_on',
        fromResourceId: payload?.fromResourceId ?? RESOURCE_IDS.smf,
        toResourceId: payload?.toResourceId ?? RESOURCE_IDS.pcf,
        description: payload?.description ?? '',
        labels: payload?.labels ?? {},
        attributes: payload?.attributes ?? {},
        lifecycleState: 'active',
        source: SOURCE,
        revision: 1,
        createdAt: now,
        createdBy: 'fixture',
        updatedAt: now,
        updatedBy: 'fixture',
      });
    });
  }
  const edgeRetire = /^\/api\/topology\/edges\/([^/]+)\/retire$/.exec(pathname);
  if (edgeRetire && req.method === 'POST') {
    return readBody(req, () => {
      const edge = EDGES.find((item) => item.edgeId === edgeRetire[1]) ?? EDGES[0];
      return sendJson(res, 200, { ...edge, lifecycleState: 'retired', revision: edge.revision + 1, updatedAt: TS.t5 });
    });
  }
  const edgeMatch = /^\/api\/topology\/edges\/([^/]+)$/.exec(pathname);
  if (edgeMatch && req.method === 'GET') {
    const edge = EDGES.find((item) => item.edgeId === edgeMatch[1]);
    if (!edge) return sendJson(res, 404, { error: 'not found', code: 'TOPOLOGY_EDGE_NOT_FOUND' });
    return sendJson(res, 200, edge);
  }
  if (edgeMatch && req.method === 'PUT') {
    return readBody(req, (payload) => {
      const edge = EDGES.find((item) => item.edgeId === edgeMatch[1]) ?? EDGES[0];
      return sendJson(res, 200, {
        ...edge,
        description: payload?.edge?.description ?? edge.description,
        labels: payload?.edge?.labels ?? edge.labels,
        attributes: payload?.edge?.attributes ?? edge.attributes,
        revision: edge.revision + 1,
        updatedAt: TS.t5,
      });
    });
  }
  const neighbourMatch = /^\/api\/topology\/resources\/([^/]+)\/neighbors$/.exec(pathname);
  if (neighbourMatch) {
    const rootResourceId = neighbourMatch[1];
    const root = project(rootResourceId);
    if (!root) return sendJson(res, 404, { error: 'not found', code: 'TOPOLOGY_ROOT_RESOURCE_NOT_FOUND' });
    const direction = url.searchParams.get('direction') ?? 'both';
    const lifecycleState = url.searchParams.get('lifecycleState') ?? 'active';
    const relationshipType = url.searchParams.get('relationshipType') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? 50) || 50;
    const neighbours = neighboursOf(rootResourceId, direction, lifecycleState, relationshipType).slice(0, limit);
    return sendJson(res, 200, {
      rootResource: root,
      neighbors: neighbours,
      page: { limit, nextCursor: null, hasMore: false },
    });
  }

  context.unexpected.push(`${req.method} ${pathname}`);
  return sendJson(res, 404, { error: 'unexpected fixture request', code: 'FIXTURE_UNEXPECTED' });
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

export function resolveDistDir(frontendRoot) {
  return resolve(frontendRoot, 'dist');
}
