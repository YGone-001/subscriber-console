/*
 * Deterministic cross-route UX acceptance fixtures.
 *
 * TEST-ONLY. Nothing in this module is imported by production runtime code.
 *
 * The FE-C3 cross-route acceptance suite needs to render EVERY route in the
 * route contract against deterministic data, not just the few routes that own
 * a domain-specific fixture server. This module therefore provides:
 *
 *   1. A static host for the production SPA build with an index.html fallback,
 *      so deep links such as /subscribers/<imsi> boot the application.
 *   2. One read endpoint family per route contract entry, answered with the
 *      envelope shape the frontend adapter expects (envelope.ts), so a route
 *      renders its real surface instead of its error state.
 *   3. Deterministic identities that are reused from the existing domain
 *      fixtures (topology-fixtures, nf-health-fixtures, nf-discovery-fixtures)
 *      so a dynamic route is exercised with a legitimate, existing identifier
 *      rather than an invented one.
 *
 * The data here proves FRONTEND behaviour against replay fixtures. It is not
 * evidence that a live core network, a real charging system or a running
 * database was observed.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import {
  EDGE_IDS as TOPOLOGY_EDGE_IDS,
  RESOURCE_IDS as TOPOLOGY_RESOURCE_IDS,
} from './topology-fixtures.mjs';
import {
  RESOURCE_IDS as NF_HEALTH_RESOURCE_IDS,
  TARGET_IDS as NF_HEALTH_TARGET_IDS,
} from './nf-health-fixtures.mjs';
import {
  CANDIDATE_IDS as DISCOVERY_CANDIDATE_IDS,
  RESOURCE_IDS as DISCOVERY_RESOURCE_IDS,
  SOURCE_IDS as DISCOVERY_SOURCE_IDS,
  TARGET_IDS as DISCOVERY_TARGET_IDS,
} from './nf-discovery-fixtures.mjs';
import { RUNTIME_META, RUNTIME_OBSERVATIONS } from './runtime-fixtures.mjs';

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

/* -------------------------------------------------------------------------- */
/* Deterministic identities                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Every dynamic route in the contract gets one legitimate identifier. The
 * identifiers are the ones the domain fixtures already use, so the detail
 * surfaces read real fixture rows instead of an empty lookup.
 */
export const ROUTE_IDENTITIES = {
  imsi: '460020000000400',
  msisdn: '8613800000000',
  resourceId: TOPOLOGY_RESOURCE_IDS.amf,
  topologyResourceId: TOPOLOGY_RESOURCE_IDS.smf,
  sourceId: DISCOVERY_SOURCE_IDS.lab,
  configSnapshotSourceId: 'cfg-source-001',
  targetId: NF_HEALTH_TARGET_IDS.amf,
  discoveryTargetId: DISCOVERY_TARGET_IDS.amf,
  candidateId: DISCOVERY_CANDIDATE_IDS.amf,
  planId: 'default_plan',
  profileName: 'default',
  username: 'admin1',
  entryId: 'a1b2c3d4-0001-4000-8000-000000000001',
  agentId: 'agent-0001',
  investigationId: 'inv-0001',
  inspectionPlanId: 'plan-0001',
  inspectionRunId: 'run-0001',
  edgeId: TOPOLOGY_EDGE_IDS.depends,
};

/** A principal that can reach every permission-gated route in the contract. */
export const ADMIN_SESSION = {
  username: 'admin1',
  role: 'admin',
  normalizedRole: 'admin',
  status: 'active',
  permissions: [
    'users.read', 'users.create', 'users.update', 'users.disable', 'users.delete',
    'users.role.change', 'users.reset-password', 'users.unlock',
    'subscribers.read', 'subscribers.write', 'subscribers.delete',
    'ocs.read', 'ocs.balance.adjust', 'ocs.balance.reset', 'ocs.tariff.write',
    'ocs.plan.assign', 'ocs.rating.write', 'ocs.runtime.execute',
    'profiles.read', 'profiles.write',
    'core.read', 'core.operate', 'core.configure',
  ],
};

/** A read-only principal used for the read-only navigation journey. */
export const VIEWER_SESSION = {
  username: 'viewer1',
  role: 'viewer',
  normalizedRole: 'viewer',
  status: 'active',
  permissions: ['subscribers.read', 'profiles.read', 'ocs.read', 'core.read'],
};

/** A principal whose session is valid but whose account is disabled. */
export const DISABLED_SESSION = {
  username: 'disabled1',
  role: 'operator',
  normalizedRole: 'operator',
  status: 'disabled',
  permissions: ['core.read'],
};

/* -------------------------------------------------------------------------- */
/* Payload builders                                                           */
/* -------------------------------------------------------------------------- */

const TS = '2026-10-01T08:00:00Z';

function subscriberRow(imsi) {
  return {
    imsi,
    msisdn: ROUTE_IDENTITIES.msisdn,
    status: 'active',
    contractStatus: 'active',
    balanceState: 'active',
    balanceThreshold: 1024,
    ard: 0,
    plmn: '46000',
    profile: 'default',
    policy: 'default-policy',
    policyName: 'Default policy',
    policyStatus: 'active',
    provisioning: { contract: true, balance: true, tariffPlan: true },
    traffic: { total: 10737418240, used: 2147483648, balance: 8589934592 },
    sms: { total: 100, used: 10, balance: 90 },
    lastActive: TS,
  };
}

function profileRecord(name) {
  return {
    name,
    title: 'Default profile',
    description: 'Deterministic profile used by the cross-route UX acceptance suite.',
    archived: false,
    version: 3,
    createdAt: TS,
    updatedAt: TS,
    keys: { k: '00112233445566778899AABBCCDDEEFF', opc: '00112233445566778899AABBCCDDEEFF', amf: '8000', sqn: '0000000001' },
    slices: [],
    ambr: { downlink: { value: 1000, unit: 1 }, uplink: { value: 1000, unit: 1 } },
  };
}

function tariffPlan(planId) {
  return {
    plan_id: planId,
    name: 'Default plan',
    description: 'Deterministic tariff plan used by the cross-route UX acceptance suite.',
    status: 'active',
    validity_time: 0,
    quota_per_grant: 10737418240,
    volume_threshold: 8589934592,
    rules: [],
    created_at: TS,
    updated_at: TS,
  };
}

function balanceRecord(imsi) {
  return {
    id: 'bal-0001',
    imsi,
    plan_id: ROUTE_IDENTITIES.planId,
    status: 'active',
    data_total: 10737418240,
    data_used: 2147483648,
    data_reserved: 0,
    data_available: 8589934592,
    voice_total: 6000,
    voice_used: 1200,
    voice_reserved: 0,
    voice_available: 4800,
    sms_total: 100,
    sms_used: 10,
    sms_reserved: 0,
    sms_available: 90,
    money_balance: 50,
    version: 4,
    data_invariant_ok: true,
    voice_invariant_ok: true,
    sms_invariant_ok: true,
    invariant_ok: true,
    created_at: TS,
    updated_at: TS,
  };
}

function contractRecord(imsi) {
  return {
    id: 'contract-0001',
    imsi,
    msisdn: ROUTE_IDENTITIES.msisdn,
    plan_id: ROUTE_IDENTITIES.planId,
    status: 'active',
    created_at: TS,
    updated_at: TS,
  };
}

function userRecord(username) {
  return {
    username,
    displayName: 'Administrator',
    email: 'admin1@example.invalid',
    role: 'admin',
    status: 'active',
    locked: false,
    permissions: ['users.read', 'core.read'],
    security: {
      sessionVersion: 1,
      failedLoginAttempts: 0,
      lastLoginAt: TS,
      lastLoginIp: '127.0.0.1',
      passwordChangedAt: TS,
    },
    createdAt: TS,
    updatedAt: TS,
  };
}

function knowledgeEntry(entryId) {
  return {
    id: entryId,
    title: 'Deterministic knowledge entry',
    summary: 'Cross-route UX acceptance fixture entry.',
    body: 'Body used by the cross-route UX acceptance suite.',
    protocol: 'SIP',
    tags: ['fixture'],
    files: [],
    versions: [],
    createdAt: TS,
    updatedAt: TS,
  };
}

function agentRecord(agentId) {
  return {
    id: agentId,
    name: 'Deterministic agent',
    status: 'online',
    version: '1.0.0',
    lastSeenAt: TS,
    capabilities: [],
  };
}

/**
 * One open NF alert with a measurement snapshot.
 *
 * The evidence carries a healthy and a degraded layer so the alert evidence
 * drawer renders its layer state badges. A badge that lost its styling class
 * is invisible in a static screenshot but obvious in the rendered DOM.
 */
function fixtureAlert() {
  return {
    alertId: 'alert-fixture-1',
    schemaVersion: 1,
    ruleId: 'rule-fixture-1',
    ruleName: 'Fixture NF Health rule',
    targetId: NF_HEALTH_TARGET_IDS.amf,
    resourceId: NF_HEALTH_RESOURCE_IDS.amf,
    targetName: 'amf',
    severity: 'critical',
    state: 'open',
    conditionType: 'metric',
    triggerCount: 1,
    firstTriggeredAt: TS,
    lastTriggeredAt: TS,
    updatedAt: TS,
    evidence: {
      runStatus: 'success',
      collectedAt: TS,
      overallState: 'degraded',
      layers: {
        process: { measured: true, state: 'healthy' },
        interface: { measured: true, state: 'degraded' },
        service: { measured: false },
      },
    },
  };
}

function inventoryResource(resourceId) {  return {
    resourceId,
    schemaVersion: 1,
    kind: 'network_function',
    name: 'amf-01',
    displayName: 'AMF-01',
    description: 'Deterministic inventory resource for the cross-route UX acceptance suite.',
    domain: '5gc',
    role: 'nf',
    lifecycleState: 'active',
    source: { kind: 'manual', system: 'xcloud', authority: 'authoritative' },
    revision: 1,
    createdAt: TS,
    createdBy: 'fixture',
    updatedAt: TS,
    updatedBy: 'fixture',
  };
}

/* -------------------------------------------------------------------------- */
/* Response tables                                                            */
/* -------------------------------------------------------------------------- */

const EMPTY = {
  '/api/alerts': { alerts: [] },
  '/api/analytics/metrics': { metrics: {} },
  '/api/analytics/sparkline': { points: [] },
  '/api/config-drift/alerts': { alerts: [] },
  '/api/config-drift/meta': { sources: [], policy: null },
  '/api/config-snapshots/meta': { sources: [] },
  '/api/config-snapshots/sources': { sources: [] },
  '/api/discovery/candidates': { candidates: [] },
  '/api/discovery/meta': { sources: [] },
  '/api/discovery/runs': { runs: [] },
  '/api/discovery/sources': { sources: [] },
  '/api/ims/registrations': { items: [] },
  '/api/inspection-plans': { plans: [] },
  '/api/inspection-runs': { runs: [] },
  '/api/inspections/meta': { kinds: [] },
  '/api/investigations': { investigations: [] },
  '/api/investigations/context': { context: null },
  '/api/knowledge/files': { files: [] },
  '/api/knowledge/meta': { tags: [] },
  '/api/knowledge/tags': { tags: [] },
  '/api/nf-alerts': { alerts: [] },
  '/api/nf-alerts/meta': { severities: [], statuses: [] },
  '/api/nf-alerts/rules': { rules: [] },
  '/api/nf-health/meta': { targets: [] },
  '/api/nf-health/runs': { runs: [] },
  '/api/nf-health/samples': { samples: [] },
  '/api/nf-notifications/channels': { channels: [] },
  '/api/nf-notifications/deliveries': { deliveries: [] },
  '/api/nf-notifications/escalations': { escalations: [] },
  '/api/ocs/reservations': { reservations: [] },
  '/api/ocs/subscribers': { ok: true, records: [] },
  '/api/operations/groups': { groups: [] },
  '/api/operations/groups/members': { members: [] },
  '/api/operations/groups/summary': { summary: {} },
  '/api/operations/resources': { resources: [], page: { limit: 200, nextCursor: null, hasMore: false } },
  '/api/ops-reports/alerts': { alerts: [] },
  '/api/ops-reports/metrics': { metrics: {} },
  '/api/ops-reports/summary': { summary: {} },
  '/api/ratings': { ratings: [] },
  '/api/search': { results: [] },
  '/api/system/audit/status': { lastSaveTime: 1760000000000 },
  '/api/topology/meta': { relationshipTypes: [], domains: [], kinds: [] },
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
 * Answer one API read.
 *
 * The handler is deliberately exhaustive about the ROUTE CONTRACT rather than
 * about every endpoint in the repository: each route entry gets the read that
 * drives its surface, so a route renders its real layout instead of an error
 * state that would mask a layout defect.
 */
function answerApi(pathname, url, session) {
  if (pathname === '/api/auth/me') return { status: 200, payload: session };
  if (pathname === '/api/auth/permissions') return { status: 200, payload: { permissions: session.permissions } };

  if (pathname === '/api/notifications/stream' || pathname === '/api/runtime/stream' || pathname === '/api/nf-logs/stream') {
    return { status: 'stream' };
  }

  if (pathname === '/api/runtime/observations') return { status: 200, payload: RUNTIME_OBSERVATIONS };
  if (pathname === '/api/runtime/meta') return { status: 200, payload: RUNTIME_META };

  /* Dashboard and operations summary. */
  if (pathname === '/api/operations/summary') {
    const sections = (url.searchParams.get('sections') ?? '').split(',').filter(Boolean);
    const payload = { generatedAt: TS };
    if (sections.includes('health')) {
      payload.health = { state: 'healthy', completeness: 'complete', totals: { resources: 6, healthy: 5, degraded: 1 } };
    }
    if (sections.includes('alerts')) {
      payload.alerts = { completeness: 'complete', alerts: { openBySeverity: { critical: 1, warning: 2 } } };
    }
    if (sections.includes('inventory')) {
      payload.inventory = { completeness: 'complete', totals: { total: 6, active: 5 } };
    }
    if (sections.includes('discovery')) {
      payload.discovery = { completeness: 'complete', totals: { candidates: 4 } };
    }
    return { status: 200, payload };
  }
  if (pathname === '/api/ue-info') {
    return {
      status: 200,
      payload: {
        generatedAt: TS,
        configured: true,
        complete: true,
        summary: {
          total: 2,
          registered: 2,
          idle: 0,
          connected: 2,
          stateUnreported: 0,
          epc5gcOnlineUsers: null,
          imsOnlineUsers: null,
          totalSubscribers: null,
          totalIMSUsers: null,
        },
        sources: [],
        items: [],
        pagination: { limit: 50, offset: 0, total: 0, nextCursor: null, hasMore: false },
      },
    };
  }
  if (pathname === '/api/ims/registrations/summary') {
    return {
      status: 200,
      payload: {
        catalogSources: [],
        generatedAt: TS,
        configurationState: 'not_configured',
        completeness: 'unavailable',
        scope: 'all',
        scopeMeaning: '',
        consistency: 'unknown',
        counts: { publicIdentities: null, activePublicIdentities: null, activeBindings: null },
        observed: { publicIdentities: 0, activePublicIdentities: 0, activeBindings: 0 },
        sources: [],
        items: [],
        pagination: { limit: 50, total: null, nextCursor: null, hasMore: false },
      },
    };
  }
  if (pathname === '/api/system/health') {
    return {
      status: 200,
      payload: {
        status: 'ok',
        generatedAt: TS,
        subsystems: { database: { status: 'ok', report: { status: 'ok' } } },
      },
    };
  }
  if (pathname === '/api/system/mongo/health') {
    return { status: 200, payload: { status: 'ok' } };
  }
  if (pathname === '/api/system/retention/ocs') {
    return {
      status: 200,
      payload: {
        generatedAt: TS,
        mode: 'dry_run',
        completeness: 'complete',
        candidates: [],
        totals: { candidates: 0, orphanedReservations: 0 },
        note: 'Deterministic retention fixture.',
      },
    };
  }

  /* Inventory and topology. */
  if (pathname === '/api/inventory/meta') {
    return {
      status: 200,
      payload: {
        schemaVersion: 1,
        kinds: ['network_function', 'network_element'],
        domains: ['5gc', 'epc', 'ims', 'ran'],
        lifecycleStates: ['planned', 'active', 'retired'],
        managementProtocols: ['http', 'https', 'ssh', 'snmp', 'netconf', 'restconf', 'gnmi', 'sbi', 'sip', 'diameter', 'pfcp', 'gtp', 'ngap', 'other'],
        addressTypes: ['ipv4', 'ipv6', 'fqdn'],
      },
    };
  }
  if (pathname === '/api/inventory/resources') {
    return {
      status: 200,
      payload: {
        resources: [inventoryResource(ROUTE_IDENTITIES.resourceId)],
        total: 1,
        page: { limit: 20, nextCursor: null, hasMore: false },
      },
    };
  }
  if (pathname.startsWith('/api/inventory/resources/')) {
    const resourceId = decodeURIComponent(pathname.slice('/api/inventory/resources/'.length));
    return { status: 200, payload: inventoryResource(resourceId) };
  }
  if (pathname === '/api/topology/edges') {
    return { status: 200, payload: { edges: [], page: { limit: 200, nextCursor: null, hasMore: false } } };
  }
  if (pathname === '/api/topology/live') {
    return {
      status: 200,
      payload: {
        generatedAt: TS,
        host: { hostId: 'fixture-host', hostName: 'agent-fixture' },
        runtime: { total: 2, running: 2, stopped: 0, unverified: 0, permissionDenied: 0, unknown: 0, stale: 0, notDetected: 0, expected: 2 },
        config: { manifestConfigured: true, sourceCount: 1, availableSources: 1, complete: true },
        nodes: [],
        edges: [],
      },
    };
  }
  if (pathname.startsWith('/api/topology/resources/')) {
    const rest = pathname.slice('/api/topology/resources/'.length);
    if (rest.endsWith('/neighbors')) {
      const resourceId = decodeURIComponent(rest.slice(0, -'/neighbors'.length));
      return { status: 200, payload: { resourceId, neighbors: [], page: { limit: 200, nextCursor: null, hasMore: false } } };
    }
    return { status: 200, payload: inventoryResource(decodeURIComponent(rest)) };
  }

  /* Discovery. */
  if (pathname.startsWith('/api/discovery/sources/')) {
    const sourceId = decodeURIComponent(pathname.slice('/api/discovery/sources/'.length));
    return {
      status: 200,
      payload: {
        id: sourceId,
        name: 'lab-source',
        status: 'enabled',
        lastRunAt: TS,
        createdAt: TS,
        updatedAt: TS,
      },
    };
  }
  if (pathname.startsWith('/api/discovery/candidates/')) {
    const candidateId = decodeURIComponent(pathname.slice('/api/discovery/candidates/'.length));
    return {
      status: 200,
      payload: {
        id: candidateId,
        name: 'amf',
        nfType: 'AMF',
        domain: '5gc',
        status: 'candidate',
        linkedResourceId: DISCOVERY_RESOURCE_IDS.amf,
        monitoringAssociation: { state: 'not_monitored' },
        observedAt: TS,
      },
    };
  }

  /* NF Health. */
  if (pathname === '/api/nf-alerts') {
    return { status: 200, payload: { alerts: [fixtureAlert()], page: { limit: 20, nextCursor: null, hasMore: false } } };
  }
  if (pathname === '/api/nf-health/targets') {
    return {
      status: 200,
      payload: {
        targets: [
          {
            targetId: NF_HEALTH_TARGET_IDS.amf,
            resourceId: NF_HEALTH_RESOURCE_IDS.amf,
            name: 'amf',
            nfType: 'AMF',
            domain: '5gc',
            status: 'healthy',
            health: 'healthy',
            measurement: 'available',
            lastMeasuredAt: TS,
            completeness: 'complete',
          },
        ],
        page: { limit: 200, nextCursor: null, hasMore: false },
      },
    };
  }
  if (pathname === '/api/nf-health/interfaces') {
    return { status: 200, payload: { interfaces: [], page: { limit: 200, nextCursor: null, hasMore: false } } };
  }
  if (pathname.startsWith('/api/nf-health/targets/')) {
    const rest = pathname.slice('/api/nf-health/targets/'.length);
    if (rest.endsWith('/history')) {
      const targetId = decodeURIComponent(rest.slice(0, -'/history'.length));
      return { status: 200, payload: { targetId, samples: [], completeness: 'complete' } };
    }
    const targetId = decodeURIComponent(rest);
    return {
      status: 200,
      payload: {
        target: {
          targetId,
          resourceId: NF_HEALTH_RESOURCE_IDS.amf,
          name: 'amf',
          nfType: 'AMF',
          domain: '5gc',
          status: 'healthy',
          health: 'healthy',
          measurement: 'available',
          lastMeasuredAt: TS,
          completeness: 'complete',
        },
        completeness: 'complete',
      },
    };
  }

  /* Subscribers, profiles, charging. */
  if (pathname === '/api/subscribers') {
    return {
      status: 200,
      payload: {
        subscribers: [subscriberRow(ROUTE_IDENTITIES.imsi)],
        total: 1,
        page: 1,
        limit: 20,
        summary: { total: 1, active: 1, restricted: 0, lowTraffic: 0, lowBalance: 0, unprovisioned: 0 },
        matchedBy: '',
        matchSource: '',
      },
    };
  }
  if (pathname.startsWith('/api/subscribers/')) {
    const imsi = decodeURIComponent(pathname.slice('/api/subscribers/'.length));
    return {
      status: 200,
      payload: {
        subscriber: subscriberRow(imsi),
        sub4G: {},
        pcrf4G: {},
        auth4G: { k: '00112233445566778899AABBCCDDEEFF', opc: '00112233445566778899AABBCCDDEEFF', amf: '8000', sqn: '0000000001' },
        ueAmbr: { downlink: { value: 1000, unit: 1 }, uplink: { value: 1000, unit: 1 } },
        plmn: '46000',
        profile: 'default',
        status: 'active',
      },
    };
  }
  if (pathname === '/api/profiles') {
    return { status: 200, payload: { profiles: [profileRecord(ROUTE_IDENTITIES.profileName)] } };
  }
  if (pathname === '/api/profiles/meta') {
    /* The backend contract is { capabilities, accessRestriction }; the page
     * reads capabilities.canWrite directly, so a shape-only stub would crash. */
    return {
      status: 200,
      payload: {
        capabilities: { canWrite: true, canRestore: true, credentialVisibility: 'plaintext', canEditCredentials: true },
        accessRestriction: {
          unrestricted: 0,
          suspended: 255,
          bits: [
            { value: 128, key: 'nr' },
            { value: 16, key: 'eutran' },
            { value: 1, key: 'utran' },
          ],
        },
      },
    };
  }
  if (pathname.startsWith('/api/profiles/')) {
    const rest = pathname.slice('/api/profiles/'.length);
    if (rest.endsWith('/versions')) {
      return { status: 200, payload: { versions: [] } };
    }
    return { status: 200, payload: profileRecord(decodeURIComponent(rest)) };
  }
  if (pathname === '/api/tariff-plans') {
    return { status: 200, payload: { plans: [tariffPlan(ROUTE_IDENTITIES.planId)] } };
  }
  if (pathname.startsWith('/api/tariff-plans/')) {
    const rest = pathname.slice('/api/tariff-plans/'.length);
    const planId = decodeURIComponent(rest.split('/')[0]);
    if (rest.endsWith('/rules')) return { status: 200, payload: { rules: [] } };
    if (rest.endsWith('/subscribers')) return { status: 200, payload: { subscribers: [] } };
    if (rest.endsWith('/operations')) return { status: 200, payload: { operations: [] } };
    return { status: 200, payload: { plan: tariffPlan(planId) } };
  }
  if (pathname === '/api/ocs/balances') {
    return { status: 200, payload: { ok: true, records: [balanceRecord(ROUTE_IDENTITIES.imsi)], total: 1, page: 1, limit: 20 } };
  }
  if (pathname.startsWith('/api/ocs/balances/')) {
    const imsi = decodeURIComponent(pathname.slice('/api/ocs/balances/'.length).replace(/\/adjustments$/, ''));
    if (pathname.endsWith('/adjustments')) return { status: 200, payload: { ok: true, imsi, records: [], total: 0, page: 1, limit: 20 } };
    return { status: 200, payload: { ok: true, balance: balanceRecord(imsi) } };
  }
  if (pathname === '/api/ocs/subscribers') {
    const imsi = url.searchParams.get('imsi');
    const records = imsi ? [contractRecord(imsi)] : [contractRecord(ROUTE_IDENTITIES.imsi)];
    return { status: 200, payload: { ok: true, records, total: records.length, page: 1, limit: 20 } };
  }

  /* Users and roles. */
  if (pathname === '/api/users') {
    return { status: 200, payload: { users: [userRecord(ROUTE_IDENTITIES.username)], total: 1, page: 1, limit: 20 } };
  }
  if (pathname.startsWith('/api/users/')) {
    const username = decodeURIComponent(pathname.slice('/api/users/'.length));
    return { status: 200, payload: { user: userRecord(username) } };
  }

  /* Knowledge, agents, config snapshots, operations reports. */
  if (pathname === '/api/knowledge/entries') {
    return { status: 200, payload: { entries: [knowledgeEntry(ROUTE_IDENTITIES.entryId)], total: 1 } };
  }
  if (pathname.startsWith('/api/knowledge/entries/')) {
    const entryId = decodeURIComponent(pathname.slice('/api/knowledge/entries/'.length));
    return { status: 200, payload: { entry: knowledgeEntry(entryId) } };
  }
  if (pathname === '/api/agents') {
    return { status: 200, payload: { agents: [agentRecord(ROUTE_IDENTITIES.agentId)], total: 1 } };
  }
  if (pathname.startsWith('/api/agents/')) {
    const agentId = decodeURIComponent(pathname.slice('/api/agents/'.length));
    return { status: 200, payload: { agent: agentRecord(agentId) } };
  }
  if (pathname.startsWith('/api/config-snapshots/sources/')) {
    const rest = pathname.slice('/api/config-snapshots/sources/'.length);
    if (rest.endsWith('/diff')) return { status: 200, payload: { diff: [], completeness: 'complete' } };
    if (rest.endsWith('/observations')) return { status: 200, payload: { observations: [], completeness: 'complete' } };
    if (rest.endsWith('/snapshots')) return { status: 200, payload: { snapshots: [], completeness: 'complete' } };
    const sourceId = decodeURIComponent(rest);
    return { status: 200, payload: { source: { id: sourceId, name: 'cfg-source', status: 'enabled', lastSnapshotAt: TS } } };
  }
  if (pathname.startsWith('/api/config-drift/sources/')) {
    return { status: 200, payload: { policy: { enabled: false, sourceId: ROUTE_IDENTITIES.configSnapshotSourceId } } };
  }

  /* Investigations and inspections. */
  if (pathname.startsWith('/api/investigations/')) {
    const investigationId = decodeURIComponent(pathname.slice('/api/investigations/'.length));
    return {
      status: 200,
      payload: {
        investigation: {
          id: investigationId,
          title: 'Deterministic investigation',
          status: 'open',
          scope: 'all',
          createdAt: TS,
          updatedAt: TS,
        },
      },
    };
  }
  if (pathname.startsWith('/api/inspection-plans/')) {
    const planId = decodeURIComponent(pathname.slice('/api/inspection-plans/'.length));
    return { status: 200, payload: { plan: { id: planId, name: 'Deterministic plan', createdAt: TS, updatedAt: TS } } };
  }
  if (pathname.startsWith('/api/inspection-runs/')) {
    const rest = pathname.slice('/api/inspection-runs/'.length);
    const runId = decodeURIComponent(rest.split('/')[0]);
    if (rest.endsWith('/items')) return { status: 200, payload: { items: [] } };
    return { status: 200, payload: { run: { id: runId, status: 'completed', startedAt: TS, finishedAt: TS } } };
  }

  /* Log Center. */
  if (pathname === '/api/nf-logs/sources') {
    return { status: 200, payload: { sources: [], completeness: 'complete' } };
  }

  /* Static data file used by the subscriber PLMN picker. */
  if (pathname === '/data/mcc-mnc-table.json') {
    return { status: 200, payload: [] };
  }

  if (Object.prototype.hasOwnProperty.call(EMPTY, pathname)) {
    return { status: 200, payload: EMPTY[pathname] };
  }

  return null;
}

/**
 * Start the fixture host.
 *
 * `session` selects the principal the browser authenticates as. The route
 * acceptance suite uses the administrator principal so that every route in the
 * contract, including the permission-gated ones, is reachable.
 */
export async function startCrossRouteFixtureServer({ distDir, session = ADMIN_SESSION, principal = 'admin' }) {
  const unexpected = [];
  const requestLog = [];
  const openStreams = new Set();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      requestLog.push(`${req.method} ${pathname}`);
      const answer = answerApi(pathname, url, session);
      if (!answer) {
        unexpected.push(`${req.method} ${pathname}`);
        return sendJson(res, 404, { error: 'fixture has no answer for this read', code: 'FIXTURE_UNANSWERED' });
      }
      if (answer.status === 'stream') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 600000\n\n');
        if (pathname === '/api/notifications/stream') {
          res.write(`event: init\ndata: ${JSON.stringify({
            alerts: {
              activeCount: 1,
              activeCriticalCount: 1,
              activeWarningCount: 0,
              recent: [
                {
                  id: 'alert-fixture-1',
                  timestamp: TS,
                  level: 'critical',
                  imsi: ROUTE_IDENTITIES.imsi,
                  reason: 'Fixture alert used by the cross-route UX acceptance suite.',
                  is_acknowledged: false,
                  workflow_status: 'open',
                },
              ],
            },
          })}\n\n`);
        }
        openStreams.add(res);
        req.on('close', () => openStreams.delete(res));
        return undefined;
      }
      return sendJson(res, answer.status, answer.payload);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return undefined;
    }

    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    const candidate = join(distDir, relative);
    if (relative && candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      const body = readFileSync(candidate);
      res.writeHead(200, {
        'Content-Type': MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return undefined;
    }

    /* SPA fallback so a deep link boots the application. */
    const indexFile = join(distDir, 'index.html');
    const body = readFileSync(indexFile);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return undefined;
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();

  return {
    principal,
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

export const __internals = { answerApi, ROUTE_IDENTITIES };
