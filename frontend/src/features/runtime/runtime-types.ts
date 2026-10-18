/*
 * Runtime discovery types.
 *
 * The server is the single recognition authority: this module never defines its
 * own process-name table, category list or status vocabulary. Everything below
 * mirrors the bounded API contract of /api/runtime/*.
 */

export type RuntimeStatus =
  | 'running'
  | 'stopped'
  | 'unverified'
  | 'permission_denied'
  | 'unknown'
  | 'stale'
  | 'not_detected'
  | 'not_configured'
  | 'not_applicable';

export type RuntimeCategory = 'epc' | '5gc' | 'ims' | 'charging' | 'support';

export type RuntimeWorker = {
  pid: number;
  exeName: string;
  startedAt?: string;
  commandMatch?: string;
};

export type RuntimeMonitoring = {
  state: 'supported' | 'not_supported';
  reason?: string;
};

export type RuntimeAssociation = {
  state: 'associated' | 'absent' | 'unresolved';
  id?: string;
};

export type RuntimeComponent = {
  componentId: string;
  displayName: string;
  processName: string;
  matchMethod: string;
  category: RuntimeCategory;
  domain: string;
  role: string;
  nfType?: string;
  cnmsCompatible: boolean;
  templates: string[];
  runtimeStatus: RuntimeStatus;
  statusReason: string;
  previousStatus?: RuntimeStatus;
  evidence: 'verified' | 'unverified' | 'none';
  verified: boolean;
  primaryPid: number;
  workerCount: number;
  workers: RuntimeWorker[];
  workersTruncated: boolean;
  unverifiedWorkers: number;
  cpuPercent: number | null;
  cpuAvailable: boolean;
  cpuBasis: string;
  memoryRssBytes: number | null;
  memoryVmsBytes: number | null;
  memoryPercent: number | null;
  memoryAvailable: boolean;
  memoryBasis: string;
  lastScannedAt: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  expectation: 'expected' | 'not_expected';
  monitoring: RuntimeMonitoring;
  inventoryAssociation: RuntimeAssociation;
  nfHealthAssociation: RuntimeAssociation;
};

export type RuntimeScan = {
  scanId: string;
  trigger: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'complete' | 'incomplete' | 'failed' | 'not_scanned';
  complete: boolean;
  processesScanned: number;
  entriesUnreadable: number;
  workersTruncated: number;
  intervalSeconds: number;
  errorSummary?: string;
};

export type RuntimeHost = {
  hostId: string;
  hostName: string;
  identitySource: string;
  visibility: 'host' | 'container_limited' | 'unavailable';
  visibilityReason?: string;
};

export type RuntimeCounts = {
  total: number;
  running: number;
  stopped: number;
  unverified: number;
  permissionDenied: number;
  unknown: number;
  stale: number;
  notDetected: number;
  expected: number;
};

export type RuntimeRegistryCounts = {
  cnmsComponents: number;
  xCloudOnlyComponents: number;
  effectiveEntries: number;
  byCategory: Record<string, number>;
  monitoringSupported: number;
  monitoringNotSupported: number;
};

export type RuntimeSnapshot = {
  profileId: string;
  profileVersion: number;
  host: RuntimeHost;
  scan: RuntimeScan;
  components: RuntimeComponent[];
  counts: RuntimeCounts;
  registry: RuntimeRegistryCounts;
  generatedAt: string;
};

export type RuntimeObservations = {
  snapshot: RuntimeSnapshot;
  associationsComplete: boolean;
};

export type RuntimeComponentMeta = {
  componentId: string;
  displayName: string;
  processName: string;
  matchMethod: string;
  category: RuntimeCategory;
  domain: string;
  role: string;
  nfType?: string;
  templates: string[];
  cnmsCompatible: boolean;
  monitoring: 'supported' | 'not_supported';
  monitoringReason?: string;
};

export type RuntimeMeta = {
  profileId: string;
  profileVersion: number;
  templates: string[];
  categories: RuntimeCategory[];
  statuses: RuntimeStatus[];
  matchMethods: string[];
  javaLaunchTokens: string[];
  scannerEnabled: boolean;
  scanIntervalSeconds: number;
  freshnessSeconds: number;
  minManualIntervalSeconds: number;
  host: RuntimeHost;
  registry: RuntimeRegistryCounts;
  components: RuntimeComponentMeta[];
  lastScan?: RuntimeScan;
  bootstrapEnabled: boolean;
  monitoringStates: string[];
};

export type BootstrapAction =
  | 'create_resource'
  | 'reuse_resource'
  | 'skip_ambiguous'
  | 'skip_not_running'
  | 'skip_monitoring_unsupported';

export type BootstrapPlanEntry = {
  componentId: string;
  displayName: string;
  processName: string;
  domain: string;
  role: string;
  nfType?: string;
  category: RuntimeCategory;
  runtimeStatus: RuntimeStatus;
  verified: boolean;
  workerCount: number;
  primaryPid: number;
  action: BootstrapAction;
  reason: string;
  resourceId?: string;
  resourceName?: string;
  targetId?: string;
  targetAction?: string;
  proposedResource?: {
    kind: string;
    name: string;
    displayName: string;
    domain: string;
    role: string;
    lifecycleState: string;
    externalId: string;
  };
  proposedTarget?: {
    collectorProfile: string;
    serviceUnit: string;
    serviceKind: string;
    collectionMode: string;
    intervalSeconds: number;
  };
  binding?: {
    resourceId: string;
    unit: string;
    processName: string;
    domain: string;
    nfType: string;
    hostId: string;
    bindingKey: string;
    source: string;
  };
  conflicts: string[];
};

export type BootstrapPlan = {
  planId: string;
  hostId: string;
  template: string;
  generatedAt: string;
  entries: BootstrapPlanEntry[];
  counts: {
    total: number;
    create: number;
    reuse: number;
    skipped: number;
    conflicts: number;
    targetCreate: number;
    targetReuse: number;
  };
};

export type BootstrapApplyEntry = {
  componentId: string;
  action: 'created' | 'reused' | 'skipped' | 'failed';
  resourceId?: string;
  resourceCreated: boolean;
  targetId?: string;
  targetCreated: boolean;
  bindingInstalled: boolean;
  reason?: string;
  conflicts: string[];
};

export type BootstrapApplyResult = {
  planId: string;
  hostId: string;
  appliedAt: string;
  entries: BootstrapApplyEntry[];
  counts: BootstrapPlan['counts'];
};
