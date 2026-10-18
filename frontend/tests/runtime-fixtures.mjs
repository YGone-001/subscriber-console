/*
 * Deterministic browser-acceptance fixtures for the runtime discovery surface.
 *
 * TEST-ONLY. Nothing in this module is imported by production runtime code.
 *
 * The runtime panel is mounted on the dashboard, the Inventory route and the
 * Topology route, so every acceptance fixture server must answer its reads.
 * Serving them here keeps the "no unexpected API request" gate meaningful: an
 * unknown request still fails the run.
 */

const TS = '2026-10-01T08:00:00Z';

const HOST = {
  hostId: 'host-0123456789abcdef',
  hostName: 'xcloud-lab-01',
  identitySource: 'machine-id',
  visibility: 'host',
};

const REGISTRY = {
  cnmsComponents: 24,
  xCloudOnlyComponents: 2,
  effectiveEntries: 26,
  byCategory: { '5gc': 12, epc: 7, ims: 5, charging: 1, support: 1 },
  monitoringSupported: 24,
  monitoringNotSupported: 2,
};

function component(overrides) {
  return {
    componentId: 'amf',
    displayName: 'AMF',
    processName: 'amfd',
    matchMethod: 'exact_process_name',
    category: '5gc',
    domain: '5gc',
    role: 'amf',
    nfType: 'AMF',
    cnmsCompatible: true,
    templates: ['auto', '5g'],
    runtimeStatus: 'running',
    statusReason: 'verified_process_running',
    evidence: 'verified',
    verified: true,
    primaryPid: 4211,
    workerCount: 1,
    workers: [{ pid: 4211, exeName: 'amfd', startedAt: TS }],
    workersTruncated: false,
    unverifiedWorkers: 0,
    cpuPercent: 1.8,
    cpuAvailable: true,
    cpuBasis: 'interval_delta_verified_group',
    memoryRssBytes: 188743680,
    memoryVmsBytes: 402653184,
    memoryPercent: 4.2,
    memoryAvailable: true,
    memoryBasis: 'verified_group_aggregate',
    lastScannedAt: TS,
    firstSeenAt: TS,
    lastSeenAt: TS,
    expectation: 'expected',
    monitoring: { state: 'supported' },
    inventoryAssociation: { state: 'absent' },
    nfHealthAssociation: { state: 'absent' },
    ...overrides,
  };
}

const COMPONENTS = [
  component({}),
  component({
    componentId: 'smf',
    displayName: 'SMF',
    processName: 'smfd',
    role: 'smf',
    nfType: 'SMF',
    primaryPid: 4212,
    workers: [{ pid: 4212, exeName: 'smfd', startedAt: TS }],
    cpuPercent: 0.9,
    memoryRssBytes: 96468992,
    memoryVmsBytes: 201326592,
  }),
  component({
    componentId: 'mme',
    displayName: 'MME',
    processName: 'mmed',
    category: 'epc',
    domain: 'epc',
    role: 'mme',
    nfType: 'MME',
    templates: ['auto', '4g'],
    runtimeStatus: 'stopped',
    statusReason: 'previously_observed_absent',
    evidence: 'none',
    verified: false,
    primaryPid: 0,
    workerCount: 0,
    workers: [],
    cpuPercent: null,
    cpuAvailable: false,
    memoryRssBytes: null,
    memoryVmsBytes: null,
    memoryPercent: null,
    memoryAvailable: false,
  }),
  component({
    componentId: 'dra',
    displayName: 'DRA',
    processName: 'drad',
    category: 'support',
    domain: 'shared',
    role: 'dra',
    nfType: '',
    cnmsCompatible: true,
    templates: ['auto', '4g'],
    primaryPid: 4213,
    workers: [{ pid: 4213, exeName: 'drad', startedAt: TS }],
    monitoring: { state: 'not_supported', reason: 'support_component_not_a_monitorable_network_function' },
  }),
  component({
    componentId: 'pgwc',
    displayName: 'PGW-C',
    processName: 'pgwcd',
    category: 'epc',
    domain: 'epc',
    role: 'pgwc',
    nfType: 'PGW-C',
    templates: ['auto', '4g'],
    runtimeStatus: 'not_detected',
    statusReason: 'never_observed',
    evidence: 'none',
    verified: false,
    primaryPid: 0,
    workerCount: 0,
    workers: [],
    cpuPercent: null,
    cpuAvailable: false,
    memoryRssBytes: null,
    memoryVmsBytes: null,
    memoryPercent: null,
    memoryAvailable: false,
    expectation: 'not_expected',
  }),
];

export const RUNTIME_OBSERVATIONS = {
  snapshot: {
    profileId: 'cnms_compat',
    profileVersion: 1,
    host: HOST,
    scan: {
      scanId: 'scan-0123456789abcdef',
      trigger: 'scheduled',
      startedAt: TS,
      completedAt: TS,
      durationMs: 14,
      status: 'complete',
      complete: true,
      processesScanned: 214,
      entriesUnreadable: 0,
      workersTruncated: 0,
      intervalSeconds: 10,
    },
    components: COMPONENTS,
    counts: {
      total: COMPONENTS.length,
      running: 3,
      stopped: 1,
      unverified: 0,
      permissionDenied: 0,
      unknown: 0,
      stale: 0,
      notDetected: 1,
      expected: 2,
    },
    registry: REGISTRY,
    generatedAt: TS,
  },
  associationsComplete: true,
};

export const RUNTIME_META = {
  profileId: 'cnms_compat',
  profileVersion: 1,
  templates: ['auto', '5g', '4g', 'ims'],
  categories: ['epc', '5gc', 'ims', 'charging', 'support'],
  statuses: [
    'running', 'stopped', 'unverified', 'permission_denied', 'unknown',
    'stale', 'not_detected', 'not_configured', 'not_applicable',
  ],
  matchMethods: ['exact_process_name', 'java_command_line_identity'],
  javaLaunchTokens: ['HSSContainer', 'imsHss', 'FHoSS'],
  scannerEnabled: true,
  scanIntervalSeconds: 10,
  freshnessSeconds: 30,
  minManualIntervalSeconds: 2,
  host: HOST,
  registry: REGISTRY,
  components: COMPONENTS.map((entry) => ({
    componentId: entry.componentId,
    displayName: entry.displayName,
    processName: entry.processName,
    matchMethod: entry.matchMethod,
    category: entry.category,
    domain: entry.domain,
    role: entry.role,
    nfType: entry.nfType,
    templates: entry.templates,
    cnmsCompatible: entry.cnmsCompatible,
    monitoring: entry.monitoring.state,
    monitoringReason: entry.monitoring.reason,
  })),
  lastScan: RUNTIME_OBSERVATIONS.snapshot.scan,
  bootstrapEnabled: true,
  monitoringStates: ['supported', 'not_supported'],
};

/**
 * Serves the runtime reads a page may issue. Returns true when the request was
 * handled so the caller can keep its own unexpected-request accounting.
 */
export function serveRuntimeFixture(pathname, sendJson, res) {
  if (pathname === '/api/runtime/observations') {
    sendJson(res, 200, RUNTIME_OBSERVATIONS);
    return true;
  }
  if (pathname === '/api/runtime/meta') {
    sendJson(res, 200, RUNTIME_META);
    return true;
  }
  return false;
}
